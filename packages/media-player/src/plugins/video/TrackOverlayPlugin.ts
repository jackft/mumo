import * as PIXI from 'pixi.js'
import type { VideoPlugin } from './VideoPlugin.js'
import type { VideoRenderer } from '../../VideoRenderer.js'
import type { TrackSetStore, TrajectoryPoint } from '@mumo/core'
import type { ID } from '@mumo/core'

function _drawMarker(g: PIXI.Graphics, x: number, y: number, r: number, color: number, alpha: number): void {
  g.circle(x, y, r)
    .fill({ color, alpha })
    .stroke({ width: 1.5, color: 0xffffff, alpha })
}

export const TRACK_COLORS = [
  0x26a69a, // teal (accent)
  0xFF6B6B, // red
  0x45B7D1, // blue
  0xFFA07A, // salmon
  0x98D8C8, // mint
  0xF7DC6F, // yellow
  0xBB8FCE, // purple
  0x58D68D, // green
]

const SEL_ALPHA   = 1.0
const UNSEL_ALPHA = 0.35
const HOVER_R2    = 100   // px² hover radius

export interface VizOptions {
  showPath:      boolean
  showPoint:     boolean
  showBbox:      boolean
  showKeypoints: boolean
}

const DEFAULT_VIZ: VizOptions = {
  showPath:      true,
  showPoint:     true,
  showBbox:      true,
  showKeypoints: true,
}

const LABEL_STYLE = new PIXI.TextStyle({
  fontFamily:  'monospace',
  fontSize:    11,
  fontWeight:  '600',
  fill:        0xffffff,
  dropShadow: { blur: 3, distance: 0, color: 0x000000, alpha: 0.85 },
})

interface TrackEntry {
  trackSetId: ID
  trackId:    ID
  frameRate:  number
  colorIdx:   number
  label:      string
  trajectory: TrajectoryPoint[]
}

export class TrackOverlayPlugin implements VideoPlugin {
  readonly id = 'track-overlay'

  private _renderer:    VideoRenderer | null = null
  private _container:  PIXI.Container | null = null
  private _gfxStatic:  PIXI.Graphics  | null = null   // updated with video frames
  private _gfxDynamic: PIXI.Graphics  | null = null   // updated instantly on mouse move

  private _videoRef       = ''
  private _tracks:        TrackEntry[] = []
  private _focusedId:     ID | null = null
  private _hiddenIds      = new Set<ID>()
  private _viz            = { ...DEFAULT_VIZ }
  private _enabled        = true
  private _participantMap = new Map<ID, string>()
  private _labelContainer: PIXI.Container | null = null
  private _labelPool      = new Map<ID, PIXI.Text>()
  private _frameStart  = 0
  private _frameEnd    = Infinity
  private _lastFrame   = 0

  private _hoverPtFrame:    number | null = null
  private _isDragging       = false
  private _isRangeSelecting = false
  private _rangeStart:      number | null = null
  private _rangeEnd:        number | null = null

  onSeekToFrame:  ((frame: number) => void) | null = null
  onScrubToFrame: ((frame: number) => void) | null = null
  onEndScrub:     (() => void) | null = null
  onSelectRange:  ((lo: number, hi: number) => void) | null = null

  private readonly _onMouseDown:  (e: MouseEvent) => void
  private readonly _onMouseMove:  (e: MouseEvent) => void
  private readonly _onMouseLeave: ()              => void
  private readonly _onClick:      (e: MouseEvent) => void

  constructor(private readonly _store: TrackSetStore) {
    this._onMouseDown  = e  => { this._handleMouseDown(e); }
    this._onMouseMove  = e  => { this._handleMouseMove(e); }
    this._onMouseLeave = () => { this._handleMouseLeave(); }
    this._onClick      = e  => { this._handleClick(e); }
  }

  // Public control API

  setVideoRef(videoRef: string): void {
    this._videoRef = videoRef
    this._rebuildTracks()
  }

