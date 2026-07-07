import type { AnnotationStore, SuggestedChange, TextletCode } from './store.js'

/**
 * Apply an accepted suggestion's change. Called inside an existing Yjs transaction
 * so all writes land in the caller's transaction. Uses slot-granular writes so
 * concurrent accepts merge cleanly.
 */
export function applySuggestedChange(store: AnnotationStore, change: SuggestedChange): void {
  switch (change.type) {
  case 'textlet:add':
  case 'annotation:add': {
      const a = change.annotation
      store.addAnnotation(a.type, a.anchors, a.features, a.id)
      break
    }
  case 'textlet:delete':
      store.removeAnnotation(change.textletId)
      break
  case 'textlet:add-code': {
      const ann = store.getAnnotation(change.textletId)
      if (!ann) break
      const existing: TextletCode[] = (ann.features.codes as TextletCode[] | undefined) ?? []
      const isDup = change.code.vocabEntryId
        ? existing.some(c => c.vocabEntryId === change.code.vocabEntryId)
        : existing.some(c => !c.vocabEntryId && c.value === change.code.value)
      if (!isDup) store.updateAnnotation(change.textletId, { features: { codes: [...existing, change.code] } })
      break
    }
  case 'textlet:remove-code': {
      const ann = store.getAnnotation(change.textletId)
      if (!ann) break
      const existing: TextletCode[] = (ann.features.codes as TextletCode[] | undefined) ?? []
      const next = existing.filter(c =>
        change.code.vocabEntryId ? c.vocabEntryId !== change.code.vocabEntryId : (c.vocabEntryId != null || c.value !== change.code.value)
      )
      const patch: Record<string, unknown> = next.length > 0 ? { codes: next } : { codes: undefined }
      store.updateAnnotation(change.textletId, { features: patch })
      break
    }
  case 'pattern:add':
      store.addPattern(change.schemaId, [], {}, change.patternId)
      break
  case 'pattern:delete':
      store.removePattern(change.patternId)
      break
  case 'pattern:fill-slot': {
      if (change.pendingAnnotation) {
        const a = change.pendingAnnotation
        store.addAnnotation(a.type, a.anchors, a.features, a.id)
      }
      store.fillPatternSlot(change.patternId, change.slot)
      break
    }
  case 'pattern:fill-metric':
      store.setPatternSlotMetric(change.patternId, change.slotSchemaId, change.metricId, change.value)
      break
  case 'annotation:delete':
      store.removeAnnotation(change.annotationId)
      break
  case 'annotation:update':
      store.updateAnnotation(change.annotationId, change.patch)
      break
  case 'pm:replace':
  case 'utt:set-participant':
  case 'utt:set-time':
      // These change types require host-application involvement (PM doc access).
      // The host handles them via the 'suggestion:pre-accept' event before this runs.
      break
  }
}
