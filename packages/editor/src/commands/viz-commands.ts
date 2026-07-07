import { InputRule, inputRules } from 'prosemirror-inputrules'
import type { Plugin } from 'prosemirror-state'
import { schema } from '@mumo/core'

function buildVizTypePlugin(pattern: RegExp, vizType: string): Plugin {
  const rule = new InputRule(pattern, (state, _match, start, end) => {
    const $from = state.selection.$from
    if ($from.parent.type !== schema.nodes['visualization']) return null
    const vizPos = $from.before($from.depth)
    const tr = state.tr.delete(start, end)
    tr.setNodeAttribute(tr.mapping.map(vizPos), 'type', vizType)
    return tr
  })
  return inputRules({ rules: [rule] })
}

export function buildSpectInputRulePlugin(): Plugin {
  return buildVizTypePlugin(/\/spect$/, 'spectrogram-clip')
}