  setFocusedTrack(_trackSetId: ID | null, trackId: ID | null): void {
    this._focusedId    = trackId
    this._hoverPtFrame = null
    this._rangeStart   = null
    this._rangeEnd     = null
    this._rerender()
  }

  setTimeRange(frameStart: number, frameEnd: number): void {
    this._frameStart = frameStart
    this._frameEnd   = frameEnd
    this._rerender()
  }

  clearTimeRange(): void {
    this._frameStart = 0
    this._frameEnd   = Infinity
    this._rerender()
  }

  setVizOptions(opts: Partial<VizOptions>): void {
    Object.assign(this._viz, opts)
    this._rerender()
  }

  get vizOptions(): Readonly<VizOptions> { return this._viz }

  setTrackVisible(trackId: ID, visible: boolean): void {
    if (visible) this._hiddenIds.delete(trackId)
    else this._hiddenIds.add(trackId)
    this._rerender()
  }

  get hiddenTrackIds(): ReadonlySet<ID> { return this._hiddenIds }

  setEnabled(enabled: boolean): void { this._enabled = enabled; this._rerender() }
  get enabled(): boolean { return this._enabled }

  setParticipantMap(map: Map<ID, string>): void {
    this._participantMap = map
    this._rebuildTracks()
  }

  /** Returns current track entries (trackSetId, trackId, colorIdx) for UI display. */
  getTrackEntries(): readonly { trackSetId: ID; trackId: ID; colorIdx: number }[] {
    return this._tracks.map(({ trackSetId, trackId, colorIdx }) => ({ trackSetId, trackId, colorIdx }))
  }

  /** Call after new track sets are imported so trajectory data is reloaded. */
  refreshTracks(): void { this._rebuildTracks() }

  private _rebuildTracks(): void {
    const sets = this._store.allTrackSets().filter(ts => ts.videoRef === this._videoRef)

    // Destroy labels for tracks that no longer exist
    const newIds = new Set(sets.flatMap(ts => ts.tracks.map(t => t.id)))
    for (const [id, txt] of this._labelPool) {
      if (!newIds.has(id)) { txt.destroy(); this._labelPool.delete(id) }
    }

    this._tracks = []
    let colorIdx = 0
    for (const ts of sets) {
      for (const track of ts.tracks) {
        const participant = this._participantMap.get(track.id)
        const name = track.name || track.id.slice(0, 8)
        const label = participant ? `${participant} · ${name}` : name

        this._tracks.push({
          trackSetId: ts.id,
          trackId:    track.id,
          frameRate:  ts.frameRate,
          colorIdx:   colorIdx++,
          label,
          trajectory: this._store.trajectory(ts.id, track.id),
        })

        // Ensure a PIXI.Text exists for this track
        if (!this._labelPool.has(track.id)) {
          const txt = new PIXI.Text({ text: label, style: LABEL_STYLE })
          txt.visible = false
          this._labelPool.set(track.id, txt)
          this._labelContainer?.addChild(txt)
        } else {
          this._labelPool.get(track.id)!.text = label
        }
      }
    }
  }

  // VideoPlugin lifecycle

  onAttach(renderer: VideoRenderer): void {
    this._renderer      = renderer
    this._container     = new PIXI.Container()
    this._gfxStatic     = new PIXI.Graphics()
    this._gfxDynamic    = new PIXI.Graphics()
    this._labelContainer = new PIXI.Container()
    this._container.addChild(this._gfxStatic)
    this._container.addChild(this._gfxDynamic)
    this._container.addChild(this._labelContainer)
    renderer.stage.addChild(this._container)

    // Adopt any already-built label texts into the new container
    for (const txt of this._labelPool.values()) this._labelContainer.addChild(txt)

    const c = renderer.canvas
    c.addEventListener('mousedown',  this._onMouseDown)
    c.addEventListener('mousemove',  this._onMouseMove)
    c.addEventListener('mouseleave', this._onMouseLeave)
    c.addEventListener('click',      this._onClick)
  }

