import { describe, it, expect } from 'vitest'
import { docToTimeline } from '../src/docToTimeline.js'
import { docFromBlocks, createEmptyDoc, TokenStore, AnnotationStore, newId } from '@mumo/core'
import type { TierDef, Annotation, LinguisticType } from '@mumo/core'

// helpers

function makeTokenStore(doc: ReturnType<typeof docFromBlocks>) {
  const ts = new TokenStore()
  ts.buildFromDoc(doc)
  return ts
}

function barsIn(bars: ReturnType<typeof docToTimeline>['bars'], laneId: string) {
  return bars.filter(b => b.laneId === laneId)
}

// utterance bars

describe('utterance bars', () => {
  it('creates a timed utterance bar at the correct position', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'hello', startTimeSeconds: 1.0, endTimeSeconds: 3.0 }])
    const { bars } = docToTimeline(doc)
    const b = bars.find(b => b.type === 'utterance')!
    expect(b.start).toBe(1.0)
    expect(b.end).toBe(3.0)
    expect(b.placeholder).toBe(false)
    expect(b.laneId).toBe('utterance:A')
  })

  it('creates a placeholder bar for an untimed utterance starting at 0', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'hello' }])
    const { bars } = docToTimeline(doc)
    const b = bars.find(b => b.type === 'utterance')!
    expect(b.placeholder).toBe(true)
    expect(b.start).toBe(0)
    expect(b.end).toBe(1)
  })

  it('stacks untimed utterances sequentially using prevEnd', () => {
    const doc = docFromBlocks([
      { type: 'utterance', participant: 'A', text: 'first' },
      { type: 'utterance', participant: 'B', text: 'second' },
    ])
    const { bars } = docToTimeline(doc)
    const utts = bars.filter(b => b.type === 'utterance')
    expect(utts[0]!.start).toBe(0); expect(utts[0]!.end).toBe(1)
    expect(utts[1]!.start).toBe(1); expect(utts[1]!.end).toBe(2)
  })

  it('creates both a participant lane and a word lane', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'x', startTimeSeconds: 0, endTimeSeconds: 1 }])
    const { lanes } = docToTimeline(doc)
    const ids = lanes.map(l => l.id)
    expect(ids).toContain('utterance:A')
    expect(ids).toContain('tokens:utterance:A')
  })

  it('word lane appears after participant lane', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'x', startTimeSeconds: 0, endTimeSeconds: 1 }])
    const { lanes } = docToTimeline(doc)
    const ids = lanes.map(l => l.id)
    expect(ids.indexOf('tokens:utterance:A')).toBeGreaterThan(ids.indexOf('utterance:A'))
  })
})

// word / token bars

describe('word/token bars', () => {
  it('produces no word bars when tokenStore is absent', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'foo bar', startTimeSeconds: 0, endTimeSeconds: 2 }])
    expect(docToTimeline(doc).bars.filter(b => b.type === 'token')).toHaveLength(0)
  })

  it('distributes symbolic (null-time) tokens evenly across the parent span', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'foo bar', startTimeSeconds: 0, endTimeSeconds: 2 }])
    const ts = makeTokenStore(doc)
    const wBars = barsIn(docToTimeline(doc, [], [], ts).bars, 'tokens:utterance:A')
    expect(wBars).toHaveLength(2) // ws excluded
    expect(wBars[0]!.start).toBeCloseTo(0);  expect(wBars[0]!.end).toBeCloseTo(1)
    expect(wBars[1]!.start).toBeCloseTo(1);  expect(wBars[1]!.end).toBeCloseTo(2)
    expect(wBars[0]!.placeholder).toBe(true)
    expect(wBars[0]!.constraint).toBe('symbolic_subdivision')
  })

  it('uses assigned token times when promoted to time_subdivision', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'foo bar', startTimeSeconds: 0, endTimeSeconds: 2 }])
    const ts = makeTokenStore(doc)
    const annStore = new AnnotationStore()
    const blockId = doc.firstChild!.attrs.id as string
    const words = ts.getUttTokens(blockId).filter(t => t.kind === 'word')
    annStore.setTokenTime(words[0]!.id, 0, 0.7)
    annStore.setTokenTime(words[1]!.id, 0.7, 2.0)
    const { bars } = docToTimeline(doc, [], [], ts, [], new Map(), annStore)
    const foo = bars.find(b => b.label === 'foo')!
    const bar = bars.find(b => b.label === 'bar')!
    expect(foo.start).toBe(0);   expect(foo.end).toBe(0.7)
    expect(bar.start).toBe(0.7); expect(bar.end).toBe(2.0)
    expect(foo.placeholder).toBe(false)
    expect(foo.constraint).toBe('time_subdivision')
  })

  it('gap tokens appear as word bars at their assigned times', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'yeah (0.4) right', startTimeSeconds: 0, endTimeSeconds: 3 }])
    const ts = makeTokenStore(doc)
    const annStore = new AnnotationStore()
    const blockId = doc.firstChild!.attrs.id as string
    const gap = ts.getUttTokens(blockId).find(t => t.kind === 'gap')!
    annStore.setTokenTime(gap.id, 0.5, 0.9)
    const gapBar = docToTimeline(doc, [], [], ts, [], new Map(), annStore).bars.find(b => b.label === '(0.4)')!
    expect(gapBar).toBeDefined()
    expect(gapBar.start).toBe(0.5)
    expect(gapBar.end).toBe(0.9)
    expect(gapBar.constraint).toBe('time_subdivision')
  })

  it('whitespace tokens are excluded from word bars', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'a b c', startTimeSeconds: 0, endTimeSeconds: 3 }])
    const ts = makeTokenStore(doc)
    const wBars = barsIn(docToTimeline(doc, [], [], ts).bars, 'tokens:utterance:A')
    expect(wBars).toHaveLength(3) // a, b, c — no ws bars
    for (const b of wBars) expect(b.label.trim()).not.toBe('')
  })

  it('word bar parentNodeId links back to its utterance', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'hello', startTimeSeconds: 0, endTimeSeconds: 1 }])
    const ts = makeTokenStore(doc)
    const uttId = doc.firstChild!.attrs.id as string
    const tokenBar = docToTimeline(doc, [], [], ts).bars.find(b => b.type === 'token')!
    expect(tokenBar.parentNodeId).toBe(uttId)
  })
})

