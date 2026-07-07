import { TimeIntervalTree } from './interval-tree.js'

type SeekCallback = (t: number) => void
type ActiveChangeCallback = (added: string[], removed: string[]) => void

// Shared time source for Timeline and TranscriptEditor.
// Interval tree of block/utterance IDs; subscribers get O(log n) added/removed diffs on seek.
export class TimeKeeper {
  private tree = new TimeIntervalTree<string>()
  private registered = new Map<string, { start: number; end: number }>()

  private currentTime = 0
  private activeIds = new Set<string>()

  private seekListeners = new Set<SeekCallback>()
  private activeChangeListeners = new Set<ActiveChangeCallback>()

  // Registration

  register(id: string, start: number, end: number): void {
    const existing = this.registered.get(id)
    if (existing) {
      if (existing.start === start && existing.end === end) return
      this.tree.remove(existing.start, existing.end, id)
    }
    this.registered.set(id, { start, end })
    this.tree.insert(start, end, id)
  }

  unregister(id: string): void {
    const existing = this.registered.get(id)
    if (!existing) return
    this.tree.remove(existing.start, existing.end, id)
    this.registered.delete(id)
    this.activeIds.delete(id)
  }

  clearRegistrations(): void {
    this.tree.clear()
    this.registered.clear()
    this.activeIds.clear()
  }

  // Time control

  seek(t: number): void {
    this.currentTime = t

    for (const cb of this.seekListeners) cb(t)

    // Avoid allocating a new Set on every frame - diff against existing activeIds first.
    const results = this.tree.search(t, t)
    let changed = results.length !== this.activeIds.size
    if (!changed) {
      for (const id of results) { if (!this.activeIds.has(id)) { changed = true; break } }
    }
    if (!changed) return

    const added: string[] = []
    const removed: string[] = []
    const nowActive = new Set(results)
    for (const id of nowActive) { if (!this.activeIds.has(id)) added.push(id) }
    for (const id of this.activeIds) { if (!nowActive.has(id)) removed.push(id) }
    this.activeIds = nowActive
    for (const cb of this.activeChangeListeners) cb(added, removed)
  }

  getTime(): number {
    return this.currentTime
  }

  // Subscriptions

  onSeek(fn: SeekCallback): () => void {
    this.seekListeners.add(fn)
    return () => this.seekListeners.delete(fn)
  }

  onActiveChange(fn: ActiveChangeCallback): () => void {
    this.activeChangeListeners.add(fn)
    return () => this.activeChangeListeners.delete(fn)
  }
}
