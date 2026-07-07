import type { SpectrogramTile, WaveformBins } from '@mumo/timeline'
import type { SpectrogramSettings, MediaState, VadSegment } from './types.js'
import { DEFAULT_SPEC_SETTINGS } from './types.js'
import type { PlatformIO } from './platform.js'
import { MediaPlayer } from './MediaPlayer.js'
import type { MediaPlayerCallbacks } from './MediaPlayer.js'
import type { VideoPlugin } from './plugins/video/VideoPlugin.js'

export interface MultiMediaPlayerCallbacks {
  onPlayersChange(players: readonly MediaPlayer[]): void
  onPrimaryStateChange(state: MediaState | null): void
  onPrimaryPlayheadChange(t: number): void
  onPrimaryPlayingChange(playing: boolean): void
  /** playerId is the MediaPlayer's UUID — stable across reordering */
  onWaveform(playerId: string, channelIndex: number, bins: WaveformBins): void
  onSpectrogramOverview(playerId: string, channelIndex: number, tile: SpectrogramTile): void
  onSpectrogramTile(playerId: string, channelIndex: number, tile: SpectrogramTile): void
  onOnsets(playerId: string, channelIndex: number, timestamps: Float32Array, strengths: Float32Array, bandTimestamps: Float32Array[], bandStrengths: Float32Array[]): void
  onVad(segments: VadSegment[]): void
  onProgress(done: number, total: number): void
  onError(message: string): void
  onCustom(pluginId: string, data: unknown): void
}

// Top-level media controller. Owns the shared AudioContext and master clock.
// Offset-based playback — no drift correction needed for multi-track sync.
export class MultiMediaPlayer {
  private _players: MediaPlayer[] = []
  private _settings: SpectrogramSettings = { ...DEFAULT_SPEC_SETTINGS }
  private readonly _playersListeners = new Set<(players: readonly MediaPlayer[]) => void>()

  private _audioCtx: AudioContext | null = null
  private _gainNode: GainNode | null = null
  private _isPlaying = false
  private _playbackTimeAtStart = 0
  private _audioContextStartTime: number | null = null
  private _speed = 1
  private _preservePitch = true
  private _volume = 1
  private _loopRegion: { start: number; end: number } | null = null
  private _rafId = 0
  private _seekId = 0
  private _pendingDisplay: Promise<void> = Promise.resolve()
  private _isScrubbing = false
  private _wasPlayingBeforeScrub = false
  private _scrubRafPending = false

  constructor(
    private readonly _callbacks: Partial<MultiMediaPlayerCallbacks>,
    private readonly _platform: PlatformIO,
    private readonly _workerUrl?: string,
  ) {}

  get primary(): MediaPlayer | null { return this._players[0] ?? null }
  get players(): readonly MediaPlayer[] { return this._players }

  /** Total duration of all tracks on the global timeline. */
  get duration(): number {
    return this._players.reduce((m, p) => Math.max(m, (p.track?.offsetSec ?? 0) + (p.state?.duration ?? 0)), 0)
  }

  getPlaybackTime(): number {
    if (this._isPlaying && this._audioCtx && this._audioContextStartTime !== null) {
      return this._playbackTimeAtStart + (this._audioCtx.currentTime - this._audioContextStartTime) * this._speed
    }
    return this._playbackTimeAtStart
  }

  onPlayersChange(cb: (players: readonly MediaPlayer[]) => void): () => void {
    this._playersListeners.add(cb)
    return () => this._playersListeners.delete(cb)
  }

  // Loading

  async loadPrimary(file: File, path: string | null): Promise<void> {
    const isNew = this._players.length === 0
    await this._ensurePrimary().load(file, path, this._settings)
    if (isNew) this._notifyPlayersChange()
  }

  async loadPrimaryUrl(url: string): Promise<void> {
    const isNew = this._players.length === 0
    await this._ensurePrimary().loadUrl(url, this._settings)
    if (isNew) this._notifyPlayersChange()
  }

  async addTrack(file: File, path: string | null, offsetSec = 0): Promise<MediaPlayer> {
    const player = this._makePlayer()
    player.track = { file, path, mediaUrl: '', offsetSec }
    await player.load(file, path, this._settings)
    this._players.push(player)
    this._startAudioForPlayer(player)
    this._notifyPlayersChange()
    return player
  }

