import { describe, it, expect } from 'vitest'
import { tokenizeString } from '../src/tokenize.js'

describe('tokenizeString', () => {
  it('splits words and whitespace', () => {
    expect(tokenizeString('hello world')).toEqual([
      { kind: 'word', text: 'hello' },
      { kind: 'ws',   text: ' ' },
      { kind: 'word', text: 'world' },
    ])
  })

  it('handles punctuation as separate tokens', () => {
    expect(tokenizeString('hello, world.')).toEqual([
      { kind: 'word',  text: 'hello' },
      { kind: 'punct', text: ',' },
      { kind: 'ws',    text: ' ' },
      { kind: 'word',  text: 'world' },
      { kind: 'punct', text: '.' },
    ])
  })

  it('parses action tokens {text}', () => {
    expect(tokenizeString('{nods}')).toEqual([
      { kind: 'action', text: '{nods}' },
    ])
  })

  it('parses gap tokens (N.Ns)', () => {
    expect(tokenizeString('(0.4s)')).toEqual([
      { kind: 'gap', text: '(0.4s)' },
    ])
  })

  it('parses gap without unit', () => {
    expect(tokenizeString('(0.4)')).toEqual([
      { kind: 'gap', text: '(0.4)' },
    ])
  })

  it('parses ellipsis as single punct', () => {
    expect(tokenizeString('well...')).toEqual([
      { kind: 'word',  text: 'well' },
      { kind: 'punct', text: '...' },
    ])
  })

  it('preserves apostrophes inside words', () => {
    expect(tokenizeString("don't")).toEqual([
      { kind: 'word', text: "don't" },
    ])
  })

  it('handles mixed content', () => {
    const tokens = tokenizeString('The uh (0.4s) {looks up} yeah.')
    expect(tokens.map(t => t.kind)).toEqual([
      'word', 'ws', 'word', 'ws', 'gap', 'ws', 'action', 'ws', 'word', 'punct',
    ])
  })

  it('returns empty array for empty string', () => {
    expect(tokenizeString('')).toEqual([])
  })
})
