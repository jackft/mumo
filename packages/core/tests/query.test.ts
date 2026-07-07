import { describe, it, expect } from 'vitest'
import { MumoContext } from '../src/query.js'
import { AnnotationStore } from '../src/store.js'
import { TokenStore } from '../src/token-store.js'
import { docFromUtterances, createEmptyDoc } from '../src/controller.js'
import { newId } from '../src/id.js'

// helpers

function makeCtx(doc = createEmptyDoc(), store = new AnnotationStore(), ts?: TokenStore) {
  return new MumoContext(doc, store, ts)
}

function makeTokenStore(doc: ReturnType<typeof docFromUtterances>) {
  const ts = new TokenStore()
  ts.buildFromDoc(doc)
  return ts
}

// TokenView

describe('TokenView', () => {
  it('returns null for unknown token id', () => {
    expect(makeCtx().token('not-an-id')).toBeNull()
  })

  it('exposes text, kind, and record', () => {
    const doc = docFromUtterances([{ participant: 'A', text: 'hello world', startTimeSeconds: 0, endTimeSeconds: 2 }])
    const ts  = makeTokenStore(doc)
    const ctx = makeCtx(doc, new AnnotationStore(), ts)

    const tok = ctx.allTokens().find(t => t.text === 'hello')!
    expect(tok).toBeDefined()
    expect(tok.kind).toBe('word')
    expect(tok.record.uttId).toBeDefined()
  })

  it('exposes the utterance attrs', () => {
    const doc = docFromUtterances([{ participant: 'Alice', text: 'hi', startTimeSeconds: 1, endTimeSeconds: 2 }])
    const ts  = makeTokenStore(doc)
    const ctx = makeCtx(doc, new AnnotationStore(), ts)

    const tok = ctx.allTokens().find(t => t.text === 'hi')!
    expect(tok.utterance?.participant).toBe('Alice')
    expect(tok.utterance?.startTimeSeconds).toBe(1)
    expect(tok.utterance?.endTimeSeconds).toBe(2)
  })

  it('returns 0-based index among non-ws tokens', () => {
    const doc = docFromUtterances([{ participant: 'A', text: 'a b c', startTimeSeconds: 0, endTimeSeconds: 3 }])
    const ts  = makeTokenStore(doc)
    const ctx = makeCtx(doc, new AnnotationStore(), ts)

    const tokens = ctx.allTokens().filter(t => t.kind !== 'ws')
    expect(tokens[0]!.index).toBe(0)
    expect(tokens[1]!.index).toBe(1)
    expect(tokens[2]!.index).toBe(2)
  })

  it('time returns null when no token time is stored', () => {
    const doc = docFromUtterances([{ participant: 'A', text: 'hello', startTimeSeconds: 0, endTimeSeconds: 1 }])
    const ts  = makeTokenStore(doc)
    const ctx = makeCtx(doc, new AnnotationStore(), ts)
    expect(ctx.allTokens().find(t => t.text === 'hello')!.time).toBeNull()
  })

  it('time returns the stored token time', () => {
    const doc   = docFromUtterances([{ participant: 'A', text: 'hello', startTimeSeconds: 0, endTimeSeconds: 1 }])
    const ts    = makeTokenStore(doc)
    const store = new AnnotationStore()
    const tokId = ts.allTokens().find(t => t.text === 'hello')!.id
    store.setTokenTime(tokId, 0.1, 0.9)

    const ctx = makeCtx(doc, store, ts)
    expect(ctx.token(tokId)!.time).toEqual({ start: 0.1, end: 0.9 })
  })

  it('boundedTime fills open boundaries from utterance edges', () => {
    const doc   = docFromUtterances([{ participant: 'A', text: 'hello world', startTimeSeconds: 0, endTimeSeconds: 2 }])
    const ts    = makeTokenStore(doc)
    const store = new AnnotationStore()
    const tokens = ts.allTokens().filter(t => t.kind !== 'ws')
    store.setTokenTime(tokens[0]!.id, null, 1.0)  // open start
    store.setTokenTime(tokens[1]!.id, 1.0, null)  // open end

    const ctx = makeCtx(doc, store, ts)
    expect(ctx.token(tokens[0]!.id)!.boundedTime).toEqual({ start: 0, end: 1.0 })
    expect(ctx.token(tokens[1]!.id)!.boundedTime).toEqual({ start: 1.0, end: 2 })
  })

  it('boundedTime returns null when utterance has no time either', () => {
    const doc = docFromUtterances([{ participant: 'A', text: 'hello' }])
    const ts  = makeTokenStore(doc)
    const ctx = makeCtx(doc, new AnnotationStore(), ts)
    expect(ctx.allTokens().find(t => t.text === 'hello')!.boundedTime).toBeNull()
  })

  it('boundedTime clamps stored token time to utterance bounds', () => {
    const doc   = docFromUtterances([{ participant: 'A', text: 'hello', startTimeSeconds: 1, endTimeSeconds: 3 }])
    const ts    = makeTokenStore(doc)
    const store = new AnnotationStore()
    const tokId = ts.allTokens().find(t => t.text === 'hello')!.id
    store.setTokenTime(tokId, 0.5, 4.0)  // extends beyond utterance on both sides

    const bt = makeCtx(doc, store, ts).token(tokId)!.boundedTime!
    expect(bt.start).toBe(1)
    expect(bt.end).toBe(3)
  })
})

