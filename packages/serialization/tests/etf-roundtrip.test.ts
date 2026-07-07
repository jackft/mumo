import { describe, it, expect } from 'vitest'
import { AnnotationStore } from '@mumo/core'
import { emitETF } from '../src/eaf-emit.js'
import { emitMMETF } from '../src/mmeaf-emit.js'
import { parseETF } from '../src/eaf-parse.js'
import { parseMMEAF } from '../src/mmeaf-parse.js'
import { buildETFFixture } from './fixtures/build.js'

// emitETF output structure

describe('emitETF output structure', () => {
  it('is valid XML with ANNOTATION_DOCUMENT root', () => {
    const { xml } = buildETFFixture()
    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain('<ANNOTATION_DOCUMENT')
    expect(xml).toContain('</ANNOTATION_DOCUMENT>')
  })

  it('omits TIME_ORDER block', () => {
    const { xml } = buildETFFixture()
    expect(xml).not.toContain('<TIME_ORDER>')
    expect(xml).not.toContain('<TIME_SLOT')
  })

  it('omits ANNOTATION elements', () => {
    const { xml } = buildETFFixture()
    expect(xml).not.toContain('<ANNOTATION>')
    expect(xml).not.toContain('<ALIGNABLE_ANNOTATION')
    expect(xml).not.toContain('<REF_ANNOTATION')
  })

  it('emits TIER elements', () => {
    const { xml } = buildETFFixture()
    expect(xml).toContain('TIER_ID="Speech"')
    expect(xml).toContain('TIER_ID="POS"')
    expect(xml).toContain('TIER_ID="Gesture"')
    expect(xml).toContain('TIER_ID="GesturePhase"')
  })

  it('emits PARENT_REF on child tiers', () => {
    const { xml } = buildETFFixture()
    expect(xml).toContain('PARENT_REF="Speech"')
    expect(xml).toContain('PARENT_REF="Gesture"')
  })

  it('emits LINGUISTIC_TYPE elements', () => {
    const { xml } = buildETFFixture()
    expect(xml).toContain('LINGUISTIC_TYPE_ID="POS-type"')
    expect(xml).toContain('LINGUISTIC_TYPE_ID="GesturePhase-type"')
  })

  it('emits constraint stereotypes on linguistic types', () => {
    const { xml } = buildETFFixture()
    expect(xml).toContain('CONSTRAINTS="Symbolic_Association"')
    expect(xml).toContain('CONSTRAINTS="Included_In"')
  })

  it('emits CONTROLLED_VOCABULARY_REF linking LT to vocab', () => {
    const { xml } = buildETFFixture()
    expect(xml).toContain('CONTROLLED_VOCABULARY_REF=')
  })

  it('emits CONTROLLED_VOCABULARY with entries', () => {
    const { xml } = buildETFFixture()
    expect(xml).toContain('<CONTROLLED_VOCABULARY')
    expect(xml).toContain('NOUN')
    expect(xml).toContain('VERB')
    expect(xml).toContain('ADJ')
  })

  it('emits all four CONSTRAINT declarations', () => {
    const { xml } = buildETFFixture()
    expect(xml).toContain('STEREOTYPE="Time_Subdivision"')
    expect(xml).toContain('STEREOTYPE="Included_In"')
    expect(xml).toContain('STEREOTYPE="Symbolic_Association"')
    expect(xml).toContain('STEREOTYPE="Symbolic_Subdivision"')
  })

  it('empty store produces minimal valid ETF', () => {
    const store = new AnnotationStore()
    const xml = emitETF(store)
    expect(xml).toContain('<ANNOTATION_DOCUMENT')
    expect(xml).not.toContain('<TIME_ORDER>')
    expect(xml).not.toContain('<ANNOTATION>')
  })
})

// parseETF imports tiers / LTs / CVs

describe('parseETF: tiers', () => {
  it('imports all tier names', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    const names = result.tiers.map(t => t.name)
    expect(names).toContain('Speech')
    expect(names).toContain('POS')
    expect(names).toContain('Gesture')
    expect(names).toContain('GesturePhase')
  })

  it('restores parent-child relationship', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    const pos = result.tiers.find(t => t.name === 'POS')!
    const speech = result.tiers.find(t => t.name === 'Speech')!
    expect(pos).toBeDefined()
    expect(speech).toBeDefined()
    expect(pos.parentTierId).toBe(speech.id)
  })

  it('restores gesture phase parent-child relationship', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    const phase = result.tiers.find(t => t.name === 'GesturePhase')!
    const gesture = result.tiers.find(t => t.name === 'Gesture')!
    expect(phase.parentTierId).toBe(gesture.id)
  })

  it('produces no annotations (template has no annotation data)', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    expect(result.annotations).toHaveLength(0)
  })

  it('produces a placeholder utterance when template has no annotation data', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    const doc = result.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    // eafTomumo always inserts one placeholder utterance when there are no blocks
    const utterances = doc.content.filter(n => n.type === 'utterance')
    expect(utterances).toHaveLength(1)
    expect(utterances[0]!.attrs['startTimeSeconds']).toBeNull()
  })
})

describe('parseETF: linguistic types', () => {
  it('imports all linguistic type names', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    const names = result.linguisticTypes.map(lt => lt.name)
    expect(names).toContain('POS-type')
    expect(names).toContain('GesturePhase-type')
  })

  it('restores symbolic_association constraint', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    const posLt = result.linguisticTypes.find(lt => lt.name === 'POS-type')!
    expect(posLt).toBeDefined()
    expect(posLt.constraint).toBe('symbolic_association')
  })

  it('restores included_in constraint', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    const phaseLt = result.linguisticTypes.find(lt => lt.name === 'GesturePhase-type')!
    expect(phaseLt).toBeDefined()
    expect(phaseLt.constraint).toBe('included_in')
  })

  it('restores vocabulary reference on linguistic type', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    const posLt = result.linguisticTypes.find(lt => lt.name === 'POS-type')!
    expect(posLt.vocabularyId).toBeDefined()
    // vocabularyId should point to the POS vocabulary
    const vocab = result.vocabularies.find(v => v.id === posLt.vocabularyId)
    expect(vocab).toBeDefined()
    expect(vocab!.name).toBe('POS')
  })
})

