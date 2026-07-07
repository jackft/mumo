import { Input, UrlSource, AudioBufferSink, ALL_FORMATS } from 'mediabunny'
import type { SpectrogramTile, WaveformBins } from '@mumo/timeline'
import type { SpectrogramSettings, MediaState, MediaTrack, VadSegment, FrameStat } from './types.js'
import type { PlatformIO } from './platform.js'
import { SignalBroker } from './SignalBroker.js'
import type { SignalCallbacks } from './SignalBroker.js'
import { VideoRenderer } from './VideoRenderer.js'
import type { VideoPlugin } from './plugins/video/VideoPlugin.js'
import { DecodeDebugPlugin } from './plugins/video/DecodeDebugPlugin.js'

async function computeMediaFingerprint(file: File): Promise<string> {
  const headSize = Math.min(65536, file.size)
  const head = await file.slice(0, headSize).arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', head)
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `${file.size}:${file.lastModified}:${hex}`
}

export interface MediaPlayerCallbacks {
  onStateChange(state: MediaState | null): void
  onPlayingChange(playing: boolean): void
  onWaveform(channelIndex: number, bins: WaveformBins): void
  onSpectrogramOverview(channelIndex: number, tile: SpectrogramTile): void
  onSpectrogramTile(channelIndex: number, tile: SpectrogramTile): void
  onOnsets(channelIndex: number, timestamps: Float32Array, strengths: Float32Array, bandTimestamps: Float32Array[], bandStrengths: Float32Array[]): void
  onVad(segments: VadSegment[]): void
  onProgress(done: number, total: number): void
  onError(message: string): void
  onCustom(pluginId: string, data: unknown): void
}

/** Controller for a single media item. Canvas is attached by MediaPlayerView after mount. */
export class MediaPlayer {
  readonly id: string = crypto.randomUUID()
  state: MediaState | null = null
  track: MediaTrack | null = null

  private _videoRenderer: VideoRenderer | null = null
  private readonly _broker: SignalBroker
  private _paused = true
  private _clockFn: () => number = () => 0
  private _decodeId = 0  // cancels stale audio decode loops on reload

  private readonly _stateListeners   = new Set<(s: MediaState | null) => void>()
  private readonly _playingListeners = new Set<(playing: boolean) => void>()

  constructor(
    private readonly _callbacks: Partial<MediaPlayerCallbacks>,
    private readonly _platform: PlatformIO,
    workerUrl?: string,
  ) {
    const signalCallbacks: SignalCallbacks = {
      onDecoded: (sampleRate, channelCount, duration) => {
        if (this.state) this._setState({ ...this.state, sampleRate, channelCount, duration })
      },
      onWaveform:             (ch, bins)               => _callbacks.onWaveform?.(ch, bins),
      onSpectrogramOverview:  (ch, tile)               => _callbacks.onSpectrogramOverview?.(ch, tile),
      onSpectrogramTile:      (ch, tile)               => _callbacks.onSpectrogramTile?.(ch, tile),
      onOnsets:               (ch, ts, str, bts, bstr) => _callbacks.onOnsets?.(ch, ts, str, bts, bstr),
      onVad:                  segs                     => _callbacks.onVad?.(segs),
      onProgress:             (d, t)                   => _callbacks.onProgress?.(d, t),
      onError:                msg                      => _callbacks.onError?.(msg),
      onCustom:               (id, data)               => _callbacks.onCustom?.(id, data),
    }
    this._broker = new SignalBroker(signalCallbacks, workerUrl)
  }

  onStateUpdate(cb: (s: MediaState | null) => void): () => void {
    this._stateListeners.add(cb)
    return () => this._stateListeners.delete(cb)
  }

  onPlayingUpdate(cb: (playing: boolean) => void): () => void {
    this._playingListeners.add(cb)
    return () => this._playingListeners.delete(cb)
  }

  // Internal — called by MultiMediaPlayer

  _setClockFn(fn: () => number): void { this._clockFn = fn }

  _setPaused(v: boolean): void {
    if (this._paused === v) return
    this._paused = v
    this._playingListeners.forEach(cb => { cb(!v); })
    this._callbacks.onPlayingChange?.(!v)
  }

