import { InputRule, inputRules } from 'prosemirror-inputrules'
import type { Plugin } from 'prosemirror-state'
import { schema, newId } from '@mumo/core'

export function buildImageInputRulePlugin(): Plugin {
  const rule = new InputRule(/\/image$/, (state, _match, start, end) => {
    const $from = state.selection.$from
    const parent = $from.parent

    if (parent.type === schema.nodes['visualization']) {
      // Inside a viz block: insert an inline image node at the cursor
      const tr = state.tr.delete(start, end)
      const img = schema.nodes['image'].create({ id: newId() })
      return tr.insert(tr.mapping.map($from.pos), img)
    }

    if (parent.type === schema.nodes['utterance'] || parent.type === schema.nodes['event']) {
      // Inside utterance/event: create a viz block after the current block
      const tr = state.tr.delete(start, end)
      const blockEnd = $from.end($from.depth - 1) + 1
      const img = schema.nodes['image'].create({ id: newId() })
      const viz = schema.nodes['visualization'].create({ id: newId(), type: 'screenshot' }, img)
      return tr.insert(tr.mapping.map(blockEnd), viz)
    }

    return null
  })
  return inputRules({ rules: [rule] })
}
