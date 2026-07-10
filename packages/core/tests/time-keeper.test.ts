import { describe, it, expect, vi } from 'vitest'
import { TimeKeeper } from '../src/time-keeper.js'

describe('TimeKeeper', () => {
  it('fires onActiveChange when entering a block', () => {
    const tk = new TimeKeeper()
    tk.register('a', 1.0, 2.0)
    const cb = vi.fn()
    tk.onActiveChange(cb)
    tk.seek(1.5)
    expect(cb).toHaveBeenCalledWith(['a'], [])
  })

  it('fires onActiveChange when leaving a block', () => {
    const tk = new TimeKeeper()
    tk.register('a', 1.0, 2.0)
    const cb = vi.fn()
    tk.onActiveChange(cb)
    tk.seek(1.5)
    cb.mockClear()
    tk.seek(3.0)
    expect(cb).toHaveBeenCalledWith([], ['a'])
  })

  it('does not fire onActiveChange when active set is unchanged', () => {
    const tk = new TimeKeeper()
    tk.register('a', 1.0, 2.0)
    const cb = vi.fn()
    tk.onActiveChange(cb)
    tk.seek(1.5)
    cb.mockClear()
    tk.seek(1.8)
    expect(cb).not.toHaveBeenCalled()
  })

  it('clearRegistrations resets active set so next seek always fires', () => {
    // Regression: _syncTimeKeeperFromDoc calls clearRegistrations() before re-registering,
    // so the subsequent seek always produces a diff even if the same blocks are active.
    // This is what causes onActiveChange to fire after the onMount re-sync in App.svelte.
    const tk = new TimeKeeper()
    tk.register('a', 1.0, 2.0)
    tk.seek(1.5)  // activeIds = {a} — no listener yet (simulates module-init call)

    const cb = vi.fn()
    tk.onActiveChange(cb)

    // Simulate _syncTimeKeeperFromDoc: clear and re-register, then seek same time
    tk.clearRegistrations()
    tk.register('a', 1.0, 2.0)
    tk.seek(1.5)  // activeIds was cleared, so changed=true and cb fires

    expect(cb).toHaveBeenCalledWith(['a'], [])
  })

  it('clearRegistrations fires removed for previously-active IDs', () => {
    const tk = new TimeKeeper()
    tk.register('a', 1.0, 2.0)
    const cb = vi.fn()
    tk.onActiveChange(cb)
    tk.seek(1.5)
    cb.mockClear()

    tk.clearRegistrations()
    expect(cb).toHaveBeenCalledWith([], ['a'])
  })

  it('clears stale highlight when re-registered times no longer contain playhead', () => {
    // Regression: after a drag/sync the utterance moved past the playhead but stayed highlighted
    // because clearRegistrations() didn't notify listeners, so the subsequent seek saw an empty
    // activeIds baseline and produced no diff.
    const tk = new TimeKeeper()
    tk.register('a', 1.0, 3.0)
    const cb = vi.fn()
    tk.onActiveChange(cb)
    tk.seek(2.0)  // 'a' is active
    cb.mockClear()

    // Simulate _syncTimeKeeperFromDoc after utterance moved to [5, 7] — outside playhead
    tk.clearRegistrations()
    tk.register('a', 5.0, 7.0)
    tk.seek(2.0)

    // 'a' must appear in removed across all calls; must not end up in added
    const allAdded   = (cb.mock.calls as [string[], string[]][]).flatMap(([a]) => a)
    const allRemoved = (cb.mock.calls as [string[], string[]][]).flatMap(([, r]) => r)
    expect(allRemoved).toContain('a')
    expect(allAdded).not.toContain('a')
  })

  it('transitions correctly between blocks', () => {
    const tk = new TimeKeeper()
    tk.register('a', 0.0, 1.0)
    tk.register('b', 1.0, 2.0)
    const cb = vi.fn()
    tk.onActiveChange(cb)

    tk.seek(0.5)
    expect(cb).toHaveBeenLastCalledWith(['a'], [])

    cb.mockClear()
    tk.seek(1.5)
    expect(cb).toHaveBeenLastCalledWith(['b'], ['a'])
  })
})
