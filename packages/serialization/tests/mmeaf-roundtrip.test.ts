/**
 * Round-trip tests for MMEAF (.mmeaf) format.
 *
 * MMEAF is a superset of EAF 3.0: it embeds a mm:mumo_DATA block that
 * preserves mumo-specific data (token IDs, frame schemas, frames) that
 * would otherwise be lost in a plain EAF round-trip.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { emitMMEAF, emitMMETF, parseMMEAF, parseMMETF, emitEAF } from '../src/index.js'
import { AnnotationStore, TokenStore, newId } from '@mumo/core'
import type { TokenRecord } from '@mumo/core'
import type { PMNodeJSON } from '../src/types.js'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { validateEAF } from './xsd-validate.js'

// helpers

function emptyDoc(): PMNodeJSON {
  return { type: 'doc', content: [] }
}

/** Build a plain-text doc, a TokenStore, and an AnnotationStore from a token-level spec. */
function makeDocAndStore(
  blocks: Array<{
    type: 'utterance'
    participant?: string
    startTimeSeconds: number
    endTimeSeconds: number
    tokens: Array<{ kind: string; id?: string; text: string; start?: number | null; end?: number | null }>
  }>
): { doc: PMNodeJSON; tokenStore: TokenStore; annotationStore: AnnotationStore } {
  const tokenRecords: TokenRecord[] = []
  const tokenTimes: Record<string, { start: number | null; end: number | null }> = {}
  const docBlocks = blocks.map(b => {
    const blockId = newId()
    let offset = 0
    for (const t of b.tokens) {
      const id = t.id ?? newId()
      tokenRecords.push({
        id, uttId: blockId,
        kind: t.kind as TokenRecord['kind'],
        text: t.text,
        startOffset: offset, endOffset: offset + t.text.length,
      })
      if (t.start !== undefined || t.end !== undefined) {
        tokenTimes[id] = { start: t.start ?? null, end: t.end ?? null }
      }
      offset += t.text.length
    }
    const text = b.tokens.map(t => t.text).join('')
    return {
      type: b.type,
      attrs: {
        id: blockId,
        participant: b.participant ?? 'A',
        startTimeSeconds: b.startTimeSeconds,
        endTimeSeconds:   b.endTimeSeconds,
      },
      content: text ? [{ type: 'text', text }] : [],
    }
  })

  const tokenStore = new TokenStore()
  tokenStore.loadTokens(tokenRecords)

  const annotationStore = new AnnotationStore()
  annotationStore.loadTokenTimes(tokenTimes)

  return { doc: { type: 'doc', content: docBlocks }, tokenStore, annotationStore }
}

// XML structure

describe('emitMMEAF — XML structure', () => {
  it('declares mm: namespace on root element', () => {
    const xml = emitMMEAF(emptyDoc(), new AnnotationStore())
    expect(xml).toContain('xmlns:mm="https://mumo.io/ns/mmeaf/1"')
  })

  it('includes mm:mumo_DATA block', () => {
    const xml = emitMMEAF(emptyDoc(), new AnnotationStore())
    expect(xml).toContain('<mm:mumo_data')
    expect(xml).toContain('</mm:mumo_data>')
  })

  it('includes mm:TRANSCRIPT_STRUCTURE', () => {
    const xml = emitMMEAF(emptyDoc(), new AnnotationStore())
    expect(xml).toContain('<mm:transcript_structure>')
  })

  it('is still a valid EAF document (has ANNOTATION_DOCUMENT root)', () => {
    const xml = emitMMEAF(emptyDoc(), new AnnotationStore())
    expect(xml).toContain('<ANNOTATION_DOCUMENT')
    expect(xml).toContain('</ANNOTATION_DOCUMENT>')
    expect(xml).toContain('FORMAT="3.0"')
  })

  it('still contains standard EAF tiers for utterances', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', text: 'hi' }],
    }])
    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    expect(xml).toContain('TIER_ID="utterance:A"')
    expect(xml).toContain('<ALIGNABLE_ANNOTATION')
  })

  it('includeWords emits token tiers named tokens:<participant> with PARENT_REF and PARTICIPANT', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', text: 'hi', start: 0, end: 1 }],
    }])
    const xml = emitEAF(doc, annotationStore, { includeWords: true, tokenStore })
    expect(xml).toContain('TIER_ID="tokens:A"')
    expect(xml).toContain('PARENT_REF="utterance:A"')
    expect(xml).toMatch(/TIER_ID="tokens:A"[^>]*PARTICIPANT="A"/)
    validateEAF(xml)
  })

  it('exports fully-timed token tiers as Time_Subdivision ALIGNABLE annotations', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 2,
      tokens: [{ kind: 'word', text: 'hi', start: 0, end: 1 }, { kind: 'word', text: 'there', start: 1, end: 2 }],
    }])
    const xml = emitEAF(doc, annotationStore, { includeWords: true, tokenStore })
    expect(xml).toContain('<TIER LINGUISTIC_TYPE_REF="lt-token-ts" TIER_ID="tokens:A"')
    expect(xml).toMatch(/LINGUISTIC_TYPE_ID="lt-token-ts" TIME_ALIGNABLE="true" CONSTRAINTS="Time_Subdivision"/)
    const tokenTier = xml.slice(xml.indexOf('TIER_ID="tokens:A"'), xml.indexOf('</TIER>', xml.indexOf('TIER_ID="tokens:A"')))
    expect(tokenTier).toContain('<ALIGNABLE_ANNOTATION')
    validateEAF(xml)
  })

  it('exports promoted lanes (edge anchors only) as Time_Subdivision with interpolated boundaries', () => {
    // Lane promotion stores open-sided edge anchors: first {start, null}, last {null, end};
    // interior tokens stay unstored. This is still a time-subdivision lane.
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 3,
      tokens: [
        { kind: 'word', text: 'a', start: 0, end: null },
        { kind: 'word', text: 'b' },
        { kind: 'word', text: 'c', start: null, end: 3 },
      ],
    }])
    const xml = emitEAF(doc, annotationStore, { includeWords: true, tokenStore })
    expect(xml).toContain('<TIER LINGUISTIC_TYPE_REF="lt-token-ts" TIER_ID="tokens:A"')
    const tokenTier = xml.slice(xml.indexOf('TIER_ID="tokens:A"'), xml.indexOf('</TIER>', xml.indexOf('TIER_ID="tokens:A"')))
    expect((tokenTier.match(/<ALIGNABLE_ANNOTATION/g) ?? []).length).toBe(3)
    // unstored inner boundaries interpolate evenly across the utterance span
    expect(xml).toContain('TIME_VALUE="1000"')
    expect(xml).toContain('TIME_VALUE="2000"')
    validateEAF(xml)
  })

  it('exports lt-token-ii TierDef tiers as Included_In, skipping untimed tokens', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 2,
      tokens: [{ kind: 'word', text: 'hi', start: 0.2, end: 0.8 }, { kind: 'word', text: 'there' }],
    }])
    annotationStore.addTier('tokens:A', { linguisticTypeId: 'lt-token-ii', participant: 'A' })
    const xml = emitEAF(doc, annotationStore, { includeWords: true, tokenStore })
    expect(xml).toContain('<TIER LINGUISTIC_TYPE_REF="lt-token-ii" TIER_ID="tokens:A"')
    expect(xml).toMatch(/LINGUISTIC_TYPE_ID="lt-token-ii" TIME_ALIGNABLE="true" CONSTRAINTS="Included_In"/)
    const tokenTier = xml.slice(xml.indexOf('TIER_ID="tokens:A"'), xml.indexOf('</TIER>', xml.indexOf('TIER_ID="tokens:A"')))
    expect(tokenTier).toContain('>hi<')
    expect(tokenTier).not.toContain('>there<')
    validateEAF(xml)
  })

  it('includeWords exports tokens as Symbolic_Subdivision REF_ANNOTATION chains', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 2,
      tokens: [{ kind: 'word', text: 'hi' }, { kind: 'ws', text: ' ' }, { kind: 'word', text: 'there' }],
    }])
    const xml = emitEAF(doc, annotationStore, { includeWords: true, tokenStore })
    const tokenTier = xml.slice(xml.indexOf('TIER_ID="tokens:A"'), xml.indexOf('</TIER>', xml.indexOf('TIER_ID="tokens:A"')))
    // both words emitted as REF_ANNOTATIONs (ws skipped), chained via PREVIOUS_ANNOTATION
    expect(tokenTier).toContain('>hi<')
    expect(tokenTier).toContain('>there<')
    expect(tokenTier).toContain('<REF_ANNOTATION')
    expect(tokenTier).toContain('PREVIOUS_ANNOTATION=')
    // the token LT is symbolic, not time-alignable
    expect(xml).toMatch(/LINGUISTIC_TYPE_ID="lt-token"[^>]*TIME_ALIGNABLE="false"[^>]*CONSTRAINTS="Symbolic_Subdivision"/)
    validateEAF(xml)
  })
})

