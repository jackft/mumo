import _IntervalTree from 'node-interval-tree'

// Vite 8 / Rolldown CJS interop: with __esModule:true, the default import may be
// the full exports namespace object rather than exports.default itself.
type _IT<T> = { insert(l: number, h: number, d: T): void; search(l: number, h: number): T[]; remove(l: number, h: number, d: T): boolean }
const IntervalTree = ((_IntervalTree as { default?: unknown }).default ?? _IntervalTree) as new <T>() => _IT<T>

/** Time-keyed interval tree - insert/search/remove by [start, end] in seconds. */
export class TimeIntervalTree<T> {
  private tree = new IntervalTree<T>()

  insert(start: number, end: number, value: T): void {
    if (end > start) this.tree.insert(start, end, value)
  }

  search(start: number, end: number): T[] {
    return this.tree.search(start, end)
  }

  remove(start: number, end: number, value: T): boolean {
    return this.tree.remove(start, end, value)
  }

  clear(): void {
    this.tree = new IntervalTree<T>()
  }
}
