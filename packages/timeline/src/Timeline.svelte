<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import * as PIXI from 'pixi.js'
  // CSP-safe shader codegen (no new Function()) — required under the electron renderer CSP
  import 'pixi.js/unsafe-eval'
  import { TimeIntervalTree, TimeKeeper } from '@mumo/core'
  import type { Lane, BarItem, CommitEntry, SignalChannel, SpectrogramTile, TickMark, ArcItem, MotionCurve } from './types.js'
  import { SPEC_DB_FLOOR, SPEC_DB_RANGE } from './types.js'
  import type { SnapPlugin, SnapCtx, SnapMode } from './plugin.js'
  import { defaultSnapPlugins } from './snapPlugins.js'
  import { LinearScale } from './scales.js'
  import { pickTickInterval, pickSubInterval, formatRulerTime, pickHzInterval, formatHz } from './ruler.js'
  import { palette } from './palette.js'

  // Props

  interface Props {
    timeKeeper?: TimeKeeper
    isPlaying?: boolean
    onSeek?: (t: number) => void
    onSelectBar?: (nodeId: string | null) => void
    onCommitBars?: (updates: CommitEntry[]) => void
    onNudgeEdge?: (barId: string, side: 'left' | 'right', direction: 1 | -1) => void
    onBarContextMenu?: (barId: string, timeAtClick: number, clientX: number, clientY: number) => void
    onBarCtrlClick?: (barId: string, timeAtClick: number) => void
    onSelection?: (start: number, end: number, laneId: string | null) => void
    onSelectionChange?: (sel: { start: number; end: number } | null) => void
    onLaneClick?: (laneId: string) => void
    onLaneContextMenu?: (laneId: string, clientX: number, clientY: number) => void
    onBarDblClick?: (barId: string, clientX: number, clientY: number) => void
    onBarSuggestionHover?: (suggestionId: string | null, clientX: number, clientY: number) => void
    onSelectionActive?: (active: boolean) => void
    showLanePanel?: boolean
    lanePanelWidth?: number
    onRenameLane?: (laneId: string, newLabel: string) => void
    contentHeight?: number
    onContentHeight?: (h: number) => void
    mediaContent?: Snippet
    onFps?: (fps: number) => void
    onViewChange?: (pxPerSec: number) => void
    onHzChange?: (hz: number | null) => void
    snapPlugins?: SnapPlugin[]
  }

  let {
    timeKeeper,
    isPlaying = false,
    onSeek,
    onSelectBar,
    onCommitBars,
    onNudgeEdge,
    onBarContextMenu,
    onBarCtrlClick,
    onSelection,
    onSelectionChange,
    onLaneClick,
    onLaneContextMenu,
    onBarDblClick,
    onBarSuggestionHover,
    onSelectionActive,
    showLanePanel = true,
    lanePanelWidth = 160,
    onRenameLane,
    contentHeight = $bindable(80),
    onContentHeight,
    mediaContent,
    onFps,
    onViewChange,
    onHzChange,
    snapPlugins = defaultSnapPlugins,
  }: Props = $props()

  // DOM + PIXI

  let wrapEl: HTMLDivElement
  let app: PIXI.Application
  let canvasEl: HTMLCanvasElement
  let rulerGfx: PIXI.Graphics
  let laneGfx: PIXI.Graphics
  let barContainer: PIXI.Container
  let barBorderGfx: PIXI.Graphics
  let arcGfx: PIXI.Graphics
  let playheadGfx: PIXI.Graphics
  let selectionGfx: PIXI.Graphics
  let loopGfx: PIXI.Graphics
  let cursorGfx: PIXI.Graphics
  let peerGfx: PIXI.Graphics
  let signalGfx: PIXI.Graphics
  let tickGfx:   PIXI.Graphics
  let motionGfx: PIXI.Graphics
  let signalContainer: PIXI.Container
  let hzGfx: PIXI.Graphics
  let hzLabelContainer: PIXI.Container
  let tierLabelContainer: PIXI.Container
  let summaryGfx: PIXI.Graphics
  let summaryViewportGfx: PIXI.Graphics
  let summaryPlayheadGfx: PIXI.Graphics
  let labelContainer: PIXI.Container
  let rulerLabelContainer: PIXI.Container
  let summaryLabelContainer: PIXI.Container

  // FPS tracking
  let _fpsLastTime = 0
  let _fpsFrameCount = 0

  // Per-bar sprite objects — one entry per bar, updated in place
  interface BarObj { fill: PIXI.Sprite; label: PIXI.Text | null; bar: BarItem }
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const barObjs    = new Map<string, BarObj>()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const barChildren = new Map<string, string[]>()   // parentNodeId → [child bar ids]
  const barTree    = new TimeIntervalTree<string>()  // bar.start/end (seconds) → bar.id
  const _freeLabelPool:     PIXI.Text[] = []
  const _freeWordLabelPool: PIXI.Text[] = []
  let   _whiteTex: PIXI.Texture
  const   _prevSelectedId: string | null = null
  let   _arcs: ArcItem[] = []

  const _rulerPool: PIXI.Text[] = []
  let   _rulerIdx   = 0
  const _sumPool:   PIXI.Text[] = []
  let   _sumIdx     = 0
  const _hzPool:    PIXI.Text[] = []
  let   _hzIdx      = 0
  const _tierPool:  PIXI.Text[] = []
  let   _tierIdx    = 0

  // URL-loaded textures (imageUrl fallback)
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const loadedTextures = new Map<string, PIXI.Texture>()

  // Spectrogram tile storage (fed via addSpectrogramTile / setSpectrogramOverview)
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const _spectrogramTiles     = new Map<string, SpectrogramTile[]>()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const _spectrogramOverviews = new Map<string, SpectrogramTile>()

  // GPU texture caches keyed by tile object identity.
  // Entries carry the RGBA buffer (must stay alive while PIXI texture exists)
  // and the lutKey used to build them; stale entries are evicted on LUT change.
  interface TexEntry { tex: PIXI.Texture; rgba?: Uint8ClampedArray; lutKey: string }
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const _tileTexCache     = new Map<SpectrogramTile, TexEntry>()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const _overviewTexCache = new Map<SpectrogramTile, TexEntry>()

  // Per-channel adaptive LUT state
  interface ChannelLut { lut: Uint32Array; key: string }
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const _channelLuts = new Map<string, ChannelLut>()

  // Inverted greyscale: quiet → white (255), loud → black (0)
  // gamma > 1 suppresses noise; lower values preserve weak signals like F1
  function _buildLut(dbFloor: number, dbRange: number, gamma: number): Uint32Array {
    const lut = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      const dB = i / 255 * SPEC_DB_RANGE + SPEC_DB_FLOOR
      const t  = Math.max(0, Math.min(1, (dB - dbFloor) / dbRange))
      const v  = 255 - Math.round(255 * Math.pow(t, gamma))
      lut[i] = (255 << 24) | (v << 16) | (v << 8) | v  // little-endian RGBA
    }
    return lut
  }
  function _rawDbToRgba(tile: SpectrogramTile, lut: Uint32Array): Uint8ClampedArray {
    const raw = tile.rawDb!
    const rgba = new Uint8ClampedArray(raw.length * 4)
    const u32  = new Uint32Array(rgba.buffer)
    for (let i = 0; i < raw.length; i++) u32[i] = lut[raw[i]!]!
    return rgba
  }
  // Returns [p2, p99] quantised rawDb values from visible tiles in one histogram pass.
  function _viewportRange(
    tiles: SpectrogramTile[] | undefined, overview: SpectrogramTile | undefined,
    useDetail: boolean, viewStart: number, viewEnd: number, tOffset: number,
  ): [number, number] {
    const hist = new Uint32Array(256)
    let total = 0
    if (useDetail && tiles) {
      for (const tile of tiles) {
        if (!tile.rawDb || tile.timeEnd + tOffset <= viewStart || tile.timeStart + tOffset >= viewEnd) continue
        const raw = tile.rawDb
        for (let i = 0; i < raw.length; i++) { const v = raw[i]!; hist[v] = (hist[v]! + 1) }
        total += raw.length
      }
    } else if (overview?.rawDb) {
      const ov = overview, raw = ov.rawDb!, w = ov.width, h = ov.height
      const t0 = ov.timeStart + tOffset, span = ov.timeEnd - ov.timeStart
      const c0 = Math.max(0, Math.floor((viewStart - t0) / span * w))
      const c1 = Math.min(w,  Math.ceil ((viewEnd   - t0) / span * w))
      for (let col = c0; col < c1; col++)
        for (let row = 0; row < h; row++) { const v = raw[row * w + col]!; hist[v] = (hist[v]! + 1); total++ }
    }
    if (total === 0) return [50, 200]
    const loThresh = Math.ceil(total * 0.10)
    const hiThresh = Math.ceil(total * 0.99)
    let cum = 0, lo = 0, hi = 255
    for (let v = 0; v <= 255; v++) {
      cum += hist[v]!
      if (cum >= loThresh && lo === 0) lo = v
      if (cum >= hiThresh) { hi = v; break }
    }
    return [lo, hi]
  }

  // No hard cap — render all visible detail tiles.
  const MAX_VISIBLE_TILES = Infinity

  // Internal data state (driven imperatively via exported methods)

  let _bars: BarItem[] = []
  let _barsInitialized = false                  // true after initialRenderBars; gates resetBars sprite sync
  let _lanes      = $state<Lane[]>([])          // $state: drives HTML lane panel
  let _signals    = $state<SignalChannel[]>([])  // $state: drives HTML signal rows
  let _selectedId: string | null = null
  let _peerBarSelections: { nodeId: string; color: string }[] = []
  let _showWords  = $state(true)                 // $state: drives HTML panel row filter
  let _snapEnabled          = false
  let _snapMode: SnapMode   = 'all'
  let _snapChannelId: string | null = null
  let _annotationSnapMode: 'all' | 'same-lane' | 'none' = 'all'
  let _mouseFreqFraction: number | null = null
  let _specBandCache: Array<{ y: number; bottom: number; ch: SignalChannel }> = []
  let _waveformBandCache: Array<{ y: number; bottom: number }> = []
  let _vadSegments: Array<{ start: number; end: number }> = []
  let _loopRegion: { start: number; end: number } | null = null
  let _mediaDuration: number | undefined
  let _ticks: TickMark[] = []
  let _motionCurves: MotionCurve[] = []

  interface _MotionStats { dxAbs: number; dyAbs: number; velMax: number }
  const _motionStats = new WeakMap<MotionCurve, _MotionStats>()

  // Per-pair height overrides keyed by channel group (e.g. "ch0", "ch1")
  let pairHeights = $state<Record<string, number>>({})

  // IDs are now "playerId:kind:chN"; group by "playerId:kind" so waveform
  // and spectrogram resize independently while channels of the same kind share a handle.
  function chGroup(id: string): string {
    const parts = id.split(':')
    return parts.length >= 3 ? `${parts[0]}:${parts[1]}` : (parts[0] ?? id)
  }

  function sigH(ch: SignalChannel): number { return pairHeights[chGroup(ch.id)] ?? ch.height ?? SIGNAL_H }

  function signalGroups(): { key: string; channels: SignalChannel[] }[] {
    const map = new SvelteMap<string, SignalChannel[]>()
    for (const ch of audioChannels()) {  // audioChannels() reads _signals
      const k = chGroup(ch.id)
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(ch)
    }
    return [...map.entries()].map(([key, channels]) => ({ key, channels }))
  }


  // Snap helper

  function snapZone(): string {
    for (const band of _specBandCache) {
      if (curMouseY >= band.y && curMouseY < band.bottom) return 'spectrogram'
    }
    for (const band of _waveformBandCache) {
      if (curMouseY >= band.y && curMouseY < band.bottom) return 'waveform'
    }
    return 'vad'
  }

  function snapTime(t: number, radiusSec: number): number {
    if (!_snapEnabled || radiusSec <= 0) return t
    const zone = snapZone()

    // Resolve bars available for boundary snapping.
    // Always exclude the bar being dragged — snapping it to its own boundaries
    // would prevent it from moving away from its current position.
    const d = drag
    const dragNodeId = (d.kind === 'moveBar' || d.kind === 'resizeLeft' || d.kind === 'resizeRight') ? d.nodeId : null

    let barsForSnap: BarItem[]
    if (_annotationSnapMode === 'none') {
      barsForSnap = []
    } else if (_annotationSnapMode === 'same-lane') {
      const dragLaneId = dragNodeId ? (_bars.find(b => b.nodeId === dragNodeId)?.laneId ?? null) : null
      barsForSnap = dragLaneId ? _bars.filter(b => b.laneId === dragLaneId) : _bars
    } else {
      barsForSnap = _bars
    }
    if (dragNodeId) barsForSnap = barsForSnap.filter(b => b.nodeId !== dragNodeId)

    if (_snapChannelId) {
      // Channel-specific snap: bar boundaries + onsets for the target channel only.
      const targetSignals = _signals.filter(s => s.id === _snapChannelId)
      const ctxZone = (targetSignals[0]?.kind === 'spectrogram') ? 'spectrogram' : 'waveform'
      const ctx: SnapCtx = { zone: ctxZone, signals: targetSignals, vadSegments: _vadSegments, mouseFreqFraction: _mouseFreqFraction, bars: barsForSnap }
      for (const plugin of snapPlugins) {
        if (plugin.kind === 'vad') continue
        if (plugin.zones && !plugin.zones.includes(ctxZone)) continue
        const snapped = plugin.snap(t, radiusSec, ctx)
        if (snapped !== null) return snapped
      }
      return t
    }

    // In a specific mode, override zone so onset plugin uses the right channel type.
    const ctxZone = _snapMode === 'all' ? zone : _snapMode
    const ctx: SnapCtx = { zone: ctxZone, signals: _signals, vadSegments: _vadSegments, mouseFreqFraction: _mouseFreqFraction, bars: barsForSnap }
    for (const plugin of snapPlugins) {
      // Mode filtering: vad mode skips onset plugins; non-vad modes rely on zones check to exclude vad plugin.
      if (_snapMode === 'vad' && plugin.kind === 'onset') continue
      if (plugin.zones && !plugin.zones.includes(ctxZone)) continue
      const snapped = plugin.snap(t, radiusSec, ctx)
      if (snapped !== null) return snapped
    }
    return t
  }

  // View state

  let viewStart = 0
  let viewEnd = 30

  // Local playhead — driven by TimeKeeper.onSeek callbacks
  let localPlayhead = 0
  let _hoverCursorT: number | null = null
  let _hoveredSugBarId: string | null = null
  let _unsubTimeKeeper: (() => void) | undefined
  let mouseIsOver = false
  let selection: { start: number; end: number } | null = null
  let selectionLaneId: string | null = null

  // Drag state

  type DragState =
    | { kind: 'none' }
    | { kind: 'seek' }
    | { kind: 'summarySeek' }
    | { kind: 'selection'; startTime: number; laneId: string | null }
    | { kind: 'moveBar';    nodeId: string; origStart: number; origEnd: number; startX: number; minStart: number; maxEnd: number; grabOffset: number }
    | { kind: 'resizeLeft'; nodeId: string; origStart: number; origEnd: number; startX: number; minStart: number; maxStart?: number; siblingId?: string; siblingOrigEnd?: number }
    | { kind: 'resizeRight'; nodeId: string; origStart: number; origEnd: number; startX: number; maxEnd: number; minEnd?: number; siblingId?: string; siblingOrigStart?: number }
    | { kind: 'summaryDrag'; startViewStart: number; startViewEnd: number; startX: number }

  let drag: DragState = { kind: 'none' }
  // Pending edge drag: set on pointerdown on an edge; committed to drag on move > threshold,
  // or becomes an edge selection on short click (pointer up without movement).
  let _pendingEdge: (Extract<DragState, {kind: 'resizeLeft'|'resizeRight'}> & { startX: number }) | null = null
  let _selectedEdge: { barId: string; side: 'left' | 'right' } | null = null
  let mouseDownX = 0
  let curMouseX = 0
  let curMouseY = 0
  let lastUp: { time: number; barId: string } | null = null

  // Layout constants

  const RULER_H         = 18
  const SUMMARY_RULER_H = 14
  const UTT_H           = 24
  const EVT_H           = 18
  const WORD_H          = EVT_H
  const LANE_GAP        = 0
  const BAR_INSET       = 2
  const WORD_INSET      = 1
  const EDGE_ZONE       = 6
  const SIGNAL_H        = 50   // default signal channel height
  const SUMMARY_H       = 22   // overview strip (bars + viewport indicator)
  const PAIR_HANDLE_H   = 3    // px height of the per-group resize handle
  const INDENT_PX       = 10   // px per indent level in lane panel
  const TIER_STRIP_H    = 20   // height per TextGrid tier overlay strip

  const ANN_BAR_COLOR = palette.annotation

  const styleRuler = new PIXI.TextStyle({ fontSize: 9,  fill: '#444', fontFamily: 'system-ui, sans-serif' })
  const styleBar   = new PIXI.TextStyle({ fontSize: 10, fill: '#000', fontFamily: 'system-ui, sans-serif' })
  const styleWord  = new PIXI.TextStyle({ fontSize: 8,  fill: '#000', fontFamily: 'system-ui, sans-serif' })
  const styleHz    = new PIXI.TextStyle({ fontSize: 8,  fill: '#888', fontFamily: 'system-ui, sans-serif' })
  const styleTier  = new PIXI.TextStyle({ fontSize: 9,  fill: '#333', fontFamily: 'system-ui, sans-serif' })
  const styleTierName = new PIXI.TextStyle({ fontSize: 8, fill: '#999', fontFamily: 'system-ui, sans-serif', fontStyle: 'italic' })

  // Layout helpers

  interface LaneLayout { y: number; height: number; color?: number }
  interface SignalLayout { id: string; y: number; height: number; specH: number }

  // Zone helpers
  // Layout (top → bottom):
  //   [SUMMARY_H]    overview / navigation strip
  //   [audioZone]    waveform + spectrogram channels  (kind !== 'series')
  //   [RULER_H]      time ruler
  //   [laneZone]     utterance / word / tier lanes
  //   [seriesZone]   quantitative series channels     (kind === 'series')

  // Lane order (stable, manually reorderable)

  // svelte-ignore state_referenced_locally
  let panelWidth      = $state(lanePanelWidth)
  let internalLaneOrder = $state<string[]>([])
  let panelDragId     = $state<string | null>(null)
  let panelDropId     = $state<string | null>(null)
  let panelDropAfter  = $state(false)

  function orderedLanes(): Lane[] {
    const laneMap = new Map(_lanes.map(l => [l.id, l]))
    return internalLaneOrder.map(id => laneMap.get(id)).filter(Boolean) as Lane[]
  }

  function visibleLanes(): Lane[] {
    const ol = orderedLanes()
    return _showWords ? ol : ol.filter(l => l.type !== 'token')
  }

  function getLaneBlock(laneId: string): string[] {
    const order = internalLaneOrder
    const idx = order.indexOf(laneId)
    if (idx === -1) return []
    const lane = _lanes.find(l => l.id === laneId)
    if (!lane) return [laneId]
    const myIndent = laneIndentLevel(lane)
    const block = [laneId]
    for (let i = idx + 1; i < order.length; i++) {
      const oid = order[i]!
      const l = _lanes.find(x => x.id === oid)
      if (!l || laneIndentLevel(l) <= myIndent) break
      block.push(oid)
    }
    return block
  }

  function getGroupRootId(laneId: string): string | null {
    const order = internalLaneOrder
    const idx = order.indexOf(laneId)
    for (let i = idx; i >= 0; i--) {
      const oid = order[i]
      const l = _lanes.find(x => x.id === oid)
      if (l && laneIndentLevel(l) === 0) return oid ?? null
    }
    return null
  }

  function isValidPanelDrop(dragId: string, targetId: string): boolean {
    if (dragId === targetId) return false
    if (getLaneBlock(dragId).includes(targetId)) return false
    const dragLane   = _lanes.find(l => l.id === dragId)
    const targetLane = _lanes.find(l => l.id === targetId)
    if (!dragLane || !targetLane) return false
    const dragIndent = laneIndentLevel(dragLane)
    if (dragIndent === 0) {
      // Top-level lanes can only be reordered against other top-level lanes
      return laneIndentLevel(targetLane) === 0
    }
    return getGroupRootId(dragId) === getGroupRootId(targetId)
  }

  function performPanelReorder(dragId: string, targetId: string, after: boolean) {
    const order = [...internalLaneOrder]
    const block = getLaneBlock(dragId)
    const dragIdx = order.indexOf(dragId)
    order.splice(dragIdx, block.length)

    const targetIdx = order.indexOf(targetId)
    let insertIdx: number
    if (after) {
      const targetLane = _lanes.find(l => l.id === targetId)
      if (targetLane && laneIndentLevel(targetLane) === 0) {
        // Insert after the entire target group, not just the target row
        let end = targetIdx + 1
        while (end < order.length) {
          const l = _lanes.find(x => x.id === order[end])
          if (!l || laneIndentLevel(l) === 0) break
          end++
        }
        insertIdx = end
      } else {
        insertIdx = targetIdx + 1
      }
    } else {
      insertIdx = targetIdx
    }

    order.splice(insertIdx, 0, ...block)
    internalLaneOrder = order
    if (app) { renderLaneBackground(); repositionBarObjs() }
  }

  function startPanelResize(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = panelWidth
    function onMove(ev: PointerEvent) { panelWidth = Math.max(60, Math.min(400, startW + ev.clientX - startX)) }
    function onUp() { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp) }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }

  function handlePanelDragStart(e: DragEvent, laneId: string) {
    panelDragId = laneId
    e.dataTransfer!.effectAllowed = 'move'
    e.dataTransfer!.setData('text/plain', laneId)
  }

  function handlePanelDragOver(e: DragEvent, laneId: string) {
    if (!panelDragId || !isValidPanelDrop(panelDragId, laneId)) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    panelDropId    = laneId
    panelDropAfter = e.clientY > rect.top + rect.height / 2
  }

  function handlePanelDrop(e: DragEvent, _laneId: string) {
    e.preventDefault()
    if (panelDragId && panelDropId && isValidPanelDrop(panelDragId, panelDropId)) {
      performPanelReorder(panelDragId, panelDropId, panelDropAfter)
    }
    panelDragId = null
    panelDropId = null
  }

  function handlePanelDragEnd() {
    panelDragId = null
    panelDropId = null
  }

  function audioChannels():  SignalChannel[] { return _signals.filter(ch => ch.kind !== 'series') }
  function seriesChannels(): SignalChannel[] { return _signals.filter(ch => ch.kind === 'series') }



  function countGroups(chs: SignalChannel[]): number {
    return new Set(chs.map(ch => chGroup(ch.id))).size
  }

  function overlayH(ch: SignalChannel): number {
    return (ch.overlayTiers?.length ?? 0) * TIER_STRIP_H
  }

  function zoneH(chs: SignalChannel[]): number {
    return chs.reduce((h, ch) => h + sigH(ch) + overlayH(ch) + LANE_GAP, 0) + countGroups(chs) * PAIR_HANDLE_H
  }

  function laneZoneHeight(): number {
    return visibleLanes().reduce(
      (h, l) => h + (l.type === 'participant' ? UTT_H : l.type === 'token' ? WORD_H : EVT_H) + LANE_GAP,
      0
    )
  }

  const summaryRulerY = 0
  function summaryBarsY():  number { return SUMMARY_RULER_H }
  function rulerY():        number { return SUMMARY_RULER_H + SUMMARY_H }
  function audioStartY():   number { return rulerY() + RULER_H }
  function laneStartY():    number { return audioStartY() + zoneH(audioChannels()) }
  function laneEndY():      number { return laneStartY() + laneZoneHeight() }

  function buildSignalLayouts(): Map<string, SignalLayout> {
    const map = new SvelteMap<string, SignalLayout>()
    let y = audioStartY()
    let lastGroup: string | null = null
    for (const ch of audioChannels()) {
      const g = chGroup(ch.id)
      if (g !== lastGroup) { y += PAIR_HANDLE_H; lastGroup = g }
      const specH = sigH(ch)
      const height = specH + overlayH(ch)
      map.set(ch.id, { id: ch.id, y, height, specH })
      y += height + LANE_GAP
    }
    y = laneEndY()
    lastGroup = null
    for (const ch of seriesChannels()) {
      const g = chGroup(ch.id)
      if (g !== lastGroup) { y += PAIR_HANDLE_H; lastGroup = g }
      const specH = sigH(ch)
      const height = specH + overlayH(ch)
      map.set(ch.id, { id: ch.id, y, height, specH })
      y += height + LANE_GAP
    }
    return map
  }

  function buildLaneLayouts(): Map<string, LaneLayout> {
    const map = new SvelteMap<string, LaneLayout>()
    let y = laneStartY()
    for (const lane of visibleLanes()) {
      const height = lane.type === 'participant' ? UTT_H : lane.type === 'token' ? WORD_H : EVT_H
      map.set(lane.id, { y, height, ...(lane.color !== undefined ? { color: lane.color } : {}) })
      y += height + LANE_GAP
    }
    return map
  }

  function canvasHeight(): number {
    const h = Math.max(SUMMARY_H + SUMMARY_RULER_H + zoneH(audioChannels()) + RULER_H + laneZoneHeight() + zoneH(seriesChannels()), 80)
    contentHeight = h
    onContentHeight?.(h)
    return h
  }

  function hitLane(y: number): string | null {
    if (y < laneStartY() || y >= laneEndY()) return null
    const lLayouts = buildLaneLayouts()
    for (const [laneId, lo] of lLayouts) {
      if (y >= lo.y && y < lo.y + lo.height) return laneId
    }
    return null
  }

  // Full document time extent (from timed, non-word bars) — cached, invalidated when _bars changes.
  let _docExtentCache: { start: number; end: number } | null = null
  function _invalidateDocExtent() { _docExtentCache = null }
  function docExtent(): { start: number; end: number } {
    if (_docExtentCache) return _docExtentCache
    let start = Infinity, end = -Infinity
    for (const b of _bars) {
      if (b.placeholder || b.type === 'token') continue
      if (b.start < start) start = b.start
      if (b.end   > end)   end   = b.end
    }
    _docExtentCache = (start === Infinity)
      ? { start: 0, end: Math.max(30, viewEnd) }
      : { start, end }
    return _docExtentCache
  }

  function summaryExtent(): { start: number; end: number } {
    const doc = docExtent()
    const end = _mediaDuration != null ? Math.max(doc.end, _mediaDuration) : doc.end
    return { start: doc.start, end }
  }

  function makeSummaryXScale(): LinearScale {
    const { start, end } = summaryExtent()
    const pad = Math.max((end - start) * 0.03, 0.5)
    return new LinearScale([start - pad, end + pad], [0, app?.screen.width ?? 800])
  }

  // Load a spectrogram image; returns cached texture or null (triggers re-render on load)
  function ensureTexture(url: string): PIXI.Texture | null {
    if (loadedTextures.has(url)) return loadedTextures.get(url)!
    const img = new window.Image()
    img.onload = () => {
      loadedTextures.set(url, PIXI.Texture.from(img as HTMLImageElement))
      if (app) render()
    }
    img.src = url
    return null
  }

  function _makeTexEntry(tile: SpectrogramTile, lut: Uint32Array, lutKey: string): TexEntry | null {
    if (!tile.width || !tile.height) return null
    if (tile.rawDb?.length) {
      const rgba = _rawDbToRgba(tile, lut)
      return { tex: new PIXI.Texture({ source: new PIXI.BufferImageSource({ resource: rgba, width: tile.width, height: tile.height }) }), rgba, lutKey }
    }
    if (tile.pixels?.length) {
      return { tex: new PIXI.Texture({ source: new PIXI.BufferImageSource({ resource: tile.pixels, width: tile.width, height: tile.height }) }), lutKey: '' }
    }
    return null
  }

  function getTileTexture(tile: SpectrogramTile, lut: Uint32Array, lutKey: string): PIXI.Texture | null {
    const cached = _tileTexCache.get(tile)
    if (cached && cached.lutKey === lutKey) return cached.tex
    if (cached) { cached.tex.destroy(true); _tileTexCache.delete(tile) }
    const entry = _makeTexEntry(tile, lut, lutKey)
    if (!entry) return null
    _tileTexCache.set(tile, entry)
    return entry.tex
  }

  function getOverviewTexture(tile: SpectrogramTile, lut: Uint32Array, lutKey: string): PIXI.Texture | null {
    const cached = _overviewTexCache.get(tile)
    if (cached && cached.lutKey === lutKey) return cached.tex
    if (cached) { cached.tex.destroy(true); _overviewTexCache.delete(tile) }
    const entry = _makeTexEntry(tile, lut, lutKey)
    if (!entry) return null
    _overviewTexCache.set(tile, entry)
    return entry.tex
  }

  function addSpriteTile(
    tile: SpectrogramTile,
    tex: PIXI.Texture,
    y: number,
    height: number,
    xScale: LinearScale,
    tOffset = 0,
  ): void {
    const x = xScale.map(tile.timeStart + tOffset)
    const w = xScale.map(tile.timeEnd + tOffset) - x
    if (w <= 0) return
    const sprite = new PIXI.Sprite(tex)
    sprite.x = x; sprite.y = y
    sprite.width = w; sprite.height = height
    signalContainer.addChild(sprite)
  }

  // X scale

  function makeXScale(): LinearScale {
    return new LinearScale([viewStart, viewEnd], [0, app?.screen.width ?? 800])
  }

  // Drag bounds

  function dragBoundsFor(bar: BarItem): { minStart: number; maxEnd: number; maxStart?: number; minEnd?: number } {
    // included_in annotation bars: sibling overlap is allowed — only parent bounds constrain.
    // included_in token bars: no overlap allowed, same as other constraint modes.
    let minStart = 0
    let maxEnd = Infinity
    if (bar.constraint !== 'included_in' || bar.type === 'token') {
      const laneBars = _bars
        .filter(b => {
          if (b.laneId !== bar.laneId || b.id === bar.id) return false
          return bar.type === 'token' ? b.type === 'token' : b.type !== 'token'
        })
        .sort((a, b) => a.start - b.start)
      const prev = [...laneBars].reverse().find(b => b.end <= bar.start)
      const next = laneBars.find(b => b.start >= bar.end)
      minStart = prev ? prev.end : 0
      maxEnd = next ? next.start : Infinity
    }
    if ((bar.constraint === 'included_in' || bar.constraint === 'time_subdivision') && bar.parentNodeId) {
      const parentObj = barObjs.get(bar.parentNodeId)
      if (parentObj) {
        minStart = Math.max(minStart, parentObj.bar.start)
        maxEnd = Math.min(maxEnd, parentObj.bar.end)
      }
    }
    // Parent can't be resized smaller than its included_in children
    let maxStart: number | undefined
    let minEnd: number | undefined
    const childIds = barChildren.get(bar.id)
    if (childIds) {
      for (const cid of childIds) {
        const child = barObjs.get(cid)?.bar
        if (!child || child.constraint !== 'included_in') continue
        maxStart = maxStart === undefined ? child.start : Math.min(maxStart, child.start)
        minEnd   = minEnd   === undefined ? child.end   : Math.max(minEnd,   child.end)
      }
    }
    return { minStart, maxEnd, ...(maxStart !== undefined ? { maxStart } : {}), ...(minEnd !== undefined ? { minEnd } : {}) }
  }

  function _findTimeSubdivSibling(bar: BarItem, edge: 'left' | 'right'): BarItem | null {
    if (!bar.parentNodeId || bar.constraint !== 'time_subdivision') return null
    const childIds = barChildren.get(bar.parentNodeId)
    if (!childIds) return null
    const all: BarItem[] = []
    for (const cid of childIds) {
      const childObj = barObjs.get(cid)
      if (!childObj || childObj.bar.constraint !== 'time_subdivision') continue
      all.push(childObj.bar)
    }
    // Sort by listIndex (document/list order) when available, fall back to start time
    if (all.some(b => b.listIndex !== undefined)) {
      all.sort((a, b) => (a.listIndex ?? Infinity) - (b.listIndex ?? Infinity))
    } else {
      all.sort((a, b) => a.start - b.start)
    }
    const myIdx = all.findIndex(b => b.nodeId === bar.nodeId)
    if (myIdx === -1) return null
    if (edge === 'right' && myIdx < all.length - 1) return all[myIdx + 1]!
    if (edge === 'left'  && myIdx > 0)              return all[myIdx - 1]!
    return null
  }

  // Bar position during drag

  function getBarTimes(bar: BarItem): { start: number; end: number } {
    const d = drag  // snapshot so TypeScript retains narrowing across function calls
    if (d.kind !== 'moveBar' && d.kind !== 'resizeLeft' && d.kind !== 'resizeRight') {
      return { start: bar.start, end: bar.end }
    }
    if (d.nodeId !== bar.nodeId) {
      // Sibling coupling for time_subdivision shared boundaries
      if ((d.kind === 'resizeLeft' || d.kind === 'resizeRight') && d.siblingId && d.siblingId === bar.nodeId) {
        const draggedObj = barObjs.get(d.nodeId) ?? [...barObjs.values()].find(o => o.bar.nodeId === d.nodeId)
        if (draggedObj) {
          const draggedTimes = getBarTimes(draggedObj.bar)
          if (d.kind === 'resizeRight') return { start: draggedTimes.end, end: bar.end }
          else                          return { start: bar.start, end: draggedTimes.start }
        }
      }
      // Propagate drag to children via parentNodeId chain (recursive, O(depth))
      if (bar.parentNodeId) {
        const parentObj = barObjs.get(bar.parentNodeId)
        if (parentObj) {
          const parentOrig = parentObj.bar
          const parentNew  = getBarTimes(parentObj.bar)  // recursive — reads drag state, no mutation
          if (parentNew.start !== parentOrig.start || parentNew.end !== parentOrig.end) {
            const dt = parentNew.start - parentOrig.start
            if (bar.constraint === 'included_in') {
              if (d.kind === 'moveBar') {
                return { start: bar.start + dt, end: bar.end + dt }
              }
              // resize: keep absolute position, clamp to new parent bounds
              return {
                start: Math.max(bar.start, parentNew.start),
                end: Math.min(bar.end, parentNew.end),
              }
            }
            // time_subdivision and others: translate on move, proportional on resize
            if (d.kind === 'moveBar') {
              return { start: bar.start + dt, end: bar.end + dt }
            }
            const origDur = parentOrig.end - parentOrig.start
            if (origDur > 0) {
              const rs = (bar.start - parentOrig.start) / origDur
              const re = (bar.end   - parentOrig.start) / origDur
              const newDur = parentNew.end - parentNew.start
              return { start: parentNew.start + rs * newDur, end: parentNew.start + re * newDur }
            }
            return { start: bar.start + dt, end: bar.end + dt }
          }
        }
      }
      return { start: bar.start, end: bar.end }
    }

    const pxPerSec = (app?.screen.width ?? 800) / (viewEnd - viewStart)
    const dt = (curMouseX - d.startX) / pxPerSec

    // Snap radius scales with zoom: 8px equivalent in time units.
    const snapR = 8 / pxPerSec

    if (d.kind === 'moveBar') {
      const dur = d.origEnd - d.origStart
      const cursorTime = viewStart + curMouseX / pxPerSec
      const rawStart = cursorTime - d.grabOffset
      const rawEnd = rawStart + dur
      const snappedStart = snapTime(rawStart, snapR)
      const snappedEnd = snapTime(rawEnd, snapR)
      const deltaStart = Math.abs(snappedStart - rawStart)
      const deltaEnd = Math.abs(snappedEnd - rawEnd)
      let s: number
      if (snappedStart !== rawStart && snappedEnd !== rawEnd) {
        s = deltaStart <= deltaEnd ? snappedStart : snappedEnd - dur
      } else if (snappedStart !== rawStart) {
        s = snappedStart
      } else if (snappedEnd !== rawEnd) {
        s = snappedEnd - dur
      } else {
        s = rawStart
      }
      s = Math.max(d.minStart, Math.min(d.maxEnd - dur, Math.max(0, s)))
      return { start: s, end: s + dur }
    }
    if (d.kind === 'resizeLeft') {
      let s = d.origStart + dt
      s = Math.max(d.minStart, Math.max(0, s))
      s = Math.min(d.origEnd - 1 / pxPerSec, s)
      s = snapTime(s, snapR)
      s = Math.max(d.minStart, Math.max(0, Math.min(d.origEnd - 1 / pxPerSec, s)))
      if (d.maxStart !== undefined) s = Math.min(s, d.maxStart)
      return { start: s, end: d.origEnd }
    }
    let e = d.origEnd + dt
    e = Math.min(d.maxEnd, e)
    e = Math.max(d.origStart + 1 / pxPerSec, e)
    e = snapTime(e, snapR)
    e = Math.max(d.origStart + 1 / pxPerSec, Math.min(d.maxEnd, e))
    if (d.minEnd !== undefined) e = Math.max(e, d.minEnd)
    return { start: d.origStart, end: e }
  }

  // Ruler rendering helper

  function renderRuler(
    gfx: PIXI.Graphics,
    addLabel: ((text: string, x: number, y: number) => void) | null,
    xScale: LinearScale,
    rangeStart: number,
    rangeEnd: number,
    y: number,
    height: number,
    showLabels: boolean,
  ) {
    const w = app.screen.width
    const pxPerSec = w / (rangeEnd - rangeStart)
    const interval = pickTickInterval(pxPerSec)
    const subInterval = pickSubInterval(interval)

    // Sub-ticks first (shorter)
    const firstSub = Math.ceil(rangeStart / subInterval) * subInterval
    for (let t = firstSub; t <= rangeEnd + subInterval; t = +(t + subInterval).toFixed(10)) {
      const isMajor = Math.round(t / interval) * interval === +t.toFixed(10) ||
                      Math.abs((t % interval + interval) % interval) < subInterval * 0.05 ||
                      Math.abs((t % interval + interval) % interval - interval) < subInterval * 0.05
      if (isMajor) continue
      const x = Math.round(xScale.map(t))
      if (x < 0 || x > w) continue
      gfx.moveTo(x, y + height - 4).lineTo(x, y + height)
    }
    gfx.stroke({ width: 1, color: palette.textFaint, alpha: 0.8 })

    // Major ticks + optional labels
    const firstMajor = Math.ceil(rangeStart / interval) * interval
    for (let t = firstMajor; t <= rangeEnd + interval; t = +(t + interval).toFixed(10)) {
      const x = Math.round(xScale.map(t))
      if (x < 0 || x > w) continue
      gfx.moveTo(x, y + height - 8).lineTo(x, y + height)
      if (showLabels && addLabel) addLabel(formatRulerTime(t), x + 3, y + height / 2)
    }
    gfx.stroke({ width: 1, color: palette.textLight })
  }

  // Label pool helper
  // Reuses a PIXI.Text from the pool at `idx`, or creates and appends a new one.
  // Returns the next pool index. Only creates new Text objects when the pool grows.
  function _poolLabel(
    pool: PIXI.Text[], ctr: PIXI.Container, idx: number,
    text: string, x: number, y: number,
    style: PIXI.TextStyle, alpha = 1,
  ): number {
    let t = pool[idx]
    if (!t) { t = new PIXI.Text({ text: '', style }); ctr.addChild(t); pool.push(t) }
    if (t.text !== text) t.text = text
    t.x = x; t.y = y; t.anchor.set(0.5, 0.5); t.alpha = alpha; t.visible = true
    return idx + 1
  }

  // Per-layer render functions

  function renderSummaryLayer() {
    if (!app) return
    const w = app.screen.width
    const layouts = buildLaneLayouts()
    const smx = makeSummaryXScale()
    const { start: smDocStart, end: smDocEnd } = summaryExtent()
    const smPad = Math.max((smDocEnd - smDocStart) * 0.03, 0.5)

    for (const t of _sumPool) t.visible = false
    _sumIdx = 0

    summaryGfx.clear()
    summaryGfx.rect(0, summaryRulerY, w, SUMMARY_RULER_H).fill(palette.bg2)
    summaryGfx.rect(0, summaryBarsY(), w, SUMMARY_H).fill(palette.bg4)
    summaryGfx.moveTo(0, SUMMARY_RULER_H + SUMMARY_H).lineTo(w, SUMMARY_RULER_H + SUMMARY_H).stroke({ width: 1, color: palette.border })

    renderRuler(summaryGfx, (text, x, y) => {
      _sumIdx = _poolLabel(_sumPool, summaryLabelContainer, _sumIdx, text, x, y, styleRuler)
      const lbl = _sumPool[_sumIdx - 1]!; lbl.anchor.set(0, 0.5)
    }, smx, smDocStart - smPad, smDocEnd + smPad, summaryRulerY, SUMMARY_RULER_H, true)

    for (const bar of _bars) {
      if (bar.placeholder || bar.type === 'token' || bar.summaryHidden) continue
      const lo = layouts.get(bar.laneId)
      if (!lo) continue
      const bx = smx.map(bar.start)
      const bw = Math.max(smx.map(bar.end) - bx, 1)
      if (bx + bw < 0 || bx > w) continue
      const color = bar.color ?? lo.color ?? (bar.type === 'annotation' ? ANN_BAR_COLOR : palette.primary)
      const lzh = laneZoneHeight()
      const relY = lzh > 0 ? (lo.y - laneStartY()) / lzh : 0
      const stripY = summaryBarsY() + 4 + relY * (SUMMARY_H - 12)
      summaryGfx.rect(bx, stripY, bw, 4).fill({ color, alpha: 0.75 })
    }

    renderSummaryViewport()
  }

  function renderSummaryViewport() {
    if (!app) return
    const w = app.screen.width
    const smx = makeSummaryXScale()
    summaryViewportGfx.clear()
    const smVx1 = Math.max(0, smx.map(viewStart))
    const smVx2 = Math.min(w, smx.map(viewEnd))
    if (smVx2 > smVx1) {
      summaryViewportGfx.rect(smVx1, summaryBarsY(), smVx2 - smVx1, SUMMARY_H).fill({ color: palette.primary, alpha: 0.12 })
      summaryViewportGfx.rect(smVx1, summaryBarsY(), smVx2 - smVx1, SUMMARY_H).stroke({ width: 2, color: palette.primary, alpha: 0.7 })
    }
  }

  function renderSignalLayer() {
    if (!app) return
    const w = app.screen.width
    const xScale = makeXScale()
    const sigLayouts = buildSignalLayouts()

    signalGfx.clear()
    signalContainer.removeChildren()
    hzGfx.clear()
    _hzIdx = 0
    _tierIdx = 0

    // Draw group separator at the top of each signal group (matches panel handle)
    let lastRenderedGroup: string | null = null
    for (const ch of audioChannels()) {
      const g = chGroup(ch.id)
      if (g !== lastRenderedGroup) {
        const sl = sigLayouts.get(ch.id)
        if (sl) signalGfx.rect(0, sl.y - PAIR_HANDLE_H, w, PAIR_HANDLE_H).fill(palette.border)
        lastRenderedGroup = g
      }
    }
    for (const ch of _signals) {
      const sl = sigLayouts.get(ch.id)
      if (!sl) continue

      signalGfx.rect(0, sl.y, w, sl.height).fill(palette.bg3)
      signalGfx.moveTo(0, sl.y + sl.height).lineTo(w, sl.y + sl.height).stroke({ width: 1, color: palette.borderStrong })

      // Spectrogram
      if (ch.kind === 'spectrogram') {
        const overview = _spectrogramOverviews.get(ch.id)
        const tiles    = _spectrogramTiles.get(ch.id)

        const tOffset = ch.timeOffset ?? 0

        // Determine whether detail tiles are worth rendering at current zoom.
        // If more than MAX_VISIBLE_TILES would be visible, they'd blow GPU memory
        // and provide no perceptual benefit — fall back to the overview only.
        let visibleTileCount = 0
        if (tiles?.length) {
          for (const tile of tiles) {
            if (tile && tile.timeEnd + tOffset > viewStart && tile.timeStart + tOffset < viewEnd) visibleTileCount++
          }
        }
        const useDetailTiles = !!(tiles && tiles.length > 0 && visibleTileCount <= MAX_VISIBLE_TILES)

        // Compute adaptive LUT: map [p2, p99] of visible rawDb values to the
        // full colour range so background noise stays dark and speech peaks
        // stay bright.  Single O(N) histogram scan, typically <0.5 ms.
        const [loRaw, hiRaw] = _viewportRange(tiles, overview, useDetailTiles, viewStart, viewEnd, tOffset)
        const lutFloor = loRaw / 255 * SPEC_DB_RANGE + SPEC_DB_FLOOR
        const dynRange = Math.max(1, hiRaw / 255 * SPEC_DB_RANGE + SPEC_DB_FLOOR - lutFloor)
        const gamma    = ch.spectrogramGamma ?? 1.2
        const lutKey   = `${lutFloor.toFixed(1)}:${dynRange.toFixed(1)}:${gamma}`
        let chLut = _channelLuts.get(ch.id)
        if (!chLut || chLut.key !== lutKey) {
          chLut = { lut: _buildLut(lutFloor, dynRange, gamma), key: lutKey }
          _channelLuts.set(ch.id, chLut)
        }
        const { lut, key } = chLut

        // Always render overview as the base layer — it fills in immediately and
        // covers regions where detail tiles haven't been received yet.
        if (overview) {
          const ovTex = getOverviewTexture(overview, lut, key)
          if (ovTex) addSpriteTile(overview, ovTex, sl.y, sl.specH, xScale, tOffset)
        } else if (ch.imageUrl) {
          const tex = ensureTexture(ch.imageUrl)
          if (tex) {
            const { start: docStart, end: docEnd } = docExtent()
            const imgStart = (ch.imageTimeStart ?? docStart) + tOffset
            const imgEnd   = (ch.imageTimeEnd   ?? docEnd)   + tOffset
            const ix = xScale.map(imgStart)
            const iw = xScale.map(imgEnd) - ix
            if (iw > 0) {
              const sprite = new PIXI.Sprite(tex)
              sprite.x = ix; sprite.y = sl.y
              sprite.width = iw; sprite.height = sl.specH
              signalContainer.addChild(sprite)
            }
          }
        }

        // Overlay detail tiles when zoomed in enough.
        if (useDetailTiles) {
          for (const tile of tiles!) {
            if (!tile || tile.timeEnd + tOffset <= viewStart || tile.timeStart + tOffset >= viewEnd) continue
            const tex = getTileTexture(tile, lut, key)
            if (tex) addSpriteTile(tile, tex, sl.y, sl.specH, xScale, tOffset)
          }
        }

        // "Computing…" label while waiting for the first overview.
        if (!overview && !ch.imageUrl) {
          const lbl = new PIXI.Text({
            text: 'Computing…',
            style: {
              fontFamily: 'system-ui, sans-serif',
              fontSize: 10,
              fill: 0x888888,
            },
          })
          lbl.x = 8
          lbl.y = sl.y + Math.max(0, (sl.specH - 10) / 2)
          signalContainer.addChild(lbl)
        }

        // Hz frequency axis ticks — short marks on the right edge
        if (ch.maxFreqHz && ch.maxFreqHz > 0) {
          const pxPerHz = sl.specH / ch.maxFreqHz
          const interval = pickHzInterval(pxPerHz, ch.maxFreqHz)
          const TICK_W = 10
          for (let hz = interval; hz < ch.maxFreqHz; hz += interval) {
            const ty = Math.round(sl.y + sl.specH * (1 - hz / ch.maxFreqHz))
            hzGfx.rect(w - TICK_W, ty - 1, TICK_W, 2).fill({ color: 0xffffff, alpha: 0.7 })
            _hzIdx = _poolLabel(_hzPool, hzLabelContainer, _hzIdx, formatHz(hz), w - TICK_W - 2, ty, styleHz)
            _hzPool[_hzIdx - 1]!.anchor.set(1, 0.5)
          }
        }


      // Mirror waveform from bins
      } else if (ch.kind === 'waveform' && ch.waveformBins) {
        const { rms, binDuration, binCount } = ch.waveformBins
        const tOffset = ch.timeOffset ?? 0
        const color   = palette.waveform
        const centerY = sl.y + sl.specH / 2
        const half    = sl.specH / 2 * 0.9

        const startBin = Math.max(0, Math.floor((viewStart - tOffset) / binDuration))
        const endBin   = Math.min(binCount - 1, Math.ceil((viewEnd - tOffset) / binDuration))
        if (endBin - startBin < w) {
          // Zoomed in: one draw call per visible bin
          for (let b = startBin; b <= endBin; b++) {
            const bx  = xScale.map(b * binDuration + tOffset)
            const bx2 = xScale.map((b + 1) * binDuration + tOffset)
            const rh  = Math.sqrt(rms[b]!) * half
            signalGfx.rect(bx, centerY - rh, Math.max(1, bx2 - bx), rh * 2)
          }
        } else {
          // Zoomed out: one draw call per pixel, sweepline over bins — O(w) draw calls
          let b = startBin
          for (let px = 0; px < w; px++) {
            const bEnd = Math.min(endBin, Math.floor((xScale.invert(px + 1) - tOffset) / binDuration))
            let maxRMS = 0
            while (b <= bEnd) { if (rms[b]! > maxRMS) maxRMS = rms[b]!; b++ }
            if (maxRMS > 0) {
              const rh = Math.sqrt(maxRMS) * half
              signalGfx.rect(px, centerY - rh, 1, rh * 2)
            }
          }
        }
        signalGfx.fill({ color, alpha: 0.6 })
        signalGfx.moveTo(0, centerY).lineTo(w, centerY).stroke({ width: 1, color, alpha: 0.3 })

      // Fallback line plot
      } else if (ch.samples && ch.samples.length > 1) {
        const vals = ch.samples.map(([, v]) => v)
        const yMin = ch.yMin ?? Math.min(...vals)
        const yMax = ch.yMax ?? Math.max(...vals)
        const yRange = yMax - yMin || 1
        const vpad = sl.specH * 0.08
        const drawH = sl.specH - vpad * 2
        const color = ch.color ?? (ch.kind === 'waveform' ? palette.primary : palette.speakerColors[1]!)

        let penDown = false
        for (const [st, v] of ch.samples) {
          const spx = xScale.map(st)
          if (spx < -2 || spx > w + 2) { penDown = false; continue }
          const spy = sl.y + vpad + (1 - (v - yMin) / yRange) * drawH  // drawH uses sl.specH
          if (!penDown) { signalGfx.moveTo(spx, spy); penDown = true }
          else            signalGfx.lineTo(spx, spy)
        }
        signalGfx.stroke({ width: 1, color, alpha: 0.8 })

        if (ch.kind === 'series') {
          const zeroY = yMin <= 0 && yMax >= 0
            ? sl.y + vpad + (1 - (0 - yMin) / yRange) * drawH
            : sl.y + sl.specH - vpad
          signalGfx.moveTo(0, zeroY).lineTo(w, zeroY).stroke({ width: 1, color: palette.waveformZero, alpha: 0.5 })
        }
      }
    }
    for (let i = _hzIdx; i < _hzPool.length; i++) _hzPool[i]!.visible = false

    // TextGrid tier overlay strips
    for (const ch of _signals) {
      const tiers = ch.overlayTiers
      if (!tiers || tiers.length === 0) continue
      const sl = sigLayouts.get(ch.id)
      if (!sl) continue

      for (let ti = 0; ti < tiers.length; ti++) {
        const tier = tiers[ti]!
        const stripY = sl.y + sl.specH + ti * TIER_STRIP_H

        // Background + bottom border
        signalGfx.rect(0, stripY, w, TIER_STRIP_H).fill(palette.bg2)
        signalGfx.moveTo(0, stripY + TIER_STRIP_H - 1).lineTo(w, stripY + TIER_STRIP_H - 1).stroke({ width: 1, color: palette.border })

        // Tier name label — left edge, vertically centred
        _tierIdx = _poolLabel(_tierPool, tierLabelContainer, _tierIdx,
          tier.label, 4, stripY + TIER_STRIP_H / 2, styleTierName)
        _tierPool[_tierIdx - 1]!.anchor.set(0, 0.5)

        // Interval bars
        const tOffset = ch.timeOffset ?? 0
        for (const iv of tier.intervals) {
          const x1 = xScale.map(iv.start + tOffset)
          const x2 = xScale.map(iv.end   + tOffset)
          if (x2 < 0 || x1 > w) continue

          // Right edge tick
          if (x2 >= 0 && x2 <= w) {
            signalGfx.moveTo(x2, stripY).lineTo(x2, stripY + TIER_STRIP_H - 1).stroke({ width: 1, color: palette.border })
          }

          // Label — only if the interval is wide enough to show text
          const visW = Math.min(x2, w) - Math.max(x1, 0)
          if (visW >= 8 && iv.label) {
            const cx = Math.max(x1, 0) + visW / 2
            const cy = stripY + TIER_STRIP_H / 2
            _tierIdx = _poolLabel(_tierPool, tierLabelContainer, _tierIdx,
              iv.label, cx, cy, styleTier)
            const lbl = _tierPool[_tierIdx - 1]!
            lbl.anchor.set(0.5, 0.5)
            // Clip label to interval bounds by masking with a Graphics mask
            // For performance we just hide labels wider than the interval
            if (lbl.width > visW - 2) lbl.visible = false
          }
        }
      }
    }
    for (let i = _tierIdx; i < _tierPool.length; i++) _tierPool[i]!.visible = false

  }

  function renderRulerLayer() {
    if (!app) return
    const w = app.screen.width
    const xScale = makeXScale()
    const ry = rulerY()

    for (const t of _rulerPool) t.visible = false
    _rulerIdx = 0

    rulerGfx.clear()
    rulerGfx.rect(0, ry, w, RULER_H).fill(palette.bg2)
    rulerGfx.moveTo(0, ry + RULER_H - 1).lineTo(w, ry + RULER_H - 1).stroke({ width: 1, color: palette.bg5 })
    renderRuler(rulerGfx, (text, x, y) => {
      _rulerIdx = _poolLabel(_rulerPool, rulerLabelContainer, _rulerIdx, text, x, y, styleRuler)
      const lbl = _rulerPool[_rulerIdx - 1]!; lbl.anchor.set(0, 0.5)
    }, xScale, viewStart, viewEnd, ry, RULER_H, true)
  }

  function renderLaneBackground() {
    if (!app) return
    const w = app.screen.width
    const layouts = buildLaneLayouts()

    laneGfx.clear()
    let laneIdx = 0
    for (const lane of visibleLanes()) {
      const lo = layouts.get(lane.id)
      if (!lo) continue
      const isGroupStart = laneIdx > 0 && (lane.id.startsWith('participant:') || lane.id.startsWith('evt::'))
      if (isGroupStart) {
        laneGfx.moveTo(0, lo.y).lineTo(w, lo.y).stroke({ width: 1.5, color: palette.separator })
      }
      const bg = laneIdx % 2 === 0 ? palette.bg0 : palette.bg5
      laneGfx.rect(0, lo.y, w, lo.height).fill(lane.type === 'token' ? { color: bg, alpha: 0.5 } : bg)
      laneIdx++
    }
  }

  // Per-bar sprite helpers

  function _acquireLabel(pool: PIXI.Text[], style: PIXI.TextStyle, ctr: PIXI.Container): PIXI.Text {
    const lbl = pool.pop()
    if (lbl) { lbl.style = style; return lbl }
    const t = new PIXI.Text({ text: '', style })
    t.anchor.set(0.5, 0.5)
    ctr.addChild(t)
    return t
  }

  function _releaseLabel(pool: PIXI.Text[], lbl: PIXI.Text | null) {
    if (!lbl) return
    lbl.visible = false
    pool.push(lbl)
  }

  function _barColor(bar: BarItem, lo: LaneLayout): number {
    return bar.color ?? lo.color ?? (bar.type === 'annotation' ? ANN_BAR_COLOR : palette.primary)
  }

  function _applyBarObj(obj: BarObj, bar: BarItem, xScale: LinearScale, layouts: Map<string, LaneLayout>, w: number) {
    const isWord = bar.type === 'token'
    if (isWord && !_showWords) {
      obj.fill.visible = false
      if (obj.label) obj.label.visible = false
      return
    }

    const lo = layouts.get(bar.laneId)
    if (!lo) {
      obj.fill.visible = false
      if (obj.label) obj.label.visible = false
      return
    }
    const inset  = isWord ? WORD_INSET : BAR_INSET
    const minW   = isWord ? 1 : 2

    const { start, end } = getBarTimes(bar)
    const bx = xScale.map(start)
    const bw = Math.max(xScale.map(end) - bx - (isWord ? 1 : 0), minW)
    const by = lo.y + inset
    const bh = lo.height - inset * 2

    const inView = bx + bw >= 0 && bx <= w
    obj.fill.visible = inView
    if (inView) {
      obj.fill.x = bx; obj.fill.y = by
      obj.fill.width = bw; obj.fill.height = bh
      const sk = bar.suggestionKind
      const isSugGreen  = sk === 'add' || sk === 'move-new'
      const isSugRed    = sk === 'move-old' || sk === 'delete'
      obj.fill.tint  = isSugGreen ? 0x22c55e : isSugRed ? 0xef4444 : _barColor(bar, lo)
      const isNonReified = bar.type === 'annotation' && !bar.label && bar.parentNodeId !== undefined
      obj.fill.alpha = isWord ? 0.45 : isSugGreen ? 0.5 : isSugRed ? 0.45 : sk === 'update-label' ? 0.45 : bar.placeholder ? 0.3 : bar.nodeId === _selectedId ? 0.55 : isNonReified ? 0.22 : 0.45
    }

    // Labels live in a separate container — manage visibility explicitly
    const lbl = obj.label
    if (lbl) {
      const minLabelW = isWord ? 16 : 20
      const showLabel = inView && bw > minLabelW
      lbl.visible = showLabel
      if (showLabel) {
        const labelText = isWord ? bar.label : (bar.label || (bar.placeholder && bar.nodeId !== _selectedId ? '(no time)' : ''))
        if (lbl.text !== labelText) lbl.text = labelText
        lbl.x = bx + bw / 2
        lbl.y = by + bh / 2
        const fadeW = isWord ? bw - 4 : bw - 8
        lbl.alpha = Math.max(0, Math.min(1, fadeW / Math.max(lbl.width, 1))) * (bar.placeholder ? 0.6 : 1)
      }
    }
  }

  /** Build PIXI sprites for all bars in _bars. Call once at initialization. */
  function initialRenderBarObjs() {
    if (!app) return
    const xScale  = makeXScale()
    const layouts = buildLaneLayouts()
    const w       = app.screen.width
    for (const bar of _bars) {
      const isWord = bar.type === 'token'
      const fill = new PIXI.Sprite(_whiteTex)

      barContainer.addChild(fill)
      const label = _acquireLabel(
        isWord ? _freeWordLabelPool : _freeLabelPool,
        isWord ? styleWord : styleBar,
        labelContainer,
      )
      const obj: BarObj = { fill, label, bar }
      barObjs.set(bar.id, obj)
      if (bar.parentNodeId) {
        let siblings = barChildren.get(bar.parentNodeId)
        if (!siblings) { siblings = []; barChildren.set(bar.parentNodeId, siblings) }
        siblings.push(bar.id)
      }
      barTree.insert(bar.start, bar.end, bar.id)
      _applyBarObj(obj, bar, xScale, layouts, w)
    }
    _renderBarBorders(xScale, layouts)
    _renderPeerBarBorders(xScale, layouts)
  }

  /** Add a single bar sprite. Call when one annotation/utterance is created. */
  function _addBarObj(bar: BarItem) {
    if (!app) return
    const isWord = bar.type === 'token'
    const fill = new PIXI.Sprite(_whiteTex)
    barContainer.addChild(fill)
    const label = _acquireLabel(
      isWord ? _freeWordLabelPool : _freeLabelPool,
      isWord ? styleWord : styleBar,
      labelContainer,
    )
    const obj: BarObj = { fill, label, bar }
    barObjs.set(bar.id, obj)
    if (bar.parentNodeId) {
      let siblings = barChildren.get(bar.parentNodeId)
      if (!siblings) { siblings = []; barChildren.set(bar.parentNodeId, siblings) }
      siblings.push(bar.id)
    }
    barTree.insert(bar.start, bar.end, bar.id)
    _applyBarObj(obj, bar, makeXScale(), buildLaneLayouts(), app.screen.width)
  }

  /** Remove a single bar sprite. Call when one annotation/utterance is deleted. */
  function _removeBarObj(id: string) {
    const obj = barObjs.get(id)
    if (!obj) return
    barContainer.removeChild(obj.fill)
    obj.fill.destroy()
    const isWord = obj.bar.type === 'token'
    _releaseLabel(isWord ? _freeWordLabelPool : _freeLabelPool, obj.label)
    barTree.remove(obj.bar.start, obj.bar.end, id)
    if (obj.bar.parentNodeId) {
      const siblings = barChildren.get(obj.bar.parentNodeId)
      if (siblings) {
        const idx = siblings.indexOf(id)
        if (idx !== -1) siblings.splice(idx, 1)
        if (siblings.length === 0) barChildren.delete(obj.bar.parentNodeId)
      }
    }
    barObjs.delete(id)
  }

  /** Reposition bar sprites after pan/zoom — only touches bars in the current viewport. */
  function repositionBarObjs() {
    if (!app) return
    const xScale  = makeXScale()
    const layouts = buildLaneLayouts()
    const w       = app.screen.width

    for (const [, obj] of barObjs) {
      _applyBarObj(obj, obj.bar, xScale, layouts, w)
    }
    _renderBarBorders(xScale, layouts)
    _renderPeerBarBorders(xScale, layouts)
    renderArcs(xScale, layouts)
  }

  function renderArcs(xScale: LinearScale, layouts: Map<string, LaneLayout>) {
    if (!arcGfx) return
    arcGfx.clear()
    if (_arcs.length === 0) return

    for (const arc of _arcs) {
      const srcObj = barObjs.get(arc.sourceBarId)
      const tgtObj = barObjs.get(arc.targetBarId)
      if (!srcObj || !tgtObj) continue
      const srcLo = layouts.get(srcObj.bar.laneId)
      const tgtLo = layouts.get(tgtObj.bar.laneId)
      if (!srcLo || !tgtLo) continue

      const { start: ss, end: se } = getBarTimes(srcObj.bar)
      const { start: ts, end: te } = getBarTimes(tgtObj.bar)
      const x1 = xScale.map((ss + se) / 2)
      const x2 = xScale.map((ts + te) / 2)
      const y1 = srcLo.y
      const y2 = tgtLo.y
      const topY = Math.min(y1, y2)
      const arcH = Math.min(Math.max(Math.abs(x2 - x1) * 0.25, 12), 60)
      const cy = topY - arcH
      const color = arc.color ?? 0x888888

      arcGfx.moveTo(x1, y1)
      arcGfx.bezierCurveTo(x1, cy, x2, cy, x2, y2)

      // Arrowhead pointing at target
      const angle = Math.atan2(y2 - cy, x2 - x1)
      const al = 7
      arcGfx.moveTo(x2, y2)
      arcGfx.lineTo(x2 - al * Math.cos(angle - 0.4), y2 - al * Math.sin(angle - 0.4))
      arcGfx.moveTo(x2, y2)
      arcGfx.lineTo(x2 - al * Math.cos(angle + 0.4), y2 - al * Math.sin(angle + 0.4))
      arcGfx.stroke({ width: 1.5, color, alpha: 0.7 })
    }
  }

  /** Update a single bar's sprite and its word/token children during drag. */
  function _applyDescendants(id: string, xScale: LinearScale, layouts: Map<string, LaneLayout>, w: number) {
    const childIds = barChildren.get(id)
    if (!childIds) return
    for (const cid of childIds) {
      const childObj = barObjs.get(cid)
      if (!childObj) continue
      _applyBarObj(childObj, childObj.bar, xScale, layouts, w)
      _applyDescendants(cid, xScale, layouts, w)
    }
  }

  function updateBarObj(nodeId: string) {
    if (!app) return
    const xScale  = makeXScale()
    const layouts = buildLaneLayouts()
    const w       = app.screen.width
    const obj = barObjs.get(nodeId) ?? [...barObjs.values()].find(o => o.bar.nodeId === nodeId)
    if (obj) {
      _applyBarObj(obj, obj.bar, xScale, layouts, w)
    }
    _renderBarBorders(xScale, layouts)
    _renderPeerBarBorders(xScale, layouts)
  }

  /** Redraw the thin border Graphics for selected + placeholder bars only. */
  function _renderBarBorders(xScale: LinearScale, layouts: Map<string, LaneLayout>) {
    barBorderGfx.clear()
    if (!app) return
    const w = app.screen.width
    for (const bar of _bars) {
      const lo = layouts.get(bar.laneId)
      if (!lo) continue

      // Word tokens: selected edge only (no dividers)
      if (bar.type === 'token') {
        const obj = barObjs.get(bar.id)
        if (!obj) continue
        const { start, end } = getBarTimes(obj.bar)
        const bx = xScale.map(start)
        const bw = Math.max(xScale.map(end) - bx, 2)
        if (bx + bw < 0 || bx > w) continue
        continue
      }

      const isSubdiv = bar.constraint === 'time_subdivision' || bar.constraint === 'symbolic_subdivision'

      // Use obj.bar for times — resetBars may update _bars while drag is active without
      // updating obj.bar, so using obj.bar keeps the border aligned with the sprite.
      const obj = barObjs.get(bar.id)
      if (!obj) continue
      const { start, end } = getBarTimes(obj.bar)
      const bx = xScale.map(start)
      const bw = Math.max(xScale.map(end) - bx, 2)
      if (bx + bw < 0 || bx > w) continue
      const by = lo.y + BAR_INSET
      const bh = lo.height - BAR_INSET * 2

      if (isSubdiv) {
        // Draw vertical dividers. Adjacent bars share a boundary pixel so drawing both
        // edges for every bar produces a single line at each shared boundary.
        // Grey = no stored time (symbolic_subdivision), black = stored time (time_subdivision).
        const divColor = bar.constraint === 'symbolic_subdivision' ? 0x999999 : 0x333333
        barBorderGfx.moveTo(bx,      by).lineTo(bx,      by + bh).stroke({ width: 1, color: divColor })
        barBorderGfx.moveTo(bx + bw, by).lineTo(bx + bw, by + bh).stroke({ width: 1, color: divColor })
        continue
      }

      const sk = bar.suggestionKind
      if (sk === 'add' || sk === 'move-new' || sk === 'move-old' || sk === 'delete' || sk === 'update-label') {
        const isGreen  = sk === 'add' || sk === 'move-new' || sk === 'update-label'
        const stripeColor  = isGreen ? 0x16a34a : 0xdc2626
        const borderColor  = isGreen ? 0x16a34a : 0xdc2626
        const STEP = 7
        for (let k = -Math.ceil(bh / STEP); k < Math.ceil(bw / STEP) + 2; k++) {
          const lx = bx + k * STEP
          const cx1 = Math.max(bx, lx)
          const cy1 = by + (cx1 - lx)
          const cx2 = Math.min(bx + bw, lx + bh)
          const cy2 = by + (cx2 - lx)
          if (cx1 >= cx2) continue
          barBorderGfx.moveTo(cx1, Math.max(by, cy1))
          barBorderGfx.lineTo(cx2, Math.min(by + bh, cy2))
        }
        barBorderGfx.stroke({ width: 1.5, color: stripeColor, alpha: 0.55 })
        barBorderGfx.rect(bx, by, bw, bh).stroke({ width: 1.5, color: borderColor, alpha: 0.85 })
        continue
      }

      const color = _barColor(obj.bar, lo)
      if (obj.bar.placeholder) {
        barBorderGfx.rect(bx, by, bw, bh).stroke({ width: 1, color, alpha: 0.7 })
      } else {
        barBorderGfx.rect(bx, by, bw, bh).stroke({ width: 1, color: palette.border })
      }
    }
  }

  function _renderPeerBarBorders(xScale: LinearScale, layouts: Map<string, LaneLayout>) {
    peerGfx.clear()
    if (!app || _peerBarSelections.length === 0) return
    const w = app.screen.width
    for (const ps of _peerBarSelections) {
      const bar = _bars.find(b => b.nodeId === ps.nodeId && b.type !== 'token')
      if (!bar) continue
      const lo = layouts.get(bar.laneId)
      if (!lo) continue
      const obj = barObjs.get(bar.id)
      if (!obj) continue
      const { start, end } = getBarTimes(obj.bar)
      const bx = xScale.map(start)
      const bw = Math.max(xScale.map(end) - bx, 2)
      if (bx + bw < 0 || bx > w) continue
      const by = lo.y + BAR_INSET
      const bh = lo.height - BAR_INSET * 2
      const color = parseInt(ps.color.slice(1), 16)
      peerGfx.rect(bx - 2, by - 2, bw + 4, bh + 4).stroke({ width: 2, color, alpha: 0.85 })
    }
  }

  function _renderDragBorder(bar: BarItem, xScale: LinearScale, layouts: Map<string, LaneLayout>) {
    barBorderGfx.clear()
    if (!app) return
    const lo = layouts.get(bar.laneId)
    if (!lo) return
    const { start, end } = getBarTimes(bar)
    const bx = xScale.map(start)
    const bw = Math.max(xScale.map(end) - bx, 2)
    const by = lo.y + BAR_INSET
    const bh = lo.height - BAR_INSET * 2
    const color = _barColor(bar, lo)
    if (bar.placeholder) {
      barBorderGfx.rect(bx, by, bw, bh).stroke({ width: 1, color, alpha: 0.7 })
    } else {
      barBorderGfx.rect(bx, by, bw, bh).stroke({ width: 1, color: palette.border })
    }
  }

  function renderSelectionLayer() {
    if (!app) return
    const h = app.screen.height
    const xScale = makeXScale()
    const ry = rulerY()
    selectionGfx.clear()
    if (selection) {
      const selX = xScale.map(selection.start)
      const selW = xScale.map(selection.end) - selX
      if (selW > 0) {
        selectionGfx.rect(selX, ry, selW, h - ry).fill({ color: palette.selection, alpha: 0.12 })
        selectionGfx.moveTo(selX, ry).lineTo(selX, h)
        selectionGfx.moveTo(selX + selW, ry).lineTo(selX + selW, h)
        selectionGfx.stroke({ width: 1, color: palette.selection, alpha: 0.5 })
      }
    }
  }

  function renderLoopLayer() {
    if (!app) return
    const h = app.screen.height
    const xScale = makeXScale()
    const ry = rulerY()
    loopGfx.clear()
    if (_loopRegion) {
      const lx = xScale.map(_loopRegion.start)
      const lw = xScale.map(_loopRegion.end) - lx
      if (lw > 0) {
        loopGfx.rect(lx, ry, lw, h - ry).fill({ color: palette.loopRegion, alpha: 0.10 })
        loopGfx.moveTo(lx, ry).lineTo(lx, h)
        loopGfx.moveTo(lx + lw, ry).lineTo(lx + lw, h)
        loopGfx.stroke({ width: 2, color: palette.loopRegion, alpha: 0.7 })
      }
    }
  }

  // Render

  const TICK_H          = 7
  const TICK_COLOR      = 0xE8861A
  const KEYFRAME_COLOR  = 0xFFFFFF
  const KEYFRAME_S      = 4   // half-size of diamond in px

  function renderTicks() {
    if (!tickGfx || !app) return
    tickGfx.clear()
    if (!_ticks.length) return
    const xScale    = makeXScale()
    const ry        = rulerY()
    const w         = app.screen.width
    const layouts   = buildLaneLayouts()
    const pxPerSec  = w / (viewEnd - viewStart)

    // rug marks (default)
    for (const tick of _ticks) {
      if (tick.kind === 'keyframe') continue
      if (tick.minPxPerSec && pxPerSec < tick.minPxPerSec) continue
      const x = xScale.map(tick.timeSeconds)
      if (x < -4 || x > w + 4) continue
      const tx = Math.round(x)
      const lo = tick.laneId ? layouts.get(tick.laneId) : undefined
      if (lo) {
        tickGfx.rect(tx - 1, lo.y + lo.height - TICK_H, 2, TICK_H)
      } else {
        tickGfx.rect(tx - 1, ry + RULER_H - TICK_H, 2, TICK_H)
      }
    }
    tickGfx.fill({ color: TICK_COLOR, alpha: 0.85 })

    // keyframe diamonds
    for (const tick of _ticks) {
      if (tick.kind !== 'keyframe') continue
      if (tick.minPxPerSec && pxPerSec < tick.minPxPerSec) continue
      const x = xScale.map(tick.timeSeconds)
      if (x < -KEYFRAME_S - 2 || x > w + KEYFRAME_S + 2) continue
      const tx = Math.round(x)
      const lo = tick.laneId ? layouts.get(tick.laneId) : undefined
      const ty = lo ? lo.y + lo.height / 2 : ry + RULER_H / 2
      const S  = KEYFRAME_S
      tickGfx.poly([tx, ty - S, tx + S, ty, tx, ty + S, tx - S, ty])
    }
    tickGfx.fill({ color: KEYFRAME_COLOR, alpha: 0.9 })
  }

  const MOTION_DX_COLOR  = 0xE84040
  const MOTION_DY_COLOR  = 0x40C040
  const MOTION_VEL_COLOR = 0x5090FF
  const MOTION_LINE_W    = 1
  const MOTION_ALPHA     = 0.6
  const MOTION_VPAD      = 2

  function _bsLow(arr: Float32Array, val: number): number {
    let lo = 0, hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid]! < val) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  function _strokeCurve(
    vals: Float32Array,
    times: Float32Array,
    startIdx: number,
    xScale: LinearScale,
    toY: (v: number) => number,
    w: number,
  ): void {
    let prevPx = -Infinity
    let penDown = false
    for (let i = startIdx; i < times.length; i++) {
      if (times[i]! > viewEnd) break
      const px = xScale.map(times[i]!)
      if (px > w + 2) break
      const pxr = Math.round(px)
      if (pxr === prevPx) continue
      prevPx = pxr
      const py = toY(vals[i]!)
      if (!penDown) { motionGfx.moveTo(px, py); penDown = true }
      else           motionGfx.lineTo(px, py)
    }
  }

  function renderMotionCurves(): void {
    if (!motionGfx || !app) return
    motionGfx.clear()
    if (_motionCurves.length === 0) return

    const xScale  = makeXScale()
    const layouts = buildLaneLayouts()
    const w = app.screen.width

    for (const curve of _motionCurves) {
      const lo = layouts.get(curve.laneId)
      if (!lo || curve.times.length === 0) continue

      const stats     = _motionStats.get(curve)
      if (!stats) continue
      const startIdx  = _bsLow(curve.times, viewStart)
      const laneTop   = lo.y + MOTION_VPAD
      const laneBot   = lo.y + lo.height - MOTION_VPAD
      const laneMid   = (laneTop + laneBot) / 2
      const laneHalf  = (laneBot - laneTop) / 2

      // dx — signed, centred at lane midpoint
      if (stats.dxAbs > 0) {
        const sc = laneHalf / stats.dxAbs
        _strokeCurve(curve.dx, curve.times, startIdx, xScale, v => laneMid - v * sc, w)
        motionGfx.stroke({ width: MOTION_LINE_W, color: MOTION_DX_COLOR, alpha: MOTION_ALPHA })
      }

      // dy — signed, centred at lane midpoint
      if (stats.dyAbs > 0) {
        const sc = laneHalf / stats.dyAbs
        _strokeCurve(curve.dy, curve.times, startIdx, xScale, v => laneMid - v * sc, w)
        motionGfx.stroke({ width: MOTION_LINE_W, color: MOTION_DY_COLOR, alpha: MOTION_ALPHA })
      }

      // velocity — positive only, grows upward from lane bottom
      if (stats.velMax > 0) {
        const sc = (laneBot - laneTop) / stats.velMax
        _strokeCurve(curve.velocity, curve.times, startIdx, xScale, v => laneBot - v * sc, w)
        motionGfx.stroke({ width: MOTION_LINE_W, color: MOTION_VEL_COLOR, alpha: MOTION_ALPHA })
      }
    }
  }

  function render() {
    if (!app) return
    canvasHeight()  // updates contentHeight bindable
    renderSummaryLayer()
    renderSignalLayer()
    renderRulerLayer()
    renderLaneBackground()
    repositionBarObjs()
    renderMotionCurves()
    renderSelectionLayer()
    renderLoopLayer()
    renderPlayhead()
    renderTicks()
    renderCursor()
    if (onViewChange) onViewChange(app.screen.width / (viewEnd - viewStart))
  }

  // Pan/zoom: static layers (lane bg, summary bars) are skipped; only moving parts redrawn
  function renderOnViewChange() {
    if (!app) return
    renderSummaryViewport()
    renderSignalLayer()
    renderRulerLayer()
    repositionBarObjs()
    renderMotionCurves()
    renderSelectionLayer()
    renderLoopLayer()
    renderPlayhead()
    renderTicks()
    renderCursor()
    if (onViewChange) onViewChange(app.screen.width / (viewEnd - viewStart))
  }

  function renderPlayhead() {
    if (!app) return
    if (onFps) {
      const now = performance.now()
      _fpsFrameCount++
      if (now - _fpsLastTime >= 500) {
        onFps(Math.round(_fpsFrameCount * 1000 / (now - _fpsLastTime)))
        _fpsFrameCount = 0
        _fpsLastTime = now
      }
    }
    const w = app.screen.width
    const h = app.screen.height
    const xScale = makeXScale()
    const smx = makeSummaryXScale()
    const ry = rulerY()

    // Main playhead
    playheadGfx.clear()
    const px = Math.round(xScale.map(localPlayhead))
    if (px >= 0 && px <= w) {
      playheadGfx.moveTo(px, ry).lineTo(px, h)
      playheadGfx.stroke({ width: 1.5, color: palette.playhead, alpha: 0.9 })
      playheadGfx.poly([px - 4, ry, px + 4, ry, px, ry + 7]).fill(palette.playhead)
    }

    // Summary playhead
    summaryPlayheadGfx.clear()
    const sphx = Math.round(smx.map(localPlayhead))
    if (sphx >= 0 && sphx <= w) {
      const sry = summaryRulerY
      summaryPlayheadGfx.moveTo(sphx, sry).lineTo(sphx, SUMMARY_RULER_H + SUMMARY_H)
      summaryPlayheadGfx.stroke({ width: 1.5, color: palette.playhead, alpha: 0.9 })
      summaryPlayheadGfx.poly([sphx - 4, sry, sphx + 4, sry, sphx, sry + 7]).fill(palette.playhead)
    }

    // External hover cursor (e.g. trajectory hover from video panel)
    if (_hoverCursorT !== null) {
      const hx = Math.round(xScale.map(_hoverCursorT))
      if (hx >= 0 && hx <= w) {
        playheadGfx.moveTo(hx, ry).lineTo(hx, h)
        playheadGfx.stroke({ width: 1, color: 0x888888, alpha: 0.7 })
        playheadGfx.poly([hx - 4, ry, hx + 4, ry, hx, ry + 7]).fill({ color: 0x888888, alpha: 0.7 })
      }
    }
  }

  function renderCursor() {
    if (!app) return
    const w = app.screen.width
    const h = app.screen.height
    const xScale = makeXScale()
    const ry = rulerY()
    cursorGfx.clear()

    // Compute signal band caches — reused for cursor rendering and snap zone detection
    const sigLayouts = mouseIsOver ? buildSignalLayouts() : null
    const specBands: Array<{ y: number; bottom: number; ch: SignalChannel }> = []
    const waveBands: Array<{ y: number; bottom: number }> = []
    if (sigLayouts) {
      for (const ch of _signals) {
        const sl = sigLayouts.get(ch.id)
        if (!sl) continue
        if (ch.kind === 'spectrogram' && ch.maxFreqHz) {
          specBands.push({ y: sl.y, bottom: sl.y + sl.specH, ch })
        } else if (ch.kind === 'waveform') {
          waveBands.push({ y: sl.y, bottom: sl.y + sl.specH })
        }
      }
      specBands.sort((a, b) => a.y - b.y)
    }
    _specBandCache    = specBands
    _waveformBandCache = waveBands

    // Update mouse frequency fraction — 0 = lowest freq, 1 = highest
    _mouseFreqFraction = null
    for (const band of specBands) {
      if (curMouseY >= band.y && curMouseY < band.bottom) {
        _mouseFreqFraction = 1 - (curMouseY - band.y) / (band.bottom - band.y)
        break
      }
    }

    if (mouseIsOver && curMouseY >= ry && curMouseY < h) {
      let cxRaw = curMouseX
      const dd = drag
      if (dd.kind === 'moveBar' || dd.kind === 'resizeLeft' || dd.kind === 'resizeRight') {
        const barObj = barObjs.get(dd.nodeId) ?? [...barObjs.values()].find(o => o.bar.nodeId === dd.nodeId)
        if (barObj) {
          const times = getBarTimes(barObj.bar)
          const indicatorT = dd.kind === 'resizeRight' ? times.end : times.start
          cxRaw = xScale.map(indicatorT)
        }
      }
      const cx = Math.round(cxRaw)
      if (cx >= 0 && cx <= w) {
        cursorGfx.moveTo(cx, ry).lineTo(cx, h).stroke({ width: 1, color: palette.textDark, alpha: 0.3 })
      }
    }

    const pxPerSec = w / (viewEnd - viewStart)
    const adaptiveSnapR = 8 / pxPerSec

    const d = drag
    if (_snapEnabled) {
      let indicatorX: number | null = null
      if (d.kind === 'resizeLeft') {
        const rawT = d.origStart + (curMouseX - d.startX) / pxPerSec
        const snapped = snapTime(rawT, adaptiveSnapR)
        if (snapped !== rawT) indicatorX = xScale.map(snapped)
      } else if (d.kind === 'resizeRight') {
        const rawT = d.origEnd + (curMouseX - d.startX) / pxPerSec
        const snapped = snapTime(rawT, adaptiveSnapR)
        if (snapped !== rawT) indicatorX = xScale.map(snapped)
      } else if (d.kind === 'moveBar') {
        const dur = d.origEnd - d.origStart
        const cursorTime = xScale.invert(curMouseX)
        const rawStart = cursorTime - d.grabOffset
        const rawEnd = rawStart + dur
        const snappedStart = snapTime(rawStart, adaptiveSnapR)
        const snappedEnd = snapTime(rawEnd, adaptiveSnapR)
        const deltaStart = Math.abs(snappedStart - rawStart)
        const deltaEnd = Math.abs(snappedEnd - rawEnd)
        if (snappedStart !== rawStart && snappedEnd !== rawEnd) {
          indicatorX = xScale.map(deltaStart <= deltaEnd ? snappedStart : snappedEnd)
        } else if (snappedStart !== rawStart) {
          indicatorX = xScale.map(snappedStart)
        } else if (snappedEnd !== rawEnd) {
          indicatorX = xScale.map(snappedEnd)
        }
      } else if (d.kind === 'selection') {
        const rawT = xScale.invert(curMouseX)
        const snapped = snapTime(rawT, adaptiveSnapR)
        if (snapped !== rawT) indicatorX = xScale.map(snapped)
      }
      if (indicatorX !== null) {
        const sx = Math.round(indicatorX)
        cursorGfx.moveTo(sx, audioStartY()).lineTo(sx, h).stroke({ width: 1.5, color: palette.primary, alpha: 0.8 })
      }
    }

    // Horizontal Hz crosshair + Hz readout
    let hzHit: number | null = null
    if (mouseIsOver) {
      for (const band of specBands) {
        if (curMouseY < band.y || curMouseY >= band.bottom) continue
        const lineY = Math.round(curMouseY)
        cursorGfx.moveTo(0, lineY).lineTo(w, lineY).stroke({ width: 1, color: palette.textDark, alpha: 0.3 })
        hzHit = band.ch.maxFreqHz! * (1 - (curMouseY - band.y) / (band.bottom - band.y))
        break
      }
    }
    if (onHzChange) onHzChange(hzHit)
  }

  // Hit testing

  function hitBar(x: number, y: number): { bar: BarItem; edge: 'left' | 'right' | null } | null {
    const xScale  = makeXScale()
    const layouts = buildLaneLayouts()
    const t       = xScale.invert(x)
    const epsilon = xScale.invert(x + EDGE_ZONE) - t  // edge zone in time units

    const candidates = barTree.search(t - epsilon, t + epsilon)
    let edgeHit: { bar: BarItem; edge: 'left' | 'right' } | null = null
    for (const id of candidates) {
      const bar = barObjs.get(id)?.bar
      if (!bar) continue
      const lo = layouts.get(bar.laneId)
      if (!lo) continue
      const { start, end } = getBarTimes(bar)
      const bx = xScale.map(start)
      const bw = xScale.map(end) - bx
      const barInset = bar.type === 'token' ? WORD_INSET : BAR_INSET
      const by = lo.y + barInset
      const bh = lo.height - barInset * 2
      if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
        if (x > bx + EDGE_ZONE && x < bx + bw - EDGE_ZONE) return { bar, edge: null }
        const edge: 'left' | 'right' = x <= bx + EDGE_ZONE ? 'left' : 'right'
        if (!edgeHit) edgeHit = { bar, edge }
      }
    }
    return edgeHit
  }

  function canvasXY(e: PointerEvent): [number, number] {
    const rect = canvasEl.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  // Pointer handlers

  function onPointerDown(e: PointerEvent) {
    const [x, y] = canvasXY(e)
    mouseDownX = x
    curMouseX = x
    curMouseY = y
    canvasEl.setPointerCapture(e.pointerId)

    if (y < SUMMARY_RULER_H) {
      // Summary ruler → seek playhead
      const smx = makeSummaryXScale()
      const t = smx.invert(x)
      localPlayhead = t
      onSeek?.(t)
      drag = { kind: 'summarySeek' }
      canvasEl.style.cursor = 'text'
      renderPlayhead()
      return
    }

    if (y < SUMMARY_RULER_H + SUMMARY_H) {
      // Summary bars strip → navigate or drag viewport
      const smx = makeSummaryXScale()
      const vx1 = smx.map(viewStart)
      const vx2 = smx.map(viewEnd)
      if (x >= vx1 - 4 && x <= vx2 + 4) {
        drag = { kind: 'summaryDrag', startViewStart: viewStart, startViewEnd: viewEnd, startX: x }
        canvasEl.style.cursor = 'grabbing'
      } else {
        const t = smx.invert(x)
        const dur = viewEnd - viewStart
        viewStart = t - dur / 2
        viewEnd   = t + dur / 2
        renderOnViewChange()
      }
      return
    }

    if (y < laneStartY()) {
      // Check for tick click in the ruler zone
      if (y >= rulerY() && _ticks.length > 0) {
        const xScale = makeXScale()
        for (const tick of _ticks) {
          const tx = xScale.map(tick.timeSeconds)
          if (Math.abs(x - tx) <= 5) {
            onSelectBar?.(tick.id)
            onSeek?.(tick.timeSeconds)
            localPlayhead = tick.timeSeconds
            drag = { kind: 'seek' }
            canvasEl.style.cursor = 'text'
            renderPlayhead()
            return
          }
        }
      }
      // Audio channel zone or ruler → seek
      drag = { kind: 'seek' }
      canvasEl.style.cursor = 'text'
      const t = makeXScale().invert(x)
      localPlayhead = t
      onSeek?.(t)
      renderPlayhead()
      return
    }

    // Check for tick click in lane zone
    if (_ticks.length > 0) {
      const xScale = makeXScale()
      const layouts = buildLaneLayouts()
      for (const tick of _ticks) {
        if (!tick.laneId) continue
        const lo = layouts.get(tick.laneId)
        if (!lo) continue
        if (y < lo.y + lo.height - TICK_H - 2 || y > lo.y + lo.height + 2) continue
        const tx = xScale.map(tick.timeSeconds)
        if (Math.abs(x - tx) <= 5) {
          onSelectBar?.(tick.id)
          onSeek?.(tick.timeSeconds)
          localPlayhead = tick.timeSeconds
          drag = { kind: 'seek' }
          canvasEl.style.cursor = 'text'
          renderPlayhead()
          return
        }
      }
    }

    const hit = hitBar(x, y)
    if (hit?.bar.suggestionKind) console.log('[tl] hit suggestion bar', hit.bar.nodeId, 'selected=', _selectedId, 'edge=', hit.edge)
    if (!hit && _bars.some(b => b.suggestionKind === 'add')) {
      const t = makeXScale().invert(x)
      const ghostBars = _bars.filter(b => b.suggestionKind === 'add')
      const layouts = buildLaneLayouts()
      console.log('[tl] no hit, ghost bars:', ghostBars.map(b => ({ id: b.id, start: b.start.toFixed(3), end: b.end.toFixed(3), laneId: b.laneId, inLayout: !!layouts.get(b.laneId), treeHit: barTree.search(b.start - 0.01, b.end + 0.01).includes(b.id) })), 'click t=', t.toFixed(3), 'y=', y)
    }
    if (hit) {
      const { bar, edge } = hit

      // Right-click: fire bar context menu, no drag
      if (e.button === 2) {
        const t = makeXScale().invert(x)
        onBarContextMenu?.(bar.nodeId, t, e.clientX, e.clientY)
        canvasEl.releasePointerCapture(e.pointerId)
        return
      }

      // Ctrl+click: split annotation at click time
      if (e.ctrlKey) {
        const t = makeXScale().invert(x)
        onBarCtrlClick?.(bar.nodeId, t)
        canvasEl.releasePointerCapture(e.pointerId)
        return
      }

      if (!bar.locked && bar.constraint === 'time_subdivision') {
        // time_subdivision bars: single-click-drag — whole bar is a resize handle.
        // Left half → resize left edge, right half → resize right edge.
        // Works on first click (select + start pending) and second click alike.
        onSelectBar?.(bar.nodeId)
        const xs = makeXScale()
        const bx = xs.map(bar.start)
        const bw = xs.map(bar.end) - bx
        const clickEdge: 'left' | 'right' = (edge !== null) ? edge : (x <= bx + bw / 2 ? 'left' : 'right')
        if (clickEdge === 'left') {
          const sib = _findTimeSubdivSibling(bar, 'left')
          if (sib) {
            _pendingEdge = { kind: 'resizeLeft', nodeId: bar.nodeId, origStart: bar.start, origEnd: bar.end, startX: x,
              minStart: sib.start, siblingId: sib.nodeId, siblingOrigEnd: sib.end }
          }
        } else {
          const sib = _findTimeSubdivSibling(bar, 'right')
          if (sib) {
            _pendingEdge = { kind: 'resizeRight', nodeId: bar.nodeId, origStart: bar.start, origEnd: bar.end, startX: x,
              maxEnd: sib.end, siblingId: sib.nodeId, siblingOrigStart: sib.start }
          }
        }
      } else if (bar.nodeId !== _selectedId) {
        // First click on non-subdivision bar: select only
        _selectedEdge = null
        _pendingEdge = null
        onSelectBar?.(bar.nodeId)
      } else if (!bar.locked && bar.constraint !== 'symbolic_association' && bar.constraint !== 'symbolic_subdivision') {
        // Already selected: Audacity-style — use pending edge for resize,
        // commit to real drag only after movement threshold (see onPointerMove).
        const { minStart, maxEnd, maxStart, minEnd } = dragBoundsFor(bar)
        if (edge === 'left') {
          _pendingEdge = { kind: 'resizeLeft', nodeId: bar.nodeId, origStart: bar.start, origEnd: bar.end, startX: x, minStart, ...(maxStart !== undefined ? { maxStart } : {}) }
        } else if (edge === 'right') {
          _pendingEdge = { kind: 'resizeRight', nodeId: bar.nodeId, origStart: bar.start, origEnd: bar.end, startX: x, maxEnd, ...(minEnd !== undefined ? { minEnd } : {}) }
        } else {
          _selectedEdge = null
          const grabOffset = makeXScale().invert(x) - bar.start
          drag = { kind: 'moveBar', nodeId: bar.nodeId, origStart: bar.start, origEnd: bar.end, startX: x, minStart, maxEnd, grabOffset }
        }
      }
    } else {
      // Click on empty lane: deselect + start selection drag
      _selectedEdge = null
      _pendingEdge = null
      if (_selectedId) onSelectBar?.(null)
      const rawT = makeXScale().invert(x)
      const snapR = 8 / ((app?.screen.width ?? 800) / (viewEnd - viewStart))
      const t = _snapEnabled ? snapTime(rawT, snapR) : rawT
      const laneId = hitLane(y)
      drag = { kind: 'selection', startTime: t, laneId }
      selection = null
      canvasEl.style.cursor = 'crosshair'
    }
  }

  function onPointerMove(e: PointerEvent) {
    const [x, y] = canvasXY(e)
    curMouseX = x
    curMouseY = y

    // Keep _mouseFreqFraction current using the cached band geometry.
    // renderCursor (called later in this frame) also updates it, but we need
    // it for snap calculations that happen before renderCursor runs.
    _mouseFreqFraction = null
    for (const band of _specBandCache) {
      if (y >= band.y && y < band.bottom) {
        _mouseFreqFraction = 1 - (y - band.y) / (band.bottom - band.y)
        break
      }
    }

    // Commit pending edge to drag once movement exceeds threshold
    if (_pendingEdge && Math.abs(x - _pendingEdge.startX) > 3) {
      drag = _pendingEdge
      _pendingEdge = null
      _selectedEdge = null
    }

    if (drag.kind === 'seek') {
      const t = makeXScale().invert(x)
      localPlayhead = t
      onSeek?.(t)
      renderPlayhead()
      return
    }

    if (drag.kind === 'summarySeek') {
      const t = makeSummaryXScale().invert(x)
      localPlayhead = t
      onSeek?.(t)
      renderPlayhead()
      return
    }

    if (drag.kind === 'summaryDrag') {
      const smx = makeSummaryXScale()
      const dt = smx.invert(x) - smx.invert(drag.startX)
      viewStart = drag.startViewStart + dt
      viewEnd   = drag.startViewEnd   + dt
      renderOnViewChange()
      return
    }

    if (drag.kind === 'selection') {
      const rawT = makeXScale().invert(x)
      const snapR = 8 / ((app?.screen.width ?? 800) / (viewEnd - viewStart))
      const t = _snapEnabled ? snapTime(rawT, snapR) : rawT
      const s = Math.min(drag.startTime, t)
      const en = Math.max(drag.startTime, t)
      selection = en - s > 0.01 ? { start: s, end: en } : null
      onSelectionChange?.(selection)
      canvasEl.style.cursor = 'crosshair'
      renderSelectionLayer()
      renderCursor()
      return
    }

    if (drag.kind === 'none') {
      if (y < SUMMARY_RULER_H) {
        canvasEl.style.cursor = 'text'
      } else if (y < SUMMARY_RULER_H + SUMMARY_H) {
        canvasEl.style.cursor = 'grab'
      } else if (y < laneStartY()) {
        canvasEl.style.cursor = 'text'
      } else {
        const hit = hitBar(x, y)
        if (hit) {
          if (hit.bar.nodeId === _selectedId && hit.bar.constraint !== 'symbolic_subdivision' && hit.bar.constraint !== 'symbolic_association') {
            canvasEl.style.cursor = (hit.edge === 'left' || hit.edge === 'right') ? 'ew-resize' : 'grab'
          } else {
            canvasEl.style.cursor = 'pointer'
          }
        } else {
          canvasEl.style.cursor = 'crosshair'
        }
        // Suggestion hover tracking
        const sugBar = hit?.bar.suggestionKind && hit.bar.suggestionId ? hit.bar : null
        if (sugBar) {
          if (sugBar.id !== _hoveredSugBarId) {
            _hoveredSugBarId = sugBar.id
          }
          onBarSuggestionHover?.(sugBar.suggestionId!, e.clientX, e.clientY)
        } else if (_hoveredSugBarId !== null) {
          _hoveredSugBarId = null
          onBarSuggestionHover?.(null, e.clientX, e.clientY)
        }
      }
      renderCursor()
      return
    }

    const d = drag
    if (d.kind === 'moveBar' || d.kind === 'resizeLeft' || d.kind === 'resizeRight') {
      canvasEl.style.cursor = d.kind === 'moveBar' ? 'grabbing' : 'ew-resize'
      const xScale     = makeXScale()
      const layouts    = buildLaneLayouts()
      const w          = app!.screen.width
      const draggedObj = barObjs.get(d.nodeId)
      if (draggedObj) {
        _applyBarObj(draggedObj, draggedObj.bar, xScale, layouts, w)
        _applyDescendants(d.nodeId, xScale, layouts, w)
        // Update sibling for time_subdivision shared boundary
        if ((d.kind === 'resizeLeft' || d.kind === 'resizeRight') && d.siblingId) {
          const sibObj = barObjs.get(d.siblingId) ?? [...barObjs.values()].find(o => o.bar.nodeId === d.siblingId)
          if (sibObj) _applyBarObj(sibObj, sibObj.bar, xScale, layouts, w)
        }
        getBarTimes(draggedObj.bar)
        // Draw only the dragged bar's selection border — skip full _bars scan
        _renderDragBorder(draggedObj.bar, xScale, layouts)
      }
      renderCursor()
      return
    }
  }

  function onPointerUp(e: PointerEvent) {
    const [x, y] = canvasXY(e)
    canvasEl.releasePointerCapture(e.pointerId)
    const moved = Math.abs(x - mouseDownX) > 3

    if (drag.kind === 'seek' || drag.kind === 'summarySeek') {
      drag = { kind: 'none' }
      canvasEl.style.cursor = 'default'
      renderCursor()
      return
    }

    if (drag.kind === 'summaryDrag') {
      drag = { kind: 'none' }
      canvasEl.style.cursor = 'default'
      renderCursor()
      return
    }

    if (drag.kind === 'selection') {
      if (selection) {
        // Keep selection visible; user commits with Enter
        selectionLaneId = drag.laneId
        onSelectionActive?.(true)
        wrapEl.focus()
      } else {
        onSelectionActive?.(false)
        onSelectionChange?.(null)
      }
      drag = { kind: 'none' }
      canvasEl.style.cursor = 'crosshair'
      renderSelectionLayer()
      renderCursor()
      return
    }

    // Pending edge click without movement → select the edge
    if (_pendingEdge) {
      const side: 'left' | 'right' = _pendingEdge.kind === 'resizeLeft' ? 'left' : 'right'
      _selectedEdge = { barId: _pendingEdge.nodeId, side }
      _pendingEdge = null
      _renderBarBorders(makeXScale(), buildLaneLayouts())
    }

    if (moved) {
      lastUp = null
      const d = drag
      if (d.kind === 'moveBar' || d.kind === 'resizeLeft' || d.kind === 'resizeRight') {
        const bar = _bars.find(b => b.nodeId === d.nodeId)
        if (bar) {
          const { start, end } = getBarTimes(bar)
          // Update only this bar's sprite + tree entry — no full resync
          const obj = barObjs.get(bar.id) ?? [...barObjs.values()].find(o => o.bar.nodeId === d.nodeId)
          if (obj) {
            const xScale  = makeXScale()
            const layouts = buildLaneLayouts()
            const w       = app.screen.width

            // Collect all positions first (drag still active — getBarTimes correct for all depths)
            function collectDescendants(
              id: string,
              out: Array<{obj: BarObj; newStart: number; newEnd: number; origStart: number; origEnd: number}>
            ) {
              const childIds = barChildren.get(id)
              if (!childIds) return
              for (const cid of childIds) {
                const childObj = barObjs.get(cid)
                if (!childObj) continue
                const { start: cs, end: ce } = getBarTimes(childObj.bar)
                out.push({ obj: childObj, newStart: cs, newEnd: ce, origStart: childObj.bar.start, origEnd: childObj.bar.end })
                collectDescendants(cid, out)
              }
            }

            const updates: Array<{obj: BarObj; newStart: number; newEnd: number; origStart: number; origEnd: number}> = []
            updates.push({ obj, newStart: start, newEnd: end, origStart: d.origStart, origEnd: d.origEnd })
            collectDescendants(d.nodeId, updates)

            // Sibling coupling: commit shared boundary for time_subdivision
            if ((d.kind === 'resizeLeft' || d.kind === 'resizeRight') && d.siblingId) {
              const sibBar = _bars.find(b => b.nodeId === d.siblingId)
              if (sibBar) {
                const { start: ss, end: se } = getBarTimes(sibBar)
                const sibObj = barObjs.get(sibBar.id) ?? [...barObjs.values()].find(o => o.bar.nodeId === d.siblingId)
                if (sibObj) {
                  const origS = d.kind === 'resizeRight' ? (d.siblingOrigStart ?? sibBar.start) : sibBar.start
                  const origE = d.kind === 'resizeLeft'  ? (d.siblingOrigEnd   ?? sibBar.end)   : sibBar.end
                  updates.push({ obj: sibObj, newStart: ss, newEnd: se, origStart: origS, origEnd: origE })
                }
              }
            }

            // Build commit payload before mutating bar objects.
            // Exclude symbolic_subdivision bars: their timing is derived from the parent
            // and must not be stored independently.
            const commitPayload: CommitEntry[] = updates
              .filter(entry => entry.obj.bar.constraint !== 'symbolic_subdivision')
              .map(entry => ({
                nodeId: entry.obj.bar.nodeId,
                start:  entry.newStart,
                end:    entry.newEnd,
                origStart: entry.origStart,
                origEnd:   entry.origEnd,
              }))

            // Apply sprite/tree updates
            for (const { obj: u, newStart, newEnd, origStart: os, origEnd: oe } of updates) {
              barTree.remove(os, oe, u.bar.id)
              barTree.insert(newStart, newEnd, u.bar.id)
              u.bar = { ...u.bar, start: newStart, end: newEnd }
              _applyBarObj(u, u.bar, xScale, layouts, w)
            }

            // Commit all to backing stores in one batch
            onCommitBars?.(commitPayload)

            _renderBarBorders(xScale, layouts)
          }
        }
      }
    } else {
      const hit = hitBar(x, y)
      if (hit && onBarDblClick) {
        const now = Date.now()
        if (lastUp && lastUp.barId === hit.bar.nodeId && now - lastUp.time < 300) {
          onBarDblClick(hit.bar.nodeId, e.clientX, e.clientY)
          lastUp = null
        } else {
          lastUp = { time: now, barId: hit.bar.nodeId }
        }
      } else {
        lastUp = null
      }
    }

    drag = { kind: 'none' }
    canvasEl.style.cursor = 'default'
    renderCursor()
  }

  function onWheel(e: WheelEvent) {
    if (e.ctrlKey) {
      e.preventDefault()
      const rect = canvasEl.getBoundingClientRect()
      const x = e.clientX - rect.left
      const cursorTime = makeXScale().invert(x)
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15
      const dur = (viewEnd - viewStart) * factor
      const ratio = (cursorTime - viewStart) / (viewEnd - viewStart)
      viewStart = cursorTime - ratio * dur
      viewEnd = viewStart + dur
      renderOnViewChange()
    } else if (e.shiftKey) {
      e.preventDefault()
      // WebKitGTK (Tauri/Linux) converts shift+scroll to deltaX; fall back accordingly
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX
      const dt = delta * (viewEnd - viewStart) / app.screen.width
      viewStart += dt
      viewEnd += dt
      renderOnViewChange()
    }
    // No modifier: let event bubble so the parent container scrolls vertically
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && selection) {
      e.preventDefault()
      onSelection?.(selection.start, selection.end, selectionLaneId)
      selection = null
      onSelectionActive?.(false)
      onSelectionChange?.(null)
      render()
    } else if (_selectedEdge && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      onNudgeEdge?.(_selectedEdge.barId, _selectedEdge.side, dir)
    } else if (e.key === 'Escape') {
      selection = null
      onSelectionActive?.(false)
      onSelectionChange?.(null)
      if (_selectedId) onSelectBar?.(null)
      _selectedEdge = null
      render()
    }
  }

  // Resize

  let ro: ResizeObserver

  function onResize() {
    if (!app || !wrapEl) return
    app.renderer.resize(wrapEl.clientWidth, canvasHeight())
    render()
  }

  let _resizePending = false
  function scheduleResize() {
    if (_resizePending) return
    _resizePending = true
    requestAnimationFrame(() => { _resizePending = false; onResize() })
  }

  // Lifecycle

  onMount(async () => {
    const _app = new PIXI.Application()
    await _app.init({
      width: wrapEl.clientWidth,
      height: canvasHeight(),
      background: palette.bg2,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })
    app = _app  // assign only after renderer is ready; guards like `if (!app) return` stay valid

    canvasEl = app.canvas
    canvasEl.style.display = 'block'
    // eslint-disable-next-line svelte/no-dom-manipulating -- PIXI owns this canvas; Svelte never renders into wrapEl
    wrapEl.appendChild(canvasEl)

    rulerGfx       = new PIXI.Graphics()
    laneGfx        = new PIXI.Graphics()
    barContainer   = new PIXI.Container()
    barBorderGfx   = new PIXI.Graphics()
    arcGfx         = new PIXI.Graphics()
    playheadGfx    = new PIXI.Graphics()
    selectionGfx   = new PIXI.Graphics()
    loopGfx        = new PIXI.Graphics()
    cursorGfx      = new PIXI.Graphics()
    peerGfx        = new PIXI.Graphics()
    signalGfx      = new PIXI.Graphics()
    signalContainer = new PIXI.Container()
    hzGfx             = new PIXI.Graphics()
    hzLabelContainer  = new PIXI.Container()
    tierLabelContainer = new PIXI.Container()
    tickGfx               = new PIXI.Graphics()
    motionGfx             = new PIXI.Graphics()
    summaryGfx            = new PIXI.Graphics()
    summaryViewportGfx    = new PIXI.Graphics()
    summaryPlayheadGfx    = new PIXI.Graphics()
    labelContainer        = new PIXI.Container()
    rulerLabelContainer   = new PIXI.Container()
    summaryLabelContainer = new PIXI.Container()
    _whiteTex = PIXI.Texture.WHITE

    app.stage.addChild(laneGfx)
    app.stage.addChild(signalGfx)
    app.stage.addChild(signalContainer)
    app.stage.addChild(hzGfx)
    app.stage.addChild(hzLabelContainer)
    app.stage.addChild(tierLabelContainer)
    app.stage.addChild(rulerGfx)
    app.stage.addChild(rulerLabelContainer)
    app.stage.addChild(tickGfx)
    app.stage.addChild(selectionGfx)
    app.stage.addChild(loopGfx)
    app.stage.addChild(barContainer)
    app.stage.addChild(motionGfx)
    app.stage.addChild(barBorderGfx)
    app.stage.addChild(arcGfx)
    app.stage.addChild(peerGfx)
    app.stage.addChild(labelContainer)
    app.stage.addChild(playheadGfx)
    app.stage.addChild(summaryGfx)
    app.stage.addChild(summaryLabelContainer)
    app.stage.addChild(summaryViewportGfx)
    app.stage.addChild(summaryPlayheadGfx)
    app.stage.addChild(cursorGfx)

    const timed = _bars.filter(b => !b.placeholder && b.type !== 'token')
    if (timed.length > 0) {
      const minT = Math.min(...timed.map(b => b.start))
      const maxT = Math.max(...timed.map(b => b.end))
      const pad  = Math.max((maxT - minT) * 0.1, 0.5)
      viewStart  = Math.max(0, minT - pad)
      viewEnd    = maxT + pad
    }

    renderLaneBackground()
    renderSignalLayer()
    renderRulerLayer()
    renderSelectionLayer()
    renderLoopLayer()
    renderPlayhead()
    renderCursor()

    canvasEl.addEventListener('pointerdown',  onPointerDown)
    canvasEl.addEventListener('pointermove',  onPointerMove)
    canvasEl.addEventListener('pointerup',    onPointerUp)
    canvasEl.addEventListener('wheel',        onWheel, { passive: false })
    canvasEl.addEventListener('contextmenu',  (e) => { e.preventDefault() })
    canvasEl.addEventListener('mouseenter',   () => { mouseIsOver = true;  renderCursor() })
    canvasEl.addEventListener('mouseleave',   () => {
      mouseIsOver = false
      renderCursor()
      if (_hoveredSugBarId !== null) {
        _hoveredSugBarId = null
        onBarSuggestionHover?.(null, 0, 0)
      }

    })
    wrapEl.addEventListener('keydown', onKeyDown)

    _unsubTimeKeeper = timeKeeper?.onSeek((t) => {
      localPlayhead = t
      if (isPlaying && app) {
        const w = app.screen.width
        const duration = viewEnd - viewStart
        const pxPerSec = w / duration
        const px = (t - viewStart) * pxPerSec
        if (px >= w - 10) {
          viewStart = t - 10 / pxPerSec
          viewEnd = viewStart + duration
          renderOnViewChange()
          return
        }
      }
      renderPlayhead()
    })

    ro = new ResizeObserver(onResize)
    ro.observe(wrapEl)
  })

  onDestroy(() => {
    _unsubTimeKeeper?.()
    ro?.disconnect()
    app?.destroy(true, { children: true })
  })

  // Lane panel helpers

  function laneIndentLevel(lane: Lane): number {
    const id = lane.id
    if (id.startsWith('participant:'))  return 0
    if (id.startsWith('tokens:'))    return 1
    if (id.startsWith('ann:'))      return 1 + (lane.depth ?? 0)
    if (id.startsWith('viz:'))      return 1 + (lane.depth ?? 0)
    return 0
  }

  function isAncestorColumnOpen(rows: {indent: number}[], rowIdx: number, col: number): boolean {
    for (let j = rowIdx + 1; j < rows.length; j++) {
      const row = rows[j]!
      if (row.indent <= col) return false      // crossed back up past this column — no sibling
      if (row.indent === col + 1) return true  // found a sibling of the ancestor at this column
    }
    return false
  }

  function hasMoreSiblingsBelow(rows: {indent: number}[], rowIdx: number): boolean {
    const d = rows[rowIdx]?.indent ?? 0
    if (d === 0) return false
    for (let j = rowIdx + 1; j < rows.length; j++) {
      const row = rows[j]!
      if (row.indent < d)  return false
      if (row.indent === d) return true
    }
    return false
  }

  interface PanelRow {
    lane: Lane
    height: number
    indent: number
    isGroupStart: boolean
    svgLines: Array<{ x1: number; y1: number; x2: number; y2: number }>
  }

  function buildPanelRows(): PanelRow[] {
    const vl = visibleLanes()
    const simple = vl.map(lane => ({
      lane,
      indent: laneIndentLevel(lane),
      height: lane.type === 'participant' ? UTT_H : lane.type === 'token' ? WORD_H : EVT_H,
    }))

    return simple.map((row, i) => {
      const h = row.height
      const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
      for (let c = 0; c < row.indent; c++) {
        const cx = c * INDENT_PX + 5
        if (c < row.indent - 1) {
          if (isAncestorColumnOpen(simple, i, c)) {
            lines.push({ x1: cx, y1: 0, x2: cx, y2: h })
          }
        } else {
          lines.push({ x1: cx, y1: 0, x2: cx, y2: h / 2 })
          if (hasMoreSiblingsBelow(simple, i)) {
            lines.push({ x1: cx, y1: h / 2, x2: cx, y2: h })
          }
          lines.push({ x1: cx, y1: h / 2, x2: (c + 1) * INDENT_PX, y2: h / 2 })
        }
      }
      const isGroupStart = i > 0 && (row.lane.id.startsWith('participant:') || row.lane.id.startsWith('evt::'))
      return { lane: row.lane, height: h, indent: row.indent, isGroupStart, svgLines: lines }
    })
  }

  // Inline rename

  let editingLaneId = $state<string | null>(null)
  let editingValue  = $state('')

  function focusSelect(node: HTMLElement) {
    node.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(node)
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  function startLaneEdit(lane: Lane) {
    if (lane.type === 'token') return
    editingValue  = lane.label
    editingLaneId = lane.id
  }

  function commitLaneEdit(laneId: string, el: HTMLElement) {
    if (editingLaneId !== laneId) return
    const newLabel = el.textContent?.trim() ?? ''
    if (newLabel) onRenameLane?.(laneId, newLabel)
    editingLaneId = null
  }

  function cancelLaneEdit(el: HTMLElement, originalLabel: string) {
    editingLaneId = null
    el.textContent = originalLabel
  }

  function panelTypeBadge(type: string): string {
    return type === 'participant' ? 'S' : type === 'event' ? 'E' : type === 'token' ? 'T' : 'A'
  }

  function panelBadgeColor(lane: Lane): string {
    if (lane.color) return `#${lane.color.toString(16).padStart(6, '0')}`
    return lane.type === 'annotation' ? `#${palette.annotation.toString(16)}` : `#${palette.primary.toString(16)}`
  }

  function panelShowActor(lane: Lane): boolean {
    return !!(lane.participant && lane.participant !== lane.label &&
      lane.participant !== '_general' && lane.type !== 'token')
  }

  const panelRows = $derived(buildPanelRows())

  // Lane order sync helper (was $effect, now called imperatively from setLanes)

  function _syncLaneOrder(newLanes: Lane[]) {
    const incomingIds = newLanes.map(l => l.id)
    const incomingSet = new Set(incomingIds)
    const current = internalLaneOrder
    const filtered = current.filter(id => incomingSet.has(id))
    const filteredSet = new Set(filtered)
    const newIds = incomingIds.filter(id => !filteredSet.has(id))

    if (newIds.length === 0) {
      if (filtered.join(',') !== current.join(',')) internalLaneOrder = filtered
      return
    }

    // Insert each new lane at the position implied by incomingIds order rather than
    // appending to the end — this keeps child tiers adjacent to their parents.
    const incomingIdx = new Map(incomingIds.map((id, i) => [id, i]))
    const result = [...filtered]
    for (const newId of newIds) {
      const pos = incomingIdx.get(newId)!
      // Find the first already-placed lane whose incoming index is greater than ours.
      let insertAt = result.length
      for (let i = 0; i < result.length; i++) {
        const existing = incomingIdx.get(result[i]!)
        if (existing !== undefined && existing > pos) { insertAt = i; break }
      }
      result.splice(insertAt, 0, newId)
    }

    if (result.join(',') !== current.join(',')) internalLaneOrder = result
  }

  // Imperative API — all data flows in through these methods, never via $effect

  // Direct imperative seek — used when no TimeKeeper is provided.
  export function setPlayhead(t: number) {
    localPlayhead = t
    if (app) renderPlayhead()
  }

  export function setHoverCursor(t: number | null) {
    _hoverCursorT = t
    if (app) renderPlayhead()
  }

  /** Update the bar data set. Before initialRenderBars is called this is data-only.
   *  After initialRenderBars, also handles add/remove of sprites for structural changes
   *  and refreshes the summary when non-word bar times change. Word bar obj.bar is
   *  kept in sync with parent position changes (proportional remap on undo/external edits). */
  export function resetBars(newBars: BarItem[]) {
    _bars = newBars; _invalidateDocExtent()
    if (!_barsInitialized || !app || drag.kind !== 'none') return

    const newIdSet = new Set(newBars.map(b => b.id))
    let structuralChange = false
    let timesChanged = false
    let labelChanged = false

    // Add sprites for new bars
    for (const bar of newBars) {
      if (!barObjs.has(bar.id)) { _addBarObj(bar); structuralChange = true }
    }

    // Remove sprites for deleted bars (snapshot keys first to avoid mutation during iteration)
    for (const id of [...barObjs.keys()]) {
      if (!newIdSet.has(id)) { _removeBarObj(id); structuralChange = true }
    }

    // Sync obj.bar for non-word bars; proportionally remap child tokens when times change
    for (const bar of newBars) {
      if (bar.type === 'token') continue
      const obj = barObjs.get(bar.id)
      if (!obj) continue
      if (obj.bar.label !== bar.label) labelChanged = true
      if (obj.bar.start !== bar.start || obj.bar.end !== bar.end) {
        const oldStart = obj.bar.start
        const oldEnd   = obj.bar.end
        const oldDur   = oldEnd - oldStart
        barTree.remove(oldStart, oldEnd, bar.id)
        barTree.insert(bar.start, bar.end, bar.id)
        timesChanged = true

        // Proportionally remap direct children via barChildren index (O(children), not O(N))
        if (oldDur > 0) {
          const newDur = bar.end - bar.start
          const childIds = barChildren.get(bar.nodeId)
          if (childIds) {
            for (const cid of childIds) {
              const childObj = barObjs.get(cid)
              if (!childObj) continue
              const rs = (childObj.bar.start - oldStart) / oldDur
              const re = (childObj.bar.end   - oldStart) / oldDur
              barTree.remove(childObj.bar.start, childObj.bar.end, cid)
              childObj.bar = { ...childObj.bar, start: bar.start + rs * newDur, end: bar.start + re * newDur }
              barTree.insert(childObj.bar.start, childObj.bar.end, cid)
            }
          }
        }
      }
      obj.bar = bar
    }

    // Sync word bar positions from fresh docToTimeline data (authoritative over proportional remap)
    for (const bar of newBars) {
      if (bar.type !== 'token') continue
      const obj = barObjs.get(bar.id)
      if (!obj) continue
      if (obj.bar.start !== bar.start || obj.bar.end !== bar.end) {
        barTree.remove(obj.bar.start, obj.bar.end, bar.id)
        barTree.insert(bar.start, bar.end, bar.id)
        timesChanged = true
      }
      obj.bar = bar
    }

    if (structuralChange || timesChanged || labelChanged) repositionBarObjs()
    if (structuralChange || timesChanged) renderSummaryLayer()
  }

  /** Build sprites for all bars. Call once after the initial resetBars. */
  export function initialRenderBars() {
    if (app && wrapEl) app.renderer.resize(wrapEl.clientWidth, canvasHeight())
    _barsInitialized = true
    initialRenderBarObjs()
    renderSummaryLayer()
  }

  /** Update a single bar in place (label edit, time change from external source). */
  export function patchBar(bar: BarItem) {
    const idx = _bars.findIndex(b => b.id === bar.id)
    if (idx !== -1) _bars[idx] = bar
    if (app) updateBarObj(bar.id)
  }

  /** Add a single bar and create its sprite. Call when one annotation/utterance is created. */
  export function addBar(bar: BarItem) {
    _bars = [..._bars, bar]; _invalidateDocExtent()
    if (!app) return
    _addBarObj(bar)
    const xScale = makeXScale(); const layouts = buildLaneLayouts()
    _renderBarBorders(xScale, layouts)
    _renderPeerBarBorders(xScale, layouts)
    if (!bar.summaryHidden && bar.type !== 'token' && !bar.placeholder) renderSummaryLayer()
  }

  /** Remove a single bar and destroy its sprite. Call when one annotation/utterance is deleted. */
  export function removeBar(id: string) {
    _bars = _bars.filter(b => b.id !== id); _invalidateDocExtent()
    if (!app) return
    _removeBarObj(id)
    const xScale = makeXScale(); const layouts = buildLaneLayouts()
    _renderBarBorders(xScale, layouts)
    _renderPeerBarBorders(xScale, layouts)
    renderSummaryLayer()
  }

  /** Update lane list — syncs order state and redraws lane backgrounds. */
  export function setLanes(newLanes: Lane[]) {
    const oldHeight = laneZoneHeight()
    _syncLaneOrder(newLanes)
    _lanes = newLanes
    if (!app) return
    if (laneZoneHeight() !== oldHeight) scheduleResize()
    else { renderLaneBackground(); repositionBarObjs() }
  }

  /** Update signal channels — redraws signal layer; resizes canvas if channel set changed. */
  export function setSignals(newSignals: SignalChannel[]) {
    const oldKey = _signals.map(s => s.id).join(',')
    const newKey = newSignals.map(s => s.id).join(',')
    // Purge tile data for channels being removed (e.g. new file loaded).
    if (oldKey !== newKey) {
      const newIds = new Set(newSignals.map(s => s.id))
      for (const id of _spectrogramTiles.keys()) {
        if (!newIds.has(id)) {
          _spectrogramTiles.delete(id)
          const ov = _spectrogramOverviews.get(id)
          if (ov) { _overviewTexCache.get(ov)?.tex.destroy(false); _overviewTexCache.delete(ov) }
          _spectrogramOverviews.delete(id)
        }
      }
    }
    _signals = newSignals
    if (app) {
      renderSignalLayer()
      if (oldKey !== newKey) onResize()
    }
  }

  /** Replace the full set of relation arcs and redraw. */
  export function setArcs(newArcs: ArcItem[]) {
    _arcs = newArcs
    if (app) renderArcs(makeXScale(), buildLaneLayouts())
  }

  /**
   * Atomically update lanes, bars, ticks and arcs in one render pass.
   * Prefer this over four separate calls — it runs repositionBarObjs once
   * instead of twice and avoids redundant buildLaneLayouts() calls.
   */
  export function setData(data: { lanes: Lane[]; bars: BarItem[]; ticks: TickMark[]; arcs: ArcItem[] }): void {
    // 1. Update all data
    const oldHeight = laneZoneHeight()
    _syncLaneOrder(data.lanes)
    _lanes = data.lanes

    _bars = data.bars
    _invalidateDocExtent()

    _ticks = data.ticks
    _arcs  = data.arcs

    if (!app) return

    // 2. Sprite sync for bars (mirrors resetBars logic, without intermediate renders)
    if (_barsInitialized && drag.kind === 'none') {
      const newIdSet = new Set(data.bars.map(b => b.id))
      for (const bar of data.bars) {
        if (!barObjs.has(bar.id)) _addBarObj(bar)
      }
      for (const id of [...barObjs.keys()]) {
        if (!newIdSet.has(id)) _removeBarObj(id)
      }
      for (const bar of data.bars) {
        if (bar.type === 'token') continue
        const obj = barObjs.get(bar.id)
        if (!obj) continue
        if (obj.bar.start !== bar.start || obj.bar.end !== bar.end) {
          const oldStart = obj.bar.start; const oldEnd = obj.bar.end; const oldDur = oldEnd - oldStart
          barTree.remove(oldStart, oldEnd, bar.id)
          barTree.insert(bar.start, bar.end, bar.id)
          if (oldDur > 0) {
            const newDur = bar.end - bar.start
            const childIds = barChildren.get(bar.nodeId)
            if (childIds) {
              for (const cid of childIds) {
                const childObj = barObjs.get(cid)
                if (!childObj) continue
                const rs = (childObj.bar.start - oldStart) / oldDur
                const re = (childObj.bar.end   - oldStart) / oldDur
                barTree.remove(childObj.bar.start, childObj.bar.end, cid)
                childObj.bar = { ...childObj.bar, start: bar.start + rs * newDur, end: bar.start + re * newDur }
                barTree.insert(childObj.bar.start, childObj.bar.end, cid)
              }
            }
          }
        }
        obj.bar = bar
      }
      for (const bar of data.bars) {
        if (bar.type !== 'token') continue
        const obj = barObjs.get(bar.id)
        if (!obj) continue
        if (obj.bar.start !== bar.start || obj.bar.end !== bar.end) {
          barTree.remove(obj.bar.start, obj.bar.end, bar.id)
          barTree.insert(bar.start, bar.end, bar.id)
        }
        obj.bar = bar
      }
    }

    // 3. One consolidated render pass
    if (laneZoneHeight() !== oldHeight) {
      scheduleResize()
      return
    }
    renderLaneBackground()
    repositionBarObjs()   // positions bars, renders arcs + borders in one xScale pass
    renderSummaryLayer()
    renderTicks()
  }

  /** Update selection highlight — repaints bar alphas and borders. */
  export function setSelectedId(id: string | null) {
    _selectedId = id
    if (!app) return
    const xScale  = makeXScale()
    const layouts = buildLaneLayouts()
    for (const obj of barObjs.values()) {
      if (!obj.fill.visible) continue
      if (obj.bar.type === 'token') continue
      if (obj.bar.placeholder) {
        const lbl = obj.label
        if (lbl && lbl.visible) {
          const labelText = obj.bar.label || (obj.bar.nodeId === id ? '' : '(no time)')
          if (lbl.text !== labelText) lbl.text = labelText
        }
      } else {
        obj.fill.alpha = obj.bar.nodeId === _selectedId ? 0.55 : 0.45
      }
    }
    _renderBarBorders(xScale, layouts)
    _renderPeerBarBorders(xScale, layouts)
  }

  /** Update peer collaborator bar selections — draws colored outlines. */
  export function setPeerBarSelections(selections: { nodeId: string; color: string }[]) {
    _peerBarSelections = selections
    if (!app) return
    _renderPeerBarBorders(makeXScale(), buildLaneLayouts())
  }

  /** Toggle word-token lane visibility — resizes canvas and redraws. */
  export function setShowWords(show: boolean) {
    _showWords = show
    if (app) onResize()
  }

  /** Update loop-region overlay. */
  export function setLoopRegion(region: { start: number; end: number } | null) {
    _loopRegion = region
    if (app) renderLoopLayer()
  }

  /** Pan the viewport so that time t is visible, centering on it if it is out of view. */
  export function scrollToTime(t: number) {
    if (t >= viewStart && t <= viewEnd) return
    const dur = viewEnd - viewStart
    viewStart = t - dur / 2
    viewEnd   = viewStart + dur
    renderOnViewChange()
  }

  /** Programmatically set the selection region (e.g. from a track-overlay range drag). */
  export function setSelection(start: number, end: number) {
    selection = { start: Math.min(start, end), end: Math.max(start, end) }
    onSelectionChange?.(selection)
    if (app) renderSelectionLayer()
  }

  /** Enable/disable snap-to-onset. */
  export function setSnapEnabled(enabled: boolean) {
    _snapEnabled = enabled
  }

  /** Set the active snap mode ('all' | 'vad' | 'waveform' | 'spectrogram'). */
  export function setSnapMode(mode: SnapMode) {
    _snapMode = mode
  }

  /** Restrict snapping to a single signal channel by ID. Pass null to snap all channels. */
  export function setSnapChannel(id: string | null) {
    _snapChannelId = id
  }

  /** Set annotation boundary snap behaviour: 'all', 'same-lane', or 'none'. */
  export function setAnnotationSnapMode(mode: 'all' | 'same-lane' | 'none') {
    _annotationSnapMode = mode
  }

  /** Set VAD speech segments for annotation-tier snapping. */
  export function setVadSegments(segments: Array<{ start: number; end: number }>) {
    _vadSegments = segments
  }

  /** Set total media duration (used by summary ruler). */
  export function setTicks(newTicks: TickMark[]) {
    _ticks = newTicks
    if (app) renderTicks()
  }

  export function setMotionCurves(curves: MotionCurve[]) {
    _motionCurves = curves
    for (const c of curves) {
      let dxAbs = 0, dyAbs = 0, velMax = 0
      for (let i = 0; i < c.dx.length; i++) {
        const a = Math.abs(c.dx[i]!); if (a > dxAbs)  dxAbs  = a
        const b = Math.abs(c.dy[i]!); if (b > dyAbs)  dyAbs  = b
        if (c.velocity[i]! > velMax) velMax = c.velocity[i]!
      }
      _motionStats.set(c, { dxAbs, dyAbs, velMax })
    }
    if (app) renderMotionCurves()
  }

  export function setMediaDuration(duration: number | undefined) {
    _mediaDuration = duration
    if (app) renderSummaryLayer()
  }

  /** Set or replace the overview (low-res) texture for a spectrogram channel. */
  export function getSpectrogramOverviews(): Map<string, SpectrogramTile> {
    return new Map(_spectrogramOverviews)
  }

  export function setSpectrogramOverview(channelId: string, tile: SpectrogramTile): void {
    _spectrogramOverviews.set(channelId, tile)
    if (app) renderSignalLayer()
  }

  /** Add one detail tile for a spectrogram channel. Re-renders only if the tile
   *  is currently visible, avoiding redundant work during background streaming. */
  export function addSpectrogramTile(channelId: string, tile: SpectrogramTile): void {
    let arr = _spectrogramTiles.get(channelId)
    if (!arr) { arr = []; _spectrogramTiles.set(channelId, arr) }
    arr[tile.tileIndex] = tile
    if (app && tile.timeEnd > viewStart && tile.timeStart < viewEnd) renderSignalLayer()
  }

  /** Clear all spectrogram data for a channel (call before re-analysis). */
  export function clearSpectrogramChannel(channelId: string): void {
    _spectrogramTiles.delete(channelId)
    const ov = _spectrogramOverviews.get(channelId)
    if (ov) { _overviewTexCache.get(ov)?.tex.destroy(false); _overviewTexCache.delete(ov) }
    _spectrogramOverviews.delete(channelId)
    if (app) renderSignalLayer()
  }

  /** Clear only the detail tiles, keeping the overview visible during reanalysis. */
  export function clearSpectrogramDetailTiles(channelId: string): void {
    _spectrogramTiles.delete(channelId)
    if (app) renderSignalLayer()
  }

  /**
   * Crop the spectrogram for `channelId` between `timeStart` and `timeEnd`.
   * Composites available detail tiles (or the overview as fallback) onto an
   * offscreen canvas and returns a PNG data URL.  Returns null if no tile data
   * is available for the channel.
   */
  export function cropSpectrogram(channelId: string, timeStart: number, timeEnd: number): string | null {
    const duration = timeEnd - timeStart
    if (duration <= 0) return null

    // Collect tiles that overlap the requested window (prefer detail over overview).
    const detailTiles = _spectrogramTiles.get(channelId) ?? []
    const overview    = _spectrogramOverviews.get(channelId)
    const tiles: SpectrogramTile[] = detailTiles.filter(
      t => t && (t.rawDb?.length || t.pixels?.length) && t.timeEnd > timeStart && t.timeStart < timeEnd,
    )
    if (!tiles.length && overview && (overview.rawDb?.length || overview.pixels?.length) && overview.timeEnd > timeStart && overview.timeStart < timeEnd) {
      tiles.push(overview)
    }
    if (!tiles.length) return null

    // Use the first tile to determine output height (frequency bins).
    const tileH = tiles[0]!.height

    // Output width: ~2 px per spectrogram frame.  Derive frames-per-second from
    // the tile with the most detail (smallest hop size = largest width / duration).
    let framesPerSec = 0
    for (const t of tiles) {
      const fps = t.width / (t.timeEnd - t.timeStart)
      if (fps > framesPerSec) framesPerSec = fps
    }
    if (!framesPerSec) return null
    const outW = Math.max(1, Math.round(duration * framesPerSec))
    const outH = tileH

    const canvas = document.createElement('canvas')
    canvas.width  = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    for (const tile of tiles) {
      const tDur = tile.timeEnd - tile.timeStart
      // Overlap of tile with crop window in time.
      const overlapStart = Math.max(tile.timeStart, timeStart)
      const overlapEnd   = Math.min(tile.timeEnd,   timeEnd)
      if (overlapEnd <= overlapStart) continue

      // Column range within the tile.
      const colStart = Math.floor((overlapStart - tile.timeStart) / tDur * tile.width)
      const colEnd   = Math.ceil ((overlapEnd   - tile.timeStart) / tDur * tile.width)
      const colCount = colEnd - colStart

      // Destination x range in output canvas.
      const dstX = Math.round((overlapStart - timeStart) / duration * outW)
      const dstW = Math.round(colCount / tile.width * (tDur / duration) * outW)
      if (dstW <= 0) continue

      // Draw the slice by creating a temporary canvas for the tile region.
      const tmp    = document.createElement('canvas')
      tmp.width  = colCount
      tmp.height = tile.height
      const tmpCtx = tmp.getContext('2d')
      if (!tmpCtx) continue

      // Build ImageData for the column slice — apply current channel LUT for rawDb tiles.
      const cropLut = _channelLuts.get(channelId)?.lut ?? _buildLut(-80, 70, 1.2)
      const sliceData = tmpCtx.createImageData(colCount, tile.height)
      for (let row = 0; row < tile.height; row++) {
        for (let col = 0; col < colCount; col++) {
          const dstIdx = (row * colCount + col) * 4
          if (tile.rawDb) {
            const q = tile.rawDb[row * tile.width + (colStart + col)]!
            const packed = cropLut[q]!
            sliceData.data[dstIdx]     = (packed)       & 0xFF
            sliceData.data[dstIdx + 1] = (packed >> 8)  & 0xFF
            sliceData.data[dstIdx + 2] = (packed >> 16) & 0xFF
            sliceData.data[dstIdx + 3] = 255
          } else if (tile.pixels) {
            const srcIdx = (row * tile.width + (colStart + col)) * 4
            sliceData.data[dstIdx]     = tile.pixels[srcIdx]     ?? 0
            sliceData.data[dstIdx + 1] = tile.pixels[srcIdx + 1] ?? 0
            sliceData.data[dstIdx + 2] = tile.pixels[srcIdx + 2] ?? 0
            sliceData.data[dstIdx + 3] = tile.pixels[srcIdx + 3] ?? 0
          }
        }
      }
      tmpCtx.putImageData(sliceData, 0, 0)
      ctx.drawImage(tmp, dstX, 0, Math.max(1, dstW), outH)
    }

    return canvas.toDataURL('image/png')
  }
</script>

<div class="timeline-outer">
  {#if showLanePanel}
  <div class="lane-panel" style="width:{panelWidth}px">
    <!-- Summary + ruler spacer (matches canvas audioStartY exactly) -->
    <div class="panel-spacer" style="height:{audioStartY()}px">
      {@render mediaContent?.()}
    </div>

    <!-- Signal pairs: one resize handle at top of each pair -->
    {#each signalGroups() as grp (grp.key)}
      <div
        class="signal-pair-handle"
        role="separator"
        aria-label="Resize signal panel"
        onpointerdown={(e) => {
          const key = grp.key  // capture so nested closures don't trigger "used before assigned"
          const count = grp.channels.length
          const el = e.currentTarget as HTMLElement
          el.setPointerCapture(e.pointerId)
          const startY = e.clientY
          const startH = pairHeights[key] ?? grp.channels[0]?.height ?? SIGNAL_H
          function onMove(ev: PointerEvent) {
            pairHeights = { ...pairHeights, [key]: Math.max(12, startH - (ev.clientY - startY) / count) }
            if (app) scheduleResize()
          }
          function onUp() { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp) }
          el.addEventListener('pointermove', onMove)
          el.addEventListener('pointerup', onUp)
        }}
      ></div>
      {#each grp.channels as ch (ch.id)}
        <div class="signal-panel-row" style="height:{sigH(ch)}px">
          <span class="signal-panel-label">{ch.label}</span>
        </div>
      {/each}
    {/each}
    {#each panelRows as row, i (row.lane.id)}
      {@const bg = i % 2 === 0 ? '#fff' : 'var(--color-bg-5, #e0e0e0)'}
      <div
        class="panel-row"
        role="option"
        aria-selected={false}
        tabindex="-1"
        class:panel-group-start={row.isGroupStart}
        class:panel-dragging={panelDragId === row.lane.id}
        class:panel-drop-before={panelDropId === row.lane.id && !panelDropAfter}
        class:panel-drop-after={panelDropId === row.lane.id && panelDropAfter}
        style="height:{row.height}px;background:{bg}"
        ondragover={(e) => handlePanelDragOver(e, row.lane.id)}
        ondrop={(e) => handlePanelDrop(e, row.lane.id)}
        ondragleave={() => { if (panelDropId === row.lane.id) panelDropId = null }}
        oncontextmenu={(e) => { e.preventDefault(); onLaneContextMenu?.(row.lane.id, e.clientX, e.clientY) }}
        onclick={() => onLaneClick?.(row.lane.id)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onLaneClick?.(row.lane.id) }}
      >
        <div
          class="drag-handle"
          role="button"
          aria-label="Drag to reorder lane"
          tabindex="0"
          draggable={true}
          ondragstart={(e) => handlePanelDragStart(e, row.lane.id)}
          ondragend={handlePanelDragEnd}
        >⠿</div>
        {#if row.indent > 0}
        <svg width={row.indent * INDENT_PX} height={row.height} style="flex-shrink:0;display:block;overflow:visible">
          {#each row.svgLines as ln (ln.x1 + '_' + ln.y1 + '_' + ln.x2 + '_' + ln.y2)}
            <line x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2} stroke="#888" stroke-width="1"/>
          {/each}
        </svg>
        {/if}
        <div class="row-info">
          <span class="type-badge" style="background:{panelBadgeColor(row.lane)}">{panelTypeBadge(row.lane.type)}</span>
          {#if editingLaneId === row.lane.id}
            <span
              class="row-label row-label-editing"
              role="textbox"
              aria-label="Lane name"
              tabindex="0"
              contenteditable="true"
              use:focusSelect
              onblur={(e) => commitLaneEdit(row.lane.id, e.currentTarget as HTMLElement)}
              onkeydown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement).blur() }
                if (e.key === 'Escape') { e.preventDefault(); cancelLaneEdit(e.currentTarget as HTMLElement, row.lane.label) }
              }}
            >{editingValue}</span>
          {:else}
            <span
              class="row-label"
              role="button"
              tabindex="0"
              title={row.lane.label}
              ondblclick={() => startLaneEdit(row.lane)}
              onkeydown={(e) => { if (e.key === 'Enter') startLaneEdit(row.lane) }}
            >{row.lane.label || '—'}</span>
          {/if}
          {#if panelShowActor(row.lane)}<span class="row-actor">{row.lane.participant}</span>{/if}
        </div>
      </div>
    {/each}
  </div>
  <div class="panel-resize-handle" role="separator" aria-label="Resize lane panel" onpointerdown={startPanelResize}></div>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="timeline-wrap" role="application" aria-label="Timeline" bind:this={wrapEl} tabindex="0">
  </div>
</div>

<style>
  .timeline-outer {
    display: flex;
    flex-direction: row;
    width: 100%;
    background: var(--color-bg-2, #f5f5f5);
    align-items: stretch;
  }

  .lane-panel {
    flex-shrink: 0;
    overflow: hidden;
    border-right: 1px solid var(--color-border-strong, #ddd);
    background: var(--color-bg-2, #f5f5f5);
    font-family: system-ui, sans-serif;
    user-select: none;
    display: flex;
    flex-direction: column;
  }

  .signal-panel-row {
    flex-shrink: 0;
    overflow: hidden;
    border-bottom: 1px solid var(--color-bg-5, #e0e0e0);
    background: var(--color-bg-1, #fafafa);
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
    box-sizing: border-box;
  }

  .signal-panel-label {
    flex: 1;
    font-size: 10px;
    color: var(--color-text-3, #555);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .panel-spacer {
    flex-shrink: 0;
    background: var(--color-bg-2, #f5f5f5);
    overflow: hidden;
    position: relative;
  }

  .panel-row {
    position: relative;
    display: flex;
    flex-direction: row;
    align-items: center;
    border-bottom: 1px solid var(--color-bg-4, #e8e8e8);
    overflow: hidden;
    flex-shrink: 0;
  }

  .panel-row.panel-group-start::before {
    content: '';
    position: absolute;
    left: 0; right: 0; top: 0;
    height: 1.5px;
    background: var(--color-text-3, #777);
    pointer-events: none;
  }

  .panel-row.panel-dragging {
    opacity: 0.35;
  }

  .panel-row.panel-drop-before {
    box-shadow: 0 -2px 0 0 var(--color-primary, #2196f3);
  }

  .panel-row.panel-drop-after {
    box-shadow: 0 2px 0 0 var(--color-primary, #2196f3);
  }

  .drag-handle {
    flex-shrink: 0;
    padding: 0 5px;
    cursor: grab;
    color: var(--color-text-faint, #bbb);
    font-size: 11px;
    line-height: 1;
    user-select: none;
  }

  .drag-handle:hover {
    color: var(--color-text-light, #888);
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  .row-info {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 3px;
    min-width: 0;
    flex: 1;
    overflow: hidden;
    padding: 0 4px 0 2px;
  }

  .type-badge {
    font-size: 7px;
    color: #fff;
    padding: 1px 3px;
    border-radius: 2px;
    flex-shrink: 0;
    font-weight: 700;
    line-height: 1.4;
  }

  .row-label {
    font-size: 9px;
    color: var(--color-text-1, #333);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .row-label-editing {
    overflow: visible;
    outline: none;
    border-bottom: 1px solid var(--color-primary, #2196f3);
    background: transparent;
    white-space: nowrap;
    cursor: text;
  }

  .row-actor {
    font-size: 8px;
    font-family: system-ui, sans-serif;
    color: var(--color-text-light, #888);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .panel-resize-handle {
    flex-shrink: 0;
    width: 4px;
    cursor: col-resize;
    background: transparent;
    transition: background 0.15s;
  }

  .panel-resize-handle:hover {
    background: var(--color-primary, #2196f3);
  }

  .timeline-wrap {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    outline: none;
    position: relative;
  }

  .timeline-wrap :global(canvas) {
    display: block;
  }

  .signal-pair-handle {
    flex-shrink: 0;
    height: 3px;
    cursor: row-resize;
    background: var(--color-border, #d0d0d0);
  }
  .signal-pair-handle:hover { background: rgba(74, 158, 255, 0.6); }

</style>
