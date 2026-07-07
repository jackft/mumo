import { describe, it, expect, beforeEach } from 'vitest'
import { AnnotationStore } from '../src/store.js'
import { newId } from '../src/id.js'

describe('AnnotationStore — relations', () => {
  let store: AnnotationStore

  beforeEach(() => { store = new AnnotationStore() })

  it('adds and retrieves a relation', () => {
    const src = newId(), tgt = newId(), id = newId()
    store.addRelation('repair', src, tgt, id)
    const all = store.allRelations()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id, type: 'repair', source: src, target: tgt })
  })

  it('removes a relation', () => {
    const id = newId()
    store.addRelation('link', newId(), newId(), id)
    store.removeRelation(id)
    expect(store.allRelations()).toHaveLength(0)
  })

  it('removing an annotation removes its relations', () => {
    const annId = newId()
    store.addAnnotation('x', [], {}, annId)
    store.addRelation('link', annId, newId())
    store.removeAnnotation(annId)
    expect(store.allRelations()).toHaveLength(0)
  })

  it('relationsFor returns both source and target relations', () => {
    const a = newId(), b = newId(), c = newId()
    store.addRelation('r', a, b)
    store.addRelation('r', c, a)
    const rels = store.relationsFor(a)
    expect(rels).toHaveLength(2)
  })
})

describe('AnnotationStore — linguistic types', () => {
  let store: AnnotationStore

  beforeEach(() => { store = new AnnotationStore() })

  it('adds and retrieves a linguistic type', () => {
    const id = newId()
    store.addLinguisticType('POS', { constraint: 'symbolic_association' }, id)
    const all = store.allLinguisticTypes()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id, name: 'POS', constraint: 'symbolic_association' })
  })

  it('removes a linguistic type', () => {
    const id = newId()
    store.addLinguisticType('POS', {}, id)
    store.removeLinguisticType(id)
    expect(store.allLinguisticTypes()).toHaveLength(0)
  })

  it('round-trips linguistic types through JSON', () => {
    const id = newId()
    store.addLinguisticType('Gesture phase', { constraint: 'included_in' }, id)
    const store2 = new AnnotationStore()
    store2.loadJSON(store.toJSON())
    expect(store2.allLinguisticTypes()[0]).toMatchObject({ id, name: 'Gesture phase', constraint: 'included_in' })
  })
})

describe('AnnotationStore — tier updates', () => {
  let store: AnnotationStore

  beforeEach(() => { store = new AnnotationStore() })

  it('updates tier name', () => {
    const id = newId()
    store.addTier('Old', {}, id)
    store.updateTier(id, { name: 'New' })
    expect(store.getTier(id)?.name).toBe('New')
  })

  it('resolves constraint via linguistic type', () => {
    const id = newId()
    store.addTier('T', { constraint: 'symbolic_subdivision' }, id)
    expect(store.resolveTierConstraint(id)).toBe('symbolic_subdivision')
  })

  it('sets parent tier', () => {
    const parentId = newId(), childId = newId()
    store.addTier('Parent', {}, parentId)
    store.addTier('Child', {}, childId)
    store.updateTier(childId, { parentTierId: parentId })
    expect(store.getTier(childId)?.parentTierId).toBe(parentId)
  })
})

describe('AnnotationStore — pattern schemas and patterns', () => {
  let store: AnnotationStore

  beforeEach(() => { store = new AnnotationStore() })

  it('adds a pattern schema', () => {
    const id = newId()
    store.addPatternSchema({
      name: 'Repair',
      color: 0xff0000,
      slots: [],
    }, id)
    expect(store.allPatternSchemas()[0]).toMatchObject({ id, name: 'Repair' })
  })

  it('removes a pattern schema', () => {
    const id = newId()
    store.addPatternSchema({ name: 'R', color: 0, slots: [] }, id)
    store.removePatternSchema(id)
    expect(store.allPatternSchemas()).toHaveLength(0)
  })

  it('adds a pattern referencing a schema', () => {
    const schemaId = newId()
    store.addPatternSchema({ name: 'R', color: 0, slots: [] }, schemaId)
    const pattern = store.addPattern(schemaId)
    expect(store.allPatterns()[0]).toMatchObject({ id: pattern.id, schemaId })
  })

  it('removes a pattern', () => {
    const schemaId = newId()
    store.addPatternSchema({ name: 'R', color: 0, slots: [] }, schemaId)
    const pattern = store.addPattern(schemaId)
    store.removePattern(pattern.id)
    expect(store.allPatterns()).toHaveLength(0)
  })

  it('round-trips pattern schemas through JSON', () => {
    const id = newId()
    store.addPatternSchema({ name: 'Repair', color: 0x0000ff, slots: [] }, id)
    const store2 = new AnnotationStore()
    store2.loadJSON(store.toJSON())
    expect(store2.allPatternSchemas()[0]).toMatchObject({ id, name: 'Repair', color: 0x0000ff })
  })
})

describe('AnnotationStore — annotation features', () => {
  let store: AnnotationStore

  beforeEach(() => { store = new AnnotationStore() })

  it('stores and retrieves arbitrary features', () => {
    const id = newId()
    store.addAnnotation('label', [], { tierId: 'abc', custom: 42 }, id)
    const ann = store.getAnnotation(id)!
    expect(ann.features['tierId']).toBe('abc')
    expect(ann.features['custom']).toBe(42)
  })

  it('updateAnnotation merges features', () => {
    const id = newId()
    store.addAnnotation('x', [], { a: 1, b: 2 }, id)
    store.updateAnnotation(id, { features: { b: 99, c: 3 } })
    const ann = store.getAnnotation(id)!
    expect(ann.features['a']).toBe(1)
    expect(ann.features['b']).toBe(99)
    expect(ann.features['c']).toBe(3)
  })
})

describe('AnnotationStore — vocabulary updates', () => {
  let store: AnnotationStore

  beforeEach(() => { store = new AnnotationStore() })

  it('updates vocabulary name', () => {
    const id = newId()
    store.addVocabulary('Old', [], id)
    store.updateVocabulary(id, { name: 'New' })
    expect(store.getVocabulary(id)?.name).toBe('New')
  })

  it('replaces vocabulary entries', () => {
    const id = newId()
    const e1 = newId()
    store.addVocabulary('V', [{ id: e1, value: 'NOUN' }], id)
    const e2 = newId()
    store.updateVocabulary(id, { entries: [{ id: e2, value: 'VERB' }] })
    expect(store.getVocabulary(id)?.entries).toHaveLength(1)
    expect(store.getVocabulary(id)?.entries[0]?.value).toBe('VERB')
  })
})
