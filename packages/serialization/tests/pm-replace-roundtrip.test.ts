import { describe, it, expect } from 'vitest'
import { emitMMEAF, parseMMEAF } from '../src/index.js'
import { AnnotationStore, newId } from '@mumo/core'
import type { PMNodeJSON } from '../src/types.js'

describe('pm:replace suggestion roundtrip', () => {
  it('loads marks for a timed utterance', () => {
    const uttId = newId()
    const sugId = newId()
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

    const xml = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0].change.type).toBe('pm:replace')

    const uttContent = (result.doc as PMNodeJSON).content?.[0]?.content as PMNodeJSON[] | undefined
    const delNode = uttContent?.find(n => n.marks?.some(m => m.type === 'suggestion_delete'))
    const insNode = uttContent?.find(n => n.marks?.some(m => m.type === 'suggestion_insert'))
    expect(delNode?.text).toBe('hello')
    expect(insNode?.text).toBe('goodbye')
  })

  it('loads marks for an utterance starting at exactly 0ms', () => {
    // Regression: ms || '' (falsy) mishandled 0ms as untimed, breaking blockIdToFreshId lookup.
    const uttId = newId()
    const sugId = newId()
    const doc: PMNodeJSON = {
      type: 'doc',
      content: [{
        type: 'utterance',
        attrs: { id: uttId, participant: 'A', startTimeSeconds: 0, endTimeSeconds: 1 },
        content: [
          { type: 'text', text: 'say ' },
          { type: 'text', text: 'hello', marks: [{ type: 'suggestion_delete', attrs: { suggestionId: sugId, authorId: 'user:local' } }] },
          { type: 'text', text: 'goodbye', marks: [{ type: 'suggestion_insert', attrs: { suggestionId: sugId, authorId: 'user:local' } }] },
        ],
      }],
    }
    const store = new AnnotationStore()
    store.addSuggestion({ type: 'pm:replace', uttId, fromOffset: 4, toOffset: 9, replacement: 'goodbye' }, 'user:local', undefined, sugId)

    const xml = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const uttContent = (result.doc as PMNodeJSON).content?.[0]?.content as PMNodeJSON[] | undefined
    const delNode = uttContent?.find(n => n.marks?.some(m => m.type === 'suggestion_delete'))
    const insNode = uttContent?.find(n => n.marks?.some(m => m.type === 'suggestion_insert'))
    expect(delNode?.text).toBe('hello')
    expect(insNode?.text).toBe('goodbye')
  })

  it('loads marks when suggestion is on the second utterance of the same participant', () => {
    // Regression: baseBlockByKey (single-entry Map) discarded earlier utterances for the same
    // participant+startMs key. Sequential index matching within each key group fixes this.
    const utt1Id = newId()
    const utt2Id = newId()
    const sugId  = newId()
    const doc: PMNodeJSON = {
      type: 'doc',
      content: [
        {
          type: 'utterance',
          attrs: { id: utt1Id, participant: 'A', startTimeSeconds: 1.0, endTimeSeconds: 1.5 },
          content: [{ type: 'text', text: 'first utterance' }],
        },
        {
          type: 'utterance',
          attrs: { id: utt2Id, participant: 'A', startTimeSeconds: 2.0, endTimeSeconds: 2.5 },
          content: [
            { type: 'text', text: 'say ' },
            { type: 'text', text: 'hello', marks: [{ type: 'suggestion_delete', attrs: { suggestionId: sugId, authorId: 'user:local' } }] },
            { type: 'text', text: 'goodbye', marks: [{ type: 'suggestion_insert', attrs: { suggestionId: sugId, authorId: 'user:local' } }] },
          ],
        },
      ],
    }
    const store = new AnnotationStore()
    store.addSuggestion({ type: 'pm:replace', uttId: utt2Id, fromOffset: 4, toOffset: 9, replacement: 'goodbye' }, 'user:local', undefined, sugId)

    const xml = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const sug = result.suggestions[0]
    expect(sug.change.type).toBe('pm:replace')

    // Suggestion must refer to the second utterance
    const secondUtt = (result.doc as PMNodeJSON).content?.[1]
    if (sug.change.type === 'pm:replace') {
      expect(sug.change.uttId).toBe(secondUtt?.attrs?.id)
    }

    // Second utterance must have the suggestion marks
    const uttContent = secondUtt?.content as PMNodeJSON[] | undefined
    const delNode = uttContent?.find((n: PMNodeJSON) => n.marks?.some(m => m.type === 'suggestion_delete'))
    const insNode = uttContent?.find((n: PMNodeJSON) => n.marks?.some(m => m.type === 'suggestion_insert'))
    expect(delNode?.text).toBe('hello')
    expect(insNode?.text).toBe('goodbye')
  })

  it('loads pure-insert (no delete range) suggestion', () => {
    const uttId = newId()
    const sugId = newId()
    const doc: PMNodeJSON = {
      type: 'doc',
      content: [{
        type: 'utterance',
        attrs: { id: uttId, participant: 'A', startTimeSeconds: 1, endTimeSeconds: 2 },
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: ' world', marks: [{ type: 'suggestion_insert', attrs: { suggestionId: sugId, authorId: 'user:local' } }] },
        ],
      }],
    }
    const store = new AnnotationStore()
    store.addSuggestion({ type: 'pm:replace', uttId, fromOffset: 5, toOffset: 5, replacement: ' world' }, 'user:local', undefined, sugId)

    const xml = emitMMEAF(doc, store)
    const result = parseMMEAF(xml)

    expect(result.suggestions).toHaveLength(1)
    const uttContent = (result.doc as PMNodeJSON).content?.[0]?.content as PMNodeJSON[] | undefined
    const insNode = uttContent?.find(n => n.marks?.some(m => m.type === 'suggestion_insert'))
    expect(insNode?.text).toBe(' world')
  })
})