  _tick(globalTimeSec: number): void {
    this._videoRenderer?.tick(globalTimeSec)
  }

  _getVideoRenderer(): VideoRenderer | null { return this._videoRenderer }

  // Canvas lifecycle

  private readonly _pendingPlugins = new Map<string, VideoPlugin>()

  attachCanvas(el: HTMLCanvasElement): void {
    this._videoRenderer?.dispose()
    this._videoRenderer = new VideoRenderer(el, this.track?.offsetSec ?? 0)
    for (const plugin of this._pendingPlugins.values()) this._videoRenderer.addPlugin(plugin)
    const mediaUrl = this.state?.mediaUrl
    if (!mediaUrl) return
    if (this.state?.kind === 'video') {
      void this._videoRenderer.load(mediaUrl)
        .then(() => this._videoRenderer?.startDisplay(this._clockFn()))
        .catch((err: unknown) => this._callbacks.onError?.(`Video renderer: ${String(err)}`))
    } else if (this.state?.kind === 'audio') {
      void this._videoRenderer.loadAudioOnly(mediaUrl)
        .catch((err: unknown) => this._callbacks.onError?.(`Audio renderer: ${String(err)}`))
    }
  }

  detachCanvas(): void {
    this._videoRenderer?.dispose()
    this._videoRenderer = null
  }

  addVideoPlugin(plugin: VideoPlugin): void {
    this._pendingPlugins.set(plugin.id, plugin)
    this._videoRenderer?.addPlugin(plugin)
  }

  removeVideoPlugin(id: string): void {
    this._pendingPlugins.delete(id)
    this._videoRenderer?.removePlugin(id)
  }

  // Loading

  async load(file: File, path: string | null, settings: SpectrogramSettings): Promise<void> {
    const mediaUrl = this._platform.mediaUrlForFile(file, path)
    const kind: 'audio' | 'video' = file.type.startsWith('video') ? 'video' : 'audio'

    this.track = { file, path, mediaUrl, offsetSec: this.track?.offsetSec ?? 0 }
    this._setState({ mediaUrl, kind, filename: file.name, duration: 0, sampleRate: 0, channelCount: 1, activeChannel: 'mix', muted: this.state?.muted ?? false, volume: this.state?.volume ?? 1 })

    void computeMediaFingerprint(file).then(hash => {
      if (this.track?.file === file) this.track = { ...this.track, mediaHash: hash }
    })

    // Start worker for this file; then stream decoded audio chunks to it
    this._broker.startStream(settings)
    void this._streamAudio(mediaUrl, ++this._decodeId)

    if (kind === 'audio') {
      // Audio-only files never get a visible canvas tile, so create an offscreen renderer
      // here to ensure _audioSink is ready for Web Audio playback.
      if (!this._videoRenderer) {
        this._videoRenderer = new VideoRenderer(document.createElement('canvas'), this.track.offsetSec)
      }
      await this._videoRenderer.loadAudioOnly(mediaUrl)
        .catch((err: unknown) => this._callbacks.onError?.(`Audio renderer: ${String(err)}`))
    } else if (this._videoRenderer) {
      void this._videoRenderer.load(mediaUrl)
        .then(() => {
          if (this.state && this._videoRenderer) {
            this._setState({ ...this.state, duration: this._videoRenderer.duration })
          }
          void this._videoRenderer?.startDisplay(this._clockFn())
        })
        .catch((err: unknown) => this._callbacks.onError?.(`Video renderer: ${String(err)}`))
    }
  }

  async loadUrl(url: string, settings: SpectrogramSettings): Promise<void> {
    const name = url.split('/').pop()?.split('?')[0] ?? 'media'
    const kind: 'audio' | 'video' = /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(name) ? 'video' : 'audio'

    this.track = null
    this._setState({ mediaUrl: url, kind, filename: name, duration: 0, sampleRate: 0, channelCount: 1, activeChannel: 'mix', muted: this.state?.muted ?? false, volume: this.state?.volume ?? 1 })

    this._broker.startStream(settings)
    void this._streamAudio(url, ++this._decodeId)

    if (kind === 'audio') {
      if (!this._videoRenderer) {
        this._videoRenderer = new VideoRenderer(document.createElement('canvas'), 0)
      }
      await this._videoRenderer.loadAudioOnly(url)
        .catch((err: unknown) => this._callbacks.onError?.(`Audio renderer: ${String(err)}`))
    } else if (this._videoRenderer) {
      void this._videoRenderer.load(url)
        .then(() => {
          if (this.state && this._videoRenderer) {
            this._setState({ ...this.state, duration: this._videoRenderer.duration })
          }
          void this._videoRenderer?.startDisplay(this._clockFn())
        })
        .catch((err: unknown) => this._callbacks.onError?.(`Video renderer: ${String(err)}`))
    }
  }

