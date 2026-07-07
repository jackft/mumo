import * as PIXI from 'pixi.js'
// CSP-safe shader codegen (no new Function()) — required under the electron renderer CSP
import 'pixi.js/unsafe-eval'
import { Input, BlobSource, UrlSource, CanvasSink, AudioBufferSink, ALL_FORMATS } from 'mediabunny'
import type { WrappedCanvas } from 'mediabunny'
import type { VideoPlugin } from './plugins/video/VideoPlugin.js'

const FRAME_QUEUE_SIZE = 8
const SCRUB_BUFFER_RADIUS = 10  // seconds each side to pre-decode when paused
const SCRUB_BUFFER_LIMIT  = 1200  // max frames — covers 5s at 60fps, 10s at 30fps

/**
 * One media track: video via mediabunny CanvasSink + PixiJS, audio via AudioBufferSink + Web Audio.
 * Frames are decoded onto _drawCanvas (where plugins add overlays) then uploaded as a PixiJS texture.
 * offset = global timeline position (seconds) where this file's t=0 sits.
 */
export class VideoRenderer {
  offset: number
  framerate = 30
  videoWidth = 0
  videoHeight = 0
  displayWidth = 0
  displayHeight = 0
  duration = 0
  sampleRate = 0

  get frameQueueDepth(): number { return this._frameQueue.length }
  get maxQueueSize(): number { return FRAME_QUEUE_SIZE }
  get channelCount(): number { return this._channelCount }
  get scrubFillId(): number { return this._scrubFillId }

  private _canvas: HTMLCanvasElement
  private _dpr = 1
  private _app: PIXI.Application | null = null
  private _drawCanvas: HTMLCanvasElement
  private _drawCtx: CanvasRenderingContext2D
  private _texture: PIXI.Texture | null = null
  private _sprite: PIXI.Sprite | null = null
  private _currentFrame: WrappedCanvas | null = null

  private _input: Input | null = null
  private _videoSink: CanvasSink | null = null
  private _audioSink: AudioBufferSink | null = null

  private _asyncId      = 0  // video iterator generation
  private _audioAsyncId = 0  // audio iterator generation (separate from video)
  private _frameQueue: WrappedCanvas[] = []
  private _queueSpace: (() => void) | null = null
  private _videoIter: AsyncGenerator<WrappedCanvas> | null = null

  // Scrub buffer: pre-decoded frames around the paused position for instant seeking
  private _scrubSink:   CanvasSink | null = null
  private _scrubBuffer: WrappedCanvas[]   = []
  private _scrubFillId  = 0

  private _audioIter: AsyncGenerator | null = null
  private _queuedAudioNodes = new Set<AudioBufferSourceNode>()
  private _audioRoutingReady = false
  private _channelCount = 0
  private _channelSplitter: ChannelSplitterNode | null = null
  private _channelGains: GainNode[] = []
  private _channelMerger: ChannelMergerNode | null = null
  private _activeChannel: readonly number[] | 'mix' = 'mix'
  private _playerGain: GainNode | null = null  // per-player gain for mute/volume control
  private _muted = false
  private _playerVolume = 1

  private _plugins = new Map<string, VideoPlugin>()
  private _resizeObserver: ResizeObserver | null = null

  // Zoom/pan state
  private _zoom = 1
  private _panX = 0
  private _panY = 0
  private _panActive = false
  private _panStartX = 0
  private _panStartY = 0
  private _panOriginX = 0
  private _panOriginY = 0

  private readonly _onWheel:       (e: WheelEvent)   => void
  private readonly _onPointerDown: (e: PointerEvent)  => void
  private readonly _onPointerMove: (e: PointerEvent)  => void
  private readonly _onPointerUp:   (e: PointerEvent)  => void

  get zoom():      number  { return this._zoom }
  get panX():      number  { return this._panX }
  get panY():      number  { return this._panY }
  get isPanning(): boolean { return this._panActive }

  // Debug stats — reset on each startAudio()
  private _audioSkipCount = 0
  private _audioMaxLateMs = 0