// Token ID preservation

describe('parseMMEAF — token ID preservation', () => {
  it('recovers word token ID from mm:transcript_structure', () => {
    const wordId = newId()
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', id: wordId, text: 'hello' }],
    }])
    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    const result = parseMMEAF(xml)

    expect(result.tokens.find(t => t.id === wordId)).toBeDefined()
  })

  it('recovers all token types (word, ws, punct, action)', () => {
    const ids = { word: newId(), ws: newId(), punct: newId(), action: newId() }
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [
        { kind: 'word',   id: ids.word,   text: 'hey' },
        { kind: 'ws',     id: ids.ws,     text: ' ' },
        { kind: 'punct',  id: ids.punct,  text: '.' },
        { kind: 'action', id: ids.action, text: '{nods}' },
      ],
    }])
    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    const result = parseMMEAF(xml)

    const tokenMap = new Map(result.tokens.map(t => [t.id, t]))
    expect(tokenMap.get(ids.word)?.kind).toBe('word')
    expect(tokenMap.get(ids.ws)?.kind).toBe('ws')
    expect(tokenMap.get(ids.punct)?.kind).toBe('punct')
    expect(tokenMap.get(ids.action)?.kind).toBe('action')
  })

  it('recovers per-token time anchors', () => {
    const wordId = newId()
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 2,
      tokens: [{ kind: 'word', id: wordId, text: 'hello', start: 0.5, end: 1.2 }],
    }])
    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    const result = parseMMEAF(xml)

    const time = result.tokenTimes[wordId]
    expect(time).toBeDefined()
    expect(Math.abs(time!.start - 0.5)).toBeLessThan(0.001)
    expect(Math.abs(time!.end   - 1.2)).toBeLessThan(0.001)
  })

  it('preserves token count and text values', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 3,
      tokens: [
        { kind: 'word', text: 'one' },
        { kind: 'ws',   text: ' ' },
        { kind: 'word', text: 'two' },
        { kind: 'ws',   text: ' ' },
        { kind: 'word', text: 'three' },
      ],
    }])
    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    const result = parseMMEAF(xml)

    expect(result.tokens).toHaveLength(5)
    expect(result.tokens.filter(t => t.kind === 'word')).toHaveLength(3)
  })
})

// Pattern schemas

describe('pattern schemas round-trip', () => {
  it('round-trips a frame schema with slots', () => {
    const store = new AnnotationStore()
    store.addPatternSchema({
      name: 'Repair',
      description: 'Other-initiated self-repair',
      slots: [
        {
          id: newId(), name: 'trouble', anchorKind: 'textlet', required: true,
          metrics: [{ id: newId(), name: 'type', type: 'categorical' }],
        },
        {
          id: newId(), name: 'initiation', anchorKind: 'utterance',
          metrics: [],
        },
      ],
    })

    const xml = emitMMEAF(emptyDoc(), store)
    expect(xml).toContain('<mm:pattern_schema')
    expect(xml).toContain('name="Repair"')

    const result = parseMMEAF(xml)
    expect(result.patternSchemas).toHaveLength(1)
    const schema = result.patternSchemas[0]!
    expect(schema.name).toBe('Repair')
    expect(schema.description).toBe('Other-initiated self-repair')
    expect(schema.slots).toHaveLength(2)
    expect(schema.slots[0]!.name).toBe('trouble')
    expect(schema.slots[0]!.required).toBe(true)
    expect(schema.slots[0]!.anchorKind).toBe('textlet')
    expect(schema.slots[0]!.metrics[0]!.type).toBe('categorical')
    expect(schema.slots[1]!.name).toBe('initiation')
  })

  it('round-trips multiple frame schemas', () => {
    const store = new AnnotationStore()
    store.addPatternSchema({ name: 'Schema A', slots: [] })
    store.addPatternSchema({ name: 'Schema B', slots: [] })

    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    expect(result.patternSchemas).toHaveLength(2)
    const names = result.patternSchemas.map(s => s.name)
    expect(names).toContain('Schema A')
    expect(names).toContain('Schema B')
  })

  it('round-trips metric with vocabulary reference', () => {
    const store = new AnnotationStore()
    const vocabId = newId()
    store.addVocabulary('Types', [], vocabId)
    store.addPatternSchema({
      name: 'Test', slots: [{
        id: newId(), name: 'slot', anchorKind: 'textlet', metrics: [
          { id: newId(), name: 'category', type: 'categorical', vocabularyId: vocabId },
        ],
      }],
    })

    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    expect(result.patternSchemas[0]!.slots[0]!.metrics[0]!.vocabularyId).toBe(vocabId)
  })

  it('emits no FRAME_SCHEMAS block when store has none', () => {
    const xml = emitMMEAF(emptyDoc(), new AnnotationStore())
    expect(xml).not.toContain('<mm:pattern_schemas>')
  })
})

// Patterns

