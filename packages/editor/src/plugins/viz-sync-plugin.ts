import { Plugin } from 'prosemirror-state'
import type { Node } from 'prosemirror-model'

/**
 * Propagates time changes from an utterance/event to any dependent
 * visualization blocks that reference it via parentNodeId.
 */
export function buildVizSyncPlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some(tr => tr.docChanged)) return null

      // Collect utterance/event nodes whose times changed
      const changed = new Map<string, { start: number | null; end: number | null }>()

      const oldById = new Map<string, Node>()
      oldState.doc.forEach(node => {
        if (node.type.name === 'utterance')
          oldById.set(node.attrs.id as string, node)
      })

      newState.doc.forEach(node => {
        if (node.type.name !== 'utterance') return
        const id = node.attrs.id as string
        const old = oldById.get(id)
        if (!old) return
        if (
          old.attrs.startTimeSeconds !== node.attrs.startTimeSeconds ||
          old.attrs.endTimeSeconds   !== node.attrs.endTimeSeconds
        ) {
          changed.set(id, {
            start: node.attrs.startTimeSeconds as number | null,
            end:   node.attrs.endTimeSeconds   as number | null,
          })
        }
      })

      if (changed.size === 0) return null

      const tr = newState.tr
      let didChange = false
      newState.doc.forEach((node, offset) => {
        if (node.type.name !== 'visualization') return
        if (!node.attrs.dependent) return
        const parentId = node.attrs.parentNodeId as string | null
        if (!parentId) return
        const times = changed.get(parentId)
        if (!times) return
        tr.setNodeMarkup(offset, undefined, {
          ...node.attrs,
          startTimeSeconds: times.start,
          endTimeSeconds:   times.end,
        })
        didChange = true
      })

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      return didChange ? tr : null
    },
  })
}
