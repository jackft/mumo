interface UttTierView {
  setTierVisible(v: boolean): void
}

const _registry = new Map<string, UttTierView>()
let _visible = false

export function registerUttTierView(uttId: string, view: UttTierView): void {
  _registry.set(uttId, view)
}

export function unregisterUttTierView(uttId: string, view: UttTierView): void {
  if (_registry.get(uttId) === view) _registry.delete(uttId)
}

export function setUttTiersVisible(visible: boolean): void {
  _visible = visible
  for (const view of _registry.values()) {
    view.setTierVisible(visible)
  }
}

export function isUttTiersVisible(): boolean {
  return _visible
}
