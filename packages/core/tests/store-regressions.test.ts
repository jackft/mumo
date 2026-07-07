import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { AnnotationStore } from '../src/store.js'
import type { SlotInstance, Pattern } from '../src/store.js'
import { TypedEmitter } from '../src/events.js'
import { newId } from '../src/id.js'

describe('updateAnnotation ordered-list membership', () => {
  let store: AnnotationStore

  beforeEach(() => { store = new AnnotationStore() })

  it('moves the annotation between tier lists when tierId changes', () => {
    const tierA = store.addTier('A')
    const tierB = store.addTier('B')
    const ann = store.addAnnotation('x', [], { tierId: tierA.id })

    expect(store.getOrderedAnnotations(tierA.id).map(a => a.id)).toEqual([ann.id])
    expect(store.getOrderedAnnotations(tierB.id)).toEqual([])

    store.updateAnnotation(ann.id, { features: { tierId: tierB.id } })

    expect(store.getOrderedAnnotations(tierA.id)).toEqual([])
    expect(store.getOrderedAnnotations(tierB.id).map(a => a.id)).toEqual([ann.id])
  })

  it('moves the annotation between parent lists when parentAnnId changes', () => {
    const tier = store.addTier('T')
    const parent1 = store.addAnnotation('p1', [{ type: 'time', start: 0, end: 10 }], { tierId: tier.id })
    const parent2 = store.addAnnotation('p2', [{ type: 'time', start: 10, end: 20 }], { tierId: tier.id })
    const childTier = store.addTier('C', { parentTierId: tier.id })
    const child = store.addAnnotation('c', [], { tierId: childTier.id, parentAnnId: parent1.id })

    expect(store.getOrderedAnnotations(childTier.id, parent1.id).map(a => a.id)).toEqual([child.id])

    store.updateAnnotation(child.id, { features: { parentAnnId: parent2.id } })

    expect(store.getOrderedAnnotations(childTier.id, parent1.id)).toEqual([])
    expect(store.getOrderedAnnotations(childTier.id, parent2.id).map(a => a.id)).toEqual([child.id])
  })

  it('keeps list position stable when tier/parent are unchanged', () => {
    const tier = store.addTier('T')
    const a = store.addAnnotation('a', [], { tierId: tier.id })
    const b = store.addAnnotation('b', [], { tierId: tier.id })
    store.updateAnnotation(a.id, { type: 'a2' })
    expect(store.getOrderedAnnotations(tier.id).map(x => x.id)).toEqual([a.id, b.id])
  })
})

describe('relation and mark indexes', () => {
  let store: AnnotationStore

  beforeEach(() => { store = new AnnotationStore() })

  it('relationsFor finds relations by either endpoint', () => {
    const a = store.addAnnotation('a', [])
    const b = store.addAnnotation('b', [])
    const rel = store.addRelation('repair', a.id, b.id)
    expect(store.relationsFor(a.id).map(r => r.id)).toEqual([rel.id])
    expect(store.relationsFor(b.id).map(r => r.id)).toEqual([rel.id])
    expect(store.relationsFor('nope')).toEqual([])
  })

  it('removing an annotation removes its relations', () => {
    const a = store.addAnnotation('a', [])
    const b = store.addAnnotation('b', [])
    store.addRelation('repair', a.id, b.id)
    store.removeAnnotation(a.id)
    expect(store.allRelations()).toEqual([])
    expect(store.relationsFor(b.id)).toEqual([])
  })

  it('cascade delete removes relations of descendants', () => {
    const tier = store.addTier('T')
    const childTier = store.addTier('C', { parentTierId: tier.id })
    const parent = store.addAnnotation('p', [{ type: 'time', start: 0, end: 10 }], { tierId: tier.id })
    const child = store.addAnnotation('c', [], { tierId: childTier.id, parentAnnId: parent.id })
    const other = store.addAnnotation('o', [])
    store.addRelation('link', child.id, other.id)
    store.removeAnnotation(parent.id)
    expect(store.getAnnotation(child.id)).toBeUndefined()
    expect(store.allRelations()).toEqual([])
  })

  it('byMarkId uses the mark index and tracks anchor updates', () => {
    const ann = store.addAnnotation('t', [{ type: 'mark', markId: 'm1' }])
    expect(store.byMarkId('m1').map(a => a.id)).toEqual([ann.id])
    store.updateAnnotation(ann.id, { anchors: [{ type: 'mark', markId: 'm2' }] })
    expect(store.byMarkId('m1')).toEqual([])
    expect(store.byMarkId('m2').map(a => a.id)).toEqual([ann.id])
    store.removeAnnotation(ann.id)
    expect(store.byMarkId('m2')).toEqual([])
  })
})

