import { InputRule, inputRules } from 'prosemirror-inputrules'
import type { Plugin } from 'prosemirror-state'
import type { SymbolDef } from '@mumo/core'

export const DEFAULT_SYMBOL_DEFS: SymbolDef[] = [
  { unicode: '°',    shortcut: 'degree',    description: 'Degree (soft voice)' },
  { unicode: '°',    shortcut: 'deg' },
  { unicode: '˙',    shortcut: 'ib',        description: 'In-breath' },
  { unicode: '˙',    shortcut: 'inbreath' },
  { unicode: 'hh',   shortcut: 'ob',        description: 'Out-breath' },
  { unicode: 'hh',   shortcut: 'outbreath' },
  { unicode: '↑',    shortcut: 'up',        description: 'Pitch up' },
  { unicode: '↓',    shortcut: 'down',      description: 'Pitch down' },
  { unicode: '↓',    shortcut: 'dn' },
  { unicode: '=',    shortcut: 'latch',     description: 'Latch' },
  { unicode: '>',    shortcut: 'fast',      description: 'Fast speech' },
  { unicode: '<',    shortcut: 'slow',      description: 'Slow speech' },
  { unicode: ':',    shortcut: 'colon',     description: 'Prolongation' },
  { unicode: '-',    shortcut: 'cut',       description: 'Cut-off' },
  { unicode: '(.)',  shortcut: 'pause',     description: 'Micropause' },
  { unicode: '(.)',  shortcut: 'mp' },
  { unicode: '((',   shortcut: 'desc',      description: 'Begin description' },
  { unicode: '))',   shortcut: 'enddesc',   description: 'End description' },
]

function defsToCommands(defs: SymbolDef[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const def of defs) {
    if (def.shortcut) map[def.shortcut] = def.unicode
  }
  return map
}

export const SYMBOL_COMMANDS: Record<string, string> = defsToCommands(DEFAULT_SYMBOL_DEFS)

// \word<space> → replacement + space
export function buildSymbolInputRulePlugin(getSymbolDefs?: () => SymbolDef[]): Plugin {
  const rule = new InputRule(/\\([a-z]+) $/, (state, match, start, end) => {
    const defs = getSymbolDefs?.() ?? []
    const commands = defs.length > 0 ? defsToCommands(defs) : SYMBOL_COMMANDS
    const char = commands[match[1]!]
    if (!char) return null
    return state.tr.replaceWith(start, end, state.schema.text(char + ' '))
  })
  return inputRules({ rules: [rule] })
}