describe('patterns round-trip', () => {
  it('round-trips a frame with slot instance', () => {
    const store = new AnnotationStore()
    const schemaId = newId()
    const slotId = newId()
    const annId = newId()
    const frameId = newId()
    const slotInstanceId = newId()

    store.addPatternSchema({ name: 'AP', slots: [{ id: slotId, name: 'FPP', anchorKind: 'utterance', metrics: [] }] }, schemaId)
    store.addPattern(
      schemaId,
      [{ id: slotInstanceId, schemaSlotId: slotId, annotationId: annId, metrics: [] }],
      {},
      frameId,
    )

    const xml = emitMMEAF(emptyDoc(), store)
    expect(xml).toContain('<mm:pattern ')
    expect(xml).toContain('<mm:slot_instance ')

    const result = parseMMEAF(xml)
    expect(result.patterns).toHaveLength(1)
    const frame = result.patterns[0]!
    expect(frame.id).toBe(frameId)
    expect(frame.schemaId).toBe(schemaId)
    expect(frame.slots).toHaveLength(1)
    expect(frame.slots[0]!.schemaSlotId).toBe(slotId)
    expect(frame.slots[0]!.annotationId).toBe(annId)
  })

  it('round-trips metric values on slot instances', () => {
    const store = new AnnotationStore()
    const schemaId = newId()
    const slotId = newId()
    const metricId = newId()

    store.addPatternSchema({
      name: 'Test', slots: [{
        id: slotId, name: 's', anchorKind: 'textlet',
        metrics: [{ id: metricId, name: 'm', type: 'categorical' }],
      }],
    }, schemaId)
    store.addPattern(
      schemaId,
      [{ id: newId(), schemaSlotId: slotId, annotationId: newId(), metrics: [{ schemaId: metricId, value: 'NOUN' }] }],
    )

    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    const mv = result.patterns[0]!.slots[0]!.metrics[0]!
    expect(mv.schemaId).toBe(metricId)
    expect(mv.value).toBe('NOUN')
  })

  it('emits no FRAMES block when store has none', () => {
    const xml = emitMMEAF(emptyDoc(), new AnnotationStore())
    expect(xml).not.toContain('<mm:patterns>')
  })
})

// Fallback: plain EAF input

describe('parseMMEAF — plain EAF fallback', () => {
  it('parses plain EAF without throwing', () => {
    const eafXml = '<ANNOTATION_DOCUMENT AUTHOR="" DATE="2024-01-01T00:00:00" FORMAT="3.0" VERSION="3.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/EAFv3.0.xsd"><HEADER MEDIA_FILE="" TIME_UNITS="milliseconds"></HEADER><TIME_ORDER></TIME_ORDER><LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="lt-utterance" TIME_ALIGNABLE="true" GRAPHIC_REFERENCES="false"/><CONSTRAINT DESCRIPTION="Time subdivision" STEREOTYPE="Time_Subdivision"/><CONSTRAINT DESCRIPTION="Included_In" STEREOTYPE="Included_In"/><CONSTRAINT DESCRIPTION="1-1 association" STEREOTYPE="Symbolic_Association"/><CONSTRAINT DESCRIPTION="Symbolic subdivision" STEREOTYPE="Symbolic_Subdivision"/></ANNOTATION_DOCUMENT>'
    expect(() => parseMMEAF(eafXml)).not.toThrow()
  })

  it('returns empty patternSchemas and patterns for plain EAF', () => {
    const eafXml = emitEAF(emptyDoc(), new AnnotationStore())
    const result = parseMMEAF(eafXml)
    expect(result.patternSchemas).toHaveLength(0)
    expect(result.patterns).toHaveLength(0)
  })
})

// emitMMETF

describe('emitMMETF', () => {
  it('omits TIME_ORDER and ANNOTATION elements', () => {
    const store = new AnnotationStore()
    const tierId = newId()
    store.addTier('POS', {}, tierId)
    store.addAnnotation('NOUN', [{ type: 'time', start: 0, end: 1 }], { tierId })
    const xml = emitMMETF(store)
    expect(xml).not.toContain('<TIME_ORDER>')
    expect(xml).not.toContain('<ANNOTATION>')
  })

  it('retains TIER and mm:mumo_DATA', () => {
    const store = new AnnotationStore()
    store.addTier('Gesture', {})
    const xml = emitMMETF(store)
    expect(xml).toContain('<TIER')
    expect(xml).toContain('<mm:mumo_data')
  })

  it('retains frame schemas in template', () => {
    const store = new AnnotationStore()
    store.addPatternSchema({ name: 'Repair', slots: [] })
    const xml = emitMMETF(store)
    expect(xml).toContain('<mm:pattern_schema')
    expect(xml).toContain('name="Repair"')
  })
})

// Real ACLEW file

const aclewPath = resolve(__dirname, 'fixtures/011_42M_JOINT_C2_MIN1.ACLEW.eaf')
describe.skipIf(!existsSync(aclewPath))('real ACLEW file via parseMMEAF', () => {
  let xml: string
  beforeAll(() => { xml = readFileSync(aclewPath, 'utf-8') })

  it('parses real EAF as MMEAF without throwing', () => {
    expect(() => parseMMEAF(xml)).not.toThrow()
  })

  it('returns empty patternSchemas (no mm: data in plain EAF)', () => {
    const result = parseMMEAF(xml)
    expect(result.patternSchemas).toHaveLength(0)
  })

  it('still returns all tiers from the EAF base', () => {
    const result = parseMMEAF(xml)
    expect(result.tiers.length).toBeGreaterThanOrEqual(14)
  })

  it('mmeaf round-trip preserves tier count', () => {
    const r1 = parseMMEAF(xml)
    const store = new AnnotationStore()
    store.loadJSON({ annotations: r1.annotations, relations: [], tiers: r1.tiers, linguisticTypes: r1.linguisticTypes, vocabularies: r1.vocabularies })
    const xml2 = emitMMEAF(r1.doc as never, store)
    const r2 = parseMMEAF(xml2)
    expect(r2.tiers.length).toBe(r1.tiers.length)
  })

  it('mmeaf round-trip preserves token IDs for utterance blocks', () => {
    const r1 = parseMMEAF(xml)
    const store = new AnnotationStore()
    store.loadJSON({ annotations: r1.annotations, relations: [], tiers: r1.tiers, linguisticTypes: r1.linguisticTypes, vocabularies: r1.vocabularies })

    // Build a token store from r1 tokens so emitMMEAF can write mm:TOKEN elements
    const ts1 = new TokenStore()
    ts1.loadTokens(r1.tokens)
    const xml2 = emitMMEAF(r1.doc as never, store, {}, ts1)
    const r2 = parseMMEAF(xml2)

    const ids1 = new Set(r1.tokens.map(t => t.id))
    const ids2 = new Set(r2.tokens.map(t => t.id))

    // Every token ID from r1 should appear in r2 (preserved via mm:TRANSCRIPT_STRUCTURE)
    for (const id of ids1) {
      expect(ids2.has(id)).toBe(true)
    }
  })
})

// Textlet round-trip

