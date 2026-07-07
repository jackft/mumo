import type { EditorView } from 'prosemirror-view'
import type { OverlayPlugin, OverlayContext } from '../overlay.js'
import { SPACER_W } from './selection-spacer.js'

const FILL         = 'rgba(74, 158, 255, 0.12)'
const STROKE       = '#4a9eff'
const SLOT_COLORS  = ['#000000', '#FF0000', '#00A08A', '#F2AD00', '#F98400', '#5BBCD6']
const PAD          = 2
const NS           = 'http://www.w3.org/2000/svg'

type RangeGetter = (view: EditorView) => { from: number; to: number }[]

export class BlockHighlightOverlayPlugin implements OverlayPlugin {
  private _ctx:         OverlayContext | null = null
  private _hoverGrp:   SVGGElement   | null = null
  private _selectGrp:  SVGGElement   | null = null
  private _hoverIds:   string[]  = []
  private _selectors:  string[]  = []
  private _rangeGetter: RangeGetter | null = null

  mount(group: SVGGElement, ctx: OverlayContext) {
    this._ctx = ctx
    // Two sub-groups so hover and selection paint independently
    this._hoverGrp  = document.createElementNS(NS, 'g')
    this._selectGrp = document.createElementNS(NS, 'g')
    group.appendChild(this._selectGrp)
    group.appendChild(this._hoverGrp)
  }

  setHighlightIds(ids: string[]) {
    this._hoverIds = ids
    this._redrawHover()
  }

  // selectors: arbitrary CSS selectors whose bounding rects should each get a selection box
  setSelectionBoxes(selectors: string[]) {
    this._selectors = selectors
    this._redrawSelection()
  }

  // getter called on every redraw to get current PM {from,to} ranges for word boxes
  setRangeGetter(fn: RangeGetter | null) {
    this._rangeGetter = fn
  }

  redraw() {
    this._redrawSelection()
  }

  private _redrawHover() {
    const group = this._hoverGrp
    const ctx   = this._ctx
    if (!group || !ctx) return

    while (group.firstChild) group.removeChild(group.firstChild)
    if (!this._hoverIds.length) return

    const pane = ctx.getPane()
    if (!pane) return

    const paneRect  = pane.getBoundingClientRect()
    const scrollTop = pane.scrollTop

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const id of this._hoverIds) {
      const el = pane.querySelector(`[data-id="${CSS.escape(id)}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      minX = Math.min(minX, r.left   - paneRect.left)
      minY = Math.min(minY, r.top    - paneRect.top  + scrollTop)
      maxX = Math.max(maxX, r.right  - paneRect.left)
      maxY = Math.max(maxY, r.bottom - paneRect.top  + scrollTop)
    }
    if (minX === Infinity) return

    const x = minX - PAD
    const y = minY - PAD
    const w = maxX - minX + PAD * 2
    const h = maxY - minY + PAD * 2

    const rect = document.createElementNS(NS, 'rect')
    rect.setAttribute('x',      String(x))
    rect.setAttribute('y',      String(y))
    rect.setAttribute('width',  String(w))
    rect.setAttribute('height', String(h))
    rect.setAttribute('fill',   FILL)
    group.appendChild(rect)

    for (const yPos of [y, y + h]) {
      const line = document.createElementNS(NS, 'line')
      line.setAttribute('x1',           String(x))
      line.setAttribute('y1',           String(yPos))
      line.setAttribute('x2',           String(x + w))
      line.setAttribute('y2',           String(yPos))
      line.setAttribute('stroke',       STROKE)
      line.setAttribute('stroke-width', '1.5')
      group.appendChild(line)
    }
  }

  private _redrawSelection() {
    const group = this._selectGrp
    const ctx   = this._ctx
    if (!group || !ctx) return

    while (group.firstChild) group.removeChild(group.firstChild)
    if (!this._selectors.length && !this._rangeGetter) return

    const pane = ctx.getPane()
    if (!pane) return

    const paneRect  = pane.getBoundingClientRect()
    const scrollTop = pane.scrollTop

    let colorIdx = 0
    for (const selector of this._selectors) {
      const color = SLOT_COLORS[colorIdx % SLOT_COLORS.length]!
      colorIdx++
      for (const el of pane.querySelectorAll(selector)) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const r = range.getBoundingClientRect()
        if (!r.width || !r.height) continue
        // ann-span elements have spacer widgets on each side — expand the rect to reach them
        const padX = (el as HTMLElement).classList.contains('ann-span') ? SPACER_W : PAD
        this._appendSelectionBracket(group, paneRect, scrollTop, r, padX, color)
      }
    }

    const view = ctx.getView()
    if (view && this._rangeGetter) {
      for (const { from, to } of this._rangeGetter(view)) {
        if (from >= to) continue
        const color = SLOT_COLORS[colorIdx % SLOT_COLORS.length]!
        colorIdx++
        try {
          const { node: sn, offset: so } = view.domAtPos(from)
          const { node: en, offset: eo } = view.domAtPos(to)
          const range = document.createRange()
          range.setStart(sn, so)
          range.setEnd(en, eo)
          const r = range.getBoundingClientRect()
          if (!r.width || !r.height) continue
          this._appendSelectionBracket(group, paneRect, scrollTop, r, PAD, color)
        } catch { /* position out of range, skip */ }
      }
    }
  }

  private _appendSelectionBracket(
    group: SVGGElement,
    paneRect: DOMRect,
    scrollTop: number,
    r: DOMRect,
    padX = PAD,
    color = STROKE,
  ) {
    const x = r.left   - paneRect.left  - padX
    const y = r.top    - paneRect.top   + scrollTop - PAD
    const w = r.width  + padX * 2
    const h = r.height + PAD * 2
    const CAP = 5

    const strokeWidth   = '1.5'
    const strokeLinecap = 'round'

    for (const d of [
      `M${x + CAP},${y} L${x},${y} L${x},${y + h} L${x + CAP},${y + h}`,
      `M${x + w - CAP},${y} L${x + w},${y} L${x + w},${y + h} L${x + w - CAP},${y + h}`,
    ]) {
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d',                d)
      path.setAttribute('fill',             'none')
      path.setAttribute('stroke',           color)
      path.setAttribute('stroke-width',     strokeWidth)
      path.setAttribute('stroke-linecap',   strokeLinecap)
      path.setAttribute('stroke-linejoin',  'round')
      group.appendChild(path)
    }
  }

  destroy() {}
}
