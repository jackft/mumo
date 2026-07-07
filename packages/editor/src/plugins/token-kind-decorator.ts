import { Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node } from 'prosemirror-model'
import type { TokenStore, TokenRecord } from '@mumo/core'
import { charOffsetToDocPos } from '../pos-utils.js'

function buildDecorations(
  doc: Node,
  tokenStore: TokenStore,
  kindClasses: Partial<Record<TokenRecord['kind'], string>>,
  invalidTokenIds?: () => ReadonlySet<string>,
): DecorationSet {
  const invalidIds = invalidTokenIds?.()
  const decorations: Decoration[] = []
  doc.forEach((node, offset) => {
    const nodeStart = offset + 1
    if (node.type.name === 'utterance') {
      const blockId = node.attrs.id as string
      for (const tok of tokenStore.getUttTokens(blockId)) {
        const classes: string[] = []
        const cls = kindClasses[tok.kind]
        if (cls) classes.push(cls)
        if (invalidIds?.has(tok.id)) classes.push('tok-gap-invalid')
        if (classes.length > 0) {
          decorations.push(
            Decoration.inline(
              charOffsetToDocPos(doc, nodeStart, tok.startOffset),
              charOffsetToDocPos(doc, nodeStart, tok.endOffset),
              { class: classes.join(' ') },
            )
          )
        }
      }
    }
  })
  return DecorationSet.create(doc, decorations)
}

export function buildTokenKindDecoratorPlugin(
  tokenStore: TokenStore,
  kindClasses: Partial<Record<TokenRecord['kind'], string>>,
  invalidTokenIds?: () => ReadonlySet<string>,
): Plugin {
  // decorations() is called after all appendTransaction hooks, so tokenStore is always current.
  return new Plugin({
    props: {
      decorations(state) {
        return buildDecorations(state.doc, tokenStore, kindClasses, invalidTokenIds)
      },
    },
  })
}