describe('textlet round-trip', () => {
  it('emits mm:TEXTLETS block when textlets exist', () => {
    const store = new AnnotationStore()
    store.addAnnotation('textlet', [{ type: 'mark', markId: 'mark-1' }], {})
    const xml = emitMMEAF(emptyDoc(), store)
    expect(xml).toContain('<mm:textlets>')
    expect(xml).toContain('</mm:textlets>')
  })

  it('emits no mm:TEXTLETS block when store has none', () => {
    const xml = emitMMEAF(emptyDoc(), new AnnotationStore())
    expect(xml).not.toContain('<mm:textlets>')
  })

  it('round-trips a textlet with codes and comment', () => {
    const store = new AnnotationStore()
    const markId = 'mark-abc'
    const ann = store.addAnnotation(
      'textlet',
      [{ type: 'mark', markId }],
      { codes: ['repair', 'overlap'], comment: 'check this' },
    )

    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    const textlets = result.annotations.filter(a => a.anchors.some(x => x.type === 'mark'))
    expect(textlets).toHaveLength(1)
    const t = textlets[0]!
    expect(t.id).toBe(ann.id)
    expect(t.type).toBe('textlet')
    expect((t.anchors[0] as { type: 'mark'; markId: string }).markId).toBe(markId)
    expect(t.features.codes).toEqual([{ value: 'repair' }, { value: 'overlap' }])
    expect(t.features.comment).toBe('check this')
  })

  it('round-trips a textlet with no features', () => {
    const store = new AnnotationStore()
    const ann = store.addAnnotation('textlet', [{ type: 'mark', markId: 'mark-x' }], {})
    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    const textlets = result.annotations.filter(a => a.anchors.some(x => x.type === 'mark'))
    expect(textlets).toHaveLength(1)
    expect(textlets[0]!.id).toBe(ann.id)
    expect(textlets[0]!.features).toEqual({})
  })

  it('round-trips multiple textlets', () => {
    const store = new AnnotationStore()
    store.addAnnotation('textlet', [{ type: 'mark', markId: 'mk1' }], { codes: ['A'] })
    store.addAnnotation('textlet', [{ type: 'mark', markId: 'mk2' }], { codes: ['B'] })

    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    const textlets = result.annotations.filter(a => a.anchors.some(x => x.type === 'mark'))
    expect(textlets).toHaveLength(2)
  })

  it('round-trips a vocab-linked code', () => {
    const store = new AnnotationStore()
    const vocabId   = newId()
    const entryId   = newId()
    store.addVocabulary('TroubleType', [{ id: entryId, value: 'referential' }], vocabId)
    store.addAnnotation('textlet', [{ type: 'mark', markId: 'mk-v' }], {
      codes: [{ value: 'referential', vocabEntryId: entryId, vocabId }],
    })

    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    const t = result.annotations.find(a => a.anchors.some(x => x.type === 'mark'))!
    const codes = t.features.codes as { value: string; vocabEntryId?: string; vocabId?: string }[]
    expect(codes).toHaveLength(1)
    expect(codes[0]!.value).toBe('referential')
    expect(codes[0]!.vocabEntryId).toBe(entryId)
    expect(codes[0]!.vocabId).toBe(vocabId)
  })

  it('handles features with XML-special characters', () => {
    const store = new AnnotationStore()
    store.addAnnotation('textlet', [{ type: 'mark', markId: 'mk1' }], { comment: 'a < b & c > d "quoted"' })
    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    const t = result.annotations.find(a => a.anchors.some(x => x.type === 'mark'))!
    expect(t.features.comment).toBe('a < b & c > d "quoted"')
  })

  it('textlets survive MMETF round-trip', () => {
    const store = new AnnotationStore()
    const ann = store.addAnnotation('textlet', [{ type: 'mark', markId: 'mk-tmpl' }], { codes: ['template-code'] })
    const result = parseMMETF(emitMMETF(store))
    const textlets = result.annotations.filter(a => a.anchors.some(x => x.type === 'mark'))
    expect(textlets).toHaveLength(1)
    expect(textlets[0]!.id).toBe(ann.id)
  })
})

// parseMMETF

describe('parseMMETF', () => {
  it('parses MMETF output without throwing', () => {
    const store = new AnnotationStore()
    store.addTier('Gesture', {})
    store.addPatternSchema({ name: 'Repair', slots: [] })
    expect(() => parseMMETF(emitMMETF(store))).not.toThrow()
  })

  it('returns tiers from template', () => {
    const store = new AnnotationStore()
    store.addTier('Gesture', {})
    const result = parseMMETF(emitMMETF(store))
    expect(result.tiers.map(t => t.name)).toContain('Gesture')
  })

  it('returns pattern schemas from template', () => {
    const store = new AnnotationStore()
    store.addPatternSchema({ name: 'Repair', slots: [] })
    const result = parseMMETF(emitMMETF(store))
    expect(result.patternSchemas).toHaveLength(1)
    expect(result.patternSchemas[0]!.name).toBe('Repair')
  })

  it('returns no annotations (template has none)', () => {
    const store = new AnnotationStore()
    store.addTier('Gesture', {})
    store.addAnnotation('stroke', [{ type: 'time', start: 0, end: 1 }], {
      tierId: store.allTiers()[0]!.id,
    })
    const result = parseMMETF(emitMMETF(store))
    expect(result.annotations).toHaveLength(0)
  })

  it('MMETF is valid EAF — parseable by parseMMEAF with same result', () => {
    const store = new AnnotationStore()
    store.addPatternSchema({ name: 'AP', slots: [] })
    const xml = emitMMETF(store)
    const r1 = parseMMETF(xml)
    const r2 = parseMMEAF(xml)
    expect(r1.patternSchemas).toHaveLength(r2.patternSchemas.length)
    expect(r1.tiers).toHaveLength(r2.tiers.length)
  })
})

// Full store round-trip via store.loadJSON

describe('MMEAF full store round-trip', () => {
  it('restores pattern schemas and patterns via store.loadJSON', () => {
    const store1 = new AnnotationStore()
    const vocab = store1.addVocabulary('TroubleType', [
      { id: newId(), value: 'referential' },
      { id: newId(), value: 'lexical' },
    ])
    const schema = store1.addPatternSchema({
      name: 'Repair',
      color: 0xff0000,
      description: 'Other-initiated self-repair',
      slots: [
        {
          id: newId(), name: 'trouble', anchorKind: 'textlet', required: true,
          metrics: [{ id: newId(), name: 'type', type: 'categorical', vocabularyId: vocab.id }],
        },
        { id: newId(), name: 'initiation', anchorKind: 'utterance', metrics: [] },
      ],
    })
    const f1 = store1.addPattern(schema.id)
    const f2 = store1.addPattern(schema.id)

    const xml = emitMMEAF(emptyDoc(), store1)
    const result = parseMMEAF(xml)

    const store2 = new AnnotationStore()
    store2.loadJSON({
      annotations: result.annotations,
      relations: [],
      tiers: result.tiers,
      vocabularies: result.vocabularies,
      linguisticTypes: result.linguisticTypes,
      patternSchemas: result.patternSchemas,
      patterns: result.patterns,
    })

    expect(store2.allPatternSchemas()).toHaveLength(1)
    const s2 = store2.allPatternSchemas()[0]!
    expect(s2.name).toBe('Repair')
    expect(s2.color).toBe(0xff0000)
    expect(s2.slots).toHaveLength(2)
    expect(s2.slots[0]!.name).toBe('trouble')
    expect(s2.slots[0]!.required).toBe(true)
    expect(s2.slots[0]!.metrics[0]!.type).toBe('categorical')

    expect(store2.allPatterns()).toHaveLength(2)
    expect(store2.allPatterns().map(f => f.id)).toContain(f1.id)
    expect(store2.allPatterns().map(f => f.id)).toContain(f2.id)
  })

  it('double MMEAF round-trip is stable', () => {
    const store1 = new AnnotationStore()
    const schema = store1.addPatternSchema({ name: 'AP', slots: [] })
    store1.addPattern(schema.id)

    const r1 = parseMMEAF(emitMMEAF(emptyDoc(), store1))

    const store2 = new AnnotationStore()
    store2.loadJSON({
      annotations: r1.annotations, relations: [],
      tiers: r1.tiers, vocabularies: r1.vocabularies, linguisticTypes: r1.linguisticTypes,
      patternSchemas: r1.patternSchemas, patterns: r1.patterns,
    })

    const r2 = parseMMEAF(emitMMEAF(emptyDoc(), store2))

    expect(r2.patternSchemas).toHaveLength(r1.patternSchemas.length)
    expect(r2.patterns).toHaveLength(r1.patterns.length)
  })
})