// AnnotationView

describe('AnnotationView', () => {
  it('returns null for unknown annotation id', () => {
    expect(makeCtx().annotation('nope')).toBeNull()
  })

  it('time returns own time anchor directly', () => {
    const store = new AnnotationStore()
    const tierId = newId()
    store.addTier('t', {}, tierId)
    const ann = store.addAnnotation('X', [{ type: 'time', start: 1.0, end: 2.5 }], { tierId })

    const av = makeCtx(createEmptyDoc(), store).annotation(ann.id)!
    expect(av.time).toEqual({ start: 1.0, end: 2.5 })
  })

  it('time resolves from tokenNodeId stored time', () => {
    const doc   = docFromUtterances([{ participant: 'A', text: 'foo', startTimeSeconds: 0, endTimeSeconds: 1 }])
    const ts    = makeTokenStore(doc)
    const store = new AnnotationStore()
    const tokId = ts.allTokens().find(t => t.text === 'foo')!.id
    store.setTokenTime(tokId, 0.1, 0.9)

    const tierId = newId()
    store.addTier('pos', { constraint: 'symbolic_association' }, tierId)
    const ann = store.addAnnotation('NN', [], { tierId, tokenNodeId: tokId })

    const av = makeCtx(doc, store, ts).annotation(ann.id)!
    expect(av.time).toEqual({ start: 0.1, end: 0.9 })
  })

  it('time resolves from parentAnnId', () => {
    const store    = new AnnotationStore()
    const parentId = newId(), childId = newId()
    const tierId   = newId()
    store.addTier('t', {}, tierId)
    store.addAnnotation('parent', [{ type: 'time', start: 2, end: 3 }], { tierId }, parentId)
    store.addAnnotation('child',  [], { tierId, parentAnnId: parentId }, childId)

    const av = makeCtx(createEmptyDoc(), store).annotation(childId)!
    expect(av.time).toEqual({ start: 2, end: 3 })
  })

  it('time returns null when nothing resolves', () => {
    const store  = new AnnotationStore()
    const tierId = newId()
    store.addTier('t', {}, tierId)
    const ann = store.addAnnotation('X', [], { tierId })
    expect(makeCtx(createEmptyDoc(), store).annotation(ann.id)!.time).toBeNull()
  })

  it('exposes children', () => {
    const store    = new AnnotationStore()
    const tierId   = newId(), parentId = newId(), childId = newId()
    store.addTier('t', {}, tierId)
    store.addAnnotation('P', [{ type: 'time', start: 0, end: 1 }], { tierId }, parentId)
    store.addAnnotation('C', [], { tierId, parentAnnId: parentId }, childId)

    const av = makeCtx(createEmptyDoc(), store).annotation(parentId)!
    expect(av.children).toHaveLength(1)
    expect(av.children[0]!.id).toBe(childId)
  })

  it('exposes parent', () => {
    const store    = new AnnotationStore()
    const tierId   = newId(), parentId = newId(), childId = newId()
    store.addTier('t', {}, tierId)
    store.addAnnotation('P', [{ type: 'time', start: 0, end: 1 }], { tierId }, parentId)
    store.addAnnotation('C', [], { tierId, parentAnnId: parentId }, childId)

    const av = makeCtx(createEmptyDoc(), store).annotation(childId)!
    expect(av.parent?.id).toBe(parentId)
  })

  it('exposes tier and constraint', () => {
    const store  = new AnnotationStore()
    const tierId = newId()
    store.addTier('pos', { constraint: 'symbolic_association' }, tierId)
    const ann = store.addAnnotation('NN', [], { tierId })

    const av = makeCtx(createEmptyDoc(), store).annotation(ann.id)!
    expect(av.tier?.id).toBe(tierId)
    expect(av.constraint).toBe('symbolic_association')
  })
})

