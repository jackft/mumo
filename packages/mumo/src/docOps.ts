/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type { ID, TokenRecord, AnnotationStore } from '@mumo/core'
import { USER_ORIGIN } from '@mumo/core'
import { Fragment } from 'prosemirror-model'
import type { Node } from 'prosemirror-model'

const round = (n: number) => +n.toFixed(3)

export type TokenTimeGetter = (id: string) => { start: number; end: number } | undefined
export type TokenTimeSetter = (id: string, start: number, end: number) => void

// Pure helpers

export function timeAnchor(start: number, end: number) {
  return { type: 'time' as const, start: +start.toFixed(3), end: +end.toFixed(3) }
}


export function formatGapDuration(seconds: number): string {
  const tenths = Math.round(seconds * 10) / 10
  return `(${tenths.toFixed(1)})`
}

// Insertion heuristic

/**
 * Assign times to new tokens based on their timed neighbors.
 * Gap → fill equally; contiguous → split combined span; edge → split against parent bounds.
 * Call inside store.transact().
 */
export function applyInsertionHeuristic(
  tokens: TokenRecord[],
  store: AnnotationStore,
  newIds: ReadonlySet<ID>,
  parentStart?: number | null,
  parentEnd?: number | null,
): void {
  const timed = tokens.filter(t => t.kind === 'word' || t.kind === 'gap')
  if (timed.length === 0) return

  const getTime = (tok: TokenRecord): { start: number | null; end: number | null} | undefined =>
    newIds.has(tok.id) ? undefined : store.getTokenTime(tok.id)

  let i = 0
  while (i < timed.length) {
    if (!newIds.has(timed[i]!.id)) { i++; continue }

    const runStart = i
    while (i < timed.length && newIds.has(timed[i]!.id)) i++
    const runEnd = i
    const runLen = runEnd - runStart

    const leftTok  = runStart > 0           ? timed[runStart - 1] : undefined
    const rightTok = runEnd   < timed.length ? timed[runEnd]       : undefined
    const leftTime  = leftTok  ? getTime(leftTok)  : undefined
    const rightTime = rightTok ? getTime(rightTok) : undefined

    let spanStart: number
    let spanEnd:   number
    let totalSlices: number
    let leftSlices  = 0
    let rightSlices = 0

    if (leftTime && rightTime && leftTime.end != null && rightTime.start != null) {
      const gap = rightTime.start - leftTime.end
      if (gap > 0.0005) {
        // Gap exists (deletion remnant or sparse timing): new tokens fill it
        spanStart   = leftTime.end
        spanEnd     = rightTime.start
        totalSlices = runLen
      } else {
        // Contiguous neighbors: split combined span among left + new + right
        if (leftTime.start == null || rightTime.end == null) continue
        spanStart   = leftTime.start
        spanEnd     = rightTime.end
        totalSlices = runLen + 2
        leftSlices  = 1
        rightSlices = 1
      }
    } else if (leftTime && leftTime.start != null && leftTime.end != null && parentEnd != null) {
      spanStart   = leftTime.end
      spanEnd     = parentEnd
      totalSlices = runLen
    } else if (rightTime && rightTime.end != null && rightTime.start != null && parentStart != null) {
      spanStart   = parentStart
      spanEnd     = rightTime.start
      totalSlices = runLen
    } else {
      continue
    }

    if (spanEnd - spanStart <= 0.0005) continue

    const sliceSize = (spanEnd - spanStart) / totalSlices
    const boundary = (k: number) =>
      k === 0 ? spanStart : k === totalSlices ? spanEnd : round(spanStart + k * sliceSize)

    if (leftSlices > 0 && leftTok && leftTime) {
      store.setTokenTime(leftTok.id, boundary(0), boundary(1))
    }
    for (let j = 0; j < runLen; j++) {
      store.setTokenTime(timed[runStart + j]!.id, boundary(leftSlices + j), boundary(leftSlices + j + 1))
    }
    if (rightSlices > 0 && rightTok && rightTime) {
      store.setTokenTime(rightTok.id, boundary(totalSlices - 1), boundary(totalSlices))
    }
  }
}

// Doc ordering & position queries

/** @public Doc position after the last block whose startTimeSeconds ≤ t. */
export function insertPosForTime(doc: Node, t: number): number {
  let pos = 0
  doc.forEach((node, offset) => {
    if ((node.attrs.startTimeSeconds ?? 0) <= t) pos = offset + node.nodeSize
  })
  return pos
}

/** @public Blocks sorted by startTimeSeconds (untimed last). Returns null if already correct. */
export function sortedByTime(doc: Node): Fragment | null {
  const nodes: Node[] = []
  doc.forEach((node: Node) => nodes.push(node))
  const sorted = [...nodes].sort((a, b) => {
    const at: number | null = a.attrs.startTimeSeconds
    const bt: number | null = b.attrs.startTimeSeconds
    if (at === null && bt === null) return 0
    if (at === null) return 1
    if (bt === null) return -1
    return at - bt
  })
  if (sorted.every((node, i) => node === nodes[i])) return null
  return Fragment.fromArray(sorted)
}