// annotation_ref round-trip

describe('annotation_ref round-trip', () => {
  it('emits annotation_ref on mm:utt for utterance-anchored annotation', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', text: 'hello' }],
    }])
    const blockId = (doc.content![0]!.attrs as Record<string, unknown>)['id'] as string
    const ann = annotationStore.addAnnotation('gloss', [{ type: 'utterance', uttId: blockId }], { text: 'greeting' })
    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    expect(xml).toContain(`annotation_ref="${ann.id}"`)
  })

  it('round-trips an utterance-anchored annotation', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', text: 'hello' }],
    }])
    const blockId = (doc.content![0]!.attrs as Record<string, unknown>)['id'] as string
    const ann = annotationStore.addAnnotation('gloss', [{ type: 'utterance', uttId: blockId }], { text: 'greeting' })
    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    const result = parseMMEAF(xml)
    const recovered = result.annotations.find(a => a.id === ann.id)
    expect(recovered).toBeDefined()
    expect(recovered!.type).toBe('gloss')
    expect(recovered!.features.text).toBe('greeting')
    const anchor = recovered!.anchors.find(a => a.type === 'utterance')
    expect(anchor).toBeDefined()
  })

  it('slot-anchor utteranceId feature points at the parsed block ID after round-trip', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', text: 'hello' }],
    }])
    const storedBlockId = (doc.content![0]!.attrs as Record<string, unknown>)['id'] as string
    const ann = annotationStore.addAnnotation('utterance', [{ type: 'utterance', uttId: storedBlockId }], { utteranceId: storedBlockId })

    const xml    = emitMMEAF(doc, annotationStore, {}, tokenStore)
    const result = parseMMEAF(xml)

    // mm:id_map restores the original block ID on the parsed doc
    const parsedBlockId = (result.doc.content![0] as { attrs: Record<string, unknown> }).attrs['id'] as string
    expect(parsedBlockId).toBe(storedBlockId)

    const recovered = result.annotations.find(a => a.id === ann.id)
    expect(recovered).toBeDefined()
    // utteranceId must point at the parsed block ID so getUttLabel() can find the utterance
    expect(recovered!.features['utteranceId']).toBe(parsedBlockId)
    // The utterance anchor must too
    const anchor = recovered!.anchors.find(a => a.type === 'utterance')
    expect(anchor?.type === 'utterance' && anchor.uttId).toBe(parsedBlockId)
  })

  it('emits annotation_ref on mm:t for token-anchored annotation', () => {
    const tokId = newId()
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', id: tokId, text: 'hello' }],
    }])
    const ann = annotationStore.addAnnotation('gloss', [{ type: 'token', tokenId: tokId }], { value: 'GREETING' })
    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    expect(xml).toContain(`annotation_ref="${ann.id}"`)
  })

  it('round-trips a token-anchored annotation', () => {
    const tokId = newId()
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', id: tokId, text: 'hello' }],
    }])
    const ann = annotationStore.addAnnotation('gloss', [{ type: 'token', tokenId: tokId }], { value: 'GREETING' })
    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    const result = parseMMEAF(xml)
    const recovered = result.annotations.find(a => a.id === ann.id)
    expect(recovered).toBeDefined()
    expect(recovered!.features.value).toBe('GREETING')
    const anchor = recovered!.anchors.find(a => a.type === 'token')
    expect(anchor).toBeDefined()
    expect((anchor as { type: 'token'; tokenId: string }).tokenId).toBe(tokId)
  })

  it('emits mm:annotations section when utterance/token annotations exist', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', text: 'hi' }],
    }])
    const blockId = (doc.content![0]!.attrs as Record<string, unknown>)['id'] as string
    annotationStore.addAnnotation('gloss', [{ type: 'utterance', uttId: blockId }], {})
    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    expect(xml).toContain('<mm:annotations>')
    expect(xml).toContain('</mm:annotations>')
  })

  it('does not emit mm:annotations when no such annotations exist', () => {
    const xml = emitMMEAF(emptyDoc(), new AnnotationStore())
    expect(xml).not.toContain('<mm:annotations>')
  })
})

