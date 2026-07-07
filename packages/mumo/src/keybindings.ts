export type ActionId =
  | 'play_pause'
  | 'play_pause_global'
  | 'loop_play'
  | 'stop_loop_play'
  | 'toggle_loop'
  | 'play'
  | 'pause'
  | 'skip_back'
  | 'frame_forward'
  | 'frame_back'
  | 'step_forward_1s'
  | 'step_back_1s'
  | 'go_to_start'
  | 'go_to_end'
  | 'next_utterance'
  | 'prev_utterance'
  | 'speed_up'
  | 'speed_down'
  | 'cycle_snap'
  | 'create_textlet'
  | 'mode_edit'
  | 'mode_annotate'
  | 'save'
  | 'toggle_inspector'
  | 'toggle_transcript'
  | 'toggle_glosses'
  | 'toggle_utt_tiers'

export interface ActionDef {
  id: ActionId
  label: string
  group: string
  defaultBinding: string
}

export const ACTION_DEFS: ActionDef[] = [
  // Playback
  { id: 'play_pause',        label: 'Play / pause',                      group: 'Playback',   defaultBinding: ' ' },
  { id: 'play_pause_global', label: 'Play / pause (works while editing)', group: 'Playback',   defaultBinding: 'ctrl+ ' },
  { id: 'loop_play',         label: 'Loop current utterance',             group: 'Playback',   defaultBinding: 'ctrl+shift+ ' },
  { id: 'stop_loop_play',    label: 'Stop loop play (pause + disarm)',    group: 'Playback',   defaultBinding: 'ctrl+\\' },
  { id: 'toggle_loop',       label: 'Arm / disarm loop region',           group: 'Playback',   defaultBinding: '\\' },
  { id: 'play',              label: 'Play',                               group: 'Playback',   defaultBinding: 'l' },
  { id: 'pause',             label: 'Pause',                              group: 'Playback',   defaultBinding: 'k' },
  { id: 'skip_back',         label: 'Pause and skip back 2 s',           group: 'Playback',   defaultBinding: 'j' },
  { id: 'speed_up',          label: 'Speed up',                          group: 'Playback',   defaultBinding: 'ctrl+=' },
  { id: 'speed_down',        label: 'Speed down',                        group: 'Playback',   defaultBinding: 'ctrl+-' },
  // Navigation
  { id: 'frame_forward',     label: 'Step forward (1 frame)',             group: 'Navigation', defaultBinding: 'arrowright' },
  { id: 'frame_back',        label: 'Step back (1 frame)',                group: 'Navigation', defaultBinding: 'arrowleft' },
  { id: 'step_forward_1s',   label: 'Step forward 1 s',                  group: 'Navigation', defaultBinding: 'shift+arrowright' },
  { id: 'step_back_1s',      label: 'Step back 1 s',                     group: 'Navigation', defaultBinding: 'shift+arrowleft' },
  { id: 'go_to_start',       label: 'Go to start',                       group: 'Navigation', defaultBinding: 'home' },
  { id: 'go_to_end',         label: 'Go to end',                         group: 'Navigation', defaultBinding: 'end' },
  { id: 'next_utterance',    label: 'Next utterance',                     group: 'Navigation', defaultBinding: 'alt+arrowright' },
  { id: 'prev_utterance',    label: 'Previous / restart utterance',       group: 'Navigation', defaultBinding: 'alt+arrowleft' },
  // Annotation
  { id: 'create_textlet',    label: 'Create textlet from selection',      group: 'Annotation', defaultBinding: 'alt+a' },
  { id: 'mode_edit',         label: 'Switch to edit mode',                group: 'Annotation', defaultBinding: 'e' },
  { id: 'mode_annotate',     label: 'Switch to annotate mode',            group: 'Annotation', defaultBinding: '' },
  // Timeline
  { id: 'cycle_snap',        label: 'Cycle snap mode',                    group: 'Timeline',   defaultBinding: 's' },
  // File
  { id: 'save',              label: 'Save',                               group: 'File',       defaultBinding: 'ctrl+s' },
  // View
  { id: 'toggle_inspector',  label: 'Toggle inspector panel',             group: 'View',       defaultBinding: '' },
  { id: 'toggle_transcript', label: 'Toggle transcript panel',            group: 'View',       defaultBinding: '' },
  { id: 'toggle_glosses',    label: 'Toggle glosses',                     group: 'View',       defaultBinding: '' },
  { id: 'toggle_utt_tiers',  label: 'Toggle utterance tier names',        group: 'View',       defaultBinding: '' },
]

export type KeyBindings = Record<ActionId, string>

export function defaultBindings(): KeyBindings {
  const b = {} as KeyBindings
  for (const def of ACTION_DEFS) b[def.id] = def.defaultBinding
  return b
}

export function mergeBindings(base: KeyBindings, overrides: Partial<Record<string, string>>): KeyBindings {
  return { ...base, ...overrides }
}

const KEY_LABELS: Record<string, string> = {
  ' ':           'Space',
  'arrowleft':   '←',
  'arrowright':  '→',
  'arrowup':     '↑',
  'arrowdown':   '↓',
  'home':        'Home',
  'end':         'End',
  'escape':      'Esc',
  'enter':       'Enter',
  'backspace':   '⌫',
  'delete':      'Del',
  'tab':         'Tab',
  '\\':          '\\',
}

export function formatCombo(combo: string): string {
  if (!combo) return '—'
  const parts: string[] = []
  let rest = combo
  const modLabels: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: '⌘' }
  for (const mod of ['ctrl', 'alt', 'shift', 'meta']) {
    if (rest.startsWith(mod + '+')) {
      parts.push(modLabels[mod] ?? mod)
      rest = rest.slice(mod.length + 1)
    }
  }
  parts.push(KEY_LABELS[rest] ?? rest.toUpperCase())
  return parts.join('+')
}

export function normalizeKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey)  parts.push('ctrl')
  if (e.altKey)   parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey)  parts.push('meta')
  const key = e.key.toLowerCase()
  if (['control', 'alt', 'shift', 'meta'].includes(key)) return ''
  parts.push(key)
  return parts.join('+')
}