describe('parseETF: controlled vocabularies', () => {
  it('imports the POS vocabulary', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    expect(result.vocabularies).toHaveLength(1)
    expect(result.vocabularies[0]!.name).toBe('POS')
  })

  it('imports all vocabulary entries', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    const values = result.vocabularies[0]!.entries.map(e => e.value)
    expect(values).toContain('NOUN')
    expect(values).toContain('VERB')
    expect(values).toContain('ADJ')
  })

  it('imports entry descriptions', () => {
    const { xml } = buildETFFixture()
    const result = parseETF(xml)
    const noun = result.vocabularies[0]!.entries.find(e => e.value === 'NOUN')!
    expect(noun.description).toBe('Noun')
  })
})

// ETF full round-trip

describe('ETF round-trip: store → emitETF → parseETF → new store', () => {
  it('tier count survives', () => {
    const { store, xml } = buildETFFixture()
    const result = parseETF(xml)
    expect(result.tiers).toHaveLength(store.allTiers().length)
  })

  it('linguistic types from store all survive round-trip', () => {
    const { store, xml } = buildETFFixture()
    const result = parseETF(xml)
    // Ad-hoc LTs are created for tiers without explicit linguisticTypeId, so
    // result count may be >= store count — but every named store LT must be present.
    const resultNames = result.linguisticTypes.map(lt => lt.name)
    for (const lt of store.allLinguisticTypes()) {
      expect(resultNames).toContain(lt.name)
    }
  })

  it('vocabulary count survives', () => {
    const { store, xml } = buildETFFixture()
    const result = parseETF(xml)
    expect(result.vocabularies).toHaveLength(store.allVocabularies().length)
  })

  it('vocabulary entry count survives', () => {
    const { store, xml } = buildETFFixture()
    const result = parseETF(xml)
    const origEntryCount = store.allVocabularies().reduce((n, v) => n + v.entries.length, 0)
    const newEntryCount = result.vocabularies.reduce((n, v) => n + v.entries.length, 0)
    expect(newEntryCount).toBe(origEntryCount)
  })

  it('double round-trip produces equivalent tier structure', () => {
    const { xml: xml1 } = buildETFFixture()
    const r1 = parseETF(xml1)

    const store2 = new AnnotationStore()
    store2.loadJSON({ annotations: [], relations: [], tiers: r1.tiers, linguisticTypes: r1.linguisticTypes, vocabularies: r1.vocabularies })
    const xml2 = emitETF(store2)
    const r2 = parseETF(xml2)

    // Tier names must be exactly stable across both trips
    const names1 = r1.tiers.map(t => t.name).sort()
    const names2 = r2.tiers.map(t => t.name).sort()
    expect(names2).toEqual(names1)

    // Vocabularies must be stable
    expect(r2.vocabularies).toHaveLength(r1.vocabularies.length)
  })
})

// emitMMETF

describe('emitMMETF output structure', () => {
  it('is a superset of ETF — still omits TIME_ORDER and ANNOTATIONs', () => {
    const { store } = buildETFFixture()
    const xml = emitMMETF(store)
    expect(xml).not.toContain('<TIME_ORDER>')
    expect(xml).not.toContain('<ANNOTATION>')
  })

  it('includes mm namespace declaration', () => {
    const { store } = buildETFFixture()
    const xml = emitMMETF(store)
    expect(xml).toContain('xmlns:mm="https://mumo.io/ns/mmeaf/1"')
  })

  it('includes mm:mumo_DATA block', () => {
    const { store } = buildETFFixture()
    const xml = emitMMETF(store)
    expect(xml).toContain('<mm:mumo_data')
    expect(xml).toContain('</mm:mumo_data>')
  })

  it('MMETF is parseable as plain ETF (EAF-compatible portion)', () => {
    const { store } = buildETFFixture()
    const xml = emitMMETF(store)
    const result = parseETF(xml)
    expect(result.tiers).toHaveLength(store.allTiers().length)
    // All named store LTs must be present (ad-hoc LTs may add more)
    const resultLtNames = result.linguisticTypes.map(lt => lt.name)
    for (const lt of store.allLinguisticTypes()) {
      expect(resultLtNames).toContain(lt.name)
    }
  })

  it('MMETF is parseable via parseMMEAF', () => {
    const { store } = buildETFFixture()
    const xml = emitMMETF(store)
    const result = parseMMEAF(xml)
    expect(result.tiers).toHaveLength(store.allTiers().length)
    expect(result.vocabularies).toHaveLength(store.allVocabularies().length)
  })

  it('MMETF round-trip: tier names survive', () => {
    const { store } = buildETFFixture()
    const xml = emitMMETF(store)
    const result = parseMMEAF(xml)
    const names = result.tiers.map(t => t.name).sort()
    expect(names).toContain('Speech')
    expect(names).toContain('POS')
    expect(names).toContain('Gesture')
    expect(names).toContain('GesturePhase')
  })

  it('MMETF round-trip: vocabulary entries survive', () => {
    const { store } = buildETFFixture()
    const xml = emitMMETF(store)
    const result = parseMMEAF(xml)
    const values = result.vocabularies[0]!.entries.map(e => e.value)
    expect(values).toContain('NOUN')
    expect(values).toContain('VERB')
    expect(values).toContain('ADJ')
  })
})