// PatternView / SlotView

describe('PatternView / SlotView', () => {
  it('returns null for unknown pattern id', () => {
    expect(makeCtx().pattern('nope')).toBeNull()
  })

  it('exposes schema', () => {
    const store    = new AnnotationStore()
    const schemaId = newId()
    store.addPatternSchema({ name: 'Repair', slots: [] }, schemaId)
    const frame = store.addPattern(schemaId)

    const fv = makeCtx(createEmptyDoc(), store).pattern(frame.id)!
    expect(fv.schema?.name).toBe('Repair')
  })

  it('slot() by name returns the correct SlotView', () => {
    const store    = new AnnotationStore()
    const schemaId = newId()
    const slotId   = newId()
    store.addPatternSchema({
      name: 'Repair',
      slots: [{ id: slotId, name: 'trouble', anchorKind: 'span', metrics: [] }],
    }, schemaId)

    const tierId = newId()
    store.addTier('t', {}, tierId)
    const ann = store.addAnnotation('X', [{ type: 'time', start: 1, end: 2 }], { tierId })

    const { id: sInstId } = { id: newId() }
    const frame = store.addPattern(schemaId, [{ id: sInstId, schemaSlotId: slotId, annotationId: ann.id, metrics: [] }])

    const fv   = makeCtx(createEmptyDoc(), store).pattern(frame.id)!
    const slot = fv.slot('trouble')!
    expect(slot).not.toBeNull()
    expect(slot.annotation?.id).toBe(ann.id)
    expect(slot.annotation?.time).toEqual({ start: 1, end: 2 })
  })

  it('slot() by index returns the correct SlotView', () => {
    const store    = new AnnotationStore()
    const schemaId = newId()
    const slotId   = newId()
    store.addPatternSchema({
      name: 'Repair',
      slots: [{ id: slotId, name: 'trouble', anchorKind: 'span', metrics: [] }],
    }, schemaId)

    const tierId = newId()
    store.addTier('t', {}, tierId)
    const ann   = store.addAnnotation('X', [{ type: 'time', start: 0, end: 1 }], { tierId })
    const frame = store.addPattern(schemaId, [{ id: newId(), schemaSlotId: slotId, annotationId: ann.id, metrics: [] }])

    expect(makeCtx(createEmptyDoc(), store).pattern(frame.id)!.slot(0)?.schema?.name).toBe('trouble')
  })

  it('slot() returns null for unfilled slot', () => {
    const store    = new AnnotationStore()
    const schemaId = newId()
    store.addPatternSchema({
      name: 'Repair',
      slots: [{ id: newId(), name: 'trouble', anchorKind: 'span', metrics: [] }],
    }, schemaId)
    const frame = store.addPattern(schemaId, [])

    expect(makeCtx(createEmptyDoc(), store).pattern(frame.id)!.slot('trouble')).toBeNull()
  })

  it('slots returns all filled slot views', () => {
    const store    = new AnnotationStore()
    const schemaId = newId()
    const s1 = newId(), s2 = newId()
    store.addPatternSchema({
      name: 'AP',
      slots: [
        { id: s1, name: 'fpp', anchorKind: 'utterance', metrics: [] },
        { id: s2, name: 'spp', anchorKind: 'utterance', metrics: [] },
      ],
    }, schemaId)

    const tierId = newId()
    store.addTier('t', {}, tierId)
    const a1 = store.addAnnotation('FPP', [{ type: 'time', start: 0, end: 1 }], { tierId })
    const a2 = store.addAnnotation('SPP', [{ type: 'time', start: 1, end: 2 }], { tierId })
    const frame = store.addPattern(schemaId, [
      { id: newId(), schemaSlotId: s1, annotationId: a1.id, metrics: [] },
      { id: newId(), schemaSlotId: s2, annotationId: a2.id, metrics: [] },
    ])

    const fv = makeCtx(createEmptyDoc(), store).pattern(frame.id)!
    expect(fv.slots).toHaveLength(2)
    expect(fv.slots[0]!.schema?.name).toBe('fpp')
    expect(fv.slots[1]!.schema?.name).toBe('spp')
  })

  it('allPatterns returns PatternViews for every pattern in the store', () => {
    const store = new AnnotationStore()
    const sid   = newId()
    store.addPatternSchema({ name: 'X', slots: [] }, sid)
    store.addPattern(sid)
    store.addPattern(sid)

    expect(makeCtx(createEmptyDoc(), store).allPatterns()).toHaveLength(2)
  })
})