  constructor(canvas: HTMLCanvasElement, offset = 0) {
    this._canvas = canvas
    this.offset = offset
    this._dpr = window.devicePixelRatio || 1

    this._drawCanvas = document.createElement('canvas')
    this._drawCanvas.width  = 640 * this._dpr
    this._drawCanvas.height = 360 * this._dpr
    this._drawCtx = this._drawCanvas.getContext('2d')!
    this._drawCtx.fillStyle = '#111111'
    this._drawCtx.fillRect(0, 0, this._drawCanvas.width, this._drawCanvas.height)

    // PIXI is initialized lazily in _initPixi() called from load()

    this._resizeObserver = new ResizeObserver(() => {
      this._refit()
      this.redrawCurrent()
    })
    const parent = canvas.parentElement
    if (parent) this._resizeObserver.observe(parent)

    this._onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = this._canvas.getBoundingClientRect()
      const cx   = e.clientX - rect.left
      const cy   = e.clientY - rect.top
      this._zoomAt(cx, cy, e.deltaY < 0 ? 1.15 : 1 / 1.15)
    }
    this._onPointerDown = (e: PointerEvent) => {
      if (!e.ctrlKey || e.button !== 0) return
      e.preventDefault()
      this._panActive  = true
      this._panStartX  = e.clientX
      this._panStartY  = e.clientY
      this._panOriginX = this._panX
      this._panOriginY = this._panY
      this._canvas.setPointerCapture(e.pointerId)
    }
    this._onPointerMove = (e: PointerEvent) => {
      if (!this._panActive) return
      this._panX = this._panOriginX + (e.clientX - this._panStartX)
      this._panY = this._panOriginY + (e.clientY - this._panStartY)
      this._applyViewTransform()
    }
    this._onPointerUp = (e: PointerEvent) => {
      if (!this._panActive) return
      this._panActive = false
      try { this._canvas.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    }

    this._canvas.addEventListener('wheel', this._onWheel, { passive: false })
    this._canvas.addEventListener('pointerdown', this._onPointerDown)
    this._canvas.addEventListener('pointermove', this._onPointerMove)
    this._canvas.addEventListener('pointerup', this._onPointerUp)
  }

  // Plugins

  /** The PixiJS display canvas — use for mouse-event overlays and hit testing. */
  get canvas(): HTMLCanvasElement { return this._canvas }

  /** The PixiJS stage — plugins may add display objects here to render above the video. */
  get stage(): PIXI.Container { return this._app!.stage }

  /**
   * Convert client-space mouse coordinates to display-space (CSS pixel) coordinates,
   * accounting for the canvas position, pan, and zoom.
   * Returns coords in the same space as displayWidth / displayHeight.
   */
  clientToDisplay(clientX: number, clientY: number): [number, number] {
    const r = this._canvas.getBoundingClientRect()
    return [
      (clientX - r.left - this._panX) / this._zoom,
      (clientY - r.top  - this._panY) / this._zoom,
    ]
  }

  /** Re-render the PixiJS stage immediately, without decoding a new video frame. */
  requestRender(): void { this._app?.renderer.render(this._app.stage) }

  resetView(): void {
    this._zoom = 1; this._panX = 0; this._panY = 0
    this._applyViewTransform()
  }

  private _zoomAt(cx: number, cy: number, factor: number): void {
    const newZoom = Math.max(1, Math.min(20, this._zoom * factor))
    if (newZoom === this._zoom) return
    this._panX = cx - (cx - this._panX) * (newZoom / this._zoom)
    this._panY = cy - (cy - this._panY) * (newZoom / this._zoom)
    this._zoom = newZoom
    if (this._zoom === 1) { this._panX = 0; this._panY = 0 }
    this._applyViewTransform()
  }

  private _applyViewTransform(): void {
    if (!this._app) return
    this._app.stage.scale.set(this._zoom)
    this._app.stage.position.set(this._panX, this._panY)
    this._app.renderer.render(this._app.stage)
  }

  private async _initPixi(): Promise<void> {
    this._app = new PIXI.Application()
    await this._app.init({
      canvas: this._canvas,
      width: this._canvas.clientWidth || 640,
      height: this._canvas.clientHeight || 360,
      background: 0x111111,
      antialias: false,
      autoStart: false,
      resolution: this._dpr,
      autoDensity: true,
    })
    this._app.ticker.stop()
    this._texture = new PIXI.Texture({ source: new PIXI.CanvasSource({ resource: this._drawCanvas }) })
    this._sprite  = new PIXI.Sprite(this._texture)
    this._sprite.scale.set(1 / this._dpr)
    this._app.stage.addChild(this._sprite)
  }

  addPlugin(plugin: VideoPlugin): void {
    this._plugins.set(plugin.id, plugin)
    if (this.videoWidth > 0) plugin.onAttach(this)
  }

  getPlugin(id: string): VideoPlugin | undefined { return this._plugins.get(id) }

  /** Returns the pool canvas holding the current decoded video frame (kept alive until next frame). */
  getRawCanvas(): HTMLCanvasElement | null {
    return this._currentFrame ? this._currentFrame.canvas as HTMLCanvasElement : null
  }

