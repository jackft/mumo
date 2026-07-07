import { InputRule, inputRules } from 'prosemirror-inputrules'
import { schema } from '@mumo/core'

/**
 * When `//` is typed at position 0 of an utterance, convert the utterance
 * to a comment block. The `//` text stays in the content.
 */
const commentInputRule = new InputRule(/^\/\//, (state, _match, start) => {
  const $start = state.doc.resolve(start)

  let uttDepth = -1
  for (let d = $start.depth; d >= 0; d--) {
    if ($start.node(d).type === schema.nodes['utterance']) { uttDepth = d; break }
  }
  if (uttDepth === -1) return null

  // Only fire when // appears at the very start of the utterance content.
  if ($start.parentOffset !== 0) return null

  const uttPos = $start.before(uttDepth)
  const uttNode = $start.node(uttDepth)

  return state.tr.setNodeMarkup(uttPos, schema.nodes['comment'], {
    id: (uttNode.attrs.id as string | null) ?? null,
  })
})

export function buildCommentRulePlugin() {
  return inputRules({ rules: [commentInputRule] })
}
