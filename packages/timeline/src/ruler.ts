const TICK_PRESETS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600,
]

const HZ_PRESETS = [50, 100, 200, 500, 1000, 2000, 2500, 4000, 5000, 8000, 10000, 20000]

export function pickHzInterval(pxPerHz: number, maxFreqHz: number): number {
  const candidates = HZ_PRESETS.filter(h => h < maxFreqHz)
  if (candidates.length === 0) return maxFreqHz
  // Find largest preset that fits within ~25px spacing (gives ~3-6 ticks for typical heights)
  const idealHz = 25 / pxPerHz
  return [...candidates].reverse().find(h => h <= idealHz) ?? candidates[0]!
}

export function formatHz(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`
}

// Sub-divisions per major interval.  Most intervals divide cleanly by 5;
// a few look better with a different count.
const SUB_COUNTS: Record<number, number> = {
  0.025: 5, 0.05: 5, 0.1: 5, 0.25: 5, 0.5: 5,
  1: 5, 2: 4, 5: 5, 10: 5, 30: 6,
  60: 4, 120: 4, 300: 5, 600: 6, 1800: 6, 3600: 4,
}

export function pickTickInterval(pxPerSecond: number): number {
  const idealSeconds = 80 / pxPerSecond
  return TICK_PRESETS.find(t => t >= idealSeconds) ?? 3600
}

/** Returns the sub-tick interval for a given major tick interval. */
export function pickSubInterval(interval: number): number {
  const n = SUB_COUNTS[interval] ?? 5
  return interval / n
}

export function formatRulerTime(seconds: number): string {
  if (seconds < 60) {
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(2)}s`
  }
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}