describe('suggestion round-trip', () => {
  function makeUttDoc(uttId: string, participant = 'A', startS = 1, endS = 2): PMNodeJSON {
    return {
      type: 'doc',
      content: [{
        type: 'utterance',
        attrs: { id: uttId, participant, startTimeSeconds: startS, endTimeSeconds: endS },
        content: [{ type: 'text', text: 'hello' }],
      }],
    }
  }

  it('round-trips pm:replace suggestion (replacement)', () => {
    const uttId = newId()
    const sugId = newId()
    // Doc with suggestion marks already applied (as the PM state would have them)
    const doc: PMNodeJSON = {
      type: 'doc',
      content: [{
        type: 'utterance',
        attrs: { id: uttId, participant: 'A', startTimeSeconds: 1, endTimeSeconds: 2 },
        content: [
          { type: 'text', text: 'say ' },
          { type: 'text', text: 'hello', marks: [{ type: 'suggestion_delete', attrs: { suggestionId: sugId, authorId: 'user:local' } }] },
          { type: 'text', text: 'goodbye', marks: [{ type: 'suggestion_insert', attrs: { suggestionId: sugId, authorId: 'user:local' } }] },
        ],
      }],
    }
    const store = new AnnotationStore()
    store.addSuggestion({ type: 'pm:replace', uttId, fromOffset: 4, toOffset: 9, replacement: 'goodbye' }, 'user:local', undefined, sugId)

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    // Suggestion should be restored
    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('pm:replace')
    if (sug.change.type !== 'pm:replace') return
    expect(sug.change.fromOffset).toBe(4)
    expect(sug.change.toOffset).toBe(9)
    expect(sug.change.replacement).toBe('goodbye')

    // Marks should be injected into the loaded doc
    const utt = (result.doc as { content: PMNodeJSON[] }).content[0]!
    const delNode = (utt.content as PMNodeJSON[]).find(n => n.marks?.some(m => m.type === 'suggestion_delete'))
    expect(delNode).toBeDefined()
    expect(delNode?.text).toBe('hello')
    const insNode = (utt.content as PMNodeJSON[]).find(n => n.marks?.some(m => m.type === 'suggestion_insert'))
    expect(insNode).toBeDefined()
    expect(insNode?.text).toBe('goodbye')
  })

  it('round-trips pm:replace suggestion (pure insert)', () => {
    const uttId = newId()
    const sugId = newId()
    const doc: PMNodeJSON = {
      type: 'doc',
      content: [{
        type: 'utterance',
        attrs: { id: uttId, participant: 'A', startTimeSeconds: 1, endTimeSeconds: 2 },
        content: [
          { type: 'text', text: 'say ' },
          { type: 'text', text: 'hmm ', marks: [{ type: 'suggestion_insert', attrs: { suggestionId: sugId, authorId: 'user:local' } }] },
          { type: 'text', text: 'hello' },
        ],
      }],
    }
    const store = new AnnotationStore()
    store.addSuggestion({ type: 'pm:replace', uttId, fromOffset: 4, toOffset: 4, replacement: 'hmm ' }, 'user:local', undefined, sugId)

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('pm:replace')
    if (sug.change.type !== 'pm:replace') return
    expect(sug.change.fromOffset).toBe(4)
    expect(sug.change.toOffset).toBe(4)
    expect(sug.change.replacement).toBe('hmm ')

    const utt = (result.doc as { content: PMNodeJSON[] }).content[0]!
    const insNode = (utt.content as PMNodeJSON[]).find(n => n.marks?.some(m => m.type === 'suggestion_insert'))
    expect(insNode).toBeDefined()
    expect(insNode?.text).toBe('hmm ')
  })

  it('round-trips utt:set-time suggestion', () => {
    const uttId = newId()
    const doc   = makeUttDoc(uttId)
    const store = new AnnotationStore()
    store.addSuggestion({ type: 'utt:set-time', uttId, startTime: 1.5, endTime: 2.5 }, 'user:alice')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('utt:set-time')
    if (sug.change.type === 'utt:set-time') {
      expect(sug.change.startTime).toBeCloseTo(1.5)
      expect(sug.change.endTime).toBeCloseTo(2.5)
      expect(sug.authorId).toBe('user:alice')
    }
  })

  it('round-trips annotation:add suggestion', () => {
    const uttId = newId()
    const doc   = makeUttDoc(uttId)
    const store = new AnnotationStore()
    store.addTier({ id: 't1', name: 'Gesture', participant: 'A', linguisticTypeId: 'default-lt' })
    const annId = newId()
    store.addSuggestion({
      type: 'annotation:add',
      annotation: { id: annId, type: 'stroke', anchors: [{ type: 'time', start: 1.1, end: 1.8 }], features: { tierId: 't1' } },
    }, 'user:alice')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('annotation:add')
    if (sug.change.type === 'annotation:add') {
      expect(sug.change.annotation.id).toBe(annId)
      expect(sug.change.annotation.type).toBe('stroke')
      const ta = sug.change.annotation.anchors.find(a => a.type === 'time')
      expect(ta?.type === 'time' && ta.start).toBeCloseTo(1.1)
      expect(ta?.type === 'time' && ta.end).toBeCloseTo(1.8)
      expect(sug.change.annotation.features['tierId']).toBe('t1')
    }
  })

  it('round-trips annotation:update (time move) suggestion', () => {
    const uttId = newId()
    const doc   = makeUttDoc(uttId)
    const store = new AnnotationStore()
    store.addTier({ id: 't1', name: 'Gesture', participant: 'A', linguisticTypeId: 'default-lt' })
    const ann   = store.addAnnotation('stroke', [{ type: 'time', start: 1.0, end: 1.5 }], { tierId: 't1' })
    store.addSuggestion({
      type: 'annotation:update',
      annotationId: ann.id,
      patch: { anchors: [{ type: 'time', start: 1.2, end: 1.9 }] },
    }, 'user:alice')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('annotation:update')
    if (sug.change.type === 'annotation:update') {
      expect(sug.change.annotationId).toBe(ann.id)
      const ta = sug.change.patch.anchors?.find(a => a.type === 'time')
      expect(ta?.type === 'time' && ta.start).toBeCloseTo(1.2)
      expect(ta?.type === 'time' && ta.end).toBeCloseTo(1.9)
    }
  })

  it('round-trips annotation:update (label) suggestion', () => {
    const uttId = newId()
    const doc   = makeUttDoc(uttId)
    const store = new AnnotationStore()
    store.addTier({ id: 't1', name: 'Gesture', participant: 'A', linguisticTypeId: 'default-lt' })
    const ann   = store.addAnnotation('stroke', [{ type: 'time', start: 1.0, end: 1.5 }], { tierId: 't1' })
    store.addSuggestion({ type: 'annotation:update', annotationId: ann.id, patch: { type: 'hold' } }, 'user:alice')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('annotation:update')
    if (sug.change.type === 'annotation:update') {
      expect(sug.change.annotationId).toBe(ann.id)
      expect(sug.change.patch.type).toBe('hold')
    }
  })

  it('round-trips annotation:delete suggestion', () => {
    const uttId = newId()
    const doc   = makeUttDoc(uttId)
    const store = new AnnotationStore()
    store.addTier({ id: 't1', name: 'Gesture', participant: 'A', linguisticTypeId: 'default-lt' })
    const ann   = store.addAnnotation('stroke', [{ type: 'time', start: 1.0, end: 1.5 }], { tierId: 't1' })
    store.addSuggestion({ type: 'annotation:delete', annotationId: ann.id }, 'user:alice')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('annotation:delete')
    if (sug.change.type === 'annotation:delete') {
      expect(sug.change.annotationId).toBe(ann.id)
    }
  })

  it('round-trips textlet:add suggestion with word-range anchor', () => {
    const uttId    = newId()
    const doc      = makeUttDoc(uttId)
    const store    = new AnnotationStore()
    const annId    = newId()
    const wordId1  = newId()
    const wordId2  = newId()
    store.addSuggestion({
      type: 'textlet:add',
      annotation: { id: annId, type: '', anchors: [{ type: 'word-range', fromWordId: wordId1, toWordId: wordId2 }], features: {} },
    }, 'user:local')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('textlet:add')
    if (sug.change.type === 'textlet:add') {
      expect(sug.change.annotation.id).toBe(annId)
      const anchor = sug.change.annotation.anchors[0]
      expect(anchor?.type).toBe('word-range')
      if (anchor?.type === 'word-range') {
        expect(anchor.fromWordId).toBe(wordId1)
        expect(anchor.toWordId).toBe(wordId2)
      }
    }
  })

  it('round-trips textlet:delete suggestion', () => {
    const uttId    = newId()
    const doc      = makeUttDoc(uttId)
    const store    = new AnnotationStore()
    const textletId = newId()
    store.addSuggestion({ type: 'textlet:delete', textletId }, 'user:local')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('textlet:delete')
    if (sug.change.type === 'textlet:delete') {
      expect(sug.change.textletId).toBe(textletId)
    }
  })

  it('round-trips textlet:add-code suggestion', () => {
    const uttId    = newId()
    const doc      = makeUttDoc(uttId)
    const store    = new AnnotationStore()
    const textletId = newId()
    store.addSuggestion({ type: 'textlet:add-code', textletId, code: { value: 'CA', vocabEntryId: 've1', vocabId: 'v1' } }, 'user:local')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('textlet:add-code')
    if (sug.change.type === 'textlet:add-code') {
      expect(sug.change.textletId).toBe(textletId)
      expect(sug.change.code.value).toBe('CA')
      expect(sug.change.code.vocabEntryId).toBe('ve1')
      expect(sug.change.code.vocabId).toBe('v1')
    }
  })

  it('round-trips textlet:remove-code suggestion', () => {
    const uttId    = newId()
    const doc      = makeUttDoc(uttId)
    const store    = new AnnotationStore()
    const textletId = newId()
    store.addSuggestion({ type: 'textlet:remove-code', textletId, code: { value: 'repair' } }, 'user:local')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('textlet:remove-code')
    if (sug.change.type === 'textlet:remove-code') {
      expect(sug.change.textletId).toBe(textletId)
      expect(sug.change.code.value).toBe('repair')
      expect(sug.change.code.vocabEntryId).toBeUndefined()
    }
  })

  it('round-trips pattern:add suggestion', () => {
    const doc      = makeUttDoc(newId())
    const store    = new AnnotationStore()
    const patternId = newId()
    const schemaId  = newId()
    store.addSuggestion({ type: 'pattern:add', patternId, schemaId, note: 'initial repair frame' }, 'user:alice')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('pattern:add')
    if (sug.change.type === 'pattern:add') {
      expect(sug.change.patternId).toBe(patternId)
      expect(sug.change.schemaId).toBe(schemaId)
      expect(sug.change.note).toBe('initial repair frame')
    }
  })

  it('round-trips pattern:delete suggestion', () => {
    const doc       = makeUttDoc(newId())
    const store     = new AnnotationStore()
    const patternId = newId()
    store.addSuggestion({ type: 'pattern:delete', patternId }, 'user:bob', 'frame was wrong')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('pattern:delete')
    if (sug.change.type === 'pattern:delete') {
      expect(sug.change.patternId).toBe(patternId)
    }
    expect(sug.note).toBe('frame was wrong')
  })

  it('round-trips pattern:fill-slot suggestion with utterance pendingAnnotation', () => {
    const uttId        = newId()
    const doc          = makeUttDoc(uttId)
    const store        = new AnnotationStore()
    const patternId    = newId()
    const schemaSlotId = newId()
    const annotationId = newId()
    const slotId       = newId()
    const pendingId    = newId()
    store.addSuggestion({
      type: 'pattern:fill-slot',
      patternId,
      slot: { id: slotId, schemaSlotId, annotationId, metrics: [{ schemaId: 'ms1', value: 'lexical' }] },
      pendingAnnotation: {
        id: pendingId,
        type: 'utterance',
        anchors: [{ type: 'utterance', uttId }],
        features: { tierId: 'tier1', blockNodeId: uttId },
      },
    }, 'jack')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('pattern:fill-slot')
    if (sug.change.type === 'pattern:fill-slot') {
      expect(sug.change.patternId).toBe(patternId)
      expect(sug.change.slot.id).toBe(slotId)
      expect(sug.change.slot.schemaSlotId).toBe(schemaSlotId)
      expect(sug.change.slot.annotationId).toBe(annotationId)
      expect(sug.change.slot.metrics).toHaveLength(1)
      expect(sug.change.slot.metrics[0]).toMatchObject({ schemaId: 'ms1', value: 'lexical' })
      const pa = sug.change.pendingAnnotation!
      expect(pa.id).toBe(pendingId)
      expect(pa.type).toBe('utterance')
      expect(pa.anchors).toHaveLength(1)
      expect(pa.anchors[0]).toMatchObject({ type: 'utterance', uttId })
      expect(pa.features['blockNodeId']).toBe(uttId)
    }
  })

  it('round-trips pattern:fill-slot suggestion without pendingAnnotation', () => {
    const doc          = makeUttDoc(newId())
    const store        = new AnnotationStore()
    const patternId    = newId()
    const schemaSlotId = newId()
    const annotationId = newId()
    const slotId       = newId()
    store.addSuggestion({
      type: 'pattern:fill-slot',
      patternId,
      slot: { id: slotId, schemaSlotId, annotationId, metrics: [] },
    }, 'user:alice')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]!
    expect(sug.change.type).toBe('pattern:fill-slot')
    if (sug.change.type === 'pattern:fill-slot') {
      expect(sug.change.patternId).toBe(patternId)
      expect(sug.change.slot.schemaSlotId).toBe(schemaSlotId)
      expect(sug.change.slot.annotationId).toBe(annotationId)
      expect(sug.change.pendingAnnotation).toBeUndefined()
    }
  })

  it('round-trips pattern:fill-metric suggestion with all value types', () => {
    const doc       = makeUttDoc(newId())
    const store     = new AnnotationStore()
    const patternId = newId()
    const ssId      = newId()
    const mid       = newId()
    store.addSuggestion({ type: 'pattern:fill-metric', patternId, slotSchemaId: ssId, metricId: mid, value: 'lexical' },   'user:a')
    store.addSuggestion({ type: 'pattern:fill-metric', patternId, slotSchemaId: ssId, metricId: mid, value: true },        'user:a')
    store.addSuggestion({ type: 'pattern:fill-metric', patternId, slotSchemaId: ssId, metricId: mid, value: 3.14 },        'user:a')
    store.addSuggestion({ type: 'pattern:fill-metric', patternId, slotSchemaId: ssId, metricId: mid, value: null },        'user:a')

    const xml    = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(4)
    const values = result.suggestions.map(s => s.change.type === 'pattern:fill-metric' ? s.change.value : 'WRONG')
    expect(values[0]).toBe('lexical')
    expect(values[1]).toBe(true)
    expect(values[2]).toBeCloseTo(3.14)
    expect(values[3]).toBeNull()
  })
})