  /**
   * Decode audio from a URL on the main thread (AudioBuffer requires window context)
   * and stream each chunk to the worker without accumulating PCM in main memory.
   */
  private async _streamAudio(url: string, decodeId: number): Promise<void> {
    const source = new UrlSource(url)
    const input = new Input({ formats: ALL_FORMATS, source })
    try {
      const at = await input.getPrimaryAudioTrack()
      if (!at || decodeId !== this._decodeId) return
      const sampleRate = await at.getSampleRate()
      if (decodeId !== this._decodeId) return
      const sink = new AudioBufferSink(at)
      let duration = 0, channelCount = 0
      for await (const { buffer, timestamp } of sink.buffers(0)) {
        if (decodeId !== this._decodeId) break
        channelCount = buffer.numberOfChannels
        duration = Math.max(duration, timestamp + buffer.duration)
        // Extract and transfer each channel — zero-copy, no accumulation on main thread
        const chunks: Float32Array[] = []
        for (let ch = 0; ch < channelCount; ch++) {
          chunks.push(buffer.getChannelData(ch).slice())
        }
        this._broker.feedChunk(chunks, sampleRate, channelCount)
      }
      if (decodeId === this._decodeId) {
        this._broker.endStream(duration)
      }
    } catch (err) {
      if (decodeId === this._decodeId) {
        this._callbacks.onError?.(`Failed to decode audio: ${String(err)}`)
      }
    } finally {
      input.dispose()
    }
  }

  reanalyze(settings: SpectrogramSettings): void { this._broker.reanalyze(settings) }

  captureFrame(): Promise<Blob | null> {
    return this._videoRenderer?.captureFrame() ?? Promise.resolve(null)
  }

  // Transport

  setActiveChannel(ch: readonly number[] | 'mix'): void {
    if (!this.state) return
    this._setState({ ...this.state, activeChannel: ch })
    this._videoRenderer?.setActiveChannel(ch)
  }

  setMuted(muted: boolean): void {
    if (!this.state) return
    this._setState({ ...this.state, muted })
    this._videoRenderer?.setMuted(muted)
  }

  setPlayerVolume(volume: number): void {
    if (!this.state) return
    this._setState({ ...this.state, volume })
    this._videoRenderer?.setPlayerVolume(volume)
  }

  getVideoQueueDepth(): number { return this._videoRenderer?.frameQueueDepth ?? 0 }
  getVideoDisplayHeight(): number { return this._videoRenderer?.displayHeight ?? 360 }

  getDecodeStats(): readonly FrameStat[] {
    const p = this._videoRenderer?.getPlugin('decode-debug')
    return p instanceof DecodeDebugPlugin ? p.getStats() : []
  }

  clearDecodeStats(): void {
    const p = this._videoRenderer?.getPlugin('decode-debug')
    if (p instanceof DecodeDebugPlugin) p.clearStats()
  }

  getVideoInfo(): { framerate: number; videoWidth: number; videoHeight: number } | null {
    const r = this._videoRenderer
    if (!r || !r.videoWidth) return null
    return { framerate: r.framerate, videoWidth: r.videoWidth, videoHeight: r.videoHeight }
  }

  get paused(): boolean { return this._paused }

  dispose(): void {
    this._broker.dispose()
    this._videoRenderer?.dispose()
    this._videoRenderer = null
    this._setState(null)
  }

  private _setState(state: MediaState | null): void {
    this.state = state
    this._stateListeners.forEach(cb => { cb(state); })
    this._callbacks.onStateChange?.(state)
  }
}