  captureFrame(): Promise<Blob | null> {
    const raw = this._currentFrame?.canvas
    if (!raw) return Promise.resolve(null)
    const out = document.createElement('canvas')
    out.width  = this.videoWidth
    out.height = this.videoHeight
    out.getContext('2d')!.drawImage(raw, 0, 0)
    return new Promise(resolve => { out.toBlob(resolve, 'image/png'); })
  }

  removePlugin(id: string): void {
    const plugin = this._plugins.get(id)
    if (!plugin) return
    this._plugins.delete(id)
    plugin.onDetach(this)
  }

  getAudioDebugStats(): { skipCount: number; maxLateMs: number } {
    return { skipCount: this._audioSkipCount, maxLateMs: this._audioMaxLateMs }
  }

  // Loading

  async loadAudioOnly(fileOrUrl: File | string): Promise<void> {
    this._clearIterator()
    this._teardownAudioRouting()
    this._input?.dispose()
    this._input = null; this._audioSink = null
    this.sampleRate = 0

    const source = typeof fileOrUrl === 'string' ? new UrlSource(fileOrUrl) : new BlobSource(fileOrUrl)
    this._input = new Input({ formats: ALL_FORMATS, source })
    const at = await this._input.getPrimaryAudioTrack()
    if (!at) throw new Error('No audio track')
    this._audioSink = new AudioBufferSink(at)
    this.sampleRate = await at.getSampleRate()
  }

  async load(fileOrUrl: File | string): Promise<void> {
    if (!this._app) await this._initPixi()
    this._clearIterator()
    ++this._scrubFillId; this._scrubBuffer = []
    this._teardownAudioRouting()
    this._input?.dispose()
    this._input = null; this._videoSink = null; this._audioSink = null; this._scrubSink = null
    this.duration = 0; this.sampleRate = 0

    const source = typeof fileOrUrl === 'string' ? new UrlSource(fileOrUrl) : new BlobSource(fileOrUrl)
    this._input = new Input({ formats: ALL_FORMATS, source })

    const vt = await this._input.getPrimaryVideoTrack()
    if (!vt) throw new Error('No video track')

    this.videoWidth  = await vt.getDisplayWidth()
    this.videoHeight = await vt.getDisplayHeight()
    this.framerate   = (await vt.computePacketStats(100)).averagePacketRate || 30
    this.duration    = await vt.computeDuration()
    // poolSize = queue + 2: the 2 extra canvases let the decoder start the next frame
    // immediately after tick() consumes one, without waiting for GC to free a canvas.
    this._videoSink  = new CanvasSink(vt, { poolSize: FRAME_QUEUE_SIZE + 2, fit: 'contain', decoderOptions: { optimizeForLatency: true } })
    // Separate sink for the scrub buffer. Pool sized to hold the full buffer without wrapping,
    // so every stored WrappedCanvas has a stable, unaliased canvas for the lifetime of the buffer.
    this._scrubSink  = new CanvasSink(vt, { poolSize: SCRUB_BUFFER_LIMIT + 2, fit: 'contain', decoderOptions: { optimizeForLatency: true } })

    const at = await this._input.getPrimaryAudioTrack()
    if (at) {
      this._audioSink = new AudioBufferSink(at)
      this.sampleRate = await at.getSampleRate()
    }

    this._refit()
    this.resetView()
    for (const plugin of this._plugins.values()) plugin.onAttach(this)
  }

  /** Recalculate canvas size to fit the video within its container. */
  refit(): void { this._refit() }

  private _refit(): void {
    if (!this.videoWidth || !this.videoHeight) return
    const cw = this._canvas.parentElement?.clientWidth  ?? 640
    const ch = this._canvas.parentElement?.clientHeight ?? 360
    const scale = Math.min(cw / this.videoWidth, ch / this.videoHeight)
    const dw = Math.round(this.videoWidth  * scale)
    const dh = Math.round(this.videoHeight * scale)
    this.displayWidth  = dw
    this.displayHeight = dh

    const physW = dw * this._dpr
    const physH = dh * this._dpr
    if (this._drawCanvas.width !== physW || this._drawCanvas.height !== physH) {
      this._drawCanvas.width  = physW
      this._drawCanvas.height = physH
      if (this._sprite && this._texture) {
        this._texture.destroy(true)
        this._texture = new PIXI.Texture({ source: new PIXI.CanvasSource({ resource: this._drawCanvas }) })
        this._sprite.texture = this._texture
      }
    }
    this._app?.renderer.resize(dw, dh)
    if (this._sprite) this._sprite.scale.set(1 / this._dpr)
  }

