import { describe, it, expect } from 'vitest'
import { IdMap } from '../src/id-map.js'

describe('IdMap', () => {
  it('assigns sequential eaf IDs starting at a1', () => {
    const m = new IdMap()
    expect(m.eafId('mumo-1')).toBe('a1')
    expect(m.eafId('mumo-2')).toBe('a2')
    expect(m.eafId('mumo-3')).toBe('a3')
  })

  it('returns the same eaf ID for the same mumo ID', () => {
    const m = new IdMap()
    const id = m.eafId('x')
    expect(m.eafId('x')).toBe(id)
  })

  it('mumoId reverses eafId', () => {
    const m = new IdMap()
    m.eafId('mumo-a')
    m.eafId('mumo-b')
    expect(m.mumoId('a1')).toBe('mumo-a')
    expect(m.mumoId('a2')).toBe('mumo-b')
  })

  it('mumoId returns undefined for unknown eaf ID', () => {
    const m = new IdMap()
    expect(m.mumoId('a99')).toBeUndefined()
  })

  it('register installs a mapping in both directions', () => {
    const m = new IdMap()
    m.register('a5', 'mumo-xyz')
    expect(m.mumoId('a5')).toBe('mumo-xyz')
    expect(m.eafId('mumo-xyz')).toBe('a5')
  })

  it('register does not affect the counter for new eafId calls', () => {
    const m = new IdMap()
    m.register('a5', 'mumo-xyz')
    expect(m.eafId('new-mumo')).toBe('a1')
  })
})
