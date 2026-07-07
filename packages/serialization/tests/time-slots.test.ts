import { describe, it, expect } from 'vitest'
import { TimeSlotPool, buildTimeMap } from '../src/time-slots.js'

describe('TimeSlotPool', () => {
  it('assigns sequential IDs starting at ts1', () => {
    const pool = new TimeSlotPool()
    expect(pool.id(0.0)).toBe('ts1')
    expect(pool.id(1.0)).toBe('ts2')
    expect(pool.id(2.5)).toBe('ts3')
  })

  it('deduplicates identical millisecond values', () => {
    const pool = new TimeSlotPool()
    const a = pool.id(1.0)
    const b = pool.id(1.0)
    expect(a).toBe(b)
  })

  it('deduplicates values that round to the same millisecond', () => {
    const pool = new TimeSlotPool()
    const a = pool.id(1.0004)   // rounds to 1000ms
    const b = pool.id(1.0005)   // rounds to 1001ms (different)
    const c = pool.id(1.0004)   // same as first
    expect(a).toBe(c)
    expect(a).not.toBe(b)
  })

  it('sorted returns slots in ascending ms order', () => {
    const pool = new TimeSlotPool()
    pool.id(3.0)
    pool.id(1.0)
    pool.id(2.0)
    const sorted = pool.sorted()
    expect(sorted.map(s => s.ms)).toEqual([1000, 2000, 3000])
  })

  it('sorted includes all unique slots', () => {
    const pool = new TimeSlotPool()
    pool.id(0.5)
    pool.id(0.5) // duplicate
    pool.id(1.5)
    expect(pool.sorted()).toHaveLength(2)
  })

  it('handles zero and fractional seconds', () => {
    const pool = new TimeSlotPool()
    const id = pool.id(0.0)
    const sorted = pool.sorted()
    expect(sorted[0]).toMatchObject({ id, ms: 0 })
  })
})

describe('buildTimeMap', () => {
  it('maps slot id to seconds', () => {
    const m = buildTimeMap([
      { id: 'ts1', value: 0 },
      { id: 'ts2', value: 1500 },
    ])
    expect(m.get('ts1')).toBe(0)
    expect(m.get('ts2')).toBe(1.5)
  })

  it('returns empty map for empty input', () => {
    expect(buildTimeMap([])).toEqual(new Map())
  })

  it('converts milliseconds to seconds correctly', () => {
    const m = buildTimeMap([{ id: 'ts1', value: 750 }])
    expect(m.get('ts1')).toBeCloseTo(0.75, 5)
  })
})