  redrawCurrent(): void {
    if (this._currentFrame && this.displayWidth) this._applyFrame(this._currentFrame)
  }

  // Video iterator

  async startDisplay(globalTimeSec: number): Promise<void> {
    const id = ++this._asyncId
    this._queueSpace?.(); this._queueSpace = null
    await this._videoIter?.return(undefined)
    if (id !== this._asyncId) return
    if (!this._videoSink) return

    this._frameQueue = []
    const localTime  = Math.max(0, globalTimeSec - this.offset)
    const iter       = this._videoSink.canvases(localTime)
    this._videoIter  = iter

    const firstResult = await iter.next()
    if (id !== this._asyncId) return
    if (!firstResult.done) this._applyFrame(firstResult.value)

    // Pre-buffer so tick() has frames immediately when play() starts
    const minPreBuffered = Math.min(3, FRAME_QUEUE_SIZE - 1)
    while (this._frameQueue.length < minPreBuffered) {
      const r = await iter.next()
      if (id !== this._asyncId) return
      if (r.done) break
      this._frameQueue.push(r.value)
    }

    void this._fillQueue(iter, id)
  }

  private async _fillQueue(iter: AsyncGenerator<WrappedCanvas>, id: number): Promise<void> {
    for await (const frame of iter) {
      if (id !== this._asyncId) break
      this._frameQueue.push(frame)
      if (this._frameQueue.length >= FRAME_QUEUE_SIZE) {
        await new Promise<void>(r => { this._queueSpace = r })
        if (id !== this._asyncId) break
      }
    }
  }

  /** Consume queued frames whose file-local time ≤ (globalTimeSec - offset). Returns true if frame was drawn. */
  tick(globalTimeSec: number): boolean {
    const localTime = globalTimeSec - this.offset
    // Drop intermediate past-due frames without rendering — only draw the most recent on-time one.
    while (this._frameQueue.length > 1 && this._frameQueue[1]!.timestamp <= localTime) {
      this._frameQueue.shift()
      this._queueSpace?.(); this._queueSpace = null
    }
    let dirty = false
    if (this._frameQueue.length > 0 && this._frameQueue[0]!.timestamp <= localTime) {
      this._applyFrame(this._frameQueue.shift()!)
      dirty = true
      this._queueSpace?.(); this._queueSpace = null
    }
    return dirty
  }

  /** Cancel an in-flight startScrubBuffer without clearing already-decoded frames. */
  cancelScrubBuffer(): void {
    ++this._scrubFillId
  }

  // Pre-decode frames within SCRUB_BUFFER_RADIUS seconds of the given time.
  // seekScrubBuffer() can then draw buffered frames instantly without a decoder seek.
  async startScrubBuffer(globalTimeSec: number): Promise<void> {
    if (!this._scrubSink) return
    const id = ++this._scrubFillId
    this._scrubBuffer = []

    const localCenter = Math.max(0, globalTimeSec - this.offset)
    const from = Math.max(0, localCenter - SCRUB_BUFFER_RADIUS)
    const to   = Math.min(this.duration || Infinity, localCenter + SCRUB_BUFFER_RADIUS)

    try {
      let count = 0
      for await (const wc of this._scrubSink.canvases(from, to)) {
        if (id !== this._scrubFillId) break
        this._scrubBuffer.push(wc)
        if (++count >= SCRUB_BUFFER_LIMIT) break
      }
    } catch { /* decode aborted or disposed */ }
  }