describe('per-slot pattern storage', () => {
  let store: AnnotationStore

  const slot = (schemaSlotId: string, annotationId: string): SlotInstance =>
    ({ id: newId(), schemaSlotId, annotationId, metrics: [] })

  beforeEach(() => { store = new AnnotationStore() })

  it('round-trips patterns through toJSON/loadJSON with slot order preserved', () => {
    const schema = store.addPatternSchema({ name: 'Repair', slots: [] })
    const s1 = slot('trouble', 'a1')
    const s2 = slot('initiation', 'a2')
    store.addPattern(schema.id, [s1, s2], { notes: { alice: [{ text: 'hi', createdAt: 1 }] } }, 'pat1')

    const json = store.toJSON()
    const store2 = new AnnotationStore()
    store2.loadJSON(json)

    const p = store2.getPattern('pat1')!
    expect(p.slots.map(s => s.schemaSlotId)).toEqual(['trouble', 'initiation'])
    expect(p.notes).toEqual({ alice: [{ text: 'hi', createdAt: 1 }] })
  })

  it('merges concurrent fills of different slots (no lost update)', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = new AnnotationStore(docA)
    const b = new AnnotationStore(docB)
    const sync = () => {
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
    }

    const schema = a.addPatternSchema({ name: 'Repair', slots: [] })
    a.addPattern(schema.id, [], {}, 'pat1')
    sync()

    // Two clients fill different slots while offline
    a.fillPatternSlot('pat1', slot('trouble', 'annX'))
    b.fillPatternSlot('pat1', slot('initiation', 'annY'))
    sync()

    for (const s of [a, b]) {
      const p = s.getPattern('pat1')!
      expect(p.slots.map(x => x.schemaSlotId).sort()).toEqual(['initiation', 'trouble'])
    }
  })

  it('merges concurrent notes from different authors', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = new AnnotationStore(docA)
    const b = new AnnotationStore(docB)
    const sync = () => {
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
    }

    const schema = a.addPatternSchema({ name: 'Repair', slots: [] })
    a.addPattern(schema.id, [], {}, 'pat1')
    sync()
    a.addPatternNote('pat1', 'alice', 'note from alice')
    b.addPatternNote('pat1', 'bob', 'note from bob')
    sync()

    for (const s of [a, b]) {
      const notes = s.getPattern('pat1')!.notes!
      expect(Object.keys(notes).sort()).toEqual(['alice', 'bob'])
    }
  })

  it('fillPatternSlot replaces an existing instance of the same schema slot', () => {
    const schema = store.addPatternSchema({ name: 'Repair', slots: [] })
    store.addPattern(schema.id, [slot('trouble', 'a1'), slot('initiation', 'a2')], {}, 'pat1')
    store.fillPatternSlot('pat1', slot('trouble', 'a3'))
    const p = store.getPattern('pat1')!
    expect(p.slots).toHaveLength(2)
    expect(p.slots.find(s => s.schemaSlotId === 'trouble')?.annotationId).toBe('a3')
    // Replacement keeps the original position
    expect(p.slots.map(s => s.schemaSlotId)).toEqual(['trouble', 'initiation'])
  })

  it('setPatternSlotMetric updates one metric without touching other slots', () => {
    const schema = store.addPatternSchema({ name: 'Repair', slots: [] })
    store.addPattern(schema.id, [slot('trouble', 'a1'), slot('initiation', 'a2')], {}, 'pat1')
    store.setPatternSlotMetric('pat1', 'trouble', 'metric1', 'reference')
    const p = store.getPattern('pat1')!
    expect(p.slots.find(s => s.schemaSlotId === 'trouble')?.metrics).toEqual([{ schemaId: 'metric1', value: 'reference' }])
    expect(p.slots.find(s => s.schemaSlotId === 'initiation')?.metrics).toEqual([])
  })

  it('reads legacy embedded-slot patterns and migrates them on first write', () => {
    // Simulate a document persisted before per-slot storage: the pattern
    // value carries slots/notes embedded.
    const legacy: Pattern = {
      id: 'pat1', schemaId: 'schema1',
      slots: [slot('trouble', 'a1')],
      notes: { alice: [{ text: 'old', createdAt: 1 }] },
    }
    store.ydoc.transact(() => {
      (store.ydoc.getMap('patterns') as Y.Map<Pattern>).set('pat1', legacy)
    })

    // Reads honour the embedded form
    let p = store.getPattern('pat1')!
    expect(p.slots.map(s => s.schemaSlotId)).toEqual(['trouble'])
    expect(p.notes?.alice?.[0]?.text).toBe('old')

    // First write migrates to per-key storage without losing anything
    store.fillPatternSlot('pat1', slot('initiation', 'a2'))
    p = store.getPattern('pat1')!
    expect(p.slots.map(s => s.schemaSlotId)).toEqual(['trouble', 'initiation'])
    expect(p.notes?.alice?.[0]?.text).toBe('old')
    const meta = (store.ydoc.getMap('patterns') as Y.Map<Pattern>).get('pat1')!
    expect(meta.slots).toBeUndefined()
    expect(meta.notes).toBeUndefined()
  })

  it('removePattern deletes its slot and note entries', () => {
    const schema = store.addPatternSchema({ name: 'Repair', slots: [] })
    store.addPattern(schema.id, [slot('trouble', 'a1')], { notes: { alice: [{ text: 'x', createdAt: 1 }] } }, 'pat1')
    store.removePattern('pat1')
    expect(store.getPattern('pat1')).toBeUndefined()
    expect((store.ydoc.getMap('patternSlots')).size).toBe(0)
    expect((store.ydoc.getMap('patternNotes')).size).toBe(0)
  })

  it('removePatternSchema cascades pattern slot/note cleanup', () => {
    const schema = store.addPatternSchema({ name: 'Repair', slots: [] })
    store.addPattern(schema.id, [slot('trouble', 'a1')], {}, 'pat1')
    store.removePatternSchema(schema.id)
    expect(store.getPattern('pat1')).toBeUndefined()
    expect((store.ydoc.getMap('patternSlots')).size).toBe(0)
  })

  it('emits pattern:update when a slot is filled', () => {
    const schema = store.addPatternSchema({ name: 'Repair', slots: [] })
    store.addPattern(schema.id, [], {}, 'pat1')
    const updates: Pattern[] = []
    store.on('pattern:update', p => updates.push(p))
    store.fillPatternSlot('pat1', slot('trouble', 'a1'))
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.at(-1)!.slots.map(s => s.schemaSlotId)).toEqual(['trouble'])
  })
})

