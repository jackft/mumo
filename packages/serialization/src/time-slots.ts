/**
 * Time slot pool: deduplicates millisecond values and assigns TIME_SLOT_IDs.
 * EAF represents times as integer milliseconds; mumo uses float seconds.
 */

export class TimeSlotPool {
  private msToId = new Map<number, string>()
  private slots: Array<{ id: string; ms: number | null }> = []
  private counter = 0

  /** Get or create a TIME_SLOT_ID for a time in seconds. */
  id(seconds: number): string {
    const ms = Math.round(seconds * 1000)
    let slotId = this.msToId.get(ms)
    if (!slotId) {
      slotId = `ts${++this.counter}`
      this.msToId.set(ms, slotId)
      this.slots.push({ id: slotId, ms })
    }
    return slotId
  }

  /** Create a new TIME_SLOT with no TIME_VALUE (for unaligned tokens). */
  idNull(): string {
    const slotId = `ts${++this.counter}`
    this.slots.push({ id: slotId, ms: null })
    return slotId
  }

  /** All slots sorted by time value for the TIME_ORDER block. Null-value slots sort last. */
  sorted(): Array<{ id: string; ms: number | null }> {
    return [...this.slots].sort((a, b) => {
      if (a.ms === null && b.ms === null) return 0
      if (a.ms === null) return 1
      if (b.ms === null) return -1
      return a.ms - b.ms
    })
  }
}

/** Convert EAF time slot map (id → ms) to a seconds lookup. Slots without TIME_VALUE are omitted. */
export function buildTimeMap(slots: Array<{ id: string; value: number | null }>): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of slots) {
    if (s.value !== null) m.set(s.id, s.value / 1000)
  }
  return m
}