  async addTrackUrl(url: string, offsetSec = 0): Promise<MediaPlayer> {
    const player = this._makePlayer()
    player.track = { file: new File([], url.split('/').pop() ?? 'media'), path: null, mediaUrl: url, offsetSec }
    await player.loadUrl(url, this._settings)
    this._players.push(player)
    this._startAudioForPlayer(player)
    this._notifyPlayersChange()
    return player
  }

  removeTrack(id: string): void {
    const idx = this._players.findIndex(p => p.id === id)
    if (idx < 0) return
    this._players[idx]!.dispose()
    this._players.splice(idx, 1)
    this._notifyPlayersChange()
  }

  // Playback

  async play(): Promise<void> {
    if (this._isPlaying || this._players.length === 0) return

    // Cancel any in-flight scrub buffer fill so the packet reader is free for playback.
    for (const p of this._players) p._getVideoRenderer()?.cancelScrubBuffer()

    this._ensureAudioContext()
    // Wait for AudioContext resume and any in-flight seek/startDisplay in parallel.
    // _audioContextStartTime is captured AFTER both resolve so the audio clock is accurate.
    await Promise.all([
      this._audioCtx!.state === 'suspended' ? this._audioCtx!.resume() : Promise.resolve(),
      this._pendingDisplay,
    ])

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this._isPlaying) return  // guard: another play() call resolved while we were waiting

    this._audioContextStartTime = this._audioCtx!.currentTime
    this._isPlaying = true
    for (const p of this._players) p._setPaused(false)

    const pt = this._playbackTimeAtStart
    const getTime = () => this.getPlaybackTime()
    for (const p of this._players) {
      p._getVideoRenderer()?.startAudio(
        this._audioCtx!, this._gainNode!, this._audioContextStartTime, pt, this._speed, getTime, this._preservePitch,
      )
    }

