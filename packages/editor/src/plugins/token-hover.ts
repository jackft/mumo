import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import type { TokenStore, TokenRecord } from '@mumo/core'

interface HoverState {
  from: number
  to: number
  tokenId: string
}

const key = new PluginKey<HoverState | null>('tokenHover')

function hitTest(
  view: EditorView,
  event: MouseEvent,
  tokenStore: TokenStore,
): { token: TokenRecord; from: number; to: number } | null {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!hit) return null
  const $pos = view.state.doc.resolve(hit.pos)
  const parent = $pos.parent
  if (parent.type.name !== 'utterance') return null
  const uttId = parent.attrs.id as string
  const offset = $pos.parentOffset
  const tok = tokenStore.getUttTokens(uttId).find(
    t => t.kind !== 'ws' && t.startOffset <= offset && offset < t.endOffset
  )
  if (!tok) return null
  const uttStart = $pos.start($pos.depth)
  return { token: tok, from: uttStart + tok.startOffset, to: uttStart + tok.endOffset }
}

export function buildTokenHoverPlugin(
  tokenStore: TokenStore,
  getMode: () => boolean,
  onTokenClick: (token: TokenRecord) => void,
  onTokenHover?: (token: TokenRecord | null, x: number, y: number) => void,
): Plugin {
  return new Plugin({
    key,
    state: {
      init: () => null as HoverState | null,
      apply(tr, prev) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const meta = tr.getMeta(key)
        if (meta !== undefined) return meta as HoverState | null
        if (tr.docChanged) return null
        return prev
      },
    },
    props: {
      decorations(state) {
        if (!getMode()) return DecorationSet.empty
        const hover = key.getState(state)
        if (!hover) return DecorationSet.empty
        return DecorationSet.create(state.doc, [
          Decoration.inline(hover.from, hover.to, { class: 'token-hover' }),
        ])
      },
      handleDOMEvents: {
        mousemove(view, event) {
          const hit = getMode() ? hitTest(view, event, tokenStore) : null
          const prev = key.getState(view.state)
          const nextId = hit?.token.id ?? null
          const prevId = prev?.tokenId ?? null
          if (prevId !== nextId) {
            view.dispatch(view.state.tr.setMeta(key, hit
              ? { from: hit.from, to: hit.to, tokenId: hit.token.id }
              : null
            ))
            if (hit && onTokenHover) {
              const c0 = view.coordsAtPos(hit.from)
              const c1 = view.coordsAtPos(hit.to)
              onTokenHover(hit.token, (c0.left + c1.right) / 2, c0.top)
            } else {
              onTokenHover?.(null, event.clientX, event.clientY)
            }
          }
          return false
        },
        mouseleave(view) {
          if (key.getState(view.state)) view.dispatch(view.state.tr.setMeta(key, null))
          onTokenHover?.(null, 0, 0)
          return false
        },
        click(view, event) {
          if (!getMode()) return false
          const hit = hitTest(view, event, tokenStore)
          if (!hit) return false
          onTokenClick(hit.token)
          return true
        },
      },
    },
  })
}