// ID stability (mm:id_map)

describe('ID stability round-trip', () => {
  it('preserves utterance block IDs across a round-trip', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([
      { type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1, tokens: [{ kind: 'word', text: 'hello' }] },
      { type: 'utterance', participant: 'B', startTimeSeconds: 1, endTimeSeconds: 2, tokens: [{ kind: 'word', text: 'hi' }] },
    ])
    const originalIds = doc.content!.map(b => (b.attrs as Record<string, unknown>)['id'])

    const result = parseMMEAF(emitMMEAF(doc, annotationStore, {}, tokenStore))
    const resultIds = (result.doc as { content: { attrs: Record<string, unknown> }[] }).content
      .filter(b => 'participant' in b.attrs)
      .map(b => b.attrs['id'])
    expect(resultIds).toEqual(originalIds)
  })

  it('preserves utterance block IDs across two round-trips', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([
      { type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1, tokens: [{ kind: 'word', text: 'hello' }] },
    ])
    const originalId = (doc.content![0]!.attrs as Record<string, unknown>)['id']

    const r1 = parseMMEAF(emitMMEAF(doc, annotationStore, {}, tokenStore))
    const ts2 = new TokenStore()
    ts2.loadTokens(r1.tokens)
    const store2 = new AnnotationStore()
    store2.loadTokenTimes(r1.tokenTimes as Record<string, { start: number; end: number }>)
    const r2 = parseMMEAF(emitMMEAF(r1.doc as PMNodeJSON, store2, {}, ts2))

    const id2 = (r2.doc as { content: { attrs: Record<string, unknown> }[] }).content[0]!.attrs['id']
    expect(id2).toBe(originalId)
  })

  it('preserves tier annotation IDs across a round-trip', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 2,
      tokens: [{ kind: 'word', text: 'hello' }],
    }])
    const tier = annotationStore.addTier('gesture')
    const ann  = annotationStore.addAnnotation('stroke', [{ type: 'time', start: 0.5, end: 1.0 }], { tierId: tier.id })

    const result = parseMMEAF(emitMMEAF(doc, annotationStore, {}, tokenStore))
    const recovered = result.annotations.find(a => a.type === 'stroke')
    expect(recovered).toBeDefined()
    expect(recovered!.id).toBe(ann.id)
  })

  it('preserves parent/child annotation ID links across a round-trip', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 2,
      tokens: [{ kind: 'word', text: 'hello' }],
    }])
    const parentTier = annotationStore.addTier('gesture')
    const childTier  = annotationStore.addTier('phase', { parentTierId: parentTier.id, constraint: 'symbolic_association' })
    const parent = annotationStore.addAnnotation('stroke', [{ type: 'time', start: 0.5, end: 1.0 }], { tierId: parentTier.id })
    const child  = annotationStore.addAnnotation('peak', [], { tierId: childTier.id, parentAnnId: parent.id })

    const result = parseMMEAF(emitMMEAF(doc, annotationStore, {}, tokenStore))
    const rChild = result.annotations.find(a => a.type === 'peak')
    expect(rChild).toBeDefined()
    expect(rChild!.id).toBe(child.id)
    expect(rChild!.features['parentAnnId']).toBe(parent.id)
  })

  it('legacy files without mm:id_map still parse (heuristic fallback)', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', text: 'hello' }],
    }])
    const blockId = (doc.content![0]!.attrs as Record<string, unknown>)['id'] as string
    annotationStore.addAnnotation('utterance', [{ type: 'utterance', uttId: blockId }], { utteranceId: blockId })

    const xml = emitMMEAF(doc, annotationStore, {}, tokenStore)
    const stripped = xml.replace(/<mm:id_map>[\s\S]*?<\/mm:id_map>/, '')
    const result = parseMMEAF(stripped)

    // Fresh block ID minted, but the annotation's refs must be remapped to it
    const freshBlockId = (result.doc as { content: { attrs: Record<string, unknown> }[] }).content[0]!.attrs['id'] as string
    const recovered = result.annotations.find(a => a.type === 'utterance')
    expect(recovered).toBeDefined()
    expect(recovered!.features['utteranceId']).toBe(freshBlockId)
  })
})

