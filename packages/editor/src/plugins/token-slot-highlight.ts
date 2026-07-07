import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import type { TokenStore, TokenRecord } from '@mumo/core'
import { charOffsetToDocPos } from '../pos-utils.js'

export interface TokenRef { id: string }

function resolveToken(ref: TokenRef, tokenStore: TokenStore): TokenRecord | undefined {
  return tokenStore.getToken(ref.id)
}

interface HighlightRange { from: number; to: number }

const tokenSlotHighlightKey = new PluginKey<HighlightRange[]>('tokenSlotHighlight')

export function buildTokenSlotHighlightPlugin(): Plugin {
  return new Plugin({
    key: tokenSlotHighlightKey,
    state: {
      init: () => [] as HighlightRange[],
      apply(tr, prev) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const meta = tr.getMeta(tokenSlotHighlightKey)
        if (meta !== undefined) return meta as HighlightRange[]
        if (tr.docChanged && prev.length) {
          return prev.map(r => ({ from: tr.mapping.map(r.from), to: tr.mapping.map(r.to) }))
        }
        return prev
      },
    },
    props: {
      decorations(state) {
        const ranges = tokenSlotHighlightKey.getState(state)
        if (!ranges?.length) return DecorationSet.empty
        return DecorationSet.create(state.doc,
          ranges.map(h => Decoration.inline(h.from, h.to, { class: 'token-slot-highlight' })),
        )
      },
    },
  })
}

// Build uttId → doc position index

function buildUttIndex(view: EditorView): Map<string, number> {
  const index = new Map<string, number>()
  view.state.doc.forEach((node, offset) => { index.set(node.attrs.id as string, offset + 1) })
  return index
}

// On-demand token position resolution
// Resolves token refs to {from,to} PM positions on demand rather than tracking
// through transactions, so positions are always fresh after any doc change.

export function resolveTokenRanges(
  view: EditorView,
  tokens: TokenRef[],
  tokenStore: TokenStore,
): { from: number; to: number }[] {
  const uttIndex = buildUttIndex(view)
  const ranges: { from: number; to: number }[] = []
  for (const ref of tokens) {
    const tok = resolveToken(ref, tokenStore)
    if (!tok) continue
    const uttStart = uttIndex.get(tok.uttId)
    if (uttStart === undefined) continue
    ranges.push({
      from: charOffsetToDocPos(view.state.doc, uttStart, tok.startOffset),
      to: charOffsetToDocPos(view.state.doc, uttStart, tok.endOffset),
    })
  }
  return ranges
}

// Token highlight (single token — inspector hover)

export function setTokenSlotHighlight(
  view: EditorView,
  token: TokenRef | null,
  tokenStore: TokenStore,
): void {
  if (!token) {
    view.dispatch(view.state.tr.setMeta(tokenSlotHighlightKey, []))
    return
  }
  const tok = resolveToken(token, tokenStore)
  if (!tok) return
  const uttIndex = buildUttIndex(view)
  const uttStart = uttIndex.get(tok.uttId)
  if (uttStart === undefined) return
  view.dispatch(view.state.tr.setMeta(tokenSlotHighlightKey, [{
    from: charOffsetToDocPos(view.state.doc, uttStart, tok.startOffset),
    to:   charOffsetToDocPos(view.state.doc, uttStart, tok.endOffset),
  }]))
}

// Multi-token highlight (pattern hover)

export function setHoverTokenRanges(
  view: EditorView,
  refs: TokenRef[],
  tokenStore: TokenStore,
): void {
  const uttIndex = buildUttIndex(view)
  const ranges: HighlightRange[] = []
  for (const ref of refs) {
    const tok = resolveToken(ref, tokenStore)
    if (!tok) continue
    const uttStart = uttIndex.get(tok.uttId)
    if (uttStart === undefined) continue
    ranges.push({
      from: charOffsetToDocPos(view.state.doc, uttStart, tok.startOffset),
      to:   charOffsetToDocPos(view.state.doc, uttStart, tok.endOffset),
    })
  }
  view.dispatch(view.state.tr.setMeta(tokenSlotHighlightKey, ranges))
}
