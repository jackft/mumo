import { Plugin, PluginKey } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import { Node, Fragment } from 'prosemirror-model'
import { schema } from './schema.js'
import { newId } from './id.js'
import type { ID } from './types.js'
import type { TokenStore } from './token-store.js'
import type { AnnotationStore } from './store.js'
import { USER_ORIGIN } from './store.js'

export interface ControllerMeta {
  newIds: ReadonlySet<ID>
  shrunkBlocks: ReadonlySet<ID>
  removedIds: ReadonlySet<ID>
}

const EMPTY_META: ControllerMeta = { newIds: new Set<ID>(), shrunkBlocks: new Set<ID>(), removedIds: new Set<ID>() }

export const controllerKey = new PluginKey<ControllerMeta>('mumo-controller')

/** Ranges changed by the transactions, expressed in final-doc coordinates. */
function changedRanges(transactions: readonly Transaction[]): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  for (let i = 0; i < transactions.length; i++) {
    const tr = transactions[i]!
    for (let j = 0; j < tr.steps.length; j++) {
      tr.steps[j]!.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        let from = newStart
        let to = newEnd
        for (let k = j + 1; k < tr.steps.length; k++) {
          const m = tr.steps[k]!.getMap()
          from = m.map(from, -1)
          to = m.map(to, 1)
        }
        for (let t = i + 1; t < transactions.length; t++) {
          for (const s of transactions[t]!.steps) {
            const m = s.getMap()
            from = m.map(from, -1)
            to = m.map(to, 1)
          }
        }
        ranges.push({ from, to })
      })
    }
  }
  return ranges
}

/**
 * Top-level blocks touched by the given ranges.
 * Returns null if any touched block is not an utterance (caller falls back to full rebuild).
 */
function touchedUtterances(doc: Node, ranges: Array<{ from: number; to: number }>): Node[] | null {
  if (ranges.length === 0) return []
  let blocks: Node[] | null = []
  doc.forEach((node, offset) => {
    const from = offset
    const to = offset + node.nodeSize
    if (!ranges.some(r => r.from <= to && r.to >= from)) return
    if (node.type.name !== 'utterance') { blocks = null; return }
    blocks?.push(node)
  })
  return blocks
}

/**
 * Pass yjsSyncKey (the y-prosemirror ySyncPluginKey) so Yjs-sourced transactions
 * (undo, redo, remote) always do a full rebuild. Without it, undo in a different block
 * leaves stale tokens and _syncSymbolicAnnotations recreates removed annotations.
 */
export function createControllerPlugin(tokenStore: TokenStore, yjsSyncKey?: PluginKey): Plugin<ControllerMeta> {
  return new Plugin<ControllerMeta>({
    key: controllerKey,

    state: {
      init: () => EMPTY_META,
      apply: (tr, prev) => (tr.getMeta(controllerKey) as ControllerMeta | undefined) ?? prev,
    },

    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some(tr => tr.docChanged)) return null

      // Yjs-sourced transactions (undo, redo, remote sync) always rebuild in
      // full so buildFromDoc can exact-match restored tokens back to their
      // original IDs via the deleted pool.
      const isYjsSource = yjsSyncKey !== undefined &&
        transactions.some(t => t.getMeta(yjsSyncKey) !== undefined)

      if (!isYjsSource && newState.doc.childCount === oldState.doc.childCount) {
        // Fast path: rebuild exactly the utterance blocks the steps touched.
        // Derived from the transactions' step maps - not from the selection -
        // so programmatic edits away from the cursor are handled correctly.
        const blocks = touchedUtterances(newState.doc, changedRanges(transactions))
        if (blocks) {
          const newIds = new Set<ID>()
          const shrunkBlocks = new Set<ID>()
          const removedIds = new Set<ID>()
          for (const block of blocks) {
            const meta = tokenStore.rebuildBlockNode(block)
            for (const id of meta.newIds) newIds.add(id)
            for (const id of meta.shrunkBlocks) shrunkBlocks.add(id)
            for (const id of meta.removedIds) removedIds.add(id)
          }
          return newState.tr.setMeta(controllerKey, { newIds, shrunkBlocks, removedIds })
        }
      }

      // Fallback: initial sync, block add/remove, undo/redo, remote change,
      // edits touching non-utterance blocks
      const meta = tokenStore.buildFromDoc(newState.doc)
      return newState.tr.setMeta(controllerKey, meta)
    },
  })
}

/** Build a minimal document with one empty utterance from scratch. */
export function createEmptyDoc(): Node {
  const utt = schema.node('utterance', {
    id: newId(),
    participant: '',
    startTimeSeconds: null,
    endTimeSeconds: null,
  })
  return schema.node('doc', null, [utt])
}

