import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { AnnotationStore, TokenStore, USER_ORIGIN, newId, docFromBlocks } from '@mumo/core'
import { healPromotedBlocks } from '../src/docOps.js'

// Helpers

function makeSetup(uttText: string, uttStart: number, uttEnd: number, uttId = newId()) {
  const ydoc  = new Y.Doc()
  const store = new AnnotationStore(ydoc)
  const ts    = new TokenStore()
  const undoManager = new Y.UndoManager(store.getYTypes(), {
    trackedOrigins: new Set([USER_ORIGIN]),
    captureTimeout: 0,  // one undo entry per transact call
  })
  const doc = docFromBlocks([{
    type: 'utterance' as const, participant: 'A',
    text: uttText, startTimeSeconds: uttStart, endTimeSeconds: uttEnd, id: uttId,
  }])
  ts.buildFromDoc(doc)
  return { store, ts, undoManager, doc, uttId }
}

// Basic undo correctness

describe('utterance drag undo: token times are restored', () => {
  it('restores two token times after undoing a drag', () => {
    const { store, ts, undoManager, uttId } = makeSetup('hello world', 0, 10)

    const words = ts.getUttTokens(uttId).filter(t => t.kind === 'word')
    const [hello, world] = words

    store.loadTokenTimes({
      [hello!.id]: { start: 0, end: 5 },
      [world!.id]: { start: 5, end: 10 },
    })

    // Simulate drag commit: utterance shifted from [0,10] → [5,15], tokens follow
    store.transact(() => {
      store.setTokenTime(hello!.id, 5, 10, USER_ORIGIN)
      store.setTokenTime(world!.id, 10, 15, USER_ORIGIN)
    })

    expect(store.getTokenTime(hello!.id)).toEqual({ start: 5,  end: 10 })
    expect(store.getTokenTime(world!.id)).toEqual({ start: 10, end: 15 })

    undoManager.undo()

    expect(store.getTokenTime(hello!.id)).toEqual({ start: 0, end: 5  })
    expect(store.getTokenTime(world!.id)).toEqual({ start: 5, end: 10 })
  })

  it('restores all tokens when the utterance has three words', () => {
    const { store, ts, undoManager, uttId } = makeSetup('one two three', 0, 9)

    const words = ts.getUttTokens(uttId).filter(t => t.kind === 'word')
    const [one, two, three] = words

    store.loadTokenTimes({
      [one!.id]:   { start: 0, end: 3 },
      [two!.id]:   { start: 3, end: 6 },
      [three!.id]: { start: 6, end: 9 },
    })

    store.transact(() => {
      store.setTokenTime(one!.id,   3, 6,  USER_ORIGIN)
      store.setTokenTime(two!.id,   6, 9,  USER_ORIGIN)
      store.setTokenTime(three!.id, 9, 12, USER_ORIGIN)
    })

    undoManager.undo()

    expect(store.getTokenTime(one!.id)).toEqual(  { start: 0, end: 3 })
    expect(store.getTokenTime(two!.id)).toEqual(  { start: 3, end: 6 })
    expect(store.getTokenTime(three!.id)).toEqual({ start: 6, end: 9 })
  })

  it('untimed tokens remain untimed after undo', () => {
    const { store, ts, undoManager, uttId } = makeSetup('hello world', 0, 10)

    const hello = ts.getUttTokens(uttId).find(t => t.text === 'hello')!
    const world = ts.getUttTokens(uttId).find(t => t.text === 'world')!

    // Only hello has a stored time; world is symbolic (no time)
    store.loadTokenTimes({ [hello.id]: { start: 0, end: 10 } })

    store.transact(() => {
      store.setTokenTime(hello.id, 5, 15, USER_ORIGIN)
    })

    undoManager.undo()

    expect(store.getTokenTime(hello.id)).toEqual({ start: 0, end: 10 })
    expect(store.getTokenTime(world.id)).toBeUndefined()
  })

  it('redo re-applies the drag after undo', () => {
    const { store, ts, undoManager, uttId } = makeSetup('hello world', 0, 10)

    const words = ts.getUttTokens(uttId).filter(t => t.kind === 'word')
    const [hello, world] = words

    store.loadTokenTimes({
      [hello!.id]: { start: 0, end: 5 },
      [world!.id]: { start: 5, end: 10 },
    })

    store.transact(() => {
      store.setTokenTime(hello!.id, 5, 10, USER_ORIGIN)
      store.setTokenTime(world!.id, 10, 15, USER_ORIGIN)
    })

    undoManager.undo()
    undoManager.redo()

    expect(store.getTokenTime(hello!.id)).toEqual({ start: 5,  end: 10 })
    expect(store.getTokenTime(world!.id)).toEqual({ start: 10, end: 15 })
  })
})

// Regression: healPromotedBlocks after undo must not corrupt token positions

describe('healPromotedBlocks after undo is idempotent', () => {
  it('heal is a no-op when tokens are correctly positioned after undo', () => {
    // Regression for the Phase 2 bug: heal used to expand token bounds to utterance
    // boundaries, overwriting correctly-restored positions with wrong values.
    const uttId = newId()
    const { store, ts, undoManager, doc } = makeSetup('hello world', 0, 10, uttId)

    const words = ts.getUttTokens(uttId).filter(t => t.kind === 'word')
    const [hello, world] = words

    store.loadTokenTimes({
      [hello!.id]: { start: 0, end: 5 },
      [world!.id]: { start: 5, end: 10 },
    })

    store.transact(() => {
      store.setTokenTime(hello!.id, 5, 10, USER_ORIGIN)
      store.setTokenTime(world!.id, 10, 15, USER_ORIGIN)
    })

    undoManager.undo()

    // Simulate handleDocChange firing without the _isUndoRedo guard:
    // heal runs on the original doc (utterance [0,10]) after tokens are restored.
    const changed = healPromotedBlocks(doc, id => ts.getUttTokens(id),
      id => { const t = store.getTokenTime(id); return (t?.start != null && t?.end != null) ? { start: t.start!, end: t.end! } : undefined },
      (id, s, e) => store.setTokenTime(id, s, e))

    expect(changed).toBe(false)
    expect(store.getTokenTime(hello!.id)).toEqual({ start: 0, end: 5  })
    expect(store.getTokenTime(world!.id)).toEqual({ start: 5, end: 10 })
  })

})
