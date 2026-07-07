import type { SnapPlugin } from './plugin.js'

// Snap to existing bar start/end boundaries (utterances and annotations only — not words/placeholders).
// Runs first so confirmed annotation positions take priority over acoustic cues.
export const barBoundarySnapPlugin: SnapPlugin = {
  kind: 'boundary',
  snap(t, radiusSec, ctx) {
    let best: number | null = null, bestDist = radiusSec
    for (const bar of ctx.bars) {
      if (bar.placeholder || bar.type === 'token') continue
      for (const boundary of [bar.start, bar.end]) {
        const d = Math.abs(boundary - t)
        if (d < bestDist) { best = boundary; bestDist = d }
      }
    }
    return best
  },
}

function lowerBound(arr: Float32Array, t: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]! < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

const vadSnapPlugin: SnapPlugin = {
  kind: 'vad',
  zones: ['vad'],
  snap(t, radiusSec, ctx) {
    if (ctx.vadSegments.length === 0) return null
    let best: number | null = null, bestDist = radiusSec
    for (const seg of ctx.vadSegments) {
      for (const boundary of [seg.start, seg.end]) {
        const d = Math.abs(boundary - t)
        if (d < bestDist) { best = boundary; bestDist = d }
      }
    }
    return best
  },
}

const onsetSnapPlugin: SnapPlugin = {
  kind: 'onset',
  snap(t, radiusSec, ctx) {
    let best: number | null = null, bestDist = radiusSec
    for (const ch of ctx.signals) {
      const zone = ctx.zone
      if (zone === 'spectrogram' && ch.kind !== 'spectrogram') continue
      if (zone === 'waveform'    && ch.kind !== 'waveform')    continue

      let onsets: Float32Array | undefined
      let strengths: Float32Array | undefined
      if (zone === 'spectrogram' && ctx.mouseFreqFraction != null && ch.bandOnsets && ch.bandOnsets.length > 0) {
        const bandIdx = Math.min(ch.bandOnsets.length - 1, Math.floor(ctx.mouseFreqFraction * ch.bandOnsets.length))
        onsets    = ch.bandOnsets[bandIdx]
        strengths = ch.bandOnsetStrengths?.[bandIdx]
      } else {
        onsets    = ch.onsets
        strengths = ch.onsetStrengths
      }

      if (!onsets || onsets.length === 0) continue
      const idx = lowerBound(onsets, t)
      for (let i = Math.max(0, idx - 1); i <= Math.min(onsets.length - 1, idx + 1); i++) {
        const candidate = onsets[i]!
        const strength = strengths ? (strengths[i] ?? 0.5) : 0.5
        const effectiveRadius = radiusSec * Math.max(0.4, strength)
        const d = Math.abs(candidate - t)
        if (d < effectiveRadius && d < bestDist) { best = candidate; bestDist = d }
      }
    }
    return best
  },
}

export const defaultSnapPlugins: SnapPlugin[] = [barBoundarySnapPlugin, vadSnapPlugin, onsetSnapPlugin]
