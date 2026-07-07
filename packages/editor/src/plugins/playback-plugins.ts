import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'

// Loop plugin

const loopKey = new PluginKey<Set<string>>('loop')

export function buildLoopPlugin(): Plugin {
  return new Plugin({
    key: loopKey,
    state: {
      init: () => new Set<string>(),
      apply(tr, prev) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const meta = tr.getMeta(loopKey)
        if (meta !== undefined) return meta as Set<string>
        return prev
      },
    },
    props: {
      decorations(state) {
        const loopIds = loopKey.getState(state)!
        if (!loopIds.size) return DecorationSet.empty
        const decos: Decoration[] = []
        state.doc.forEach((node, offset) => {
          const id = node.attrs.id as string | undefined
          if (id && loopIds.has(id)) {
            decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'is-looping' }))
          }
        })
        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

export function updateLoopIds(view: EditorView, ids: string[]): void {
  const prev = loopKey.getState(view.state) ?? new Set<string>()
  const next = new Set(ids)
  if (next.size === prev.size && [...next].every(id => prev.has(id))) return
  view.dispatch(view.state.tr.setMeta(loopKey, next).setMeta('addToHistory', false))
}

// Playing plugin

const playingKey = new PluginKey<Set<string>>('playing')

export function buildPlayingPlugin(): Plugin {
  return new Plugin({
    key: playingKey,
    state: {
      init: () => new Set<string>(),
      apply(tr, prev) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const meta = tr.getMeta(playingKey)
        if (meta !== undefined) return meta as Set<string>
        return prev
      },
    },
    props: {
      decorations(state) {
        const activeIds = playingKey.getState(state)!
        if (!activeIds.size) return DecorationSet.empty
        const decos: Decoration[] = []
        state.doc.forEach((node, offset) => {
          const id = node.attrs.id as string | undefined
          if (id && activeIds.has(id)) {
            decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'is-playing' }))
          }
        })
        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

export function updatePlaying(view: EditorView, added: string[], removed: string[]): void {
  const prev = playingKey.getState(view.state) ?? new Set<string>()
  if (!added.length && !removed.length) return
  const next = new Set(prev)
  for (const id of removed) next.delete(id)
  for (const id of added) next.add(id)
  view.dispatch(view.state.tr.setMeta(playingKey, next).setMeta('addToHistory', false))
}
