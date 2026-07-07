import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseXML, eafTomumo, parseEAF } from '../src/eaf-parse.js'
import { emitEAF } from '../src/eaf-emit.js'
import { AnnotationStore } from '@mumo/core'
import {
  buildSingleSpeaker,
  buildTwoSpeakers,
  buildWithStoreTier,
  buildArbitraryTiers,
} from './fixtures/build.js'
import { validateEAF } from './xsd-validate.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

// Helpers

function textContent(node: { content?: Array<{ text?: string; content?: unknown[] }> }): string {
  return (node.content ?? []).map((c: { text?: string; content?: unknown[] }) =>
    c.text ?? textContent(c as { content?: Array<{ text?: string; content?: unknown[] }> })
  ).join('')
}

// parseXML

describe('parseXML', () => {
  it('parses time slots', () => {
    const { xml } = buildSingleSpeaker()
    const eaf = parseXML(xml)
    expect(eaf.timeSlots.length).toBeGreaterThan(0)
    for (const s of eaf.timeSlots) {
      expect(typeof s.id).toBe('string')
      expect(typeof s.value).toBe('number')
    }
  })

  it('parses tiers', () => {
    const { xml } = buildTwoSpeakers()
    const eaf = parseXML(xml)
    const tierIds = eaf.tiers.map(t => t.id)
    expect(tierIds).toContain('utterance:A')
    expect(tierIds).toContain('utterance:B')
  })

  it('parses alignable annotations with time refs', () => {
    const { xml } = buildSingleSpeaker()
    const eaf = parseXML(xml)
    const tier = eaf.tiers.find(t => t.id === 'utterance:A')!
    expect(tier).toBeDefined()
    expect(tier.annotations).toHaveLength(2)
    for (const ann of tier.annotations) {
      expect(ann.kind).toBe('alignable')
      if (ann.kind === 'alignable') {
        expect(ann.ts1).toMatch(/^ts\d+$/)
        expect(ann.ts2).toMatch(/^ts\d+$/)
      }
    }
  })

  it('parses linguistic types', () => {
    const { xml } = buildSingleSpeaker()
    const eaf = parseXML(xml)
    expect(eaf.linguisticTypes.some(lt => lt.id === 'lt-utterance')).toBe(true)
  })
})

// eafTomumo

describe('eafTomumo', () => {
  it('produces utterance blocks for utterance: tiers', () => {
    const { xml } = buildSingleSpeaker()
    const result = eafTomumo(parseXML(xml))
    const doc = result.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    const utterances = doc.content.filter(n => n.type === 'utterance')
    expect(utterances).toHaveLength(2)
  })

  it('preserves participant', () => {
    const { xml } = buildTwoSpeakers()
    const result = eafTomumo(parseXML(xml))
    const doc = result.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    const participants = doc.content.map(n => n.attrs['participant'])
    expect(participants).toContain('A')
    expect(participants).toContain('B')
  })

  it('default utterance:<p> tiers import with an empty tier attr (no lane-ID doubling)', () => {
    const { xml } = buildTwoSpeakers()
    const result = eafTomumo(parseXML(xml))
    const doc = result.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    for (const n of doc.content.filter(n => n.type === 'utterance')) {
      expect(n.attrs['tier']).toBe('')
    }
  })

  it('custom base:participant tiers import with the suffix stripped from the tier attr', () => {
    const { xml } = buildArbitraryTiers()
    const result = eafTomumo(parseXML(xml), { transcriptTierIds: ['CHI:Child', 'MOT:Mother'] })
    const doc = result.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    const tiers = doc.content.filter(n => n.type === 'utterance').map(n => n.attrs['tier'])
    expect(tiers).toContain('CHI')
    expect(tiers).toContain('MOT')
  })

  it('preserves start/end time to millisecond precision', () => {
    const { xml } = buildSingleSpeaker()
    const result = eafTomumo(parseXML(xml))
    const doc = result.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    const first = doc.content[0]!
    expect(first.attrs['startTimeSeconds']).toBeCloseTo(0.0, 2)
    expect(first.attrs['endTimeSeconds']).toBeCloseTo(1.8, 2)
  })

  it('preserves annotation text', () => {
    const { xml } = buildSingleSpeaker()
    const result = eafTomumo(parseXML(xml))
    const doc = result.doc as { content: Array<{ type: string; content?: unknown[] }> }
    const text = textContent(doc.content[0] as { content?: Array<{ text?: string; content?: unknown[] }> })
    expect(text).toBe('Hello world.')
  })

  it('produces store annotations for non-transcript tiers', () => {
    const { xml } = buildWithStoreTier()
    const result = eafTomumo(parseXML(xml))
    expect(result.annotations).toHaveLength(1)
    expect(result.annotations[0]!.type).toBe('stroke')
    expect(result.tiers).toHaveLength(1)
    expect(result.tiers[0]!.name).toBe('Gesture')
  })

  it('preserves store annotation time anchors', () => {
    const { xml } = buildWithStoreTier()
    const result = eafTomumo(parseXML(xml))
    const ann = result.annotations[0]!
    const timeAnchor = ann.anchors.find(a => a.type === 'time')!
    expect(timeAnchor).toBeDefined()
    if (timeAnchor.type === 'time') {
      expect(timeAnchor.start).toBeCloseTo(0.5, 2)
      expect(timeAnchor.end).toBeCloseTo(1.0, 2)
    }
  })
})

