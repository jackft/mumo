import { describe, it, expect } from 'vitest'
import { healPromotedBlock, healPromotedBlocks } from '../src/docOps.js'
import { docFromBlocks, TokenStore, AnnotationStore, newId } from '@mumo/core'
import type { TokenRecord } from '@mumo/core'

// helpers

interface TokenSpec extends Partial<TokenRecord> {
  startTimeSeconds?: number | null
  endTimeSeconds?: number | null
}

function makeStore(...recs: TokenSpec[]): { ts: TokenStore; store: AnnotationStore } {
  const store = new AnnotationStore()
  const ts = new TokenStore()
  const full: TokenRecord[] = recs.map((r, i) => ({
    id: r.id ?? newId(),
    uttId: r.uttId ?? 'utt1',
    kind: r.kind ?? 'word',
    text: r.text ?? `w${i}`,
    startOffset: r.startOffset ?? i,
    endOffset: r.endOffset ?? i + 1,
  }))
  ts.loadTokens(full)
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!
    const tok = full[i]!
    if (r.startTimeSeconds != null && r.endTimeSeconds != null) {
      store.setTokenTime(tok.id, r.startTimeSeconds, r.endTimeSeconds)
    }
  }
  return { ts, store }
}

function makeTimeFns(store: AnnotationStore) {
  const getTime = (id: string) => {
    const t = store.getTokenTime(id)
    if (!t || t.start == null || t.end == null) return undefined
    return { start: t.start, end: t.end }
  }
  const setTime = (id: string, start: number, end: number) => store.setTokenTime(id, start, end)
  return [getTime, setTime] as const
}

// healPromotedBlock

