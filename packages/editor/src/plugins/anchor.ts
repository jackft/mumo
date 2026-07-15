/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import { schema } from '@mumo/core'

function shortId(): string {
  return Math.random().toString(36).slice(2, 6)
}

// Input plugin
// Trigger: [ or ] after /{delim}{optional_id}*
//   /*a*[   → delimiter *, id "a", kind start
//   /**[    → delimiter *, auto-id, kind start
//   /+b*]   → delimiter +, id "b", kind end
//
// Pattern: /\/([*+#%&])(\w*)\*$/ looked up before the [ or ]
// Does NOT conflict with overlap brackets: their lookback /\/(\w*)$/
// fails when the preceding char is * (not a word char).

export function buildAnchorPlugin() {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (from !== to) return false
        if (text !== '[' && text !== '|' && text !== ']') return false

        const searchFrom = Math.max(0, from - 40)
        const textBefore = view.state.doc.textBetween(searchFrom, from)
        const match = textBefore.match(/\/([*+#%&])(\w*)\*$/)
        if (!match) return false

        const anchorType = schema.nodes['anchor']
        if (!anchorType) return false

        const delimiter = match[1]!
        const givenId   = match[2] || ''
        const seqLen    = match[0].length
        const seqStart  = from - seqLen

        const id   = givenId || shortId()
        const kind = text === '[' ? 'start' : text === '|' ? 'middle' : 'end'
        const node = anchorType.create({ id, delimiter, kind })
        view.dispatch(view.state.tr.delete(seqStart, from).insert(seqStart, node))
        return true
      },
    },
  })
}

// Alignment plugin
// Inserts invisible spacer widgets before each anchor atom so that anchors
// with the same id and kind align horizontally across utterances.
// Mirrors the overlap alignment approach: groups are processed in doc order,
// accumulated spacers from earlier groups in the same utterance are accounted
// for, and recalc runs after DOM layout (not inside apply).

export const anchorAlignmentKey = new PluginKey<Map<number, number>>('anchorAlignment')

interface AnchorMeasure {
  pos: number
  blockStart: number
  x: number  // viewport-relative left edge of the atom, at time of measurement
}

// Sum of spacers already committed that precede `pos` within the same block.
function _spacersBefore(spacerMap: Map<number, number>, pos: number, blockStart: number): number {
  let total = 0
  for (const [p, w] of spacerMap) {
    if (p >= blockStart && p < pos) total += w
  }
  return total
}

function _recalcAnchorAlignment(view: EditorView): void {
  const anchorType = schema.nodes['anchor']
  if (!anchorType) return

  // Group by id, separated by kind (starts align with starts, ends with ends).
  const startGroups = new Map<string, AnchorMeasure[]>()
  const endGroups   = new Map<string, AnchorMeasure[]>()
  const orderedIds  = new Set<string>()  // doc-order of first occurrence per id

  view.state.doc.descendants((node, pos) => {
    if (node.type !== anchorType) return
    const id   = node.attrs.id as string
    const kind = node.attrs.kind as 'start' | 'end'
    const $pos = view.state.doc.resolve(pos)
    const blockStart = $pos.start($pos.depth)

    // coordsAtPos(pos) = cursor just before the atom = its left edge in viewport
    let x: number
    try { x = view.coordsAtPos(pos).left } catch { return }

    const entry: AnchorMeasure = { pos, blockStart, x }
    const map = kind === 'start' ? startGroups : endGroups
    const arr = map.get(id) ?? []
    arr.push(entry)
    map.set(id, arr)
    orderedIds.add(id)
  })

  const spacerMap = new Map<number, number>()

  // Process each id in doc order: align starts first, then ends.
  // spacersBefore() accounts for spacers already placed earlier in the same
  // utterance, since those shift all subsequent inline content rightward.
  for (const id of orderedIds) {
    const startArr = startGroups.get(id)
    if (startArr && startArr.length >= 2) {
      const effective = startArr.map(b => b.x + _spacersBefore(spacerMap, b.pos, b.blockStart))
      const maxX = Math.max(...effective)
      for (let i = 0; i < startArr.length; i++) {
        const delta = maxX - effective[i]!
        if (delta > 0.5) {
          const prev = spacerMap.get(startArr[i]!.pos) ?? 0
          if (delta > prev) spacerMap.set(startArr[i]!.pos, delta)
        }
      }
    }

    const endArr = endGroups.get(id)
    if (endArr && endArr.length >= 2) {
      // Include any just-placed start spacers in effective end positions
      const effective = endArr.map(b =>
        b.x + _spacersBefore(spacerMap, b.pos, b.blockStart) + (spacerMap.get(b.pos) ?? 0)
      )
      const maxX = Math.max(...effective)
      for (let i = 0; i < endArr.length; i++) {
        const delta = maxX - effective[i]!
        if (delta > 0.5) {
          const prev = spacerMap.get(endArr[i]!.pos) ?? 0
          if (delta > prev) spacerMap.set(endArr[i]!.pos, delta)
        }
      }
    }
  }

  view.dispatch(view.state.tr.setMeta(anchorAlignmentKey, spacerMap))
}

export function buildAnchorAlignmentPlugin() {
  return new Plugin<Map<number, number>>({
    key: anchorAlignmentKey,
    state: {
      init: () => new Map(),
      apply(tr, prev) {
        const meta = tr.getMeta(anchorAlignmentKey)
        if (meta !== undefined) return meta as Map<number, number>
        if (!tr.docChanged) return prev
        // Remap positions through the transaction; recalc fires from view.update
        const next = new Map<number, number>()
        for (const [pos, width] of prev) next.set(tr.mapping.map(pos), width)
        return next
      },
    },
    props: {
      decorations(state) {
        const map = anchorAlignmentKey.getState(state)
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
    view(v) {
      // Fire once after initial layout
      queueMicrotask(() => { _recalcAnchorAlignment(v) })
      return {
        update(view, prevState) {
          // Only recalc when the doc actually changed, not when we dispatched
          // the spacer meta (which doesn't change the doc).
          if (view.state.doc !== prevState.doc) _recalcAnchorAlignment(view)
        },
        destroy() {},
      }
    },
  })
}
