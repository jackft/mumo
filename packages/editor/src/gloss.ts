export interface GlossEntry {
  /** null = no gloss annotation for this utterance (hide slot).
   *  ''  = annotation exists but empty (show editable slot).
   *  str = annotation text. */
  text: string | null
  onSave: ((text: string) => void) | null
}

interface GlossView {
  applyGloss(entry: GlossEntry): void
  setGlossVisible(v: boolean): void
}

const _registry = new Map<string, GlossView>()
const _currentGlosses = new Map<string, GlossEntry>()
let _visible = false

export function registerGlossView(uttId: string, view: GlossView): void {
  _registry.set(uttId, view)
}

export function unregisterGlossView(uttId: string, view: GlossView): void {
  if (_registry.get(uttId) === view) _registry.delete(uttId)
}

export function getGlossEntryFor(uttId: string): GlossEntry {
  return _currentGlosses.get(uttId) ?? { text: null, onSave: null }
}

export function setAllGlosses(glosses: Map<string, GlossEntry>): void {
  _currentGlosses.clear()
  for (const [k, v] of glosses) _currentGlosses.set(k, v)
  for (const [id, view] of _registry) {
    view.applyGloss(glosses.get(id) ?? { text: null, onSave: null })
  }
}

export function setGlossesVisible(visible: boolean): void {
  _visible = visible
  for (const view of _registry.values()) {
    view.setGlossVisible(visible)
  }
}

export function isGlossesVisible(): boolean {
  return _visible
}