  /** Draw a buffered frame for globalTimeSec if available. Returns false on cache miss. */
  seekScrubBuffer(globalTimeSec: number): boolean {
    if (this._scrubBuffer.length === 0) return false
    const localTime = globalTimeSec - this.offset
    const bufLo = this._scrubBuffer[0]!.timestamp
    const bufHi = this._scrubBuffer[this._scrubBuffer.length - 1]!.timestamp
    if (localTime < bufLo - 0.001 || localTime > bufHi + 0.001) return false

    // Binary search for the frame at or just after localTime
    let lo = 0, hi = this._scrubBuffer.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this._scrubBuffer[mid]!.timestamp < localTime) lo = mid + 1
      else hi = mid
    }
    const a = this._scrubBuffer[lo]!
    const b = lo > 0 ? this._scrubBuffer[lo - 1] : null
    const wc = (b && Math.abs(b.timestamp - localTime) < Math.abs(a.timestamp - localTime)) ? b : a
    this._applyFrame(wc)
    return true
  }

  private _applyFrame(wc: WrappedCanvas): void {
    this._drawCtx.drawImage(wc.canvas, 0, 0, this._drawCanvas.width, this._drawCanvas.height)
    this._currentFrame = wc
    const frameNum = Math.floor(wc.timestamp * this.framerate)
    this._drawCtx.save()
    this._drawCtx.scale(this._dpr, this._dpr)
    for (const plugin of this._plugins.values()) plugin.onFrame(this, frameNum, wc.timestamp, this._drawCtx)
    this._drawCtx.restore()
    this._texture?.source.update()
    this._app?.renderer.render(this._app.stage)
  }

  // Audio

  startAudio(
    audioCtx: AudioContext,
    masterGain: GainNode,
    audioContextStartTime: number,
    playbackTimeAtStart: number,
    speed: number,
    getPlaybackTime: () => number,
    preservePitch = true,
  ): void {
    // Increment audio ID before closing the old iterator so any in-flight _runAudio sees
    // id !== this._audioAsyncId in its catch block and swallows the InputDisposedError.
    const id = ++this._audioAsyncId
    void this._audioIter?.return(undefined)
    this._audioIter = null
    if (!this._audioSink) return

    // Create (or reuse) a per-player gain node that sits between this player's audio
    // and the shared masterGain, so muting can be toggled without restarting playback.
    if (!this._playerGain || this._playerGain.context !== audioCtx) {
      if (this._playerGain) {
        try { this._playerGain.disconnect() } catch { /* ignore */ }
        this._teardownAudioRouting()
      }
      this._playerGain = audioCtx.createGain()
      this._playerGain.gain.value = this._muted ? 0 : this._playerVolume
      this._playerGain.connect(masterGain)
    }

    this._audioSkipCount = 0
    this._audioMaxLateMs = 0
    const trackStart = Math.max(0, playbackTimeAtStart - this.offset)
    const playWallMs = performance.now()
    for (const plugin of this._plugins.values()) plugin.onPlay?.(playWallMs, trackStart)
    this._audioIter  = this._audioSink.buffers(trackStart)

    void this._runAudio(audioCtx, this._playerGain, audioContextStartTime, playbackTimeAtStart, speed, getPlaybackTime, preservePitch, id)
  }

  private async _runAudio(
    audioCtx: AudioContext,
    masterGain: GainNode,
    audioContextStartTime: number,
    playbackTimeAtStart: number,
    speed: number,
    getPlaybackTime: () => number,
    preservePitch: boolean,
    id: number,
  ): Promise<void> {
    // Initialized lazily on first buffer (need numberOfChannels / sampleRate from the stream)
    let st: StretchState | null = null

    try { for await (const { buffer, timestamp } of this._audioIter as AsyncIterable<{ buffer: AudioBuffer; timestamp: number }>) {
      if (id !== this._audioAsyncId) break
      this._ensureAudioRouting(audioCtx, buffer, masterGain)

      if (preservePitch && speed !== 1) {
        // Pitch-preserved path: stream through SoundTouch WSOLA
        if (!st) st = makeStretchState(buffer.numberOfChannels, buffer.sampleRate, speed)
        stretchFeed(st, buffer)
        const out = stretchDrain(st, audioCtx)
        if (!out) continue  // still accumulating — needs sampleReq samples before first grain

        const source = audioCtx.createBufferSource()
        source.buffer = out
        source.playbackRate.value = 1
        source.connect(this._channelSplitter ?? masterGain)
        this._queuedAudioNodes.add(source)
        source.onended = () => this._queuedAudioNodes.delete(source)

        // Output frame 0 plays at audioContextStartTime; frame N at +N/sr seconds.
        const when = audioContextStartTime + (st.outFrames - out.length) / out.sampleRate
        const snapped = Math.round(audioCtx.sampleRate * when) / audioCtx.sampleRate
        if (snapped >= audioCtx.currentTime) {
          source.start(snapped)
        } else {
          const off = audioCtx.currentTime - snapped
          this._audioMaxLateMs = Math.max(this._audioMaxLateMs, off * 1000)
          if (off < out.duration) {
            source.start(audioCtx.currentTime, off)
          } else {
            source.disconnect(); this._queuedAudioNodes.delete(source); this._audioSkipCount++; continue
          }
        }

        // Sleep when we're >1 real second ahead of the playhead.
        // Capture outEndSec before the await — TypeScript doesn't narrow 'st' past async boundaries.
        const outEndSec = st.outFrames / out.sampleRate
        const realAhead = audioContextStartTime + outEndSec - audioCtx.currentTime
        if (realAhead >= 1) {
          const bulkSleep = Math.max(0, (realAhead - 1) * 1000 - 50)
          if (bulkSleep > 0) await new Promise<void>(r => setTimeout(r, bulkSleep))
          while (id === this._audioAsyncId && audioContextStartTime + outEndSec - audioCtx.currentTime >= 1) {
            await new Promise<void>(r => setTimeout(r, 16))
          }
        }
      } else {
        // Distorted path (tape-speed effect)
        const source = audioCtx.createBufferSource()
        source.buffer = buffer
        source.playbackRate.value = speed
        source.connect(this._channelSplitter ?? masterGain)
        this._queuedAudioNodes.add(source)
        source.onended = () => this._queuedAudioNodes.delete(source)

        const globalTs = timestamp + this.offset
        let when = audioContextStartTime + (globalTs - playbackTimeAtStart) / speed
        when = Math.round(audioCtx.sampleRate * when) / audioCtx.sampleRate

        if (when >= audioCtx.currentTime) {
          source.start(when)
        } else {
          const lateMs = (audioCtx.currentTime - when) * 1000
          this._audioMaxLateMs = Math.max(this._audioMaxLateMs, lateMs)
          const offsetInBuffer = (audioCtx.currentTime - when) * speed
          if (offsetInBuffer < buffer.duration) {
            source.start(audioCtx.currentTime, offsetInBuffer)
          } else {
            source.disconnect()
            this._queuedAudioNodes.delete(source)
            this._audioSkipCount++
            continue
          }
        }

        const lookahead = 1
        const ahead = globalTs - getPlaybackTime()
        if (ahead >= lookahead) {
          const bulkSleep = Math.max(0, (ahead - lookahead) * 1000 / speed - 50)
          if (bulkSleep > 0) await new Promise<void>(r => setTimeout(r, bulkSleep))
          while (id === this._audioAsyncId && globalTs - getPlaybackTime() >= lookahead) {
            await new Promise<void>(r => setTimeout(r, 16))
          }
        }
      }
    } } catch (err) {
      // InputDisposedError: media closed while audio was streaming — normal teardown.
      if (id === this._audioAsyncId) throw err
    }
  }

  private _ensureAudioRouting(audioCtx: AudioContext, buffer: AudioBuffer, masterGain: GainNode): void {
    if (this._audioRoutingReady) return
    this._audioRoutingReady = true
    this._channelCount = buffer.numberOfChannels
    if (this._channelCount <= 1) return

    this._channelSplitter = audioCtx.createChannelSplitter(this._channelCount)
    this._channelMerger   = audioCtx.createChannelMerger(2)
    this._channelGains    = []
    for (let i = 0; i < this._channelCount; i++) {
      const g = audioCtx.createGain()
      this._channelSplitter.connect(g, i, 0)
      g.connect(this._channelMerger, 0, 0)
      g.connect(this._channelMerger, 0, 1)
      this._channelGains.push(g)
    }
    this._channelMerger.connect(masterGain)
    this._applyChannelGains()
  }

  stopAudio(): void {
    ++this._audioAsyncId  // invalidate any in-flight _runAudio so its catch swallows InputDisposedError
    void this._audioIter?.return(undefined)
    this._audioIter = null
    for (const node of this._queuedAudioNodes) { try { node.stop() } catch { /* already stopped */ } }
    this._queuedAudioNodes.clear()
    for (const plugin of this._plugins.values()) plugin.onPause?.()
  }

  setMuted(muted: boolean): void {
    this._muted = muted
    if (this._playerGain) this._playerGain.gain.value = muted ? 0 : this._playerVolume
  }

  setPlayerVolume(volume: number): void {
    this._playerVolume = volume
    if (this._playerGain && !this._muted) this._playerGain.gain.value = volume
  }

  setActiveChannel(ch: readonly number[] | 'mix'): void {
    this._activeChannel = ch
    this._applyChannelGains()
  }

  private _applyChannelGains(): void {
    const n = this._channelGains.length
    if (n === 0) return
    const ch = this._activeChannel
    if (ch === 'mix') {
      for (let i = 0; i < n; i++) this._channelGains[i]!.gain.value = 1 / n
    } else {
      const sel = new Set(ch)
      const gain = sel.size > 0 ? 1 / sel.size : 0
      for (let i = 0; i < n; i++) this._channelGains[i]!.gain.value = sel.has(i) ? gain : 0
    }
  }

  private _teardownAudioRouting(): void {
    try { for (const g of this._channelGains) g.disconnect() } catch { /* ignore */ }
    try { this._channelSplitter?.disconnect() } catch { /* ignore */ }
    try { this._channelMerger?.disconnect() } catch { /* ignore */ }
    this._channelSplitter   = null
    this._channelMerger     = null
    this._channelGains      = []
    this._channelCount      = 0
    this._audioRoutingReady = false
  }

  // Lifecycle

  private _clearIterator(): void {
    ++this._asyncId
    this._queueSpace?.(); this._queueSpace = null
    void this._videoIter?.return(undefined)
    this._frameQueue = []
    this._videoIter  = null
    // Scrub buffer is independent — intentionally not cleared here.
    // It stays valid until startScrubBuffer() replaces it or load()/dispose() runs.
  }

  dispose(): void {
    this._canvas.removeEventListener('wheel', this._onWheel)
    this._canvas.removeEventListener('pointerdown', this._onPointerDown)
    this._canvas.removeEventListener('pointermove', this._onPointerMove)
    this._canvas.removeEventListener('pointerup', this._onPointerUp)
    this._resizeObserver?.disconnect()
    this._resizeObserver = null
    this._clearIterator()
    ++this._scrubFillId  // stop any in-flight startScrubBuffer
    this._scrubBuffer = []
    this.stopAudio()
    this._teardownAudioRouting()
    try { this._playerGain?.disconnect() } catch { /* ignore */ }
    this._playerGain = null
    for (const plugin of this._plugins.values()) plugin.onDetach(this)
    this._plugins.clear()
    this._currentFrame = null
    this._sprite?.destroy()
    this._sprite = null
    this._texture?.destroy(true)
    this._texture = null
    this._app?.destroy(false)
    this._app = null
    this._input?.dispose(); this._input = null
    this._videoSink = null; this._audioSink = null
  }
}

