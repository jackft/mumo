import { VideoRenderer } from './VideoRenderer.js'
import type { VideoPlugin } from './plugins/video/VideoPlugin.js'

export class PlayerController {
  readonly renderer: VideoRenderer

  private _audioCtx:      AudioContext | null = null
  private _gainNode:      GainNode    | null = null
  private _isPlaying    = false
  private _speed        = 1
  private _preservePitch = true
  private _playbackTimeAtStart = 0
  private _audioCtxStart = 0
  private _perfStart     = 0
  private _rafHandle     = 0

  onTimeUpdate: ((timeS: number, frame: number) => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new VideoRenderer(canvas)
  }

  get framerate():    number  { return this.renderer.framerate }
  get duration():     number  { return this.renderer.duration  }
  get isPlaying():    boolean { return this._isPlaying }
  get speed():        number  { return this._speed }
  get channelCount(): number  { return this.renderer.channelCount }

  getPlaybackTime(): number {
    if (!this._isPlaying) return this._playbackTimeAtStart
    return this._playbackTimeAtStart + (performance.now() / 1000 - this._perfStart) * this._speed
  }

  get currentFrame(): number {
    return Math.floor(this.getPlaybackTime() * this.renderer.framerate)
  }

  async load(file: File): Promise<void> {
    await this.renderer.load(file)
    await this.renderer.startDisplay(0)
    this.onTimeUpdate?.(0, 0)
  }

  addPlugin(plugin: VideoPlugin): void { this.renderer.addPlugin(plugin) }
  removePlugin(id: string): void       { this.renderer.removePlugin(id)  }

  async play(): Promise<void> {
    if (this._isPlaying) return
    this._isPlaying     = true
    this._perfStart     = performance.now() / 1000
    this._audioCtxStart = await this._ensureAudio()
    this.renderer.startAudio(
      this._audioCtx!,
      this._gainNode!,
      this._audioCtxStart,
      this._playbackTimeAtStart,
      this._speed,
      () => this.getPlaybackTime(),
      this._preservePitch,
    )
    this._raf()
  }

  pause(): void {
    if (!this._isPlaying) return
    this._playbackTimeAtStart = this.getPlaybackTime()
    this._isPlaying = false
    this.renderer.stopAudio()
    cancelAnimationFrame(this._rafHandle)
  }

  playpause(): void { if (this._isPlaying) { this.pause() } else { void this.play() } }

  async seekTo(timeS: number): Promise<void> {
    const was = this._isPlaying
    if (was) this.pause()
    this._playbackTimeAtStart = Math.max(0, Math.min(timeS, this.duration))
    await this.renderer.startDisplay(this._playbackTimeAtStart)
    this.onTimeUpdate?.(this._playbackTimeAtStart, this.currentFrame)
    if (was) await this.play()
  }

  scrubTo(timeS: number): void {
    if (this._isPlaying) this.pause()
    this._playbackTimeAtStart = Math.max(0, Math.min(timeS, this.duration))
    void this.renderer.startDisplay(this._playbackTimeAtStart)
    this.onTimeUpdate?.(this._playbackTimeAtStart, Math.floor(this._playbackTimeAtStart * this.framerate))
  }

  async stepForward(n = 1):  Promise<void> { await this.seekTo(this.getPlaybackTime() + n / this.framerate) }
  async stepBackward(n = 1): Promise<void> { await this.seekTo(Math.max(0, this.getPlaybackTime() - n / this.framerate)) }

  setVolume(v: number): void { if (this._gainNode) this._gainNode.gain.value = v * v }

  setSpeed(s: number): void {
    if (s === this._speed) return
    const was = this._isPlaying
    if (was) {
      this._playbackTimeAtStart = this.getPlaybackTime()
      this._isPlaying = false
      this.renderer.stopAudio()
      cancelAnimationFrame(this._rafHandle)
    }
    this._speed = s
    if (was) void this.play()
  }

  setPreservePitch(v: boolean): void {
    if (this._preservePitch === v) return
    const was = this._isPlaying
    if (was) {
      this._playbackTimeAtStart = this.getPlaybackTime()
      this._isPlaying = false
      this.renderer.stopAudio()
      cancelAnimationFrame(this._rafHandle)
    }
    this._preservePitch = v
    if (was) void this.play()
  }

  setChannel(ch: readonly number[] | 'mix'): void { this.renderer.setActiveChannel(ch) }

  dispose(): void {
    this.pause()
    this.renderer.dispose()
    void this._audioCtx?.close()
  }

  private async _ensureAudio(): Promise<number> {
    if (!this._audioCtx) {
      this._audioCtx = new AudioContext()
      this._gainNode = this._audioCtx.createGain()
      this._gainNode.connect(this._audioCtx.destination)
    }
    if (this._audioCtx.state === 'suspended') await this._audioCtx.resume()
    return this._audioCtx.currentTime
  }

  private _raf(): void {
    this._rafHandle = requestAnimationFrame(() => {
      if (!this._isPlaying) return
      const pt = this.getPlaybackTime()
      if (pt >= this.duration && this.duration > 0) { this.pause(); return }
      const dirty = this.renderer.tick(pt)
      if (dirty) this.onTimeUpdate?.(pt, Math.floor(pt * this.framerate))
      this._raf()
    })
  }
}