// annotation tiers

describe('annotation tiers', () => {
  it('places a time-anchored annotation at the correct position', () => {
    const doc = createEmptyDoc()
    const tierId = newId(), annId = newId()
    const tiers: TierDef[] = [{ id: tierId, name: 'coding' }]
    const annotations: Annotation[] = [{
      id: annId, type: 'overlap',
      anchors: [{ type: 'time', start: 1.0, end: 2.5 }],
      features: { tierId },
    }]
    const b = docToTimeline(doc, tiers, annotations).bars.find(b => b.nodeId === annId)!
    expect(b.start).toBe(1.0)
    expect(b.end).toBe(2.5)
    expect(b.laneId).toBe(`ann:${tierId}`)
  })

  it('symbolic_association annotation inherits timing from its word token', () => {
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'foo', startTimeSeconds: 0, endTimeSeconds: 1 }])
    const ts = makeTokenStore(doc)
    const annStore = new AnnotationStore()
    const blockId = doc.firstChild!.attrs.id as string
    const wordTok = ts.getUttTokens(blockId).find(t => t.kind === 'word')!
    annStore.setTokenTime(wordTok.id, 0.1, 0.9)

    const ltId = newId(), tierId = newId(), annId = newId()
    const linguisticTypes: LinguisticType[] = [{ id: ltId, name: 'pos', constraint: 'symbolic_association' }]
    const tiers: TierDef[] = [{ id: tierId, name: 'POS', linguisticTypeId: ltId }]
    const annotations: Annotation[] = [{
      id: annId, type: 'NN', anchors: [],
      features: { tierId, tokenNodeId: wordTok.id },
    }]
    const b = docToTimeline(doc, tiers, annotations, ts, linguisticTypes, new Map(), annStore).bars.find(b => b.nodeId === annId)!
    expect(b).toBeDefined()
    expect(b.start).toBe(0.1)
    expect(b.end).toBe(0.9)
  })

  it('symbolic_association annotation inherits timing from its parent annotation', () => {
    const doc = createEmptyDoc()
    const ltId = newId(), parentTierId = newId(), childTierId = newId()
    const parentAnnId = newId(), childAnnId = newId()
    const linguisticTypes: LinguisticType[] = [{ id: ltId, name: 'child-lt', constraint: 'symbolic_association' }]
    const tiers: TierDef[] = [
      { id: parentTierId, name: 'parent' },
      { id: childTierId,  name: 'child', parentTierId, linguisticTypeId: ltId },
    ]
    const annotations: Annotation[] = [
      { id: parentAnnId, type: 'A', anchors: [{ type: 'time', start: 2.0, end: 3.0 }], features: { tierId: parentTierId } },
      { id: childAnnId,  type: 'B', anchors: [], features: { tierId: childTierId, parentAnnId } },
    ]
    const child = docToTimeline(doc, tiers, annotations, undefined, linguisticTypes).bars.find(b => b.nodeId === childAnnId)!
    expect(child).toBeDefined()
    expect(child.start).toBe(2.0)
    expect(child.end).toBe(3.0)
  })

  it('annotation with no resolvable time is omitted from bars', () => {
    const doc = createEmptyDoc()
    const tierId = newId(), annId = newId()
    const tiers: TierDef[] = [{ id: tierId, name: 'coding' }]
    const annotations: Annotation[] = [{ id: annId, type: 'X', anchors: [], features: { tierId } }]
    expect(docToTimeline(doc, tiers, annotations).bars.find(b => b.nodeId === annId)).toBeUndefined()
  })
})