    this._startRaf()
    this._callbacks.onPrimaryPlayingChange?.(true)
  }

  pause(): void {
    if (!this._isPlaying) return
    this._playbackTimeAtStart = this.getPlaybackTime()
    this._isPlaying = false
    for (const p of this._players) {
      p._getVideoRenderer()?.stopAudio()
      p._setPaused(true)
    }
    cancelAnimationFrame(this._rafId)
    this._callbacks.onPrimaryPlayingChange?.(false)
    // Pre-decode frames around the paused position so scrubbing is instant
    const t = this._playbackTimeAtStart
    for (const p of this._players) void p._getVideoRenderer()?.startScrubBuffer(t)
  }

  async seek(t: number): Promise<void> {
    const seekId = ++this._seekId
    const was = this._isPlaying
    if (was) {
      // Stop audio and rAF without kicking off startScrubBuffer — we're about to seek anyway.
      this._playbackTimeAtStart = this.getPlaybackTime()
      this._isPlaying = false
      for (const p of this._players) {
        p._getVideoRenderer()?.stopAudio()
        p._setPaused(true)
      }
      cancelAnimationFrame(this._rafId)
      this._callbacks.onPrimaryPlayingChange?.(false)
    }
    this._playbackTimeAtStart = Math.max(0, Math.min(t, this.duration || Infinity))
    this._callbacks.onPrimaryPlayheadChange?.(this._playbackTimeAtStart)

    const target = this._playbackTimeAtStart
    // Show buffer frame synchronously before the decoder seek arrives — feels instant.
    let allHit = true
    for (const p of this._players) {
      const vr = p._getVideoRenderer()
      if (vr && !vr.seekScrubBuffer(target)) allHit = false
    }

    if (seekId !== this._seekId) return
    for (const p of this._players) p._getVideoRenderer()?.cancelScrubBuffer()
    const displayPromise = Promise.all(this._players.map(p =>
      p._getVideoRenderer()?.startDisplay(target) ?? Promise.resolve()
    )).then(() => {})
    this._pendingDisplay = displayPromise
    await displayPromise
    if (seekId !== this._seekId) return

    if (was) {
      await this.play()
    } else if (!allHit) {
      // On a buffer miss when landing paused, fill the buffer for future seeks at this location.
      for (const p of this._players) void p._getVideoRenderer()?.startScrubBuffer(target)
    }
  }

  skip(sec: number): void {
    void this.seek(Math.max(0, Math.min(this.duration || Infinity, this.getPlaybackTime() + sec)))
  }

  togglePlay(): void { if (this._isPlaying) { this.pause() } else { void this.play() } }

  setVolume(v: number): void {
    this._volume = v
    if (this._gainNode) this._gainNode.gain.value = this._gainMuted() ? 0 : v * v
  }

  setSpeed(s: number): void {
    if (this._speed === s) return
    const was = this._isPlaying
    if (was) this.pause()
    this._speed = s
    if (this._gainNode) this._gainNode.gain.value = this._gainMuted() ? 0 : this._volume * this._volume
    if (was) void this.play()
  }

  setPreservePitch(v: boolean): void {
    if (this._preservePitch === v) return
    const was = this._isPlaying
    if (was) this.pause()
    this._preservePitch = v
    if (this._gainNode) this._gainNode.gain.value = this._gainMuted() ? 0 : this._volume * this._volume
    if (was) void this.play()
  }

  // Mute distorted audio above 2x — unintelligible chipmunk effect. Pitch-preserved audio
  // is fine at any speed (just fast speech).
  private _gainMuted(): boolean { return !this._preservePitch && this._speed > 2 }

  /** Update playhead during a drag scrub without restarting audio. */
  scrub(t: number): void {
    const clamped = Math.max(0, Math.min(t, this.duration || Infinity))
    if (!this._isScrubbing) {
      this._isScrubbing = true
      this._wasPlayingBeforeScrub = this._isPlaying
      if (this._isPlaying) this.pause()  // pause() also kicks off startScrubBuffer
    }
    this._playbackTimeAtStart = clamped
    this._callbacks.onPrimaryPlayheadChange?.(clamped)

    // Buffer hit: draw synchronously in the event handler — no rAF delay.
    let allHit = true
    for (const p of this._players) {
      const vr = p._getVideoRenderer()
      if (vr && !vr.seekScrubBuffer(clamped)) allHit = false
    }

    if (!allHit && !this._scrubRafPending) {
      // Cache miss: debounce the expensive decoder seek to one per frame.
      this._scrubRafPending = true
      requestAnimationFrame(() => {
        this._scrubRafPending = false
        const target = this._playbackTimeAtStart
        for (const p of this._players) {
          const vr = p._getVideoRenderer()
          if (!vr) continue
          if (!vr.seekScrubBuffer(target)) {
            const fillId = vr.scrubFillId
            void vr.startDisplay(target).then(() => {
              if (vr.scrubFillId === fillId) void vr.startScrubBuffer(target)
            })
          }
        }
      })
    }
  }

  /** Commit the scrub position and resume playback if it was playing before. */
  async endScrub(): Promise<void> {
    if (!this._isScrubbing) return
    this._isScrubbing = false
    const target = this._playbackTimeAtStart
    for (const p of this._players) p._getVideoRenderer()?.cancelScrubBuffer()
    await Promise.all(this._players.map(p =>
      p._getVideoRenderer()?.startDisplay(target) ?? Promise.resolve()
    ))
    if (this._wasPlayingBeforeScrub) await this.play()
  }

  private readonly _primaryPlugins = new Map<string, VideoPlugin>()

  /** Register a plugin on the primary player. Applied immediately if primary exists; queued for future primaries. */
  addPrimaryPlugin(plugin: VideoPlugin): void {
    this._primaryPlugins.set(plugin.id, plugin)
    this.primary?.addVideoPlugin(plugin)
  }

  removePrimaryPlugin(id: string): void {
    this._primaryPlugins.delete(id)
    this.primary?.removeVideoPlugin(id)
  }

  setActiveChannel(ch: readonly number[] | 'mix'): void { this.primary?.setActiveChannel(ch) }
  setPlayerActiveChannel(playerId: string, ch: readonly number[] | 'mix'): void {
    this._players.find(p => p.id === playerId)?.setActiveChannel(ch)
  }

  setPlayerMuted(playerId: string, muted: boolean): void {
    this._players.find(p => p.id === playerId)?.setMuted(muted)
  }

  setAllMuted(muted: boolean): void {
    for (const p of this._players) p.setMuted(muted)
  }

  setPlayerVolume(playerId: string, volume: number): void {
    this._players.find(p => p.id === playerId)?.setPlayerVolume(volume)
  }

  setLoop(region: { start: number; end: number } | null): void { this._loopRegion = region }

  updateTrackOffset(id: string, offsetSec: number): void {
    const player = this._players.find(p => p.id === id)
    if (!player?.track) return
    player.track = { ...player.track, offsetSec }
    const r = player._getVideoRenderer()
    if (r) {
      r.offset = offsetSec
      void r.startDisplay(this.getPlaybackTime())
    }
  }

  setSpectrogramSettings(settings: SpectrogramSettings): void {
    this._settings = settings
    for (const p of this._players) p.reanalyze(settings)
  }

  dispose(): void {
    cancelAnimationFrame(this._rafId)
    for (const p of this._players) p.dispose()
    this._players = []
    this._gainNode?.disconnect()
    void this._audioCtx?.close()
    this._audioCtx = null; this._gainNode = null
  }

  // rAF loop

  private _startRaf(): void {
    cancelAnimationFrame(this._rafId)
    const tick = () => {
      const pt = this.getPlaybackTime()

      if (this.duration > 0 && pt >= this.duration) {
        this.pause(); return
      }

      if (this._loopRegion && pt >= this._loopRegion.end) {
        void this.seek(this._loopRegion.start); return
      }

      for (const p of this._players) p._tick(pt)
      this._callbacks.onPrimaryPlayheadChange?.(pt)

      if (this._isPlaying) this._rafId = requestAnimationFrame(tick)
    }
    this._rafId = requestAnimationFrame(tick)
  }

  // Internal

  private _ensureAudioContext(): void {
    if (this._audioCtx) return
    const sr = this._players[0]?.state?.sampleRate
    this._audioCtx = new AudioContext(sr ? { sampleRate: sr } : undefined)
    this._gainNode = this._audioCtx.createGain()
    this._gainNode.gain.value = this._gainMuted() ? 0 : this._volume * this._volume
    this._gainNode.connect(this._audioCtx.destination)
  }

  private _notifyPlayersChange(): void {
    this._callbacks.onPlayersChange?.(this._players)
    for (const cb of this._playersListeners) cb(this._players)
  }

  private _startAudioForPlayer(player: MediaPlayer): void {
    if (!this._isPlaying || !this._audioCtx || !this._gainNode) return
    const pt = this.getPlaybackTime()
    player._getVideoRenderer()?.startAudio(
      this._audioCtx, this._gainNode, this._audioCtx.currentTime, pt,
      this._speed, () => this.getPlaybackTime(), this._preservePitch,
    )
  }

  private _ensurePrimary(): MediaPlayer {
    if (this._players.length === 0) {
      const p = this._makePlayer()
      for (const plugin of this._primaryPlugins.values()) p.addVideoPlugin(plugin)
      this._players = [p]
    }
    return this._players[0]!
  }

  private _makePlayer(): MediaPlayer {
    // eslint-disable-next-line prefer-const
    let player: MediaPlayer
    const cbs: Partial<MediaPlayerCallbacks> = {
      onStateChange: state => {
        if (player === this._players[0]) this._callbacks.onPrimaryStateChange?.(state)
      },
      onPlayingChange: playing => {
        if (player === this._players[0]) this._callbacks.onPrimaryPlayingChange?.(playing)
      },
      onWaveform:            (ch, bins)               => this._callbacks.onWaveform?.(player.id, ch, bins),
      onSpectrogramOverview: (ch, tile)               => this._callbacks.onSpectrogramOverview?.(player.id, ch, tile),
      onSpectrogramTile:     (ch, tile)               => this._callbacks.onSpectrogramTile?.(player.id, ch, tile),
      onOnsets:              (ch, ts, str, bts, bstr) => this._callbacks.onOnsets?.(player.id, ch, ts, str, bts, bstr),
      onVad:                 segs                     => { if (player === this._players[0]) this._callbacks.onVad?.(segs) },
      onProgress:            (d, t)                   => { if (player === this._players[0]) this._callbacks.onProgress?.(d, t) },
      onError:               msg                      => this._callbacks.onError?.(msg),
      onCustom:              (id, data)               => { if (player === this._players[0]) this._callbacks.onCustom?.(id, data) },
    }
    player = new MediaPlayer(cbs, this._platform, this._workerUrl)
    player._setClockFn(() => this.getPlaybackTime())
    return player
  }
}
