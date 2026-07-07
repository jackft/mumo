import type { OverlayPlugin, OverlayContext } from '../overlay.js'

const NS = 'http://www.w3.org/2000/svg'
const STRIPE_W   = 4
const STRIPE_GAP = 2

export interface PatternOverlayEntry {
  patternId: string
  color: string  // CSS hex, e.g. '#4a90d9'
  label: string  // schema shortname
  uttIds: string[]
}

export class PatternOverlayPlugin implements OverlayPlugin {
  private _ctx:       OverlayContext | null = null
  private _group:     SVGGElement    | null = null
  private _ro:        ResizeObserver | null = null
  private _observing: HTMLElement    | null = null
  private _entries:   PatternOverlayEntry[] = []

  setEntries(entries: PatternOverlayEntry[]): void {
    this._entries = entries
    this.redraw()
  }

  mount(group: SVGGElement, ctx: OverlayContext): void {
    this._ctx   = ctx
    this._group = group
    this.redraw()
  }

  redraw(): void {
    const ctx   = this._ctx
    const group = this._group
    if (!ctx || !group) return

    const view = ctx.getView()
    const pane = ctx.getPane()
    if (!view || !pane) return

    if (this._observing !== pane) {
      this._ro?.disconnect()
      this._ro = new ResizeObserver(() => { this.redraw() })
      this._ro.observe(pane)
      this._observing = pane
    }

    ctx.setSvgHeight(pane.scrollHeight)
    while (group.firstChild) group.removeChild(group.firstChild)
    if (!this._entries.length) return

    // uttId → ordered list of entry indices (insertion order = pattern creation order)
    const uttMap = new Map<string, number[]>()
    for (let i = 0; i < this._entries.length; i++) {
      for (const uttId of this._entries[i]!.uttIds) {
        const arr = uttMap.get(uttId) ?? []
        arr.push(i)
        uttMap.set(uttId, arr)
      }
    }
    if (!uttMap.size) return

    const paneRect  = pane.getBoundingClientRect()
    const scrollTop = pane.scrollTop

    for (const [uttId, idxList] of uttMap) {
      const el = pane.querySelector(`[data-id="${CSS.escape(uttId)}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue

      const top    = r.top    - paneRect.top + scrollTop
      const height = r.height

      for (let i = 0; i < idxList.length; i++) {
        const entry = this._entries[idxList[i]!]!
        const x = i * (STRIPE_W + STRIPE_GAP)

        const rect = document.createElementNS(NS, 'rect')
        rect.setAttribute('x',            String(x))
        rect.setAttribute('y',            String(top))
        rect.setAttribute('width',        String(STRIPE_W))
        rect.setAttribute('height',       String(height))
        rect.setAttribute('fill',         entry.color)
        rect.setAttribute('fill-opacity', '0.55')
        rect.setAttribute('rx',           '1')
        group.appendChild(rect)
      }
    }
  }

  destroy(): void {
    this._ro?.disconnect()
    this._ctx       = null
    this._group     = null
    this._ro        = null
    this._observing = null
  }
}
