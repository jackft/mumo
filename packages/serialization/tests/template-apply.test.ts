import { describe, it, expect } from 'vitest'
import { parseMMETF, parseMMEAF, emitMMEAF, emitMMETF } from '../src/index.js'
import { AnnotationStore } from '@mumo/core'
import { buildTemplateMerge } from '../../mumo/src/template-merge.js'

function makeStore() { return new AnnotationStore() }

describe('template apply end-to-end', () => {
  it('applies vocab, LT, and pattern schema from template onto a transcript-loaded store', () => {
    // Build a transcript store with some LTs and a pattern schema (simulates transcript.mmeaf)
    const transcriptStore = makeStore()
    transcriptStore.addLinguisticType('default-lt')
    transcriptStore.addLinguisticType('symbolic_association', { constraint: 'symbolic_association' })
    const _repairSchema = transcriptStore.addPatternSchema({ name: 'repair', slots: [] })

    // Round-trip through MMEAF serialization (same path as the app's MMEAF importer)
    const emptyDoc = { type: 'doc', content: [] } as never
    const transcriptXml = emitMMEAF(emptyDoc, transcriptStore)
    const transcriptResult = parseMMEAF(transcriptXml)
    const store = makeStore()
    store.loadJSON({
      annotations: transcriptResult.annotations,
      tiers: transcriptResult.tiers,
      vocabularies: transcriptResult.vocabularies,
      linguisticTypes: transcriptResult.linguisticTypes,
      patternSchemas: transcriptResult.patternSchemas,
      patterns: transcriptResult.patterns,
      participants: transcriptResult.participants,
    })

    expect(store.allPatternSchemas().map(s => s.name)).toContain('repair')

    // Build a template store with vocab "test", LT "blah" (referencing vocab), pattern schema "howdy"
    const templateStore = makeStore()
    const vocab = templateStore.addVocabulary('test', [
      { id: 'e1', value: 'A', description: 'B' },
      { id: 'e2', value: 'C', description: 'D' },
    ])
    templateStore.addLinguisticType('blah', { constraint: 'symbolic_association', vocabularyId: vocab.id })
    templateStore.addPatternSchema({
      name: 'howdy',
      slots: [{ id: 's1', name: 'a', anchorKind: 'any', required: true, metrics: [] }],
    })

    // Round-trip through MMETF serialization (same path as Save Template → Apply Template)
    const templateXml = emitMMETF(templateStore)
    const tmpl = parseMMETF(templateXml)

    // Apply
    const merge = buildTemplateMerge(tmpl, store)
    expect(merge.conflicts).toHaveLength(0)
    expect(merge.preview.some(s => s.items.some(i => i.action !== 'skip'))).toBe(true)

    merge.applyFn(store)

    expect(store.allVocabularies().map(v => v.name)).toContain('test')
    expect(store.allLinguisticTypes().map(lt => lt.name)).toContain('blah')
    expect(store.allPatternSchemas().map(s => s.name)).toContain('howdy')
    expect(store.allPatternSchemas().map(s => s.name)).toContain('repair')
  })
})