// Promoted-block healing

/**
 * Repair timing for a block that already has some tokens timed.
 * Pins first/last token to parent bounds; splits any gap between consecutive timed tokens.
 * Null-time tokens are left alone. Returns true if anything changed.
 */
export function healPromotedBlock(
  tokens: TokenRecord[],
  parentStart: number,
  parentEnd: number,
  getTime: TokenTimeGetter,
  setTime: TokenTimeSetter,
): boolean {
  const timed = tokens.filter(t => {
    if (t.kind !== 'word' && t.kind !== 'gap') return false
    const tt = getTime(t.id)
    if (!tt) return false
    return tt.start !== tt.end  // exclude sentinels (start === end marks an edge anchor, not a real span)
  })
  if (timed.length === 0) return false

  let changed = false

  const first = timed[0]!
  const last  = timed[timed.length - 1]!
  const firstTime = getTime(first.id)!
  const lastTime  = getTime(last.id)!

  if (Math.abs(firstTime.start - parentStart) > 0.0005) {
    setTime(first.id, parentStart, firstTime.end)
    changed = true
  }
  if (Math.abs(lastTime.end - parentEnd) > 0.0005) {
    setTime(last.id, lastTime.start, parentEnd)
    changed = true
  }

  for (let i = 0; i + 1 < timed.length; i++) {
    const leftTime  = getTime(timed[i]!.id)!
    const rightTime = getTime(timed[i + 1]!.id)!
    if (rightTime.start > leftTime.end + 0.0005) {
      const mid = round((leftTime.end + rightTime.start) / 2)
      setTime(timed[i]!.id,     leftTime.start, mid)
      setTime(timed[i + 1]!.id, mid, rightTime.end)
      changed = true
    }
  }

  return changed
}

/**
 * Calls healPromotedBlock for every timed utterance/event block in the doc.
 * Returns true if any tokens were updated.
 */
export function healPromotedBlocks(
  doc: Node,
  getBlockTokens: (id: string) => TokenRecord[],
  getTime: TokenTimeGetter,
  setTime: TokenTimeSetter,
): boolean {
  let changed = false
  doc.forEach((node) => {
    if (node.type.name !== 'utterance') return
    const blockId: string = node.attrs.id
    const parentStart: number | null = node.attrs.startTimeSeconds
    const parentEnd:   number | null = node.attrs.endTimeSeconds
    if (parentStart === null || parentEnd === null) return
    if (healPromotedBlock(getBlockTokens(blockId), parentStart, parentEnd, getTime, setTime)) changed = true
  })
  return changed
}

// Child annotation time propagation

/**
 * Recursively update child annotation times when a parent moves or resizes.
 * Reads directly from the store so incremental live-drag updates accumulate correctly.
 * time_subdivision children translate on move, scale on resize. symbolic_association
 * children have no stored anchor — just recurse.
 */
export function updateChildAnnotations(
  parentId: string,
  newStart: number,
  newEnd: number,
  origStart: number,
  origEnd: number,
  store: AnnotationStore,
): void {
  const origDur = origEnd - origStart
  const newDur  = newEnd  - newStart
  for (const child of store.childrenOf(parentId)) {
    const childTier = store.getTier(child.features.tierId as string)
    if (!childTier) continue

    if (store.resolveTierConstraint(childTier.id) === 'symbolic_association') {
      updateChildAnnotations(child.id, newStart, newEnd, origStart, origEnd, store)
      continue
    }

    const ta = child.anchors.find(a => a.type === 'time')
    if (!ta) continue

    const constraint = store.resolveTierConstraint(childTier.id)
    const isMoved = Math.abs(newDur - origDur) < 0.001
    let cs: number, ce: number

    if (isMoved) {
      const dt = newStart - origStart
      cs = ta.start + dt
      ce = ta.end + dt
    } else if (constraint === 'time_subdivision' && origDur > 0) {
      const rs = (ta.start - origStart) / origDur
      const re = (ta.end   - origStart) / origDur
      cs = newStart + rs * newDur
      ce = newStart + re * newDur
    } else if (constraint === 'included_in') {
      cs = Math.max(ta.start, newStart)
      ce = Math.min(ta.end,   newEnd)
      if (cs === ta.start && ce === ta.end) continue
      ce = Math.max(ce, cs + 0.05)
    } else {
      continue
    }

    store.updateAnnotation(child.id, {
      anchors: child.anchors.map(a => a.type === 'time' ? timeAnchor(cs, ce) : a),
    }, USER_ORIGIN, true)

    updateChildAnnotations(child.id, cs, ce, ta.start, ta.end, store)
  }
}
