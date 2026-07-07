/**
 * Programmatic EAF/ETF fixture builder.
 */
import { AnnotationStore } from '@mumo/core'
import { newId } from '@mumo/core'
import type { PMNodeJSON } from '../../src/types.js'
import { emitEAF } from '../../src/eaf-emit.js'
import { emitETF } from '../../src/eaf-emit.js'

export interface Fixture {
  doc: PMNodeJSON
  store: AnnotationStore
  xml: string
}

export function buildSingleSpeaker(): Fixture {
  const uttA = newId()
  const uttB = newId()
  const store = new AnnotationStore()

  const doc: PMNodeJSON = {
    type: 'doc',
    content: [
      {
        type: 'utterance',
        attrs: { id: uttA, participant: 'A', startTimeSeconds: 0.0, endTimeSeconds: 1.8 },
        content: [
          { type: 'word',  attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: 'Hello' }] },
          { type: 'ws',    attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: ' ' }] },
          { type: 'word',  attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: 'world' }] },
          { type: 'punct', attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: '.' }] },
        ],
      },
      {
        type: 'utterance',
        attrs: { id: uttB, participant: 'A', startTimeSeconds: 2.1, endTimeSeconds: 3.5 },
        content: [
          { type: 'word', attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: 'Goodbye' }] },
        ],
      },
    ],
  }

  const xml = emitEAF(doc, store)
  return { doc, store, xml }
}

export function buildTwoSpeakers(): Fixture {
  const store = new AnnotationStore()
  const doc: PMNodeJSON = {
    type: 'doc',
    content: [
      {
        type: 'utterance',
        attrs: { id: newId(), participant: 'A', startTimeSeconds: 0.0, endTimeSeconds: 1.2 },
        content: [{ type: 'word', attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: 'Hey' }] }],
      },
      {
        type: 'utterance',
        attrs: { id: newId(), participant: 'B', startTimeSeconds: 1.5, endTimeSeconds: 2.8 },
        content: [{ type: 'word', attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: 'Hi' }] }],
      },
    ],
  }
  const xml = emitEAF(doc, store)
  return { doc, store, xml }
}

/** Utterances with explicit arbitrary tier names (ELAN CLAN-style: CHI, MOT). */
export function buildArbitraryTiers(): Fixture {
  const store = new AnnotationStore()
  const doc: PMNodeJSON = {
    type: 'doc',
    content: [
      {
        type: 'utterance',
        attrs: { id: newId(), participant: 'Child', tier: 'CHI', startTimeSeconds: 0.0, endTimeSeconds: 1.2 },
        content: [{ type: 'word', attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: 'Hi' }] }],
      },
      {
        type: 'utterance',
        attrs: { id: newId(), participant: 'Child', tier: 'CHI', startTimeSeconds: 2.0, endTimeSeconds: 3.0 },
        content: [{ type: 'word', attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: 'Bye' }] }],
      },
      {
        type: 'utterance',
        attrs: { id: newId(), participant: 'Mother', tier: 'MOT', startTimeSeconds: 1.3, endTimeSeconds: 1.9 },
        content: [{ type: 'word', attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: 'Hello' }] }],
      },
    ],
  }
  const xml = emitEAF(doc, store)
  return { doc, store, xml }
}

export interface ETFFixture {
  store: AnnotationStore
  xml: string
}

/**
 * ETF fixture: a store with a controlled vocabulary, a linguistic type that
 * references it, and a two-level tier hierarchy (parent → POS child).
 * No annotations — templates define structure only.
 */
export function buildETFFixture(): ETFFixture {
  const store = new AnnotationStore()

  // Controlled vocabulary: POS tags
  const posVocabId = newId()
  store.addVocabulary('POS', [
    { id: newId(), value: 'NOUN', description: 'Noun' },
    { id: newId(), value: 'VERB', description: 'Verb' },
    { id: newId(), value: 'ADJ' },
  ], posVocabId)

  // Linguistic type: symbolic_association, references POS vocab
  const posLtId = newId()
  store.addLinguisticType('POS-type', { constraint: 'symbolic_association', vocabularyId: posVocabId }, posLtId)

  // Gesture phase type: included_in (for time-aligned children)
  const phaseLtId = newId()
  store.addLinguisticType('GesturePhase-type', { constraint: 'included_in' }, phaseLtId)

  // Tier hierarchy: Speech (root) → POS (child, symbolic_association)
  const speechTierId = newId()
  const posTierId = newId()
  store.addTier('Speech', { participant: 'A' }, speechTierId)
  store.addTier('POS', { parentTierId: speechTierId, linguisticTypeId: posLtId }, posTierId)

  // Gesture tier with a phase sub-tier
  const gestureTierId = newId()
  const phaseTierId = newId()
  store.addTier('Gesture', {}, gestureTierId)
  store.addTier('GesturePhase', { parentTierId: gestureTierId, linguisticTypeId: phaseLtId }, phaseTierId)

  const xml = emitETF(store)
  return { store, xml }
}

export function buildWithStoreTier(): Fixture {
  const store = new AnnotationStore()
  const tierId = newId()
  const annId  = newId()
  store.addTier('Gesture', {}, tierId)
  store.addAnnotation('stroke', [{ type: 'time', start: 0.5, end: 1.0 }], { tierId }, annId)

  const doc: PMNodeJSON = { type: 'doc', content: [
    {
      type: 'utterance',
      attrs: { id: newId(), participant: 'A', startTimeSeconds: 0.0, endTimeSeconds: 2.0 },
      content: [{ type: 'word', attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: 'ok' }] }],
    },
  ] }

  const xml = emitEAF(doc, store)
  return { doc, store, xml }
}
