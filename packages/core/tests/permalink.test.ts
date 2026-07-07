import { describe, it, expect } from 'vitest'
import { buildPermalink, parsePermalink, docKeyForPath } from '../src/permalink.js'

describe('buildPermalink', () => {
  it('builds a doc link with ref and time', () => {
    expect(buildPermalink({ kind: 'doc', docKey: 'session-01', ref: { type: 'utt', id: 'u1' }, t: 12.5 }))
      .toBe('doc/session-01/utt/u1?t=12.500')
  })
  it('builds a plain span link', () => {
    expect(buildPermalink({ kind: 'doc', docKey: 'a b', t: 0 })).toBe('doc/a%20b?t=0.000')
  })
  it('builds collection links', () => {
    expect(buildPermalink({ kind: 'collection', id: 3 })).toBe('collection/3')
    expect(buildPermalink({ kind: 'collection' })).toBe('collection')
  })
})

describe('parsePermalink', () => {
  const target = { kind: 'doc', docKey: 'session-01', ref: { type: 'utt', id: 'u1' }, t: 12.5 }

  it('parses the bare main part', () => {
    expect(parsePermalink('doc/session-01/utt/u1?t=12.500')).toEqual(target)
  })
  it('parses mumo:// links', () => {
    expect(parsePermalink('mumo://doc/session-01/utt/u1?t=12.500')).toEqual(target)
  })
  it('parses hosted https links with arbitrary prefixes', () => {
    expect(parsePermalink('https://lab.example.org/mumo/app/doc/session-01/utt/u1?t=12.500')).toEqual(target)
  })
  it('round-trips build → parse', () => {
    const t = { kind: 'doc' as const, docKey: 'my file', ref: { type: 'ann' as const, id: 'a/9' }, t: 3 }
    expect(parsePermalink('mumo://' + buildPermalink(t))).toEqual(t)
  })
  it('parses doc links without ref or time', () => {
    expect(parsePermalink('doc/session-01')).toEqual({ kind: 'doc', docKey: 'session-01' })
  })
  it('parses collection links', () => {
    expect(parsePermalink('mumo://collection/7')).toEqual({ kind: 'collection', id: 7 })
    expect(parsePermalink('https://x.org/collections')).toEqual({ kind: 'collection' })
  })
  it('ignores unknown ref types but keeps the doc', () => {
    expect(parsePermalink('doc/s1/bogus/x?t=1')).toEqual({ kind: 'doc', docKey: 's1', t: 1 })
  })
  it('rejects junk', () => {
    expect(parsePermalink('')).toBeNull()
    expect(parsePermalink('https://example.org/nothing/here')).toBeNull()
    expect(parsePermalink('random text')).toBeNull()
  })
})

describe('docKeyForPath', () => {
  it('strips directories and extension', () => {
    expect(docKeyForPath('/home/x/corpus/session-01.mumo')).toBe('session-01')
    expect(docKeyForPath('C:\\data\\s2.MUMO')).toBe('s2')
  })
})