// Pitch-preserving time stretch (adapted from SoundTouch WSOLA)
//
// Key differences from naive OLA:
//   1. Large grains (50-125 ms), tiny linear crossfade (8 ms) — not Hann-windowed.
//      Hard-copy of the middle avoids the "watery/chorus" phase-interference of
//      heavily-overlapping windows.
//   2. Persistent pMidBuf across chunks: the tail of the previous grain is kept for
//      the next crossfade, so chunk boundaries are seamless.
//   3. Seek correlates against pMidBuf (not a fixed look-ahead): finds the new grain
//      position whose start best continues the audio we already output.
//   4. Scheduling is by cumulative output-frame count, not per-chunk timestamps.

interface StretchState {
  // Fixed params for this session
  readonly overlapLen: number   // ~8 ms
  readonly seekWinLen: number   // ~50-125 ms grain
  readonly seekLen:    number   // ~15-25 ms search window
  readonly nominalSkip: number  // (seekWinLen - overlapLen) * speed
  readonly nCh: number
  readonly sr:  number
  // Mutable state across chunks
  pMidBuf:   Float32Array[]  // [nCh][overlapLen] — tail of last grain
  skipFract: number
  inBuf:     Float32Array[]  // [nCh][...] — accumulated undrained input
  inLen:     number          // valid samples currently in inBuf
  outFrames: number          // cumulative output frames produced so far
}

