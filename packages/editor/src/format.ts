let _currentDecimals = 1

export function formatTime(seconds: number | null, decimals = _currentDecimals): string {
  if (seconds === null) return '—'
  const factor = Math.pow(10, decimals)
  const abs = Math.round(Math.abs(seconds) * factor) / factor
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const s = abs % 60
  const intS = Math.floor(s)
  const pad = (n: number, w: number) => n.toString().padStart(w, '0')
  if (decimals === 0) return `${pad(h, 2)}:${pad(m, 2)}:${pad(intS, 2)}`
  const frac = (s - intS).toFixed(decimals).slice(1)
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(intS, 2)}${frac}`
}

interface TimeView { refresh(decimals: number): void }
const _registry = new Set<TimeView>()

export function registerTimeView(v: TimeView): void  { _registry.add(v) }
export function unregisterTimeView(v: TimeView): void { _registry.delete(v) }

export function getCurrentDecimals(): number { return _currentDecimals }

/** Parse a time string entered by the user into seconds.
 *  Accepts: "MM:SS.sss", "HH:MM:SS.sss", or plain "1.23" seconds. */
export function parseTimeInput(s: string): number | null {
  s = s.trim().replace('—', '')
  if (!s) return null
  const parts = s.split(':')
  if (parts.length >= 2) {
    const nums = parts.map(p => parseFloat(p.replace(',', '.')))
    if (nums.some(n => isNaN(n))) return null
    if (parts.length === 2) return nums[0]! * 60 + nums[1]!
    return nums[0]! * 3600 + nums[1]! * 60 + nums[2]!
  }
  const n = parseFloat(s.replace(',', '.'))
  return isNaN(n) ? null : n
}

export function refreshAllTimeViews(decimals: number): void {
  _currentDecimals = decimals
  for (const v of _registry) v.refresh(decimals)
}

export interface FormattingState {
  bold: boolean
  italic: boolean
  strike: boolean
  underline: boolean
  fontFamily: string
}
