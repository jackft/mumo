import type { VideoPlugin } from './VideoPlugin.js'
import type { VideoRenderer } from '../../VideoRenderer.ts'
import type { FrameStat } from '../../types.ts'

const HISTORY = 20 // recent frames to smooth overlay display

export class DecodeDebugPlugin implements VideoPlugin {
  readonly id = 'decode-debug'

  private _getVisible: () => boolean
  private _isPlaying = false
  private _starveCount = 0

  // Inter-frame wall time tracking
  private _lastFrameWallMs = 0
  private _recentInterFrameMs: number[] = []
  private _maxInterFrameMs = 0

  private _allStats: FrameStat[] = []
  private static readonly MAX_STATS = 150_000

  constructor(getVisible: () => boolean) {
    this._getVisible = getVisible
  }

  onPlay(_wallMs: number, _localMediaTimeSec: number): void {
    this._isPlaying       = true
    this._lastFrameWallMs = 0
    this._recentInterFrameMs = []
    this._maxInterFrameMs = 0
    this._starveCount     = 0
  }

  onPause(): void {
    this._isPlaying = false
    this._lastFrameWallMs = 0
  }

  onAttach(_renderer: VideoRenderer): void {}
  onDetach(_renderer: VideoRenderer): void {}

  onFrame(renderer: VideoRenderer, frameNum: number, tSec: number, ctx: CanvasRenderingContext2D): void {
    if (!this._isPlaying) return

    const now   = performance.now()
    const depth = renderer.frameQueueDepth

    const interFrameMs = this._lastFrameWallMs > 0 ? now - this._lastFrameWallMs : 0
    this._lastFrameWallMs = now

    if (interFrameMs > 0) {
      this._recentInterFrameMs.push(interFrameMs)
      if (this._recentInterFrameMs.length > HISTORY) this._recentInterFrameMs.shift()
      if (interFrameMs > this._maxInterFrameMs) this._maxInterFrameMs = interFrameMs
    }

    if (depth === 0) this._starveCount++

    if (this._allStats.length < DecodeDebugPlugin.MAX_STATS) {
      this._allStats.push({ frameNum, tSec, interFrameMs, queueDepth: depth })
    }

    if (this._getVisible()) this._draw(renderer, frameNum, tSec, depth, interFrameMs, ctx)
  }

  getStats(): readonly FrameStat[] { return this._allStats }
  clearStats(): void {
    this._allStats           = []
    this._recentInterFrameMs = []
    this._maxInterFrameMs    = 0
    this._starveCount        = 0
  }

  private _draw(renderer: VideoRenderer, frameNum: number, tSec: number, depth: number, interFrameMs: number, ctx: CanvasRenderingContext2D): void {
    const n    = this._recentInterFrameMs.length
    const maxQ = renderer.maxQueueSize

    let lines: string[]
    let lag = false

    if (n < 3) {
      lines = [`#${frameNum}  ${fmtTs(tSec)}`, `queue ${depth}/${maxQ}`, '…warming up']
    } else {
      const avgMs = avg(this._recentInterFrameMs)
      lag = avgMs > 50  // >50ms between frames = below 20fps
      const audio = renderer.getAudioDebugStats()
      lines = [
        `#${frameNum}  ${fmtTs(tSec)}`,
        `queue ${depth}/${maxQ}${depth === 0 ? ' ⚠' : ''}  starve ${this._starveCount}`,
        `frame Δ ${avgMs.toFixed(1)}ms avg  max ${this._maxInterFrameMs.toFixed(0)}ms${lag ? ' ⚠' : ''}`,
        `audio skip ${audio.skipCount}  late ${audio.maxLateMs.toFixed(0)}ms`,
      ]
    }

    const dh    = renderer.displayHeight
    const pad   = 5
    const lineH = 14
    const boxH  = lines.length * lineH + pad * 2
    const boxW  = 230

    ctx.save()
    ctx.font = '11px monospace'
    ctx.fillStyle = lag ? 'rgba(100,0,0,0.7)' : 'rgba(0,0,0,0.65)'
    ctx.beginPath()
    ctx.roundRect(pad, dh - boxH - pad, boxW, boxH, 3)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i]!, pad + 4, dh - boxH - pad + (i + 1) * lineH)
    }
    ctx.restore()
  }
}

function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function fmtTs(s: number): string {
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`
}
