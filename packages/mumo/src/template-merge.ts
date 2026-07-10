import type { AnnotationStore, TierDefJSON, VocabularyJSON, LinguisticTypeJSON, PatternSchemaJSON } from '@mumo/core'
import { newId } from '@mumo/core'
import type { ConflictEntry, PreviewSection } from './apply-template-types.js'

export type TemplateMergeInput = {
  tiers: TierDefJSON[]
  vocabularies: VocabularyJSON[]
  linguisticTypes: LinguisticTypeJSON[]
  patternSchemas?: PatternSchemaJSON[]
}

export type TemplateMergeResult = {
  conflicts: ConflictEntry[]
  preview: PreviewSection[]
  applyFn: (store: AnnotationStore) => void
}

export function buildTemplateMerge(tmpl: TemplateMergeInput, store: AnnotationStore): TemplateMergeResult {
  const tmplVocabs  = tmpl.vocabularies
  const tmplLTs     = tmpl.linguisticTypes
  const tmplTiers   = tmpl.tiers
  const tmplSchemas = tmpl.patternSchemas  ?? []

  const exVocabs  = new Map(store.allVocabularies().map(v  => [v.name, v]))
  const exLTs     = new Map(store.allLinguisticTypes().map(lt => [lt.name, lt]))
  const exTiers   = new Map(store.allTiers().map(t          => [t.name, t]))
  const exSchemas = new Map(store.allPatternSchemas().map(s  => [s.name, s]))

  const tmplLTById    = new Map(tmplLTs.map(lt   => [lt.id, lt]))
  const tmplVocabById = new Map(tmplVocabs.map(v => [v.id, v]))
  const tmplTierById  = new Map(tmplTiers.map(t  => [t.id, t]))

  const conflicts: ConflictEntry[] = []

  for (const v of tmplVocabs) {
    const ex = exVocabs.get(v.name)
    if (!ex) continue
    const tmplVals = new Set(v.entries.map(e => e.value))
    const missing = ex.entries.map(e => e.value).filter(val => !tmplVals.has(val))
    if (missing.length > 0)
      conflicts.push({ category: 'Vocabulary', name: v.name, reason: `existing has entries not in template: ${missing.join(', ')}` })
  }

  for (const lt of tmplLTs) {
    const ex = exLTs.get(lt.name)
    if (!ex) continue
    if (ex.constraint !== lt.constraint)
      conflicts.push({ category: 'Linguistic type', name: lt.name, reason: `constraint mismatch — existing: ${ex.constraint ?? 'none'}, template: ${lt.constraint ?? 'none'}` })
    const exVocabName   = ex.vocabularyId ? [...exVocabs.values()].find(v => v.id === ex.vocabularyId)?.name  : undefined
    const tmplVocabName = lt.vocabularyId ? tmplVocabById.get(lt.vocabularyId)?.name                          : undefined
    if (exVocabName !== tmplVocabName)
      conflicts.push({ category: 'Linguistic type', name: lt.name, reason: `vocabulary mismatch — existing: ${exVocabName ?? 'none'}, template: ${tmplVocabName ?? 'none'}` })
  }

  const allStoreTiers = store.allTiers()
  for (const tier of tmplTiers) {
    const ex = exTiers.get(tier.name)
    if (!ex) continue
    const exLTName     = ex.linguisticTypeId  ? [...exLTs.values()].find(lt => lt.id === ex.linguisticTypeId)?.name : undefined
    const tmplLTName   = tier.linguisticTypeId ? tmplLTById.get(tier.linguisticTypeId)?.name                        : undefined
    if (exLTName !== tmplLTName)
      conflicts.push({ category: 'Tier', name: tier.name, reason: `linguistic type mismatch — existing: ${exLTName ?? 'none'}, template: ${tmplLTName ?? 'none'}` })
    const exParentName   = ex.parentTierId   ? allStoreTiers.find(t => t.id === ex.parentTierId)?.name  : undefined
    const tmplParentName = tier.parentTierId ? tmplTierById.get(tier.parentTierId)?.name                 : undefined
    if (exParentName !== tmplParentName)
      conflicts.push({ category: 'Tier', name: tier.name, reason: `parent mismatch — existing: ${exParentName ?? 'none'}, template: ${tmplParentName ?? 'none'}` })
  }

  for (const schema of tmplSchemas) {
    const ex = exSchemas.get(schema.name)
    if (!ex) continue
    for (const exSlot of ex.slots) {
      const tmplSlot = schema.slots.find(s => s.name === exSlot.name)
      if (!tmplSlot) {
        conflicts.push({ category: 'Pattern schema', name: schema.name, reason: `existing has slot not in template: "${exSlot.name}"` })
        continue
      }
      const tmplMetricNames = new Set(tmplSlot.metrics.map(m => m.name))
      const missingMetrics = exSlot.metrics.map(m => m.name).filter(n => !tmplMetricNames.has(n))
      if (missingMetrics.length > 0)
        conflicts.push({ category: 'Pattern schema', name: schema.name, reason: `slot "${exSlot.name}" missing metrics in template: ${missingMetrics.join(', ')}` })
    }
  }

  // Preview
  const preview: PreviewSection[] = []

  const vocabItems = tmplVocabs.map(v => {
    const ex = exVocabs.get(v.name)
    if (!ex) return { action: 'add' as const, name: v.name, detail: `${v.entries.length} entries` }
    const exVals = new Set(ex.entries.map(e => e.value))
    const newEntries = v.entries.filter(e => !exVals.has(e.value))
    if (newEntries.length === 0) return { action: 'skip' as const, name: v.name }
    return { action: 'merge' as const, name: v.name, additions: newEntries.map(e => e.value) }
  })
  if (vocabItems.length > 0) preview.push({ category: 'Vocabularies', items: vocabItems })

  const ltItems = tmplLTs.map(lt => {
    if (exLTs.has(lt.name)) return { action: 'skip' as const, name: lt.name }
    const vocabName = lt.vocabularyId ? tmplVocabById.get(lt.vocabularyId)?.name : undefined
    const parts = [
      lt.constraint ? `constraint: ${lt.constraint}` : '',
      vocabName     ? `vocab: ${vocabName}` : '',
    ].filter(Boolean)
    return { action: 'add' as const, name: lt.name, ...(parts.length ? { detail: parts.join(', ') } : {}) }
  })
  if (ltItems.length > 0) preview.push({ category: 'Linguistic types', items: ltItems })

  const orderedTmplTiers = orderTiersByDependency(tmplTiers)

  const tierItems = orderedTmplTiers.map(tier => {
    if (exTiers.has(tier.name)) return { action: 'skip' as const, name: tier.name }
    const ltName     = tier.linguisticTypeId ? tmplLTById.get(tier.linguisticTypeId)?.name : undefined
    const parentName = tier.parentTierId     ? tmplTierById.get(tier.parentTierId)?.name   : undefined
    const parts = [
      ltName     ? `LT: ${ltName}`         : '',
      parentName ? `parent: ${parentName}` : '',
    ].filter(Boolean)
    return { action: 'add' as const, name: tier.name, ...(parts.length ? { detail: parts.join(', ') } : {}) }
  })
  if (tierItems.length > 0) preview.push({ category: 'Tiers', items: tierItems })

  const schemaItems = tmplSchemas.map(schema => {
    const ex = exSchemas.get(schema.name)
    if (!ex) return { action: 'add' as const, name: schema.name, detail: `${schema.slots.length} slot${schema.slots.length === 1 ? '' : 's'}` }
    const additions: string[] = []
    for (const tmplSlot of schema.slots) {
      const exSlot = ex.slots.find(s => s.name === tmplSlot.name)
      if (!exSlot) { additions.push(`slot: ${tmplSlot.name}`); continue }
      const exMetricNames = new Set(exSlot.metrics.map(m => m.name))
      for (const m of tmplSlot.metrics) {
        if (!exMetricNames.has(m.name)) additions.push(`${tmplSlot.name} › ${m.name}`)
      }
    }
    if (additions.length === 0) return { action: 'skip' as const, name: schema.name }
    return { action: 'merge' as const, name: schema.name, additions }
  })
  if (schemaItems.length > 0) preview.push({ category: 'Pattern schemas', items: schemaItems })

  const applyFn = (s: AnnotationStore) => {
    s.transact(() => {
      const vocabIdMap = new Map<string, string>()
      for (const v of tmplVocabs) {
        const ex = exVocabs.get(v.name)
        if (ex) {
          vocabIdMap.set(v.id, ex.id)
          const exVals = new Set(ex.entries.map(e => e.value))
          const newEntries = v.entries.filter(e => !exVals.has(e.value))
          if (newEntries.length > 0)
            s.updateVocabulary(ex.id, { entries: [...ex.entries, ...newEntries.map(e => ({ id: newId(), value: e.value, ...(e.description ? { description: e.description } : {}) }))] })
          continue
        }
        const added = s.addVocabulary(v.name, v.entries.map(e => ({ id: newId(), value: e.value, ...(e.description ? { description: e.description } : {}) })))
        vocabIdMap.set(v.id, added.id)
      }

      const ltIdMap = new Map<string, string>()
      for (const lt of tmplLTs) {
        const ex = exLTs.get(lt.name)
        if (ex) { ltIdMap.set(lt.id, ex.id); continue }
        const vocabStoreId = lt.vocabularyId ? vocabIdMap.get(lt.vocabularyId) : undefined
        const added = s.addLinguisticType(lt.name, {
          ...(lt.constraint  ? { constraint: lt.constraint }  : {}),
          ...(vocabStoreId   ? { vocabularyId: vocabStoreId } : {}),
        })
        ltIdMap.set(lt.id, added.id)
      }

      const tierIdMap = new Map<string, string>()
      for (const tier of orderedTmplTiers) {
        const ex = exTiers.get(tier.name)
        if (ex) { tierIdMap.set(tier.id, ex.id); continue }
        const ltStoreId     = tier.linguisticTypeId ? ltIdMap.get(tier.linguisticTypeId) : undefined
        const parentStoreId = tier.parentTierId     ? tierIdMap.get(tier.parentTierId)   : undefined
        const added = s.addTier(tier.name, {
          ...(ltStoreId     ? { linguisticTypeId: ltStoreId } : {}),
          ...(parentStoreId ? { parentTierId: parentStoreId } : {}),
          ...(tier.participant   ? { participant: tier.participant }       : {}),
          ...(tier.annotator     ? { annotator: tier.annotator }           : {}),
          ...(tier.defaultLocale ? { defaultLocale: tier.defaultLocale }   : {}),
          ...(tier.inlineGloss   ? { inlineGloss: tier.inlineGloss }       : {}),
        })
        tierIdMap.set(tier.id, added.id)
      }

      for (const schema of tmplSchemas) {
        const ex = exSchemas.get(schema.name)
        if (!ex) {
          s.addPatternSchema({
            name: schema.name,
            slots: schema.slots.map(slot => ({
              ...slot,
              id: newId(),
              metrics: slot.metrics.map(m => ({
                ...m,
                id: newId(),
                ...(m.vocabularyId ? { vocabularyId: vocabIdMap.get(m.vocabularyId) ?? m.vocabularyId } : {}),
              })),
            })),
            ...(schema.description         ? { description: schema.description } : {}),
            ...(schema.color !== undefined ? { color: schema.color }             : {}),
            ...(schema.hotkey              ? { hotkey: schema.hotkey }           : {}),
          })
          continue
        }
        const mergedSlots = [...ex.slots]
        for (const tmplSlot of schema.slots) {
          const exSlotIdx = mergedSlots.findIndex(s => s.name === tmplSlot.name)
          if (exSlotIdx === -1) {
            mergedSlots.push({ ...tmplSlot, id: newId(), metrics: tmplSlot.metrics.map(m => ({ ...m, id: newId(), ...(m.vocabularyId ? { vocabularyId: vocabIdMap.get(m.vocabularyId) ?? m.vocabularyId } : {}) })) })
          } else {
            const exSlot = mergedSlots[exSlotIdx]!
            const exMetricNames = new Set(exSlot.metrics.map(m => m.name))
            const newMetrics = tmplSlot.metrics
              .filter(m => !exMetricNames.has(m.name))
              .map(m => ({ ...m, id: newId(), ...(m.vocabularyId ? { vocabularyId: vocabIdMap.get(m.vocabularyId) ?? m.vocabularyId } : {}) }))
            if (newMetrics.length > 0)
              mergedSlots[exSlotIdx] = { ...exSlot, metrics: [...exSlot.metrics, ...newMetrics] }
          }
        }
        s.updatePatternSchema(ex.id, { slots: mergedSlots })
      }
    })
  }

  return { conflicts, preview, applyFn }
}

function orderTiersByDependency(tiers: TierDefJSON[]): TierDefJSON[] {
  const byId = new Map(tiers.map(t => [t.id, t]))
  const result: TierDefJSON[] = []
  const visited = new Set<string>()
  function visit(t: TierDefJSON) {
    if (visited.has(t.id)) return
    if (t.parentTierId) { const p = byId.get(t.parentTierId); if (p) visit(p) }
    visited.add(t.id)
    result.push(t)
  }
  tiers.forEach(visit)
  return result
}
