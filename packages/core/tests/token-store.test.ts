import { describe, it, expect } from 'vitest'
import { TokenStore } from '../src/token-store.js'
import { docFromUtterances } from '../src/controller.js'
import type { Node } from 'prosemirror-model'
import type { TokenRecord } from '../src/types.js'

/**
 * Token identity engine tests: which IDs survive which edits.
 * Each case builds an utterance with `before` text, applies the edit by
 * rebuilding with `after` text, and checks ID survival expectations.
 */

const UTT_ID = 'utt-1'

function makeDoc(text: string): Node {
  return docFromUtterances([{ participant: 'A', text, id: UTT_ID }])
}

function words(tokens: TokenRecord[]): TokenRecord[] {
  return tokens.filter(t => t.kind === 'word')
}

function idOf(store: TokenStore, text: string): string {
  const tok = store.getUttTokens(UTT_ID).find(t => t.text === text)
  expect(tok, `token "${text}" not found`).toBeDefined()
  return tok!.id
}

describe('TokenStore identity', () => {
  it('assigns IDs on initial build', () => {
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('the cat sat'))
    expect(words(store.getUttTokens(UTT_ID)).map(t => t.text)).toEqual(['the', 'cat', 'sat'])
  })

  it('keeps all IDs on an unchanged rebuild', () => {
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('the cat sat'))
    const before = store.getUttTokens(UTT_ID).map(t => t.id)
    const result = store.buildFromDoc(makeDoc('the cat sat'))
    expect(store.getUttTokens(UTT_ID).map(t => t.id)).toEqual(before)
    expect(result.newIds.size).toBe(0)
    expect(result.removedIds.size).toBe(0)
  })

  it('keeps the ID when a word is retyped in place (red → read)', () => {
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('the red hat'))
    const redId = idOf(store, 'red')
    store.rebuildBlockNode(makeDoc('the read hat').child(0))
    expect(idOf(store, 'read')).toBe(redId)
  })

  it('keeps IDs of unchanged words when a word is inserted before them', () => {
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('the cat sat'))
    const catId = idOf(store, 'cat')
    const satId = idOf(store, 'sat')
    const result = store.rebuildBlockNode(makeDoc('so the cat sat').child(0))
    expect(idOf(store, 'cat')).toBe(catId)
    expect(idOf(store, 'sat')).toBe(satId)
    expect(result.newIds.size).toBeGreaterThan(0) // "so" (+ws) is new
  })

  it('does NOT migrate a deleted word ID to an unrelated new word elsewhere', () => {
    // "the cat sat" → "the sat dog": cat is deleted, dog is new. dog must not
    // inherit cat's ID — that would silently re-target cat's annotations.
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('the cat sat'))
    const catId = idOf(store, 'cat')
    const satId = idOf(store, 'sat')
    const result = store.buildFromDoc(makeDoc('the sat dog'))
    expect(idOf(store, 'sat')).toBe(satId)      // exact match survives
    expect(idOf(store, 'dog')).not.toBe(catId)  // no cross-position migration
    expect(result.removedIds.has(catId)).toBe(true)
  })

  it('transfers the ID when a word is replaced in place (select + type over)', () => {
    // "the cat sat" → "the dog sat" in one rebuild: dog occupies cat's exact
    // range, so it inherits the token identity.
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('the cat sat'))
    const catId = idOf(store, 'cat')
    store.rebuildBlockNode(makeDoc('the dog sat').child(0))
    expect(idOf(store, 'dog')).toBe(catId)
  })

  it('aligns duplicate words in document order', () => {
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('the cat the dog'))
    const tokens = words(store.getUttTokens(UTT_ID))
    const firstThe = tokens[0]!.id
    const secondThe = tokens[2]!.id
    store.rebuildBlockNode(makeDoc('the cat the dog too').child(0))
    const after = words(store.getUttTokens(UTT_ID))
    expect(after[0]!.id).toBe(firstThe)
    expect(after[2]!.id).toBe(secondThe)
  })

  it('restores original IDs after delete + undo (deleted pool)', () => {
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('the cat sat'))
    const catId = idOf(store, 'cat')
    // User deletes "cat " (single-block edit path)
    store.rebuildBlockNode(makeDoc('the sat').child(0))
    expect(store.getUttTokens(UTT_ID).some(t => t.id === catId)).toBe(false)
    // Undo restores the text; undo path runs a full buildFromDoc
    store.buildFromDoc(makeDoc('the cat sat'))
    expect(idOf(store, 'cat')).toBe(catId)
  })

  it('reports shrunkBlocks when a word is removed from a block', () => {
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('the cat sat'))
    const result = store.rebuildBlockNode(makeDoc('the sat').child(0))
    expect(result.shrunkBlocks.has(UTT_ID)).toBe(true)
  })

  it('handles punctuation and gaps as distinct token kinds', () => {
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('well, (0.4) okay.'))
    const kinds = store.getUttTokens(UTT_ID).map(t => t.kind)
    expect(kinds).toEqual(['word', 'punct', 'ws', 'gap', 'ws', 'word', 'punct'])
  })

  it('never reuses one ID for two tokens in the same rebuild', () => {
    const store = new TokenStore()
    store.buildFromDoc(makeDoc('aa bb cc'))
    store.buildFromDoc(makeDoc('aa aa bb bb cc cc'))
    const ids = store.getUttTokens(UTT_ID).map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
