import { tokenizeString } from './tokenize.js'
import { newId } from './id.js'
import type { Node } from 'prosemirror-model'
import type { ID, TokenRecord } from './types.js'

export interface RebuildResult {
  newIds: ReadonlySet<ID>
  shrunkBlocks: ReadonlySet<ID>
  removedIds: ReadonlySet<ID>
}

export class TokenStore {
  private _byBlock = new Map<ID, TokenRecord[]>()
  private _byId    = new Map<ID, TokenRecord>()
  // Tokens removed by rebuildBlockNode (single-block user edits). Kept so that
  // a subsequent buildFromDoc (triggered by undo) can exact-match them back to
  // their original IDs - preventing tokenNodeId references in annotations from
  // becoming orphaned after undo. Bounded to avoid unbounded growth.
  private _deletedPool = new Map<ID, TokenRecord>()
  private static readonly _DELETED_POOL_MAX = 1024

  get isEmpty(): boolean { return this._byId.size === 0 }

  /** Replace store contents with pre-parsed token records (preserves IDs). */
  loadTokens(tokens: TokenRecord[]): void {
    this._byBlock = new Map()
    this._byId    = new Map()
    this._deletedPool.clear()
    for (const tok of tokens) {
      let arr = this._byBlock.get(tok.uttId)
      if (!arr) { arr = []; this._byBlock.set(tok.uttId, arr) }
      arr.push(tok)
      this._byId.set(tok.id, tok)
    }
  }

  /** Rebuild tokens for a single block node. O(words in that block). */
  rebuildBlockNode(node: Node): RebuildResult {
    const blockId = node.attrs.id as ID
    const { tokens, newIds } = this._tokensForNode(blockId, node)
    const old = this._byBlock.get(blockId) ?? []
    const oldCount = old.filter(t => t.kind !== 'ws').length
    const newCount = tokens.filter(t => t.kind !== 'ws').length
    const newTokenIds = new Set(tokens.map(t => t.id))
    const removedIds = new Set(old.map(t => t.id).filter(id => !newTokenIds.has(id)))
    // Preserve removed tokens so buildFromDoc (triggered on undo) can exact-match them
    // back to their original IDs, keeping tokenNodeId references in annotations valid.
    for (const id of removedIds) {
      const tok = this._byId.get(id)
      if (!tok) continue
      if (this._deletedPool.size >= TokenStore._DELETED_POOL_MAX)
        this._deletedPool.delete(this._deletedPool.keys().next().value!)
      this._deletedPool.set(id, tok)
    }
    for (const tok of old) this._byId.delete(tok.id)
    this._byBlock.set(blockId, tokens)
    for (const tok of tokens) this._byId.set(tok.id, tok)
    return {
      newIds,
      shrunkBlocks: newCount < oldCount ? new Set([blockId]) : new Set<ID>(),
      removedIds,
    }
  }

  /**
   * Re-derive tokens from the current PM doc's plain text.
   * Existing tokens for each block are used as an ID pool keyed by "kind:text" -
   * stable IDs are reused for tokens whose kind+text still appear.
   */
  buildFromDoc(doc: Node): RebuildResult {
    const newByBlock = new Map<ID, TokenRecord[]>()
    const newById    = new Map<ID, TokenRecord>()
    const allNewIds  = new Set<ID>()
    doc.forEach(node => {
      const blockType = node.type.name
      if (blockType !== 'utterance') return
      const blockId = node.attrs.id as ID
      const { tokens, newIds } = this._tokensForNode(blockId, node)
      newByBlock.set(blockId, tokens)
      for (const tok of tokens) newById.set(tok.id, tok)
      for (const id of newIds) allNewIds.add(id)
    })
    const removedIds = new Set([...this._byId.keys()].filter(id => !newById.has(id)))
    this._byBlock = newByBlock
    this._byId    = newById
    return { newIds: allNewIds, shrunkBlocks: new Set<ID>(), removedIds }
  }

  /** Tokens for a given utterance or event block, in document order. */
  getUttTokens(blockId: ID): TokenRecord[] {
    return this._byBlock.get(blockId) ?? []
  }

  getToken(id: ID): TokenRecord | undefined {
    return this._byId.get(id)
  }

  /** All tokens across all blocks, in insertion order. */
  allTokens(): TokenRecord[] {
    const out: TokenRecord[] = []
    for (const arr of this._byBlock.values()) out.push(...arr)
    return out
  }

