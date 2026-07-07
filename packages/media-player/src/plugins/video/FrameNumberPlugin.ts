import type { VideoPlugin } from './VideoPlugin.js'
import type { VideoRenderer } from '../../VideoRenderer.ts'

export class FrameNumberPlugin implements VideoPlugin {
  readonly id = 'frame-number'
  private _getVisible: () => boolean

  constructor(getVisible: () => boolean = () => true) {
    this._getVisible = getVisible
  }

  onAttach(_renderer: VideoRenderer): void {}
  onDetach(_renderer: VideoRenderer): void {}

  onFrame(_renderer: VideoRenderer, frameNum: number, tSec: number, ctx: CanvasRenderingContext2D): void {
    if (!this._getVisible()) return
    const m = Math.floor(tSec / 60)
    const s = (tSec % 60).toFixed(3).padStart(6, '0')

    ctx.save()
    ctx.font = 'bold 16px monospace'
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 3
    ctx.strokeText(`#${frameNum}`, 8, 24)
    ctx.fillStyle = '#fff'
    ctx.fillText(`#${frameNum}`, 8, 24)

    ctx.font = '11px monospace'
    ctx.lineWidth = 2
    ctx.strokeText(`${m}:${s}`, 8, 40)
    ctx.fillStyle = '#ddd'
    ctx.fillText(`${m}:${s}`, 8, 40)
    ctx.restore()
  }
}