// emitEAF → parseEAF round-trip

describe('EAF round-trip: emit → parse', () => {
  it('single participant: same number of utterances', () => {
    const { doc, store } = buildSingleSpeaker()
    const xml = emitEAF(doc, store)
    const result = parseEAF(xml)
    const out = result.doc as { content: Array<{ type: string }> }
    expect(out.content.filter(n => n.type === 'utterance')).toHaveLength(2)
  })

  it('two speakers: both participants survive', () => {
    const { doc, store } = buildTwoSpeakers()
    const xml = emitEAF(doc, store)
    const result = parseEAF(xml)
    const out = result.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    const participants = out.content.map(n => n.attrs['participant'])
    expect(participants).toContain('A')
    expect(participants).toContain('B')
  })

  it('store tier: annotation survives with time anchor', () => {
    const { doc, store } = buildWithStoreTier()
    const xml = emitEAF(doc, store)
    const result = parseEAF(xml)
    expect(result.annotations).toHaveLength(1)
    const timeAnchor = result.annotations[0]!.anchors.find(a => a.type === 'time')!
    expect(timeAnchor).toBeDefined()
    if (timeAnchor.type === 'time') {
      expect(timeAnchor.start).toBeCloseTo(0.5, 2)
      expect(timeAnchor.end).toBeCloseTo(1.0, 2)
    }
  })

  it('times survive ms rounding (within 1ms)', () => {
    const { doc, store } = buildSingleSpeaker()
    const xml = emitEAF(doc, store)
    const result = parseEAF(xml)
    const out = result.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    const first = out.content[0]!
    expect(Math.abs((first.attrs['startTimeSeconds'] as number) - 0.0)).toBeLessThan(0.001)
    expect(Math.abs((first.attrs['endTimeSeconds'] as number) - 1.8)).toBeLessThan(0.001)
  })

  it('arbitrary tiers: participant preserved after round-trip', () => {
    const { doc, store } = buildArbitraryTiers()
    const xml = emitEAF(doc, store)
    const result = parseEAF(xml)
    const out = result.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    const utterances = out.content.filter(n => n.type === 'utterance')
    expect(utterances).toHaveLength(3)
    const chiUtts = utterances.filter(n => n.attrs['participant'] === 'Child')
    const motUtts = utterances.filter(n => n.attrs['participant'] === 'Mother')
    expect(chiUtts).toHaveLength(2)
    expect(motUtts).toHaveLength(1)
  })

  it('arbitrary tiers: tier attr preserved after round-trip', () => {
    const { doc, store } = buildArbitraryTiers()
    const xml = emitEAF(doc, store)
    const result = parseEAF(xml)
    const out = result.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    const utterances = out.content.filter(n => n.type === 'utterance')
    const tiers = utterances.map(n => n.attrs['tier'])
    expect(tiers.filter(t => t === 'CHI')).toHaveLength(2)
    expect(tiers.filter(t => t === 'MOT')).toHaveLength(1)
  })

  it('double round-trip: emit → parse → emit → parse produces consistent results', () => {
    const { doc, store } = buildTwoSpeakers()
    const xml1 = emitEAF(doc, store)
    const r1 = parseEAF(xml1)

    const store2 = new AnnotationStore()
    store2.loadJSON({ annotations: r1.annotations, relations: [], tiers: r1.tiers })
    const xml2 = emitEAF(r1.doc as never, store2)
    const r2 = parseEAF(xml2)

    const out1 = r1.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    const out2 = r2.doc as { content: Array<{ type: string; attrs: Record<string, unknown> }> }
    expect(out2.content).toHaveLength(out1.content.length)
    for (let i = 0; i < out1.content.length; i++) {
      expect(out2.content[i]!.attrs['participant']).toBe(out1.content[i]!.attrs['participant'])
      expect(out2.content[i]!.attrs['startTimeSeconds']).toBeCloseTo(
        out1.content[i]!.attrs['startTimeSeconds'] as number, 2
      )
    }
  })
})

// emitEAF output structure