describe('healPromotedBlock', () => {
  it('does nothing for a non-promoted block (all null times)', () => {
    const { ts, store } = makeStore(
      { id: 'a', uttId: 'u', kind: 'word' },
      { id: 'b', uttId: 'u', kind: 'word' },
    )
    const changed = healPromotedBlock(ts.getUttTokens('u'), 0, 2, ...makeTimeFns(store))
    expect(changed).toBe(false)
    expect(store.getTokenTime('a')).toBeUndefined()
  })

  it('does nothing when all tokens are already tiled correctly', () => {
    const { ts, store } = makeStore(
      { id: 'a', uttId: 'u', kind: 'word', startTimeSeconds: 0, endTimeSeconds: 1 },
      { id: 'b', uttId: 'u', kind: 'word', startTimeSeconds: 1, endTimeSeconds: 2 },
    )
    const changed = healPromotedBlock(ts.getUttTokens('u'), 0, 2, ...makeTimeFns(store))
    expect(changed).toBe(false)
  })

  it('leaves null-time tokens untouched (symbolic per ELAN spec)', () => {
    const { ts, store } = makeStore(
      { id: 'a', uttId: 'u', kind: 'word', startTimeSeconds: 0, endTimeSeconds: 1 },
      { id: 'x', uttId: 'u', kind: 'word' },
      { id: 'b', uttId: 'u', kind: 'word', startTimeSeconds: 1, endTimeSeconds: 2 },
    )
    healPromotedBlock(ts.getUttTokens('u'), 0, 2, ...makeTimeFns(store))
    expect(store.getTokenTime('x')).toBeUndefined()
  })

  // Deletion gaps

  it('closes a deletion gap by splitting the difference', () => {
    // Before: A[0-1] B[1-2] C[2-3]; delete B → A[0-1] C[2-3], gap 1-2
    const { ts, store } = makeStore(
      { id: 'a', uttId: 'u', kind: 'word', startTimeSeconds: 0, endTimeSeconds: 1 },
      { id: 'c', uttId: 'u', kind: 'word', startTimeSeconds: 2, endTimeSeconds: 3 },
    )
    healPromotedBlock(ts.getUttTokens('u'), 0, 3, ...makeTimeFns(store))
    expect(store.getTokenTime('a')?.end).toBe(1.5)
    expect(store.getTokenTime('c')?.start).toBe(1.5)
  })

  it('closes two consecutive deletion gaps independently', () => {
    const { ts, store } = makeStore(
      { id: 'a', uttId: 'u', kind: 'word', startTimeSeconds: 0,   endTimeSeconds: 1 },
      { id: 'd', uttId: 'u', kind: 'word', startTimeSeconds: 2.5, endTimeSeconds: 3 },
    )
    healPromotedBlock(ts.getUttTokens('u'), 0, 3, ...makeTimeFns(store))
    // Gap 1–2.5 split: mid = 1.75
    expect(store.getTokenTime('a')?.end).toBe(1.75)
    expect(store.getTokenTime('d')?.start).toBe(1.75)
  })

  it('skips null-time tokens when closing deletion gaps between timed tokens', () => {
    // A[0-1] x[null] B[2-3] — gap between A and B should be split, x stays null
    const { ts, store } = makeStore(
      { id: 'a', uttId: 'u', kind: 'word', startTimeSeconds: 0, endTimeSeconds: 1 },
      { id: 'x', uttId: 'u', kind: 'word' },
      { id: 'b', uttId: 'u', kind: 'word', startTimeSeconds: 2, endTimeSeconds: 3 },
    )
    healPromotedBlock(ts.getUttTokens('u'), 0, 3, ...makeTimeFns(store))
    expect(store.getTokenTime('a')?.end).toBe(1.5)
    expect(store.getTokenTime('b')?.start).toBe(1.5)
    expect(store.getTokenTime('x')).toBeUndefined()
  })

  // Boundary pinning

  it('pins first timed token start to parentStart', () => {
    const { ts, store } = makeStore(
      { id: 'a', uttId: 'u', kind: 'word', startTimeSeconds: 0.1, endTimeSeconds: 1 },
      { id: 'b', uttId: 'u', kind: 'word', startTimeSeconds: 1,   endTimeSeconds: 2 },
    )
    healPromotedBlock(ts.getUttTokens('u'), 0, 2, ...makeTimeFns(store))
    expect(store.getTokenTime('a')?.start).toBe(0)
  })

  it('pins last timed token end to parentEnd', () => {
    const { ts, store } = makeStore(
      { id: 'a', uttId: 'u', kind: 'word', startTimeSeconds: 0, endTimeSeconds: 1 },
      { id: 'b', uttId: 'u', kind: 'word', startTimeSeconds: 1, endTimeSeconds: 1.9 },
    )
    healPromotedBlock(ts.getUttTokens('u'), 0, 2, ...makeTimeFns(store))
    expect(store.getTokenTime('b')?.end).toBe(2)
  })

  it('pins first timed token even when preceding null-time tokens exist', () => {
    // x[null] A[0.1-1] — A should be pinned to parentStart=0
    const { ts, store } = makeStore(
      { id: 'x', uttId: 'u', kind: 'word' },
      { id: 'a', uttId: 'u', kind: 'word', startTimeSeconds: 0.1, endTimeSeconds: 1 },
    )
    healPromotedBlock(ts.getUttTokens('u'), 0, 1, ...makeTimeFns(store))
    expect(store.getTokenTime('a')?.start).toBe(0)
    expect(store.getTokenTime('x')).toBeUndefined()
  })

  it('pins last timed token even when trailing null-time tokens exist', () => {
    // A[0-1.9] x[null] — A should be pinned to parentEnd=2
    const { ts, store } = makeStore(
      { id: 'a', uttId: 'u', kind: 'word', startTimeSeconds: 0, endTimeSeconds: 1.9 },
      { id: 'x', uttId: 'u', kind: 'word' },
    )
    healPromotedBlock(ts.getUttTokens('u'), 0, 2, ...makeTimeFns(store))
    expect(store.getTokenTime('a')?.end).toBe(2)
    expect(store.getTokenTime('x')).toBeUndefined()
  })
})

// healPromotedBlocks