export type UttSpec = { participant: string; text: string; id?: ID; startTimeSeconds?: number; endTimeSeconds?: number }

/** Build a document from a list of plain-text utterances, sorted by start time. */
export function docFromUtterances(utterances: UttSpec[]): Node {
  const sorted = [...utterances].sort((a, b) => (a.startTimeSeconds ?? Infinity) - (b.startTimeSeconds ?? Infinity))
  const nodes = sorted.map(u => {
    const content = u.text ? Fragment.from(schema.text(u.text)) : undefined
    return schema.node('utterance', {
      id: u.id ?? newId(),
      participant: u.participant,
      startTimeSeconds: u.startTimeSeconds ?? null,
      endTimeSeconds: u.endTimeSeconds ?? null,
    }, content)
  })
  return schema.node('doc', null, nodes)
}

/** @deprecated Use docFromUtterances instead. */
export function docFromBlocks(blocks: Array<{ type?: string } & UttSpec>): Node {
  return docFromUtterances(blocks)
}

function _ensureUttTier(store: AnnotationStore, participant: string, tierId?: string | null) {
  if (tierId) {
    const tier = store.getTier(tierId)
    if (tier?.isUttTier) return tier
  }
  return store.allTiers().find(t => t.isUttTier && t.participant === participant)
    ?? store.addTier(participant, { isUttTier: true, participant })
}

/**
 * Keeps utterance-mirror annotations in sync with PM utterance nodes.
 * One annotation per utterance, same ID as the node, in an isUttTier for the participant.
 * Child tiers reference these via parentAnnId instead of the old blockNodeId.
 */
export function createUttSyncPlugin(store: AnnotationStore, yjsSyncKey?: PluginKey): Plugin {
  return new Plugin({
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some(tr => tr.docChanged)) return null
      // Skip remote/undo-redo transactions — the originating client already synced the
      // annotation change, and remote clients receive it via Yjs replication.  Running
      // this on both sides causes duplicate Y.Array entries for creates and wrong-index
      // deletes for removes.
      if (yjsSyncKey && transactions.some(t => t.getMeta(yjsSyncKey) !== undefined)) return null

      const oldUtts = new Map<string, Node>()
      const newUtts = new Map<string, Node>()

      oldState.doc.forEach((node: Node) => {
        if (node.type.name === 'utterance') oldUtts.set(node.attrs.id as string, node)
      })
      newState.doc.forEach((node: Node) => {
        if (node.type.name === 'utterance') newUtts.set(node.attrs.id as string, node)
      })

      // Early exit: nothing structural or time-relevant changed
      let hasChanges = oldUtts.size !== newUtts.size
      if (!hasChanges) {
        for (const [id, newNode] of newUtts) {
          const oldNode = oldUtts.get(id)
          if (!oldNode ||
              oldNode.attrs.startTimeSeconds !== newNode.attrs.startTimeSeconds ||
              oldNode.attrs.endTimeSeconds   !== newNode.attrs.endTimeSeconds   ||
              oldNode.attrs.participant      !== newNode.attrs.participant) {
            hasChanges = true; break
          }
        }
      }
      if (!hasChanges) return null

      // One Yjs transaction for the whole reconciliation: observers fire once,
      // and the change lands as a single undo step.
      store.transact(() => {
        // Remove annotations for deleted utterances (cascades to children)
        for (const id of oldUtts.keys()) {
          if (!newUtts.has(id) && store.getAnnotation(id)) {
            store.removeAnnotation(id)
          }
        }

        // Create / update annotations for current utterances
        for (const [id, node] of newUtts) {
          const { startTimeSeconds, endTimeSeconds } = node.attrs
          const hasTime = startTimeSeconds != null && endTimeSeconds != null
          const anchors = hasTime
            ? [{ type: 'time' as const, start: startTimeSeconds as number, end: endTimeSeconds as number }]
            : []

          const existing = store.getAnnotation(id)
          if (!existing) {
            const tier = _ensureUttTier(store, node.attrs.participant as string, node.attrs.tierId as string | null)
            store.addAnnotation('', anchors, { tierId: tier.id }, id)
          } else {
            const oldNode = oldUtts.get(id)
            if (oldNode &&
                (oldNode.attrs.startTimeSeconds !== startTimeSeconds ||
                 oldNode.attrs.endTimeSeconds   !== endTimeSeconds)) {
              store.updateAnnotation(id, { anchors }, USER_ORIGIN, true)
            }
          }
        }
      })

      return null
    },
  })
}
