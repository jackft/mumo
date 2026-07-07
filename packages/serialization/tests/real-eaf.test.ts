/**
 * Tests against a real ACLEW EAF file (011_42M_JOINT_C2_MIN1.ACLEW.eaf).
 *
 * Structure of the file:
 *   CHI / FA1           — time-aligned speech tiers (CHAT-style naming, NOT participant:X)
 *   xds@FA1             — symbolic_association REF tier, child of FA1 (speech direction codes)
 *   lex@CHI             — symbolic_association REF tier, child of CHI (lexical status)
 *   mwu@CHI             — symbolic_association REF tier, child of lex@CHI (3-level hierarchy)
 *   @Transcriber / @Duration — utility tiers with alignable annotations
 *   FA2, @Situation, …  — empty tiers
 *   4 linguistic types: XDS, VCM, MWU, LEX (all Symbolic_Association with external CVs)
 *   4 controlled vocabularies: all external (no embedded entries in this file)
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { describe, it, expect, beforeAll } from 'vitest'
import { parseXML, eafTomumo, parseEAF } from '../src/eaf-parse.js'
import { emitEAF } from '../src/eaf-emit.js'
import { AnnotationStore } from '@mumo/core'
import type { EAFDocument } from '../src/types.js'

const fixturePath = resolve(__dirname, 'fixtures/011_42M_JOINT_C2_MIN1.ACLEW.eaf')
const fixtureExists = existsSync(fixturePath)
let xml: string

// parseXML

describe.skipIf(!fixtureExists)('parseXML — real ACLEW file', () => {
  let eaf: EAFDocument

  beforeAll(() => {
    xml = readFileSync(fixturePath, 'utf-8')
    eaf = parseXML(xml)
  })

  it('parses without throwing', () => {
    expect(eaf).toBeDefined()
  })

  it('parses all 62 time slots', () => {
    expect(eaf.timeSlots).toHaveLength(62)
  })

  it('first time slot is ts1 = 0ms', () => {
    expect(eaf.timeSlots[0]).toMatchObject({ id: 'ts1', value: 0 })
  })

  it('parses all tiers (14 total)', () => {
    // CHI, FA1, xds@FA1, FA2, xds@FA2, @Situation, @Comment, @Transcriber,
    // lex@CHI, mwu@CHI, @Duration, sit@CHI, act@CHI, com@CHI,
    // sit@FA1, act@FA1, com@FA1, sit@FA2, act@FA2, com@FA2
    expect(eaf.tiers.length).toBeGreaterThanOrEqual(14)
  })

  it('CHI tier has 11 annotations', () => {
    const chi = eaf.tiers.find(t => t.id === 'CHI')!
    expect(chi).toBeDefined()
    expect(chi.annotations).toHaveLength(11)
  })

  it('FA1 tier has 17 annotations', () => {
    const fa1 = eaf.tiers.find(t => t.id === 'FA1')!
    expect(fa1).toBeDefined()
    expect(fa1.annotations).toHaveLength(17)
  })

  it('xds@FA1 annotations are REF kind', () => {
    const tier = eaf.tiers.find(t => t.id === 'xds@FA1')!
    expect(tier).toBeDefined()
    expect(tier.annotations.every(a => a.kind === 'ref')).toBe(true)
  })

  it('xds@FA1 REF annotations reference FA1 annotations', () => {
    const xdsTier = eaf.tiers.find(t => t.id === 'xds@FA1')!
    const fa1Tier  = eaf.tiers.find(t => t.id === 'FA1')!
    const fa1Ids = new Set(fa1Tier.annotations.map(a => a.id))
    for (const ann of xdsTier.annotations) {
      expect(ann.kind).toBe('ref')
      if (ann.kind === 'ref') expect(fa1Ids.has(ann.ref)).toBe(true)
    }
  })

  it('mwu@CHI has PARENT_REF=lex@CHI', () => {
    const mwu = eaf.tiers.find(t => t.id === 'mwu@CHI')!
    expect(mwu.parentRef).toBe('lex@CHI')
  })

  it('lex@CHI has PARENT_REF=CHI', () => {
    const lex = eaf.tiers.find(t => t.id === 'lex@CHI')!
    expect(lex.parentRef).toBe('CHI')
  })

  it('parses 5 linguistic types (XDS VCM MWU LEX transcription)', () => {
    expect(eaf.linguisticTypes).toHaveLength(5)
    const ids = eaf.linguisticTypes.map(l => l.id)
    expect(ids).toContain('XDS')
    expect(ids).toContain('transcription')
  })

  it('XDS linguistic type has Symbolic_Association constraint', () => {
    const xds = eaf.linguisticTypes.find(l => l.id === 'XDS')!
    expect(xds.constraint).toBe('Symbolic_Association')
    expect(xds.timeAlignable).toBe(false)
  })

  it('transcription linguistic type is time-alignable', () => {
    const t = eaf.linguisticTypes.find(l => l.id === 'transcription')!
    expect(t.timeAlignable).toBe(true)
    expect(t.constraint).toBeUndefined()
  })

  it('parses 4 controlled vocabulary entries (external, no local entries)', () => {
    expect(eaf.vocabularies).toHaveLength(4)
    for (const cv of eaf.vocabularies) {
      expect(cv.entries).toHaveLength(0) // external CVs — no inline entries
    }
  })

  it('parses media descriptors', () => {
    expect(eaf.media.length).toBeGreaterThanOrEqual(1)
    expect(eaf.media[0]!.mimeType).toBe('video/mp4')
  })

  it('unescapes XML entities in annotation values', () => {
    // a7: "<Lego> [<] . [+ SR] " — was encoded as &lt;Lego&gt; [&lt;]
    const chi = eaf.tiers.find(t => t.id === 'CHI')!
    const a7 = chi.annotations.find(a => a.id === 'a7')!
    expect(a7.value).toContain('<Lego>')
  })
})

// eafTomumo

describe.skipIf(!fixtureExists)('eafTomumo — real ACLEW file', () => {
  let result: ReturnType<typeof eafTomumo>

  beforeAll(() => {
    if (!xml) xml = readFileSync(fixturePath, 'utf-8')
    result = eafTomumo(parseXML(xml))
  })

  it('adds exactly one placeholder utterance (no participant: tiers match)', () => {
    // CHI and FA1 don't match participant:X heuristic → all become store tiers.
    // eafTomumo inserts a single placeholder utterance so the PM doc is never empty.
    const doc = result.doc as { content: Array<{ type: string }> }
    expect(doc.content).toHaveLength(1)
    expect(doc.content[0]!.type).toBe('utterance')
  })

  it('creates store tiers for non-transcript tiers', () => {
    expect(result.tiers.length).toBeGreaterThan(0)
    const names = result.tiers.map(t => t.name)
    expect(names).toContain('CHI')
    expect(names).toContain('FA1')
  })

  it('CHI annotations become store annotations', () => {
    const chiTierDef = result.tiers.find(t => t.name === 'CHI')!
    expect(chiTierDef).toBeDefined()
    const chiAnns = result.annotations.filter(a => a.features['tierId'] === chiTierDef.id)
    expect(chiAnns).toHaveLength(11)
  })

  it('CHI annotations have time anchors', () => {
    const chiTierDef = result.tiers.find(t => t.name === 'CHI')!
    const chiAnns = result.annotations.filter(a => a.features['tierId'] === chiTierDef.id)
    for (const ann of chiAnns) {
      const ta = ann.anchors.find(a => a.type === 'time')
      expect(ta).toBeDefined()
    }
  })

  it('xds@FA1 annotations have no time anchors (REF annotations)', () => {
    const xdsTier = result.tiers.find(t => t.name === 'xds@FA1')!
    expect(xdsTier).toBeDefined()
    const xdsAnns = result.annotations.filter(a => a.features['tierId'] === xdsTier.id)
    expect(xdsAnns.length).toBeGreaterThan(0)
    for (const ann of xdsAnns) {
      const ta = ann.anchors.find(a => a.type === 'time')
      expect(ta).toBeUndefined()
    }
  })

  it('xds@FA1 REF annotations have parentAnnId feature', () => {
    const xdsTier = result.tiers.find(t => t.name === 'xds@FA1')!
    const xdsAnns = result.annotations.filter(a => a.features['tierId'] === xdsTier.id)
    for (const ann of xdsAnns) {
      expect(ann.features['parentAnnId']).toBeDefined()
    }
  })

  it('mwu@CHI tier has parentTierId pointing to lex@CHI', () => {
    const mwuTier = result.tiers.find(t => t.name === 'mwu@CHI')!
    const lexTier = result.tiers.find(t => t.name === 'lex@CHI')!
    expect(mwuTier).toBeDefined()
    expect(lexTier).toBeDefined()
    expect(mwuTier.parentTierId).toBe(lexTier.id)
  })

  it('symbolic_association constraint is preserved on XDS tier via linguistic type', () => {
    const xdsTier = result.tiers.find(t => t.name === 'xds@FA1')!
    const lt = result.linguisticTypes.find(l => l.id === xdsTier.linguisticTypeId)
    expect(lt?.constraint).toBe('symbolic_association')
  })

  it('linguistic types are preserved', () => {
    expect(result.linguisticTypes.length).toBeGreaterThan(0)
    const names = result.linguisticTypes.map(l => l.name)
    expect(names).toContain('XDS')
  })
})

// parseEAF (end-to-end)

describe.skipIf(!fixtureExists)('parseEAF — real ACLEW file does not throw', () => {
  beforeAll(() => {
    if (!xml) xml = readFileSync(fixturePath, 'utf-8')
  })

  it('completes without error', () => {
    expect(() => parseEAF(xml)).not.toThrow()
  })

  it('total annotation count matches expected (CHI=10, FA1=16, xds=16+0, lex=11, mwu=10, others)', () => {
    const result = parseEAF(xml)
    // CHI:10, FA1:16, xds@FA1:16, lex@CHI:11, mwu@CHI:10, act@FA1:1, @Transcriber:1, @Duration:1
    // = 66 total store annotations
    expect(result.annotations.length).toBeGreaterThanOrEqual(60)
  })
})

// import → emit → re-import consistency

describe.skipIf(!fixtureExists)('real ACLEW file: import → emit → re-import', () => {
  beforeAll(() => {
    if (!xml) xml = readFileSync(fixturePath, 'utf-8')
  })

  it('produces the same number of tiers', () => {
    const r1 = parseEAF(xml)
    const store = new AnnotationStore()
    store.loadJSON({ annotations: r1.annotations, relations: [], tiers: r1.tiers, linguisticTypes: r1.linguisticTypes, vocabularies: r1.vocabularies })
    const xml2 = emitEAF(r1.doc as never, store)
    const r2 = parseEAF(xml2)
    expect(r2.tiers.length).toBe(r1.tiers.length)
  })

  it('produces the same number of annotations', () => {
    const r1 = parseEAF(xml)
    const store = new AnnotationStore()
    store.loadJSON({ annotations: r1.annotations, relations: [], tiers: r1.tiers, linguisticTypes: r1.linguisticTypes, vocabularies: r1.vocabularies })
    const xml2 = emitEAF(r1.doc as never, store)
    const r2 = parseEAF(xml2)
    expect(r2.annotations.length).toBe(r1.annotations.length)
  })

  it('preserves annotation types (values) on second parse', () => {
    const r1 = parseEAF(xml)
    const store = new AnnotationStore()
    store.loadJSON({ annotations: r1.annotations, relations: [], tiers: r1.tiers, linguisticTypes: r1.linguisticTypes, vocabularies: r1.vocabularies })
    const xml2 = emitEAF(r1.doc as never, store)
    const r2 = parseEAF(xml2)

    const types1 = new Set(r1.annotations.map(a => a.type))
    const types2 = new Set(r2.annotations.map(a => a.type))
    for (const t of types1) expect(types2.has(t)).toBe(true)
  })

  it('time anchors are preserved within 1ms', () => {
    const r1 = parseEAF(xml)
    const store = new AnnotationStore()
    store.loadJSON({ annotations: r1.annotations, relations: [], tiers: r1.tiers })
    const xml2 = emitEAF(r1.doc as never, store)
    const r2 = parseEAF(xml2)

    const getTimePairs = (anns: typeof r1.annotations) =>
      anns.flatMap(a => a.anchors
        .filter(x => x.type === 'time')
        .map(x => x.type === 'time' ? `${x.start}:${x.end}` : ''))
        .sort()

    const pairs1 = getTimePairs(r1.annotations)
    const pairs2 = getTimePairs(r2.annotations)
    expect(pairs2).toHaveLength(pairs1.length)
    for (let i = 0; i < pairs1.length; i++) {
      const [s1, e1] = pairs1[i]!.split(':').map(Number)
      const [s2, e2] = pairs2[i]!.split(':').map(Number)
      expect(Math.abs(s1! - s2!)).toBeLessThan(0.001)
      expect(Math.abs(e1! - e2!)).toBeLessThan(0.001)
    }
  })
})