// TokenStore pool reuse (affects transcript → timeline sync)

describe('TokenStore pool reuse', () => {
  it('preserves token ID when block text is unchanged', () => {
    const blockId = newId()
    const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'hello', startTimeSeconds: 0, endTimeSeconds: 1, id: blockId }])
    const ts = makeTokenStore(doc)
    const annStore = new AnnotationStore()
    const orig = ts.getUttTokens(blockId).find(t => t.kind === 'word')!
    annStore.setTokenTime(orig.id, 0.1, 0.9)

    ts.rebuildBlockNode(doc.firstChild!)
    const after = ts.getUttTokens(blockId).find(t => t.kind === 'word')!
    expect(after.id).toBe(orig.id)
    expect(annStore.getTokenTime(after.id)?.start).toBe(0.1)
    expect(annStore.getTokenTime(after.id)?.end).toBe(0.9)
  })

  it('preserves ID when gap text changes (kind-only fallback)', () => {
    const blockId = newId()
    const doc1 = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'yeah (0.4) right', startTimeSeconds: 0, endTimeSeconds: 2, id: blockId }])
    const ts = makeTokenStore(doc1)
    const annStore = new AnnotationStore()
    const gap = ts.getUttTokens(blockId).find(t => t.kind === 'gap')!
    annStore.setTokenTime(gap.id, 0.3, 0.7)

    const doc2 = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'yeah (0.8) right', startTimeSeconds: 0, endTimeSeconds: 2, id: blockId }])
    ts.rebuildBlockNode(doc2.firstChild!)

    const newGap = ts.getUttTokens(blockId).find(t => t.kind === 'gap')!
    expect(newGap.id).toBe(gap.id)
    expect(newGap.text).toBe('(0.8)')
    expect(annStore.getTokenTime(newGap.id)?.start).toBe(0.3)
    expect(annStore.getTokenTime(newGap.id)?.end).toBe(0.7)
  })

  it('preserves ID when word text changes (typo correction)', () => {
    const blockId = newId()
    const doc1 = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'uh the red one', startTimeSeconds: 0, endTimeSeconds: 4, id: blockId }])
    const ts = makeTokenStore(doc1)
    const annStore = new AnnotationStore()
    const red = ts.getUttTokens(blockId).find(t => t.text === 'red')!
    annStore.setTokenTime(red.id, 2, 3)

    const doc2 = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'uh the read one', startTimeSeconds: 0, endTimeSeconds: 4, id: blockId }])
    ts.rebuildBlockNode(doc2.firstChild!)

    const read = ts.getUttTokens(blockId).find(t => t.text === 'read')!
    expect(read.id).toBe(red.id)
    expect(annStore.getTokenTime(read.id)?.start).toBe(2)
    expect(annStore.getTokenTime(read.id)?.end).toBe(3)
  })

  it('gap bar stays at its timed position after gap text edit', () => {
    const blockId = newId()
    const doc1 = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'yeah (0.4) right', startTimeSeconds: 0, endTimeSeconds: 2, id: blockId }])
    const ts = makeTokenStore(doc1)
    const annStore = new AnnotationStore()
    const gap = ts.getUttTokens(blockId).find(t => t.kind === 'gap')!
    annStore.setTokenTime(gap.id, 0.3, 0.7)

    const before = docToTimeline(doc1, [], [], ts, [], new Map(), annStore).bars.find(b => b.label === '(0.4)')!
    expect(before.start).toBe(0.3)
    expect(before.end).toBe(0.7)

    const doc2 = docFromBlocks([{ type: 'utterance', participant: 'A', text: 'yeah (0.8) right', startTimeSeconds: 0, endTimeSeconds: 2, id: blockId }])
    ts.rebuildBlockNode(doc2.firstChild!)

    // Gap keeps its time (kind-only fallback) — bar stays at same position, now showing new label
    const after = docToTimeline(doc2, [], [], ts, [], new Map(), annStore).bars.find(b => b.label === '(0.8)')!
    expect(after.start).toBe(0.3)
    expect(after.end).toBe(0.7)
    expect(after.placeholder).toBe(false)
    expect(after.constraint).toBe('time_subdivision')
  })
})