  onDetach(renderer: VideoRenderer): void {
    const c = renderer.canvas
    c.removeEventListener('mousedown',  this._onMouseDown)
    c.removeEventListener('mousemove',  this._onMouseMove)
    c.removeEventListener('mouseleave', this._onMouseLeave)
    c.removeEventListener('click',      this._onClick)
    c.style.cursor = ''

    if (this._container) {
      renderer.stage.removeChild(this._container)
      this._container.destroy({ children: true })
      this._container      = null
      this._gfxStatic      = null
      this._gfxDynamic     = null
      this._labelContainer = null
      this._labelPool.clear()  // texts destroyed with container
    }
    this._renderer = null
  }

  private _rerender(): void {
    if (!this._renderer) return
    this.onFrame(this._renderer, this._lastFrame, 0, null as unknown as CanvasRenderingContext2D)
    this._renderer.requestRender()
  }

  onFrame(renderer: VideoRenderer, frameNum: number, _ts: number, _ctx: CanvasRenderingContext2D): void {
    this._lastFrame = frameNum
    const g = this._gfxStatic
    if (!g) return
    g.clear()

    for (const txt of this._labelPool.values()) txt.visible = false
    if (!this._enabled) return

    const W = renderer.displayWidth
    const H = renderer.displayHeight
    if (!W || !H) return

    const hasFocus = this._focusedId !== null

    for (const entry of this._tracks) {
      if (this._hiddenIds.has(entry.trackId)) continue
      const focused = entry.trackId === this._focusedId
      const alpha   = hasFocus && !focused ? UNSEL_ALPHA : SEL_ALPHA
      const color   = TRACK_COLORS[entry.colorIdx % TRACK_COLORS.length]!
      this._drawEntry(g, entry, frameNum, W, H, color, alpha, focused)
    }
  }

  // Drawing helpers

  private _drawEntry(
    g: PIXI.Graphics, entry: TrackEntry,
    frameNum: number, W: number, H: number,
    color: number, alpha: number, focused: boolean,
  ): void {
    this._drawTrajectory(g, entry, frameNum, W, H, color, alpha, focused)

    const det = this._store.getDetectionAt(entry.trackSetId, entry.trackId, frameNum)
    if (!det) return

    const lw = focused ? 2.5 : 1.5

    // Label anchor point (top-left corner of bounding box, or above the point)
    let labelX = 0, labelY = 0

    if (det.type === 'bbox') {
      if (this._viz.showBbox) {
        g.rect(
          (det.cx - det.w / 2) * W, (det.cy - det.h / 2) * H,
          det.w * W, det.h * H,
        ).stroke({ width: lw, color, alpha })
      }
      if (this._viz.showPoint) {
        _drawMarker(g, det.cx * W, det.cy * H, focused ? 4 : 3, color, alpha)
      }
      labelX = (det.cx - det.w / 2) * W
      labelY = (det.cy - det.h / 2) * H - 14
    } else if (det.type === 'point') {
      if (this._viz.showPoint) {
        _drawMarker(g, det.x * W, det.y * H, focused ? 4 : 3, color, alpha)
      }
      labelX = det.x * W + 6
      labelY = det.y * H - 14
    } else {
      if (this._viz.showKeypoints) {
        const kpTrack = this._store.getTrack(entry.trackSetId, entry.trackId)
        const schema  = kpTrack?.keypointSchema
        const kpMap   = new Map(det.keypoints.map(kp => [kp.id, kp]))
        if (schema) {
          for (const [a, b] of schema.edges) {
            const ka = kpMap.get(a), kb = kpMap.get(b)
            if (!ka || !kb || ka.conf < 0.3 || kb.conf < 0.3) continue
            g.moveTo(ka.x * W, ka.y * H)
            g.lineTo(kb.x * W, kb.y * H)
          }
          g.stroke({ width: lw, color, alpha })
        }
        // Label above the topmost confident keypoint
        let topY = Infinity, topX = 0
        for (const kp of det.keypoints) {
          if (kp.conf < 0.3) continue
          _drawMarker(g, kp.x * W, kp.y * H, 2.5, color, alpha)
          if (kp.y * H < topY) { topY = kp.y * H; topX = kp.x * W }
        }
        labelX = topX + 6; labelY = topY - 14
      }
    }

    const txt = this._labelPool.get(entry.trackId)
    if (txt && entry.label) {
      txt.alpha   = alpha
      txt.x       = Math.max(2, Math.min(labelX, W - txt.width - 2))
      txt.y       = Math.max(2, labelY)
      txt.visible = true
    }
  }