function makeStretchState(nCh: number, sr: number, speed: number): StretchState {
  const seekMs    = Math.max(15, Math.min(25, 30 - 10 * speed))
  const overlapMs = 8
  const overlapLen = Math.round(overlapMs * sr / 1000)
  const seekLen    = Math.round(seekMs    * sr / 1000)

  // Grain size is derived so that pMidBuf (the previous grain's tail, stored at
  // seekWinLen-overlapLen samples past the grain start) falls inside the seek window
  // for the next iteration. This gives the correlation a match to work with even at
  // extreme slow rates. Derivation: (seekWinLen-overlapLen)*(1-speed) = seekLen
  //   → seekWinLen = overlapLen + seekLen/(1-speed)
  // For speed>=1, use a fixed 75ms grain (compression artifacts are different in nature).
  const rawWin = speed < 1
    ? overlapLen + Math.round(seekLen / Math.max(0.05, 1 - speed))
    : Math.round(75 * sr / 1000)
  const seekWinLen  = Math.max(Math.round(35 * sr / 1000), Math.min(Math.round(120 * sr / 1000), rawWin))
  const nominalSkip = (seekWinLen - overlapLen) * speed
  return {
    overlapLen, seekWinLen, seekLen, nominalSkip, nCh, sr,
    pMidBuf:   Array.from({ length: nCh }, () => new Float32Array(overlapLen)),
    skipFract: 0,
    inBuf:     Array.from({ length: nCh }, () => new Float32Array((seekWinLen + seekLen) * 6)),
    inLen:     0,
    outFrames: 0,
  }
}