// Vocabulary ID stability

describe('vocabulary ID stability round-trip', () => {
  it('vocabulary keeps its mumo uuid so metric vocabularyId resolves', () => {
    const store = new AnnotationStore()
    const vocabId = newId()
    store.addVocabulary('POS tags', [{ id: newId(), value: 'NOUN' }], vocabId)
    store.addPatternSchema({
      name: 'Test', slots: [{
        id: newId(), name: 'slot', anchorKind: 'textlet', metrics: [
          { id: newId(), name: 'pos', type: 'categorical', vocabularyId: vocabId },
        ],
      }],
    })

    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    const metricVocabId = result.patternSchemas[0]!.slots[0]!.metrics[0]!.vocabularyId
    expect(metricVocabId).toBe(vocabId)
    // The vocabulary itself must exist under that same uuid
    const vocab = result.vocabularies.find(v => v.id === metricVocabId)
    expect(vocab).toBeDefined()
    expect(vocab!.name).toBe('POS tags')
    expect(vocab!.entries[0]!.value).toBe('NOUN')
  })

  it('vocabulary uuid survives two round-trips', () => {
    const store = new AnnotationStore()
    const vocabId = newId()
    store.addVocabulary('Types', [{ id: newId(), value: 'x' }], vocabId)

    const r1 = parseMMEAF(emitMMEAF(emptyDoc(), store))
    const store2 = new AnnotationStore()
    store2.loadJSON({
      annotations: r1.annotations, relations: [],
      tiers: r1.tiers, vocabularies: r1.vocabularies, linguisticTypes: r1.linguisticTypes,
      patternSchemas: r1.patternSchemas, patterns: r1.patterns,
    })
    const r2 = parseMMEAF(emitMMEAF(emptyDoc(), store2))

    expect(r2.vocabularies.find(v => v.id === vocabId)).toBeDefined()
  })

  it('linguisticType vocabularyId is restored to the mumo uuid', () => {
    const store = new AnnotationStore()
    const vocabId = newId()
    store.addVocabulary('Phases', [{ id: newId(), value: 'stroke' }], vocabId)
    const tier = store.addTier('phase', { constraint: 'symbolic_association' })
    const lt = store.getLinguisticType(store.getTier(tier.id)!.linguisticTypeId)!
    store.updateLinguisticType(lt.id, { vocabularyId: vocabId })

    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    const rLt = result.linguisticTypes.find(l => l.vocabularyId === vocabId)
    expect(rLt).toBeDefined()
  })
})

// Multiple annotations per anchor

describe('multiple annotations per utterance/token', () => {
  it('round-trips two annotations anchored to the same utterance', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', text: 'hello' }],
    }])
    const blockId = (doc.content![0]!.attrs as Record<string, unknown>)['id'] as string
    const ann1 = annotationStore.addAnnotation('fpp',     [{ type: 'utterance', uttId: blockId }], { utteranceId: blockId })
    const ann2 = annotationStore.addAnnotation('trouble', [{ type: 'utterance', uttId: blockId }], { utteranceId: blockId })

    const result = parseMMEAF(emitMMEAF(doc, annotationStore, {}, tokenStore))
    const r1 = result.annotations.find(a => a.id === ann1.id)
    const r2 = result.annotations.find(a => a.id === ann2.id)
    expect(r1).toBeDefined()
    expect(r2).toBeDefined()
    const a1 = r1!.anchors.find(a => a.type === 'utterance')
    const a2 = r2!.anchors.find(a => a.type === 'utterance')
    expect(a1?.type === 'utterance' && a1.uttId).toBe(blockId)
    expect(a2?.type === 'utterance' && a2.uttId).toBe(blockId)
  })

  it('round-trips two annotations anchored to the same token', () => {
    const tokId = newId()
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', id: tokId, text: 'hello' }],
    }])
    const ann1 = annotationStore.addAnnotation('pos',   [{ type: 'token', tokenId: tokId }], {})
    const ann2 = annotationStore.addAnnotation('gloss', [{ type: 'token', tokenId: tokId }], {})

    const result = parseMMEAF(emitMMEAF(doc, annotationStore, {}, tokenStore))
    for (const ann of [ann1, ann2]) {
      const r = result.annotations.find(a => a.id === ann.id)
      expect(r).toBeDefined()
      const anchor = r!.anchors.find(a => a.type === 'token')
      expect(anchor?.type === 'token' && anchor.tokenId).toBe(tokId)
    }
  })

  it('round-trips a feature-only slot annotation (no anchors)', () => {
    const { doc, tokenStore, annotationStore } = makeDocAndStore([{
      type: 'utterance', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1,
      tokens: [{ kind: 'word', text: 'hello' }],
    }])
    const blockId = (doc.content![0]!.attrs as Record<string, unknown>)['id'] as string
    // This is the shape App.svelte's fillSlotWithNewAnnotation produces
    const ann = annotationStore.addAnnotation('', [], { utteranceId: blockId })

    const result = parseMMEAF(emitMMEAF(doc, annotationStore, {}, tokenStore))
    const recovered = result.annotations.find(a => a.id === ann.id)
    expect(recovered).toBeDefined()
    expect(recovered!.features['utteranceId']).toBe(blockId)
  })

  it('round-trips a time-anchored slot annotation without tierId', () => {
    const store = new AnnotationStore()
    const ann = store.addAnnotation('', [{ type: 'time', start: 1.5, end: 2.5 }], { patternId: newId() })

    const result = parseMMEAF(emitMMEAF(emptyDoc(), store))
    const recovered = result.annotations.find(a => a.id === ann.id)
    expect(recovered).toBeDefined()
    const ta = recovered!.anchors.find(a => a.type === 'time')
    expect(ta?.type === 'time' && ta.start).toBeCloseTo(1.5)
    expect(ta?.type === 'time' && ta.end).toBeCloseTo(2.5)
  })
})