  private _drawTrajectory(
    g: PIXI.Graphics, entry: TrackEntry,
    _frameNum: number, W: number, H: number,
    color: number, alpha: number, focused: boolean,
  ): void {
    if (!this._viz.showPath) return
    const pts = entry.trajectory.filter(p => p.frame >= this._frameStart && p.frame <= this._frameEnd)
    if (pts.length < 2) return

    const lo = focused && this._rangeStart !== null && this._rangeEnd !== null
      ? Math.min(this._rangeStart, this._rangeEnd) : null
    const hi = focused && this._rangeStart !== null && this._rangeEnd !== null
      ? Math.max(this._rangeStart, this._rangeEnd) : null

    // Faint full trajectory path
    g.moveTo(pts[0]!.x * W, pts[0]!.y * H)
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x * W, pts[i]!.y * H)
    g.stroke({ width: 2.5, color, alpha: alpha * 0.5 })

    if (!focused) return

    // Range highlight
    if (lo !== null && hi !== null) {
      const rpts = pts.filter(p => p.frame >= lo && p.frame <= hi)
      if (rpts.length >= 2) {
        g.moveTo(rpts[0]!.x * W, rpts[0]!.y * H)
        for (let i = 1; i < rpts.length; i++) g.lineTo(rpts[i]!.x * W, rpts[i]!.y * H)
        g.stroke({ width: 3, color: 0xf0b429 })
      }
    }
  }

  // Dynamic overlay (hover indicator — updates instantly, independent of video)

  private _updateDynamicOverlay(): void {
    const g = this._gfxDynamic
    const r = this._renderer
    if (!g || !r) return
    g.clear()

    const entry = this._focusedEntry()
    if (!entry || this._hoverPtFrame === null) {
      r.requestRender()
      return
    }

    const W = r.displayWidth
    const H = r.displayHeight
    if (!W || !H) { r.requestRender(); return }

    const color = TRACK_COLORS[entry.colorIdx % TRACK_COLORS.length]!
    const pts = entry.trajectory.filter(p => p.frame >= this._frameStart && p.frame <= this._frameEnd)
    const pt  = pts.find(p => p.frame === this._hoverPtFrame)
    if (pt) _drawMarker(g, pt.x * W, pt.y * H, 5, color, 1.0)

    r.requestRender()
  }

  // Mouse helpers

  private _focusedEntry(): TrackEntry | undefined {
    return this._tracks.find(t => t.trackId === this._focusedId)
  }

  private _cssCoords(e: MouseEvent): [number, number] {
    const r    = this._renderer!.canvas.getBoundingClientRect()
    const zoom = this._renderer!.zoom
    const panX = this._renderer!.panX
    const panY = this._renderer!.panY
    return [(e.clientX - r.left - panX) / zoom, (e.clientY - r.top - panY) / zoom]
  }

  private _nearestTrajPt(mx: number, my: number, maxDist2 = Infinity): number | null {
    const entry = this._focusedEntry()
    if (!entry) return null
    const W = this._renderer?.displayWidth ?? 1
    const H = this._renderer?.displayHeight ?? 1
    let best = maxDist2, frame: number | null = null
    const pts = entry.trajectory.filter(p => p.frame >= this._frameStart && p.frame <= this._frameEnd)

    for (let i = 0; i < pts.length; i++) {
      const p  = pts[i]!
      const px = p.x * W, py = p.y * H

      if (i === 0) {
        const d2 = (mx - px) ** 2 + (my - py) ** 2
        if (d2 < best) { best = d2; frame = p.frame }
        continue
      }

      const prev = pts[i - 1]!
      const ax = prev.x * W, ay = prev.y * H
      const segDx = px - ax, segDy = py - ay
      const lenSq = segDx * segDx + segDy * segDy

      // Project cursor onto segment, clamp to [0,1]
      const t = lenSq > 0
        ? Math.max(0, Math.min(1, ((mx - ax) * segDx + (my - ay) * segDy) / lenSq))
        : 0
      const cx = ax + t * segDx, cy = ay + t * segDy
      const d2 = (mx - cx) ** 2 + (my - cy) ** 2

      if (d2 < best) {
        best  = d2
        frame = Math.round(prev.frame + t * (p.frame - prev.frame))
      }
    }

    return frame
  }

  // Mouse handlers

  private _handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || e.ctrlKey || !this._renderer || !this._focusedId) return
    const [mx, my] = this._cssCoords(e)
    const frame = this._nearestTrajPt(mx, my, HOVER_R2)
    if (frame === null) return
    e.preventDefault()
    if (e.shiftKey) {
      this._rangeStart = frame; this._rangeEnd = frame
      this._hoverPtFrame = frame
      this._isRangeSelecting = true
      this._renderer.canvas.style.cursor = 'crosshair'
      this._updateDynamicOverlay()
    } else {
      this._isDragging = true
      this._renderer.canvas.style.cursor = 'grabbing'
    }
    const onUp = () => {
      const wasDragging = this._isDragging
      this._isRangeSelecting = false
      this._isDragging = false
      if (this._renderer) this._renderer.canvas.style.cursor = 'crosshair'
      if (wasDragging) this.onEndScrub?.()
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mouseup', onUp)
  }

  private _handleMouseMove(e: MouseEvent): void {
    if (!this._renderer || !this._focusedId || this._renderer.isPanning) return
    const [mx, my] = this._cssCoords(e)

    if (this._isRangeSelecting) {
      const frame = this._nearestTrajPt(mx, my)
      if (frame !== null) {
        this._rangeEnd = frame; this._hoverPtFrame = frame
        const lo = Math.min(this._rangeStart!, frame)
        const hi = Math.max(this._rangeStart!, frame)
        this.onSelectRange?.(lo, hi)
        this._updateDynamicOverlay()
      }
      return
    }

    if (this._isDragging) {
      const frame = this._nearestTrajPt(mx, my)
      if (frame !== null && frame !== this._hoverPtFrame) {
        this._hoverPtFrame = frame
        this._updateDynamicOverlay()
        this.onScrubToFrame?.(frame)
      }
      return
    }

    const newHover = this._nearestTrajPt(mx, my, HOVER_R2)
    const cursor   = newHover !== null ? 'pointer' : 'crosshair'
    if (this._renderer.canvas.style.cursor !== cursor) this._renderer.canvas.style.cursor = cursor
    if (newHover !== this._hoverPtFrame) {
      this._hoverPtFrame = newHover
      this._updateDynamicOverlay()
    }
  }

  private _handleMouseLeave(): void {
    if (this._isDragging || this._isRangeSelecting) return
    if (this._renderer) this._renderer.canvas.style.cursor = ''
    if (this._hoverPtFrame !== null) {
      this._hoverPtFrame = null
      this._updateDynamicOverlay()
    }
  }

  private _handleClick(e: MouseEvent): void {
    if (this._isDragging || this._isRangeSelecting || !this._focusedId) return
    const [mx, my] = this._cssCoords(e)
    const frame = this._nearestTrajPt(mx, my, HOVER_R2)
    if (frame !== null) this.onSeekToFrame?.(frame)
  }
}