function stretchSampleReq(st: StretchState): number {
  return Math.max(Math.floor(st.nominalSkip) + st.overlapLen, st.seekWinLen) + st.seekLen
}

function stretchFeed(st: StretchState, buf: AudioBuffer): void {
  const n = buf.length
  const need = st.inLen + n
  if (need > st.inBuf[0]!.length) {
    for (let ch = 0; ch < st.nCh; ch++) {
      const nb = new Float32Array(need * 2)
      nb.set(st.inBuf[ch]!.subarray(0, st.inLen))
      st.inBuf[ch] = nb
    }
  }
  for (let ch = 0; ch < st.nCh; ch++) st.inBuf[ch]!.set(buf.getChannelData(ch), st.inLen)
  st.inLen += n
}

function stretchDrain(st: StretchState, audioCtx: AudioContext): AudioBuffer | null {
  const sReq = stretchSampleReq(st)
  if (st.inLen < sReq) return null

  const outPerIter = st.seekWinLen - st.overlapLen

  // Count how many full iterations we can run
  let iters = 0, tmpLen = st.inLen, tmpFract = st.skipFract
  while (tmpLen >= sReq) {
    tmpFract += st.nominalSkip
    const skip = Math.floor(tmpFract); tmpFract -= skip; tmpLen -= skip; iters++
  }
  if (iters === 0) return null

  const out    = audioCtx.createBuffer(st.nCh, iters * outPerIter, st.sr)
  const outChs = Array.from({ length: st.nCh }, (_, ch) => out.getChannelData(ch))
  let outPos = 0
  let inOff  = 0

  for (let iter = 0; iter < iters; iter++) {
    // Seek: find best grain start in [inOff, inOff+seekLen] by normalized cross-correlation
    // with pMidBuf (summed across all channels for a single shared position decision).
    // Normalization by input-window energy prevents loud silence-edge positions from
    // winning when a quieter but phase-matched position exists.
    let pMidNorm = 0
    for (let ch = 0; ch < st.nCh; ch++) {
      const pMid = st.pMidBuf[ch]!
      for (let i = 0; i < st.overlapLen; i++) pMidNorm += pMid[i]! * pMid[i]!
    }
    pMidNorm = Math.sqrt(pMidNorm + 1e-12)

    let bestCorr = -Infinity, bestPos = 0
    for (let b = 0; b < st.seekLen; b++) {
      let corr = 0, inpNorm = 0
      for (let ch = 0; ch < st.nCh; ch++) {
        const inp  = st.inBuf[ch]!
        const pMid = st.pMidBuf[ch]!
        for (let i = 0; i < st.overlapLen; i++) {
          const x = inp[inOff + b + i] ?? 0
          corr    += x * pMid[i]!
          inpNorm += x * x
        }
      }
      const normCorr = corr / (Math.sqrt(inpNorm + 1e-12) * pMidNorm)
      if (normCorr > bestCorr) { bestCorr = normCorr; bestPos = b }
    }

    const gb = inOff + bestPos  // grain base

    for (let ch = 0; ch < st.nCh; ch++) {
      const inp  = st.inBuf[ch]!
      const pMid = st.pMidBuf[ch]!
      const oCh  = outChs[ch]!

      // Linear crossfade: previous grain tail (pMid) fades out, new grain fades in
      for (let i = 0; i < st.overlapLen; i++) {
        const f = i / st.overlapLen
        oCh[outPos + i] = (inp[gb + i] ?? 0) * f + pMid[i]! * (1 - f)
      }

      // Hard copy: the middle of the grain (no windowing = no phase smear)
      const mid = st.seekWinLen - 2 * st.overlapLen
      for (let i = 0; i < mid; i++) oCh[outPos + st.overlapLen + i] = inp[gb + st.overlapLen + i] ?? 0

      // Save the grain's tail — this becomes pMid for the next iteration
      const tb = gb + st.seekWinLen - st.overlapLen
      for (let i = 0; i < st.overlapLen; i++) pMid[i] = inp[tb + i] ?? 0
    }

    outPos += outPerIter

    // Advance input pointer by nominalSkip
    st.skipFract += st.nominalSkip
    const skip = Math.floor(st.skipFract); st.skipFract -= skip; inOff += skip
  }

  // Compact inBuf — remove consumed input
  const rem = st.inLen - inOff
  for (let ch = 0; ch < st.nCh; ch++) {
    if (rem > 0) st.inBuf[ch]!.copyWithin(0, inOff, inOff + rem)
  }
  st.inLen = rem
  st.outFrames += iters * outPerIter
  return out
}