  // Internal helpers

  private _tokensForNode(blockId: ID, node: Node): { tokens: TokenRecord[]; newIds: Set<ID> } {
    // Build the authoritative text by skipping suggestion_insert runs.
    // suggestion_delete text is kept as-is - it is the current document truth.
    let filteredText = ''
    node.forEach(child => {
      if (child.isText && !child.marks.some(m => m.type.name === 'suggestion_insert')) {
        filteredText += child.text ?? ''
      }
      // Atom nodes (overlap_bracket, inline_ann, image) contribute no characters.
    })
    const frags = tokenizeString(filteredText)

    type PoolEntry = { id: ID; startOffset: number; endOffset: number; fromDeleted?: true }

    // Two pools: exact (kind:text) for identical tokens, kind-only for changed-text fallback.
    const exactPool = new Map<string, PoolEntry[]>()
    const kindPool  = new Map<string, PoolEntry[]>()
    for (const tok of this._byBlock.get(blockId) ?? []) {
      const entry: PoolEntry = { id: tok.id, startOffset: tok.startOffset, endOffset: tok.endOffset }
      const exactKey = `${tok.kind}:${tok.text}`
      if (!exactPool.has(exactKey)) exactPool.set(exactKey, [])
      exactPool.get(exactKey)!.push(entry)
      if (!kindPool.has(tok.kind)) kindPool.set(tok.kind, [])
      kindPool.get(tok.kind)!.push(entry)
    }
    // Also include recently-deleted tokens for this block as exact-match candidates.
    // This ensures undo (which runs buildFromDoc) reassigns the original ID to a
    // restored word, so annotation tokenNodeId references remain valid.
    for (const [, tok] of this._deletedPool) {
      if (tok.uttId !== blockId) continue
      const exactKey = `${tok.kind}:${tok.text}`
      if (!exactPool.has(exactKey)) exactPool.set(exactKey, [])
      exactPool.get(exactKey)!.push({ id: tok.id, startOffset: tok.startOffset, endOffset: tok.endOffset, fromDeleted: true })
    }

    // Pre-compute character offsets for all fragments.
    let off = 0
    const offsets = frags.map(f => { const o = off; off += f.text.length; return o })

    // Pass 1 - exact match (kind:text).
    const tokens: (TokenRecord | null)[] = new Array<TokenRecord | null>(frags.length).fill(null)
    const usedIds = new Set<ID>()
    for (let i = 0; i < frags.length; i++) {
      const frag  = frags[i]!
      const queue = exactPool.get(`${frag.kind}:${frag.text}`)
      const entry = queue && queue.length > 0 ? queue.shift()! : null
      if (!entry) continue
      usedIds.add(entry.id)
      if (entry.fromDeleted) this._deletedPool.delete(entry.id)
      tokens[i] = {
        id: entry.id, uttId: blockId, kind: frag.kind, text: frag.text,
        startOffset: offsets[i]!, endOffset: offsets[i]! + frag.text.length,
      }
    }

    // Pass 2 - kind-only fallback for tokens whose text changed (e.g. red->read).
    // An old ID is only reused when the old token's offset range overlaps the
    // new fragment's range: in-place retypes keep their ID, but a deleted
    // word's ID never migrates to an unrelated new word elsewhere in the block
    // (which would silently re-target that word's annotations). Among
    // overlapping candidates the positionally nearest wins.
    const newIds = new Set<ID>()
    for (let i = 0; i < frags.length; i++) {
      if (tokens[i] !== null) continue
      const frag = frags[i]!
      const from = offsets[i]!
      const to   = from + frag.text.length
      let best: PoolEntry | null = null
      let bestDist = Infinity
      for (const entry of kindPool.get(frag.kind) ?? []) {
        if (usedIds.has(entry.id)) continue
        if (entry.startOffset > to || entry.endOffset < from) continue
        const dist = Math.abs(entry.startOffset - from)
        if (dist < bestDist) { best = entry; bestDist = dist }
      }
      let id: ID
      if (best) {
        id = best.id
        usedIds.add(id)
      } else {
        // Truly new token - no positionally plausible pool match.
        id = newId()
        newIds.add(id)
      }
      tokens[i] = {
        id, uttId: blockId, kind: frag.kind, text: frag.text,
        startOffset: from, endOffset: to,
      }
    }

    return { tokens: tokens as TokenRecord[], newIds }
  }
}
