import type { VideoRenderer } from '../../VideoRenderer.js'

export interface VideoPlugin {
  id: string
  /** Called once when the renderer is ready (video dimensions known). Use for setup. */
  onAttach(renderer: VideoRenderer): void
  /** Called every rendered frame. Plugins draw overlays directly onto ctx. */
  onFrame(renderer: VideoRenderer, frameNum: number, timestampSec: number, ctx: CanvasRenderingContext2D): void
  onDetach(renderer: VideoRenderer): void
  onPlay?(wallMs: number, localMediaTimeSec: number): void
  onPause?(): void
}
