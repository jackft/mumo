import type { VadSegment } from '../../types.ts'

export function computeEnergyVad(
  frameRMS: Float32Array,
  sampleRate: number,
  hop: number,
): VadSegment[] {
  const n = frameRMS.length
  const hopSec = hop / sampleRate

  const smoothFrames = Math.max(1, Math.round(0.020 * sampleRate / hop))
  const env = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0, cnt = 0
    for (let i = Math.max(0, f - smoothFrames); i <= Math.min(n - 1, f + smoothFrames); i++) {
      sum += frameRMS[i]!; cnt++
    }
    env[f] = sum / cnt
  }

  const sorted = Float32Array.from(env).sort()
  const noiseFloor = sorted[Math.floor(n * 0.10)]!
  const enterThresh = Math.max(noiseFloor * 8, 1e-4)
  const exitThresh  = Math.max(noiseFloor * 3, 5e-5)
  const minSilenceFrames = Math.max(1, Math.round(0.150 / hopSec))

  const segments: VadSegment[] = []
  let inSpeech = false, speechStart = 0, silenceCount = 0, speechCount = 0

  for (let f = 0; f < n; f++) {
    if (!inSpeech) {
      if (env[f]! >= enterThresh) {
        if (++speechCount >= 2) { inSpeech = true; speechStart = (f - 1) * hopSec; silenceCount = 0 }
      } else {
        speechCount = 0
      }
    } else {
      if (env[f]! < exitThresh) {
        if (++silenceCount >= minSilenceFrames) {
          const end = (f - silenceCount + 1) * hopSec
          if (end - speechStart >= 0.100) segments.push({ start: speechStart, end })
          inSpeech = false; speechCount = 0; silenceCount = 0
        }
      } else {
        silenceCount = 0
      }
    }
  }
  if (inSpeech) {
    const end = n * hopSec
    if (end - speechStart >= 0.100) segments.push({ start: speechStart, end })
  }
  return segments
}


/** Merge per-channel VAD segments into a single "is anyone speaking" timeline: sort by start
 *  and coalesce segments that touch or overlap (within 50 ms). Used by the Silero VAD plugin. */
export function mergeVadSegments(perChannel: VadSegment[][]): VadSegment[] {
  const all: VadSegment[] = []
  for (const segs of perChannel) all.push(...segs)
  all.sort((a, b) => a.start - b.start)
  const merged: VadSegment[] = []
  for (const seg of all) {
    const last = merged[merged.length - 1]
    if (last && seg.start <= last.end + 0.05) last.end = Math.max(last.end, seg.end)
    else merged.push({ ...seg })
  }
  return merged
}