describe('healPromotedBlocks', () => {
  it('skips untimed (non-promoted) blocks', () => {
    const blockId = newId()
    const doc = docFromBlocks([{
      type: 'utterance', participant: 'A',
      text: 'hello world',
      startTimeSeconds: 0, endTimeSeconds: 2,
      id: blockId,
    }])
    const ts = new TokenStore()
    ts.buildFromDoc(doc)
    const annStore = new AnnotationStore()

    const changed = healPromotedBlocks(doc, id => ts.getUttTokens(id), ...makeTimeFns(annStore))
    expect(changed).toBe(false)
    for (const tok of ts.getUttTokens(blockId)) {
      expect(annStore.getTokenTime(tok.id)).toBeUndefined()
    }
  })

  it('closes deletion gap across all promoted blocks in the doc', () => {
    const blockId = newId()
    const doc = docFromBlocks([{
      type: 'utterance', participant: 'A',
      text: 'one three',
      startTimeSeconds: 0, endTimeSeconds: 3,
      id: blockId,
    }])
    const ts = new TokenStore()
    ts.buildFromDoc(doc)
    const annStore = new AnnotationStore()

    const [oneTok, , threeTok] = ts.getUttTokens(blockId) // one ws three
    annStore.setTokenTime(oneTok!.id, 0, 1)
    annStore.setTokenTime(threeTok!.id, 2, 3)

    healPromotedBlocks(doc, id => ts.getUttTokens(id), ...makeTimeFns(annStore))
    expect(annStore.getTokenTime(oneTok!.id)?.end).toBe(1.5)
    expect(annStore.getTokenTime(threeTok!.id)?.start).toBe(1.5)
  })

  it('deletion: removing a token causes neighbours to split the difference', () => {
    const blockId = newId()
    const doc1 = docFromBlocks([{
      type: 'utterance', participant: 'A',
      text: 'one two three',
      startTimeSeconds: 0, endTimeSeconds: 3,
      id: blockId,
    }])
    const ts = new TokenStore()
    ts.buildFromDoc(doc1)
    const annStore = new AnnotationStore()

    const [oneTok, , twoTok, , threeTok] = ts.getUttTokens(blockId)
    annStore.setTokenTime(oneTok!.id, 0, 1)
    annStore.setTokenTime(twoTok!.id, 1, 2)
    annStore.setTokenTime(threeTok!.id, 2, 3)

    // Delete 'two' from the transcript
    const doc2 = docFromBlocks([{
      type: 'utterance', participant: 'A',
      text: 'one three',
      startTimeSeconds: 0, endTimeSeconds: 3,
      id: blockId,
    }])
    ts.rebuildBlockNode(doc2.firstChild!)

    healPromotedBlocks(doc2, id => ts.getUttTokens(id), ...makeTimeFns(annStore))
    const one   = ts.getUttTokens(blockId).find(t => t.text === 'one')!
    const three = ts.getUttTokens(blockId).find(t => t.text === 'three')!
    // Gap [1-2] split: one extends to 1.5, three starts at 1.5
    expect(annStore.getTokenTime(one.id)?.end).toBe(1.5)
    expect(annStore.getTokenTime(three.id)?.start).toBe(1.5)
  })

  it('no overlap after deleting a middle token from a fully-timed block', () => {
    // Regression: deleting a token from the transcript should close the gap,
    // not leave overlapping or gapped neighbours.
    const blockId = newId()
    const doc1 = docFromBlocks([{
      type: 'utterance', participant: 'A',
      text: 'one two three four five',
      startTimeSeconds: 0, endTimeSeconds: 5,
      id: blockId,
    }])
    const ts = new TokenStore()
    ts.buildFromDoc(doc1)
    const annStore = new AnnotationStore()

    const words = ts.getUttTokens(blockId).filter(t => t.kind === 'word')
    // Assign contiguous 1s slots: one[0-1] two[1-2] three[2-3] four[3-4] five[4-5]
    words.forEach((w, i) => annStore.setTokenTime(w.id, i, i + 1))

    // Delete 'three' from the transcript
    const doc2 = docFromBlocks([{
      type: 'utterance', participant: 'A',
      text: 'one two four five',
      startTimeSeconds: 0, endTimeSeconds: 5,
      id: blockId,
    }])
    ts.rebuildBlockNode(doc2.firstChild!)
    healPromotedBlocks(doc2, id => ts.getUttTokens(id), ...makeTimeFns(annStore))

    const timed = ts.getUttTokens(blockId)
      .filter(t => (t.kind === 'word' || t.kind === 'gap') && annStore.getTokenTime(t.id) != null)
      .sort((a, b) => annStore.getTokenTime(a.id)!.start! - annStore.getTokenTime(b.id)!.start!)

    // No two adjacent timed tokens should overlap
    for (let i = 0; i + 1 < timed.length; i++) {
      expect(annStore.getTokenTime(timed[i]!.id)!.end!).toBeLessThanOrEqual(
        annStore.getTokenTime(timed[i + 1]!.id)!.start!
      )
    }
    // They should tile the full parent span with no gaps
    expect(annStore.getTokenTime(timed[0]!.id)?.start).toBe(0)
    expect(annStore.getTokenTime(timed[timed.length - 1]!.id)?.end).toBe(5)
    for (let i = 0; i + 1 < timed.length; i++) {
      expect(annStore.getTokenTime(timed[i]!.id)!.end).toBeCloseTo(
        annStore.getTokenTime(timed[i + 1]!.id)!.start!, 3
      )
    }
  })

  it('no overlap after gap resize: rebuildBlockNode temporarily resets sibling before correction', () => {
    // Regression: when a gap is resized from the timeline, the app:
    //   1. mutates gap.text in-place
    //   2. calls setTokenTime(gap, newStart, newEnd)
    //   3. calls rebuildBlockNode — pool reuses gap by new text, but sibling reverts to OLD time
    //   4. calls setTokenTime(sibling, correctedStart, correctedEnd)
    //   5. calls healPromotedBlocks (150ms debounce)
    // After step 3, gap and sibling overlap. Step 4 corrects. Step 5 must not re-introduce a gap.
    const blockId = newId()
    const doc1 = docFromBlocks([{
      type: 'utterance', participant: 'A',
      text: 'hello (0.3) world',
      startTimeSeconds: 0, endTimeSeconds: 2,
      id: blockId,
    }])
    const ts = new TokenStore()
    ts.buildFromDoc(doc1)
    const annStore = new AnnotationStore()

    const [helloTok, , gapTok, , worldTok] = ts.getUttTokens(blockId) // hello ws (0.3) ws world
    annStore.setTokenTime(helloTok!.id, 0, 1)
    annStore.setTokenTime(gapTok!.id,   1, 1.3)
    annStore.setTokenTime(worldTok!.id, 1.3, 2)

    // Simulate app: user drags gap right edge from 1.3 → 1.5
    // Step 1: mutate gap text in-place (app does tok.text = newText)
    const gapRec = ts.getToken(gapTok!.id)!
    gapRec.text = '(0.5)'
    // Step 2: update gap time
    annStore.setTokenTime(gapTok!.id, 1, 1.5)
    // Step 3: rebuildBlockNode fires (triggered by _updateGapTextInDoc PM dispatch)
    // Pool now has gap:(0.5) → gapId[1-1.5], world:world → worldId[1.3-2] (OLD time in annStore)
    const doc2 = docFromBlocks([{
      type: 'utterance', participant: 'A',
      text: 'hello (0.5) world',
      startTimeSeconds: 0, endTimeSeconds: 2,
      id: blockId,
    }])
    ts.rebuildBlockNode(doc2.firstChild!)
    // At this point: gap=[1-1.5], world=[1.3-2] in annStore — overlap!

    // Step 4: sibling onUpdateBar corrects world's time
    annStore.setTokenTime(worldTok!.id, 1.5, 2)
    // Step 5: healPromotedBlocks (150ms debounce)
    healPromotedBlocks(doc2, id => ts.getUttTokens(id), ...makeTimeFns(annStore))

    const gap   = ts.getUttTokens(blockId).find(t => t.kind === 'gap')!
    const world = ts.getUttTokens(blockId).find(t => t.text === 'world')!
    // Gap should stay at the dragged position, world should start where gap ends
    expect(annStore.getTokenTime(gap.id)?.start).toBe(1)
    expect(annStore.getTokenTime(gap.id)?.end).toBe(1.5)
    expect(annStore.getTokenTime(world.id)?.start).toBe(1.5)
    expect(annStore.getTokenTime(world.id)?.end).toBe(2)
  })

  it('null-time tokens added by typing remain null (symbolic)', () => {
    const blockId = newId()
    const doc1 = docFromBlocks([{
      type: 'utterance', participant: 'A',
      text: 'the sat',
      startTimeSeconds: 0, endTimeSeconds: 3,
      id: blockId,
    }])
    const ts = new TokenStore()
    ts.buildFromDoc(doc1)
    const annStore = new AnnotationStore()

    const [theTok, , satTok] = ts.getUttTokens(blockId)
    annStore.setTokenTime(theTok!.id, 0, 1)
    annStore.setTokenTime(satTok!.id, 2, 3)

    // User types a new word 'dog' between them
    const doc2 = docFromBlocks([{
      type: 'utterance', participant: 'A',
      text: 'the dog sat',
      startTimeSeconds: 0, endTimeSeconds: 3,
      id: blockId,
    }])
    ts.rebuildBlockNode(doc2.firstChild!)

    healPromotedBlocks(doc2, id => ts.getUttTokens(id), ...makeTimeFns(annStore))
    const dog = ts.getUttTokens(blockId).find(t => t.text === 'dog')!
    // dog was typed new — no time; heal closes the gap between 'the' and 'sat'
    expect(annStore.getTokenTime(dog.id)).toBeUndefined()
    expect(annStore.getTokenTime(theTok!.id)?.end).toBe(1.5)
    expect(annStore.getTokenTime(satTok!.id)?.start).toBe(1.5)
  })
})
