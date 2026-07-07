import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import type { TokenStore, SlotTextStyle } from '@mumo/core'
import type { TokenRef } from './token-slot-highlight.js'
import { charOffsetToDocPos } from '../pos-utils.js'

export function styleToCSS(s: SlotTextStyle): string {
  const parts: string[] = []
  if (s.textColor)       parts.push(`color:${s.textColor}`)
  if (s.backgroundColor) parts.push(`background-color:${s.backgroundColor}`)
  if (s.bold)            parts.push(`font-weight:bold`)
  if (s.italic)          parts.push(`font-style:italic`)
  const td: string[] = []
  if (s.underline)       td.push('underline')
  if (s.strikethrough)   td.push('line-through')
  if (td.length)         parts.push(`text-decoration:${td.join(' ')}`)
  if (s.borderColor)     parts.push(`outline:1px solid ${s.borderColor};border-radius:2px`)
  return parts.join(';')
}

export interface StyledTokenRef { ref: TokenRef; style: SlotTextStyle }

interface StyledRange { from: number; to: number; css: string }

function resolveToken(ref: TokenRef, tokenStore: TokenStore) {
  return tokenStore.getToken(ref.id)
}

const pluginKey = new PluginKey<StyledRange[]>('slotStyle')

export function buildSlotStylePlugin(): Plugin {
  return new Plugin({
    key: pluginKey,
    state: {
      init: () => [] as StyledRange[],
      apply(tr, prev) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const meta = tr.getMeta(pluginKey)
        if (meta !== undefined) return meta as StyledRange[]
        if (tr.docChanged && prev.length > 0) {
          return prev.map(r => ({ ...r, from: tr.mapping.map(r.from), to: tr.mapping.map(r.to) }))
        }
        return prev
      },
    },
    props: {
      decorations(state) {
        const ranges = pluginKey.getState(state)!
        if (!ranges.length) return DecorationSet.empty
        return DecorationSet.create(state.doc,
          ranges.map(r => Decoration.inline(r.from, r.to, { style: r.css })),
        )
      },
    },
  })
}

export function setStyledSlotTokens(
  view: EditorView,
  refs: StyledTokenRef[],
  tokenStore: TokenStore,
): void {
  const uttIndex = new Map<string, number>()
  view.state.doc.forEach((node, offset) => { uttIndex.set(node.attrs.id as string, offset + 1) })
  const ranges: StyledRange[] = []
  for (const { ref, style } of refs) {
    const tok = resolveToken(ref, tokenStore)
    if (!tok) continue
    const css = styleToCSS(style)
    if (!css) continue
    const uttStart = uttIndex.get(tok.uttId)
    if (uttStart === undefined) continue
    ranges.push({
      from: charOffsetToDocPos(view.state.doc, uttStart, tok.startOffset),
      to: charOffsetToDocPos(view.state.doc, uttStart, tok.endOffset),
      css,
    })
  }
  view.dispatch(view.state.tr.setMeta(pluginKey, ranges))
}
