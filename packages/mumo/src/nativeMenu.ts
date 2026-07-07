export type MenuAction =
  | 'file:new' | 'file:open' | 'file:save'
  | 'file:openTemplate' | 'file:saveTemplate'
  | 'file:setLanguage'
  | 'tracks:importCOCO' | 'tracks:importMOT'
  | 'media:loadMedia' | 'media:linkMedia'
  | 'edit:insertVisualization'
  | 'selection:createTextlet'
  | 'view:toggleInspector' | 'view:collection'
  | 'tier:newTier'
  | 'type:lingTypes' | 'type:vocabs' | 'type:patternSchemas'
  | 'collaborate:start'
  | 'help:shortcuts'
  | 'debug:showFps' | 'debug:decodeTiming' | 'debug:debugTray'

export interface NativeMenuItem {
  label?: string
  type?: 'separator' | 'submenu' | 'normal'
  /** Electron built-in role (undo, redo, cut, copy, paste, quit, etc.) */
  role?: string
  action?: MenuAction
  accelerator?: string
  enabled?: boolean
  submenu?: NativeMenuItem[]
}

export const NATIVE_MENU_TEMPLATE: NativeMenuItem[] = [
  {
    label: 'File',
    submenu: [
      { label: 'New',             action: 'file:new',          accelerator: 'CmdOrCtrl+N' },
      { label: 'Open…',           action: 'file:open',         accelerator: 'CmdOrCtrl+O' },
      { label: 'Save',            action: 'file:save',         accelerator: 'CmdOrCtrl+S' },
      { type: 'separator' },
      { label: 'Open template…',  action: 'file:openTemplate' },
      { label: 'Save template',   action: 'file:saveTemplate' },
      { type: 'separator' },
      { label: 'Language…',       action: 'file:setLanguage' },
    ],
  },
  {
    label: 'Tracks',
    submenu: [
      { label: 'Import COCO JSON…', action: 'tracks:importCOCO' },
      { label: 'Import MOT CSV…',   action: 'tracks:importMOT' },
    ],
  },
  {
    label: 'Media',
    submenu: [
      { label: 'Load media…',      action: 'media:loadMedia' },
      { label: 'Link media file…', action: 'media:linkMedia' },
    ],
  },
  {
    label: 'Selection',
    submenu: [
      { label: 'Create Textlet', action: 'selection:createTextlet', accelerator: 'Alt+A' },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { label: 'Insert visualization', action: 'edit:insertVisualization', accelerator: 'Alt+Shift+Return' },
    ],
  },
  {
    label: 'View',
    submenu: [
      { label: 'Collections', action: 'view:collection' },
      { label: 'Tool panel', action: 'view:toggleInspector' },
    ],
  },
  {
    label: 'Tier',
    submenu: [
      { label: 'New annotation tier…', action: 'tier:newTier' },
    ],
  },
  {
    label: 'Type',
    submenu: [
      { label: 'Linguistic types…', action: 'type:lingTypes' },
      { label: 'Vocabularies…',     action: 'type:vocabs' },
      { label: 'Pattern schemas…',    action: 'type:patternSchemas' },
    ],
  },
  {
    label: 'Collaborate',
    submenu: [
      { label: 'Start collaboration…', action: 'collaborate:start' },
    ],
  },
  {
    label: 'Help',
    submenu: [
      { label: 'Keyboard shortcuts', action: 'help:shortcuts' },
    ],
  },
  ...(import.meta.env.DEV ? [{
    label: 'Debug',
    submenu: [
      { label: 'Show Timeline FPS',    action: 'debug:showFps' as const },
      { label: 'Decode timing overlay', action: 'debug:decodeTiming' as const },
      { label: 'Debug tray',           action: 'debug:debugTray' as const },
    ],
  }] : []),
]