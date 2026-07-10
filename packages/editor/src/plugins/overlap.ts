/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import { schema } from '@mumo/core'
import type { Node } from 'prosemirror-model'

function shortId(): string {
  return Math.random().toString(36).slice(2, 6)
}
import type { OverlayPlugin, OverlayContext } from '../overlay.js'

// Alignment PM plugin
// Maps doc position → spacer width (px).
// An invisible widget is inserted just before each overlap_bracket atom,
// pushing it rightward to horizontally align brackets across utterances.

export const overlapAlignmentKey = new PluginKey<Map<number, number>>('overlapAlignment')

export function buildOverlapAlignmentPlugin(onChange?: () => void) {
  return new Plugin<Map<number, number>>({
    key: overlapAlignmentKey,
    state: {
      init: () => new Map(),
      apply(tr, prev) {
        const meta = tr.getMeta(overlapAlignmentKey)
        if (meta !== undefined) return meta as Map<number, number>
        if (!tr.docChanged) return prev
        const next = new Map<number, number>()
        for (const [pos, width] of prev) next.set(tr.mapping.map(pos), width)
        if (onChange) queueMicrotask(onChange)
        return next
      },
    },
    props: {
      decorations(state) {
        const map = overlapAlignmentKey.getState(state)
        if (!map || map.size === 0) return DecorationSet.empty
        const decos: Decoration[] = []
        for (const [pos, width] of map) {
          if (width <= 0.5) continue
          const el = document.createElement('span')
          el.style.cssText = `display:inline-block;width:${width}px;height:1em;vertical-align:text-bottom`
          el.setAttribute('aria-hidden', 'true')
          el.contentEditable = 'false'
          decos.push(Decoration.widget(pos, el, { side: -1 }))
        }
        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

// Input PM plugin
// Converts /[ and /] (or /id[ and /id]) into overlap_bracket atoms.

interface BlockBounds { from: number; to: number }

function adjacentBlocks(doc: Node, pos: number): { current: BlockBounds; neighbors: BlockBounds[] } | null {
  let idx = -1
  const blocks: BlockBounds[] = []
  doc.forEach((node, offset, i) => {
    blocks.push({ from: offset, to: offset + node.nodeSize })
    if (pos > offset && pos <= offset + node.nodeSize) idx = i
  })
  if (idx === -1) return null
  const neighbors: BlockBounds[] = []
  if (idx > 0) neighbors.push(blocks[idx - 1]!)
  if (idx + 1 < blocks.length) neighbors.push(blocks[idx + 1]!)
  return { current: blocks[idx]!, neighbors }
}

// For /[: find an unmatched start bracket in an adjacent utterance.
function findAutoLinkId(doc: Node, pos: number): string | null {
  const adj = adjacentBlocks(doc, pos)
  if (!adj || adj.neighbors.length === 0) return null
  const bracketType = schema.nodes['overlap_bracket']

  // Count starts globally to identify unmatched ones
  const globalStarts = new Map<string, number>()
  doc.descendants(node => {
    if (node.type === bracketType && node.attrs.kind === 'start')
      globalStarts.set(node.attrs.id, (globalStarts.get(node.attrs.id) ?? 0) + 1)
  })

  for (const { from, to } of adj.neighbors) {
    const ids: string[] = []
    doc.nodesBetween(from, to, node => {
      if (node.type === bracketType && node.attrs.kind === 'start') ids.push(node.attrs.id)
    })
    for (let i = ids.length - 1; i >= 0; i--) {
      if (globalStarts.get(ids[i]!) === 1) return ids[i]!
    }
  }
  return null
}

// For /]: find the most recent unclosed start bracket in the current or adjacent utterances.
function findOpenStartId(doc: Node, pos: number): string | null {
  const adj = adjacentBlocks(doc, pos)
  if (!adj) return null
  const bracketType = schema.nodes['overlap_bracket']

  const search = [adj.current, ...adj.neighbors]
  const counts = new Map<string, { start: number; end: number }>()
  for (const { from, to } of search) {
    doc.nodesBetween(from, to, node => {
      if (node.type !== bracketType) return
      const c = counts.get(node.attrs.id) ?? { start: 0, end: 0 }
      if (node.attrs.kind === 'start') c.start++; else c.end++
      counts.set(node.attrs.id, c)
    })
  }

  let last: string | null = null
  for (const { from, to } of search) {
    doc.nodesBetween(from, to, node => {
      if (node.type === bracketType && node.attrs.kind === 'start') {
        const c = counts.get(node.attrs.id)!
        if (c.start > c.end) last = node.attrs.id
      }
    })
  }
  return last
}

export function buildOverlapPlugin() {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (from !== to) return false
        if (text !== '[' && text !== ']') return false

        const searchFrom = Math.max(0, from - 30)
        const textBefore = view.state.doc.textBetween(searchFrom, from)
        const match = textBefore.match(/\/(\w*)$/)
        if (!match) return false

        const bracketType = schema.nodes['overlap_bracket']
        const givenId = match[1] ?? ''
        const seqLen  = match[0].length
        const seqStart = from - seqLen

        let id: string
        if (givenId) {
          id = givenId
        } else if (text === '[') {
          id = findAutoLinkId(view.state.doc, seqStart) ?? shortId()
        } else {
          id = findOpenStartId(view.state.doc, seqStart) ?? shortId()
        }

        const kind = text === '[' ? 'start' : 'end'
        const node = bracketType.create({ id, kind })
        view.dispatch(view.state.tr.delete(seqStart, from).insert(seqStart, node))
        return true
      },
    },
  })
}

export function insertOverlapBracketAtCursor(view: import('prosemirror-view').EditorView, kind: 'start' | 'end'): void {
  const { from } = view.state.selection
  const bracketType = schema.nodes['overlap_bracket']
  const id = kind === 'start'
    ? (findAutoLinkId(view.state.doc, from) ?? shortId())
    : (findOpenStartId(view.state.doc, from) ?? shortId())
  view.dispatch(view.state.tr.insert(from, bracketType.create({ id, kind })))
  view.focus()
}

// SVG overlay plugin

const SVG_NS = 'http://www.w3.org/2000/svg'

interface BracketPos {
  id: string
  kind: 'start' | 'end'
  pos: number
  blockStart: number
  x: number
  y: number
  lineTop: number
  lineBot: number
  isBlockStart: boolean
}

function buildPath(brackets: BracketPos[], kind: 'start' | 'end'): string {
  const sorted = [...brackets].sort((a, b) => a.y - b.y)
  const yTop   = sorted[0]!.lineTop
  const yBot   = sorted[sorted.length - 1]!.lineBot
  const xs     = sorted.map(b => b.x)

  if (kind === 'start') {
    const innerX = Math.min(...xs)
    const xBar   = innerX - 3
    return `M ${xBar} ${yTop} L ${xBar} ${yBot} M ${xBar} ${yTop} L ${innerX} ${yTop} M ${xBar} ${yBot} L ${innerX} ${yBot}`
  } else {
    // x is the text-end edge (the ] atom's left).  Mirror the start bracket:
    // bar 3px right of the text, inside the atom's 0.5em trailing margin,
    // with ticks pointing back to the text edge.
    const innerX = Math.max(...xs)
    const xBar   = innerX + 3
    return `M ${xBar} ${yTop} L ${xBar} ${yBot} M ${xBar} ${yTop} L ${innerX} ${yTop} M ${xBar} ${yBot} L ${innerX} ${yBot}`
  }
}

// Viewport-space rect of the visual line that contains the bracket at `pos`.
//
// The core problem: view.coordsAtPos(pos+1) returns the *previous* visual
// line's rect whenever the queried position is at the very start of a wrapped
// visual line.  The x coordinate is unaffected (both lines start at x=0);
// only top/bottom are wrong.
//
// The fix: instead of querying the boundary position pos+1, find the first
// text node that follows the bracket within the same block and query a
// position *inside* that text (1 char in).  Interior text positions are never
// at a visual-line boundary, so coordsAtPos returns the correct line.
//
// If no text follows (bracket at end of block), try text before the bracket
// using a mid-text position for the same reason.
function bracketLineRect(view: EditorView, pos: number): { top: number; bottom: number } | null {
  const $pos   = view.state.doc.resolve(pos)
  const parent = $pos.parent
  const index  = $pos.index()

  // Walk forward through the parent's inline children after the bracket.
  let p = pos + 1
  for (let i = index + 1; i < parent.childCount; i++) {
    const child = parent.child(i)
    if (child.isText) {
      // p = text node start.  p+1 = 1 char inside = never a line-start boundary.
      const c = view.coordsAtPos(child.nodeSize >= 2 ? p + 1 : p)
      return { top: c.top, bottom: c.bottom }
    }
    p += child.nodeSize
  }

  // Walk backward: use mid-text to avoid start/end boundaries.
  p = pos
  for (let i = index - 1; i >= 0; i--) {
    const child = parent.child(i)
    p -= child.nodeSize
    if (child.isText) {
      const mid = p + Math.max(1, Math.floor(child.nodeSize / 2))
      const c   = view.coordsAtPos(mid)
      return { top: c.top, bottom: c.bottom }
    }
  }

  return null  // block has no text at all; caller falls back to coordsAtPos(pos+1)
}

export class OverlapOverlayPlugin implements OverlayPlugin {
  private _ctx: OverlayContext | null = null
  private _group: SVGGElement | null = null
  private _tooltip: HTMLDivElement | null = null
  private _ro: ResizeObserver | null = null
  private _observing: HTMLElement | null = null

  mount(group: SVGGElement, ctx: OverlayContext) {
    this._ctx   = ctx
    this._group = group

    group.addEventListener('mouseover', (e) => {
      const id = (e.target as SVGElement).getAttribute('data-overlap-id')
      if (id) this._showTooltip(id, e)
    })
    group.addEventListener('mouseout', () => { this._hideTooltip(); })

    this.redraw()
  }

  redraw() {
    const ctx   = this._ctx
    const group = this._group
    if (!ctx || !group) return

    const view = ctx.getView()
    const pane = ctx.getPane()
    if (!view || !pane) return

    if (this._observing !== pane) {
      this._ro?.disconnect()
      this._ro = new ResizeObserver(() => { this.redraw(); })
      this._ro.observe(pane)
      this._observing = pane
    }

    while (group.firstChild) group.removeChild(group.firstChild)

    const nodeType = schema.nodes['overlap_bracket']
    view.dispatch(
      view.state.tr
        .setMeta(overlapAlignmentKey, new Map<number, number>())
    )

    const paneRect    = pane.getBoundingClientRect()
    const scrollTop   = pane.scrollTop
    const startGroups = new Map<string, BracketPos[]>()
    const endGroups   = new Map<string, BracketPos[]>()
    const orderedIds  = new Set<string>()  // insertion order = doc order of each group's first bracket

    // Vertical placement for one bracket: real line rect from the bracket's
    // own DOM element (bracketLineRect), coordsAtPos as fallback, extended to
    // cover a tall preceding atom (image).
    const measureVertical = (pos: number, rect: DOMRect, sTop: number) => {
      const line   = bracketLineRect(view, pos) ?? view.coordsAtPos(pos + 1)
      let lineTop  = line.top    - rect.top + sTop
      let lineBot  = line.bottom - rect.top + sTop
      const y      = (lineTop + lineBot) / 2

      const $pos  = view.state.doc.resolve(pos)
      const index = $pos.index()
      if (index > 0) {
        const prevSibling = $pos.parent.child(index - 1)
        if (prevSibling.type.name === 'image') {
          const imgDOM = view.nodeDOM(pos - prevSibling.nodeSize)
          if (imgDOM instanceof HTMLElement) {
            const r = imgDOM.getBoundingClientRect()
            lineTop = Math.min(lineTop, r.top    - rect.top + sTop)
            lineBot = Math.max(lineBot, r.bottom - rect.top + sTop)
          }
        }
      }
      return { y, lineTop, lineBot }
    }

    view.state.doc.descendants((node: Node, pos: number) => {
      if (node.type !== nodeType) return
      const kind = node.attrs.kind as 'start' | 'end'

      const $pos       = view.state.doc.resolve(pos)
      const blockStart = $pos.start($pos.depth)
      // Use '\x00' as leafText so inline atoms (images) count as content
      const isBlockStart = view.state.doc.textBetween(blockStart, pos, '', '\x00').length === 0

      // Start brackets: x = the atom's right edge (pos+1) = where the overlap
      // text begins.  End brackets: x = the atom's LEFT edge (pos) = where the
      // overlap text ends.  Never use pos+1 for end brackets: when text
      // follows, coordsAtPos snaps to that text's left edge, which includes
      // the ]'s 0.5em margin-right — but at block end it returns the atom
      // edge without margin, so mid-utterance and utterance-final ] would be
      // measured with inconsistent conventions.
      const x = view.coordsAtPos(kind === 'end' ? pos : pos + 1).left - paneRect.left
      const { y, lineTop, lineBot } = measureVertical(pos, paneRect, scrollTop)

      const id  = node.attrs.id as string
      const map = kind === 'start' ? startGroups : endGroups
      const arr = map.get(id) ?? []
      arr.push({ id, kind, pos, blockStart, x, y, lineTop, lineBot, isBlockStart })
      map.set(id, arr)
      orderedIds.add(id)
    })

    const spacerMap = new Map<number, number>()

    // Sum of spacers already in spacerMap that precede `pos` within the same block.
    // Earlier groups' spacers shift all subsequent content in that utterance, so we
    // must account for them when computing effective positions for later groups.
    const spacersBefore = (pos: number, blockStart: number): number => {
      let total = 0
      for (const [p, w] of spacerMap) {
        if (p >= blockStart && p < pos) total += w
      }
      return total
    }
    // Align groups strictly in document order, starts then ends within each
    // group.  A spacer inserted anywhere shifts every bracket after it in the
    // same utterance, and a group's END alignment can insert a post-] spacer
    // mid-utterance — before a LATER group's brackets in that utterance.
    // Aligning all start groups before any end group (the old order) let a
    // group-1 end spacer invalidate group-2's already-computed start
    // alignment: the shared line shifted right while the other line's spacer
    // stayed stale, so only the "top" line of group 2 ended up adjusted.
    for (const id of orderedIds) {
      const startBrackets = startGroups.get(id)
      if (startBrackets && startBrackets.length >= 2) {
        const effectiveXs = startBrackets.map(b => b.x + spacersBefore(b.pos, b.blockStart))
        const maxX = Math.max(...effectiveXs)
        for (let i = 0; i < startBrackets.length; i++) {
          const b = startBrackets[i]!
          const delta = maxX - effectiveXs[i]!
          if (delta > 0.5) {
            const prev = spacerMap.get(b.pos) ?? 0
            if (delta > prev) spacerMap.set(b.pos, delta)
          }
        }
      }

      // Align all end brackets in the group to the rightmost ] position.
      // Block-start ] get a pre-spacer (pushes the atom itself right).
      // Mid-utterance ] get a post-spacer at pos+1 (pushes only the following text right).
      // The corresponding start bracket x is used as a minimum target for block-start ].
      const endBrackets = endGroups.get(id)
      if (!endBrackets) continue
      const startMaxX = startBrackets
        ? Math.max(...startBrackets.map(b => b.x + spacersBefore(b.pos, b.blockStart) + (spacerMap.get(b.pos) ?? 0)))
        : -Infinity
      const effectiveXs = endBrackets.map(b => b.x + spacersBefore(b.pos, b.blockStart) + (spacerMap.get(b.pos) ?? 0))
      const targetEndX = Math.max(...effectiveXs, startMaxX)

      for (let i = 0; i < endBrackets.length; i++) {
        const b = endBrackets[i]!
        const delta = targetEndX - effectiveXs[i]!
        if (delta <= 0.5) continue
        if (b.isBlockStart) {
          spacerMap.set(b.pos, targetEndX - (b.x + spacersBefore(b.pos, b.blockStart)))
        } else {
          const prev = spacerMap.get(b.pos + 1) ?? 0
          if (delta > prev) spacerMap.set(b.pos + 1, delta)
        }
      }
    }

    if (spacerMap.size > 0) {
      view.dispatch(
        view.state.tr
          .setMeta(overlapAlignmentKey, spacerMap)
      )
      for (const [, brackets] of startGroups) {
        for (const b of brackets) {
          b.x += spacersBefore(b.pos, b.blockStart) + (spacerMap.get(b.pos) ?? 0)
        }
      }
      for (const [, brackets] of endGroups) {
        for (const b of brackets) {
          b.x += spacersBefore(b.pos, b.blockStart) + (spacerMap.get(b.pos) ?? 0) + (spacerMap.get(b.pos + 1) ?? 0)
        }
      }

      // Spacers change line wrapping (text pushed right can wrap earlier),
      // shifting every line below the wrap point.  A scrollHeight comparison
      // cannot detect this: the SVG overlay is itself an absolutely positioned
      // child of the pane still holding the previous draw's height, which pins
      // scrollHeight and masks content growth.  Always remeasure vertical
      // coords from the final layout, with fresh pane rect and scrollTop
      // (reflow can move scrollTop via scroll anchoring).
      const paneRect2  = pane.getBoundingClientRect()
      const scrollTop2 = pane.scrollTop
      const remeasure = (b: BracketPos) => {
        const v = measureVertical(b.pos, paneRect2, scrollTop2)
        b.y       = v.y
        b.lineTop = v.lineTop
        b.lineBot = v.lineBot
      }
      for (const [, brackets] of startGroups) for (const b of brackets) remeasure(b)
      for (const [, brackets] of endGroups)   for (const b of brackets) remeasure(b)
    }

    // Size the SVG to the editor content.  Never use pane.scrollHeight here:
    // the SVG is an absolutely positioned child of the pane, so its own
    // previous height is part of scrollHeight and the value would never shrink.
    ctx.setSvgHeight(view.dom.getBoundingClientRect().bottom - paneRect.top + pane.scrollTop)

    for (const [id, brackets] of startGroups) {
      this._addPath(group, buildPath(brackets, 'start'), id)
    }
    for (const [id, brackets] of endGroups) {
      this._addPath(group, buildPath(brackets, 'end'), id)
    }
  }

  private _addPath(group: SVGGElement, d: string, id: string) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-opacity', '0.4')
    path.setAttribute('stroke-width', '1.5')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('pointer-events', 'stroke')
    path.setAttribute('data-overlap-id', id)
    group.appendChild(path)
  }

  private _showTooltip(id: string, e: MouseEvent) {
    if (!this._tooltip) {
      const el = document.createElement('div')
      el.style.cssText = [
        'position:fixed',
        'z-index:500',
        'background:var(--color-bg-0,#fff)',
        'border:1px solid var(--color-border,#ddd)',
        'border-radius:var(--radius-md,6px)',
        'box-shadow:var(--shadow-menu-sm,0 2px 8px rgba(0,0,0,.15))',
        'padding:3px 8px',
        'font-size:0.82rem',
        'pointer-events:none',
        'white-space:nowrap',
      ].join(';')
      document.body.appendChild(el)
      this._tooltip = el
    }
    this._tooltip.textContent = `overlap: ${id}`
    this._tooltip.style.left    = `${e.clientX + 12}px`
    this._tooltip.style.top     = `${e.clientY - 24}px`
    this._tooltip.style.display = 'block'
  }

  private _hideTooltip() {
    if (this._tooltip) this._tooltip.style.display = 'none'
  }

  destroy() {
    this._ro?.disconnect()
    this._tooltip?.remove()
    this._ctx       = null
    this._group     = null
    this._tooltip   = null
    this._ro        = null
    this._observing = null
  }
}
