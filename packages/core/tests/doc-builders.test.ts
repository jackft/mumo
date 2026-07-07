import { describe, it, expect } from 'vitest'
import { docFromUtterances, docFromBlocks } from '../src/controller.js'

describe('docFromUtterances', () => {
  it('produces one utterance node per entry', () => {
    const doc = docFromUtterances([
      { participant: 'A', text: 'Hello.' },
      { participant: 'B', text: 'Hi.' },
    ])
    expect(doc.childCount).toBe(2)
    expect(doc.child(0).type.name).toBe('utterance')
    expect(doc.child(1).type.name).toBe('utterance')
  })

  it('sets participant attr', () => {
    const doc = docFromUtterances([{ participant: 'X', text: 'test' }])
    expect(doc.child(0).attrs.participant).toBe('X')
  })

  it('preserves text content verbatim', () => {
    const doc = docFromUtterances([{ participant: 'A', text: 'hello world.' }])
    expect(doc.child(0).textContent).toBe('hello world.')
  })

  it('preserves supplied id', () => {
    const doc = docFromUtterances([{ participant: 'A', text: 'hi', id: 'fixed-id' }])
    expect(doc.child(0).attrs.id).toBe('fixed-id')
  })

  it('assigns a fresh id when none supplied', () => {
    const doc = docFromUtterances([{ participant: 'A', text: 'hi' }])
    expect(typeof doc.child(0).attrs.id).toBe('string')
    expect((doc.child(0).attrs.id as string).length).toBeGreaterThan(0)
  })

  it('stores time attributes', () => {
    const doc = docFromUtterances([
      { participant: 'A', text: 'x', startTimeSeconds: 1.5, endTimeSeconds: 3.0 },
    ])
    expect(doc.child(0).attrs.startTimeSeconds).toBe(1.5)
    expect(doc.child(0).attrs.endTimeSeconds).toBe(3.0)
  })

  it('defaults time to null when not provided', () => {
    const doc = docFromUtterances([{ participant: 'A', text: 'x' }])
    expect(doc.child(0).attrs.startTimeSeconds).toBeNull()
    expect(doc.child(0).attrs.endTimeSeconds).toBeNull()
  })

  it('sorts by startTimeSeconds', () => {
    const doc = docFromUtterances([
      { participant: 'B', text: 'second', startTimeSeconds: 2.0 },
      { participant: 'A', text: 'first',  startTimeSeconds: 1.0 },
    ])
    expect(doc.child(0).attrs.participant).toBe('A')
    expect(doc.child(1).attrs.participant).toBe('B')
  })
})

describe('docFromBlocks', () => {
  it('sorts by startTimeSeconds', () => {
    const doc = docFromBlocks([
      { type: 'utterance', participant: 'B', text: 'second', startTimeSeconds: 2.0 },
      { type: 'utterance', participant: 'A', text: 'first',  startTimeSeconds: 0.5 },
    ])
    expect(doc.child(0).attrs.participant).toBe('A')
    expect(doc.child(1).attrs.participant).toBe('B')
  })

  it('unanchored blocks sort after timed blocks', () => {
    const doc = docFromBlocks([
      { type: 'utterance', participant: 'A', text: 'no time' },
      { type: 'utterance', participant: 'B', text: 'has time', startTimeSeconds: 1.0 },
    ])
    expect(doc.child(0).attrs.participant).toBe('B')
    expect(doc.child(1).attrs.participant).toBe('A')
  })
})
