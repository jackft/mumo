import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import type { Node } from 'prosemirror-model'
import { schema } from '@mumo/core'

export const SPACER_W = 5

const selectionSpacerKey = new PluginKey<{ from: number; to: number }[]>('selectionSpacer')

function mkSpacer(): HTMLElement {
  const el = document.createElement('span')
  el.style.cssText = `display:inline-block;width:${SPACER_W}px;height:1em;vertical-align:text-bottom`
  el.setAttribute('aria-hidden', 'true')
  el.contentEditable = 'false'
  return el
}

export function buildSelectionSpacerPlugin(): Plugin {
  return new Plugin({
    key: selectionSpacerKey,
    state: {
      init: () => [] as { from: number; to: number }[],
      apply(tr, prev) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const meta = tr.getMeta(selectionSpacerKey)
        if (meta !== undefined) return meta as { from: number; to: number }[]
        if (tr.docChanged && prev.length) {
          return prev.map(r => ({ from: tr.mapping.map(r.from), to: tr.mapping.map(r.to) }))
        }
        return prev
      },
    },
    props: {
      decorations(state) {
        const ranges = selectionSpacerKey.getState(state)!
        if (!ranges.length) return DecorationSet.empty
        const decos: Decoration[] = []
        for (const { from, to } of ranges) {
          decos.push(Decoration.widget(from, mkSpacer, { side: -1 }))
          decos.push(Decoration.widget(to,   mkSpacer, { side:  1 }))
        }
        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

function resolveMarkRange(doc: Node, markId: string): { from: number; to: number } | null {
  const markType = schema.marks['annotation']
  let start = -1
  let end   = -1
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    if (node.marks.some(m => m.type === markType && m.attrs.id === markId)) {
      if (start === -1) start = pos
      end = pos + node.nodeSize
    }
    return true
  })
  return start !== -1 ? { from: start, to: end } : null
}

export function setSelectionMarkSpacers(view: EditorView, markIds: string[]): void {
  const ranges = markIds.flatMap(id => {
    const r = resolveMarkRange(view.state.doc, id)
    return r ? [r] : []
  })
  view.dispatch(view.state.tr.setMeta(selectionSpacerKey, ranges))
}