describe('emitEAF output', () => {
  it('produces valid XML declaration', () => {
    const { doc, store } = buildSingleSpeaker()
    const xml = emitEAF(doc, store)
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true)
  })

  it('contains TIME_ORDER block', () => {
    const { doc, store } = buildSingleSpeaker()
    const xml = emitEAF(doc, store)
    expect(xml).toContain('<TIME_ORDER>')
    expect(xml).toContain('<TIME_SLOT')
  })

  it('contains TIER elements', () => {
    const { doc, store } = buildTwoSpeakers()
    const xml = emitEAF(doc, store)
    expect(xml).toContain('TIER_ID="utterance:A"')
    expect(xml).toContain('TIER_ID="utterance:B"')
  })

  it('contains CONSTRAINT declarations', () => {
    const { doc, store } = buildSingleSpeaker()
    const xml = emitEAF(doc, store)
    expect(xml).toContain('STEREOTYPE="Symbolic_Association"')
    expect(xml).toContain('STEREOTYPE="Symbolic_Subdivision"')
  })

  it('isTemplate omits TIME_ORDER and annotations', () => {
    const { doc, store } = buildSingleSpeaker()
    const xml = emitEAF(doc, store, { isTemplate: true })
    expect(xml).not.toContain('<TIME_ORDER>')
    expect(xml).not.toContain('<ANNOTATION>')
  })

  it('custom tier names compose TIER_ID as base:participant', () => {
    const { xml } = buildArbitraryTiers()
    expect(xml).toContain('TIER_ID="CHI:Child"')
    expect(xml).toContain('TIER_ID="MOT:Mother"')
    expect(xml).not.toContain('TIER_ID="utterance:CHI"')
    expect(xml).not.toContain('TIER_ID="utterance:MOT"')
  })

  it('emits ELAN-loadable EAF: MIME_TYPE, LANGUAGE order, top-level LT alignable, parented SA tiers', () => {
    const store = new AnnotationStore()
    const metaLt   = store.addLinguisticType('transcription', {})
    const metaTier = store.addTier('@Comment', { linguisticTypeId: metaLt.id })
    store.addAnnotation('a note', [{ type: 'time', start: 0, end: 1 }], { tierId: metaTier.id })
    const saLt   = store.addLinguisticType('MWU', { constraint: 'symbolic_association' })
    const saTier = store.addTier('mwu:A', { linguisticTypeId: saLt.id, participant: 'A' })
    store.addAnnotation('multi', [], { tierId: saTier.id, blockNodeId: 'u1' })
    const doc = { type: 'doc', content: [{
      type: 'utterance',
      attrs: { id: 'u1', participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1 },
      content: [{ type: 'text', text: 'hi' }],
    }] }
    const xml = emitEAF(doc as never, store, { language: 'und', mediaUrl: 'file:///x.wav' })
    // MEDIA_DESCRIPTOR always carries the required MIME_TYPE
    expect(xml).toContain('MIME_TYPE="unknown"')
    // LANGUAGE must precede CONSTRAINT in the document sequence
    expect(xml.indexOf('<LANGUAGE')).toBeGreaterThan(0)
    expect(xml.indexOf('<LANGUAGE')).toBeLessThan(xml.indexOf('<CONSTRAINT'))
    // Unconstrained LTs type top-level tiers → must be TIME_ALIGNABLE
    expect(xml).toMatch(/LINGUISTIC_TYPE_ID="transcription" TIME_ALIGNABLE="true"/)
    // Parentless SA tier with a participant gets PARENT_REF to the utterance tier,
    // and its blockNodeId annotation is emitted as a REF to the utterance annotation
    expect(xml).toMatch(/TIER_ID="mwu:A" PARENT_REF="utterance:A"/)
    expect(xml).toContain('>multi<')
    validateEAF(xml)
  })

  it('skips the participant suffix when it equals the tier base (FA1, not FA1:FA1)', () => {
    const doc = { type: 'doc', content: [{
      type: 'utterance',
      attrs: { id: 'u1', tier: 'FA1', participant: 'FA1', startTimeSeconds: 0, endTimeSeconds: 1 },
      content: [{ type: 'text', text: 'hi' }],
    }] }
    const xml = emitEAF(doc as never, new AnnotationStore())
    expect(xml).toContain('TIER_ID="FA1"')
    expect(xml).not.toContain('FA1:FA1')
  })

  it('arbitrary tier names export PARTICIPANT attribute', () => {
    const { xml } = buildArbitraryTiers()
    expect(xml).toContain('PARTICIPANT="Child"')
    expect(xml).toContain('PARTICIPANT="Mother"')
  })
})

// XSD validation

describe('XSD validation (EAF 3.0)', () => {
  it('single participant output is valid', () => {
    const { doc, store } = buildSingleSpeaker()
    validateEAF(emitEAF(doc, store))
  })

  it('two speakers output is valid', () => {
    const { doc, store } = buildTwoSpeakers()
    validateEAF(emitEAF(doc, store))
  })

  it('store tier output is valid', () => {
    const { doc, store } = buildWithStoreTier()
    validateEAF(emitEAF(doc, store))
  })

  it('arbitrary tiers output is valid', () => {
    const { doc, store } = buildArbitraryTiers()
    validateEAF(emitEAF(doc, store))
  })

  const aclewFixture = join(fixturesDir, '011_42M_JOINT_C2_MIN1.ACLEW.eaf')
  it.skipIf(!existsSync(aclewFixture))('real ACLEW fixture file is valid', () => {
    validateEAF(readFileSync(aclewFixture, 'utf-8'))
  })
})
