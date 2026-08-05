import type { SpectrogramTile, WaveformBins } from '@mumo/timeline'
import type { SpectrogramSettings, MediaState, MediaTrack, VadSegment, VadSettings, PitchTrack, PitchSettings, FrameStat } from './types.js'
import { DEFAULT_VAD_SETTINGS, DEFAULT_PITCH_SETTINGS } from './types.js'
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
  onVadProgress(done: number, total: number): void
  onPitch(channelIndex: number, track: PitchTrack): void
  onPitchProgress(done: number, total: number): void
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
  private _vadSettings: VadSettings = { ...DEFAULT_VAD_SETTINGS }
  private _pitchSettings: PitchSettings = { ...DEFAULT_PITCH_SETTINGS }

  private readonly _stateListeners   = new Set<(s: MediaState | null) => void>()
  private readonly _playingListeners = new Set<(playing: boolean) => void>()

  constructor(
    private readonly _callbacks: Partial<MediaPlayerCallbacks>,
    private readonly _platform: PlatformIO,
    workerUrl?: string,
  ) {
    const signalCallbacks: SignalCallbacks = {
      onDecoded: (sampleRate, channelCount, duration) => {
        // For video, the renderer's duration is authoritative (audio & video tracks can differ
        // in length); only fall back to the decoded audio duration for audio-only media.
        if (this.state) this._setState({ ...this.state, sampleRate, channelCount, duration: this.state.duration || duration })
      },
      onWaveform:             (ch, bins)               => _callbacks.onWaveform?.(ch, bins),
      onSpectrogramOverview:  (ch, tile)               => _callbacks.onSpectrogramOverview?.(ch, tile),
      onSpectrogramTile:      (ch, tile)               => _callbacks.onSpectrogramTile?.(ch, tile),
      onOnsets:               (ch, ts, str, bts, bstr) => _callbacks.onOnsets?.(ch, ts, str, bts, bstr),
      onVad:                  segs                     => _callbacks.onVad?.(segs),
      onVadProgress:          (d, t)                   => _callbacks.onVadProgress?.(d, t),
      onPitch:                (ch, track)              => _callbacks.onPitch?.(ch, track),
      onPitchProgress:        (d, t)                   => _callbacks.onPitchProgress?.(d, t),
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

    console.log(`[media] loading ${kind}: ${file.name}`, path ? `(${path})` : '')
    this.track = { file, path, mediaUrl, offsetSec: this.track?.offsetSec ?? 0 }
    this._setState({ mediaUrl, kind, filename: file.name, duration: 0, sampleRate: 0, channelCount: 1, activeChannel: 'mix', muted: this.state?.muted ?? false, volume: this.state?.volume ?? 1 })

    void computeMediaFingerprint(file).then(hash => {
      if (this.track?.file === file) this.track = { ...this.track, mediaHash: hash }
    })

    // Decode + analyze the whole file in the worker (off the main thread).
    this._broker.analyze(mediaUrl, settings, { __vadSettings: this._vadSettings, __pitch: this._pitchSettings })

    if (kind === 'audio') {
      // Audio-only files never get a visible canvas tile, so create an offscreen renderer
      // here to ensure _audioSink is ready for Web Audio playback.
      if (!this._videoRenderer) {
        this._videoRenderer = new VideoRenderer(document.createElement('canvas'), this.track.offsetSec)
      }
      await this._videoRenderer.loadAudioOnly(mediaUrl)
        .then(() => { console.log(`[media] loaded audio: ${file.name}`) })
        .catch((err: unknown) => this._callbacks.onError?.(`Audio renderer: ${String(err)}`))
    } else if (this._videoRenderer) {
      void this._videoRenderer.load(mediaUrl)
        .then(() => {
          console.log(`[media] loaded video: ${file.name}`)
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

    console.log(`[media] loading ${kind} url: ${name}`)
    // addTrackUrl/loadPrimaryUrl pre-seed the track to carry offsetSec — keep it
    // when it matches this URL; otherwise the URL has no backing track.
    this.track = this.track?.mediaUrl === url ? this.track : null
    this._setState({ mediaUrl: url, kind, filename: name, duration: 0, sampleRate: 0, channelCount: 1, activeChannel: 'mix', muted: this.state?.muted ?? false, volume: this.state?.volume ?? 1 })

    this._broker.analyze(url, settings, { __vadSettings: this._vadSettings, __pitch: this._pitchSettings })

    if (kind === 'audio') {
      if (!this._videoRenderer) {
        this._videoRenderer = new VideoRenderer(document.createElement('canvas'), 0)
      }
      await this._videoRenderer.loadAudioOnly(url)
        .then(() => { console.log(`[media] loaded audio url: ${name}`) })
        .catch((err: unknown) => this._callbacks.onError?.(`Audio renderer: ${String(err)}`))
    } else if (this._videoRenderer) {
      void this._videoRenderer.load(url)
        .then(() => {
          console.log(`[media] loaded video url: ${name}`)
          if (this.state && this._videoRenderer) {
            this._setState({ ...this.state, duration: this._videoRenderer.duration })
          }
          void this._videoRenderer?.startDisplay(this._clockFn())
        })
        .catch((err: unknown) => this._callbacks.onError?.(`Video renderer: ${String(err)}`))
    }
  }

  reanalyze(settings: SpectrogramSettings): void { this._broker.reanalyze(settings) }

  /** Remember the current VAD settings so the next analyze segments with them. */
  setVadSettings(settings: VadSettings): void { this._vadSettings = { ...settings } }

  /** Apply new VAD settings now: re-segment the worker's cached probs (instant, no re-decode). */
  resegmentVad(settings: VadSettings): void { this._vadSettings = { ...settings }; this._broker.resegmentVad(this._vadSettings) }

  /** Compute VAD now as a deferred pass (re-decode, VAD-only). Used lazily when VAD is enabled. */
  computeVad(): void { this._broker.analyzeVad(this._vadSettings) }

  // Copy to a plain object: callers may pass a framework reactive proxy (e.g. Svelte $state), which
  // is not structured-cloneable and would break postMessage to the worker.
  /** Remember the current pitch settings so the next analyze uses them. */
  setPitchSettings(settings: PitchSettings): void { this._pitchSettings = { ...settings } }

  /** Re-run pitch detection with new settings (re-decodes; backend/frequency/threshold changes). */
  reanalyzePitch(settings: PitchSettings): void { this._pitchSettings = { ...settings }; this._broker.reanalyzePitch(this._pitchSettings) }

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
