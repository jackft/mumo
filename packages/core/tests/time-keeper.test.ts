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