describe('TypedEmitter safety', () => {
  it('does not skip listeners when one unsubscribes during emit', () => {
    const em = new TypedEmitter<{ ev: [] }>()
    const calls: string[] = []
    const first = () => { calls.push('first'); em.off('ev', first) }
    const second = () => calls.push('second')
    em.on('ev', first)
    em.on('ev', second)
    em.emit('ev')
    expect(calls).toEqual(['first', 'second'])
  })

  it('isolates a throwing listener', () => {
    const em = new TypedEmitter<{ ev: [] }>()
    const calls: string[] = []
    em.on('ev', () => { throw new Error('boom') })
    em.on('ev', () => calls.push('after'))
    expect(() => em.emit('ev')).not.toThrow()
    expect(calls).toEqual(['after'])
  })
})

describe('setTokenTime validation', () => {
  let store: AnnotationStore

  beforeEach(() => { store = new AnnotationStore() })

  it('accepts valid times', () => {
    store.setTokenTime('tok1', 1.0, 2.0)
    expect(store.getTokenTime('tok1')).toEqual({ start: 1.0, end: 2.0 })
  })

  it('accepts equal start and end (zero-length token)', () => {
    store.setTokenTime('tok1', 1.0, 1.0)
    expect(store.getTokenTime('tok1')).toEqual({ start: 1.0, end: 1.0 })
  })

  it('accepts null start or end (open-sided sentinel)', () => {
    store.setTokenTime('tok1', null, 2.0)
    expect(store.getTokenTime('tok1')).toEqual({ start: null, end: 2.0 })
    store.setTokenTime('tok1', 1.0, null)
    expect(store.getTokenTime('tok1')).toEqual({ start: 1.0, end: null })
  })

  it('rejects start > end and leaves existing time unchanged', () => {
    store.setTokenTime('tok1', 1.0, 2.0)
    store.setTokenTime('tok1', 5.0, 3.0)  // inverted — should be ignored
    expect(store.getTokenTime('tok1')).toEqual({ start: 1.0, end: 2.0 })
  })
})
