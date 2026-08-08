interface ProsodyView {
  redrawProsody(): void
}

const _registry = new Set<ProsodyView>()

export function registerProsodyView(view: ProsodyView): void {
  _registry.add(view)
}

export function unregisterProsodyView(view: ProsodyView): void {
  _registry.delete(view)
}

/**
 * Redraw every live intonation contour. Nodeviews read pitch data through the host's `getIntonation`
 * callback but don't observe it, so the host must call this when that data changes out-of-band —
 * late pitch compute, a loaded `.mumo` injecting persisted pitch, or a participant-channel change.
 */
export function redrawAllProsody(): void {
  for (const view of _registry) view.redrawProsody()
}
