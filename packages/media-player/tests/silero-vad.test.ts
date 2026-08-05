import { describe, it, expect } from 'vitest'
import { Resampler16k, segmentProbs } from '../src/plugins/signal/sileroVad.ts'
import { mergeVadSegments } from '../src/plugins/signal/vad.ts'
import { DEFAULT_VAD_SETTINGS } from '../src/types.ts'

// The full Silero path (ONNX + model fetch) can only run in the Electron/browser worker, so these
// tests cover the deterministic pieces: the streaming resampler and per-channel segment merging.

describe('Resampler16k streaming resampler', () => {
  function frameCount(nativeRate: number, seconds: number, chunk: number): { frames: number; total: number } {
    const r = new Resampler16k(nativeRate, 1536)
    const total = Math.round(nativeRate * seconds)
    let frames = 0
    for (let pos = 0; pos < total; pos += chunk) {
      const n = Math.min(chunk, total - pos)
      const buf = new Float32Array(n)
      for (let i = 0; i < n; i++) buf[i] = Math.sin((pos + i) * 0.01)
      frames += r.push(buf).length
    }
    return { frames, total }
  }

  it('produces ~duration*16000/1536 frames regardless of chunking (48k downsample)', () => {
    const seconds = 5
    const expected = Math.floor((seconds * 16000) / 1536)
    // Feeding in one big chunk vs many small chunks must yield the same frame count (streaming
    // must not lose or duplicate samples at chunk boundaries).
    const big = frameCount(48000, seconds, 48000 * seconds)
    const small = frameCount(48000, seconds, 511)
    const tiny = frameCount(48000, seconds, 97)
    expect(big.frames).toBe(small.frames)
    expect(big.frames).toBe(tiny.frames)
    expect(Math.abs(big.frames - expected)).toBeLessThanOrEqual(1)
  })

  it('handles 44.1k and 16k (no-op) rates', () => {
    const secs = 3
    const at441 = frameCount(44100, secs, 1000).frames
    const at16 = frameCount(16000, secs, 1000).frames
    expect(Math.abs(at441 - Math.floor((secs * 16000) / 1536))).toBeLessThanOrEqual(1)
    expect(Math.abs(at16 - Math.floor((secs * 16000) / 1536))).toBeLessThanOrEqual(1)
  })

  it('emits exactly frameSize-length frames', () => {
    const r = new Resampler16k(48000, 1536)
    const frames = r.push(new Float32Array(48000))  // 1s
    for (const f of frames) expect(f.length).toBe(1536)
    expect(frames.length).toBeGreaterThan(0)
  })

  it('preserves a constant signal through interpolation', () => {
    const r = new Resampler16k(48000, 1536)
    const input = new Float32Array(48000).fill(0.5)
    const frames = r.push(input)
    for (const f of frames) for (const v of f) expect(v).toBeCloseTo(0.5, 6)
  })
})

describe('segmentProbs (settings-driven re-segmentation)', () => {
  // 5 speech frames, 3 low frames, 5 speech frames. Frame = 96 ms.
  const probs = [0.9, 0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9, 0.9, 0.9, 0.9]

  it('short redemption splits on the gap; long redemption merges through it', () => {
    const split = segmentProbs(probs, { ...DEFAULT_VAD_SETTINGS, redemptionMs: 250, minSpeechMs: 150 })
    expect(split.length).toBe(2)

    const merged = segmentProbs(probs, { ...DEFAULT_VAD_SETTINGS, redemptionMs: 1400, minSpeechMs: 150 })
    expect(merged.length).toBe(1)
  })

  it('minSpeechMs discards bursts shorter than the threshold', () => {
    const brief = [0.9, 0.0, 0.0, 0.0, 0.0]  // one speech frame (~96 ms)
    expect(segmentProbs(brief, { ...DEFAULT_VAD_SETTINGS, redemptionMs: 250, minSpeechMs: 250 })).toEqual([])
    expect(segmentProbs(brief, { ...DEFAULT_VAD_SETTINGS, redemptionMs: 250, minSpeechMs: 90 }).length).toBe(1)
  })

  it('threshold controls whether mid-level probability counts as speech', () => {
    const mid = [0.45, 0.45, 0.45, 0.45, 0.0, 0.0, 0.0, 0.0]
    expect(segmentProbs(mid, { ...DEFAULT_VAD_SETTINGS, positiveThreshold: 0.3 }).length).toBe(1)
    expect(segmentProbs(mid, { ...DEFAULT_VAD_SETTINGS, positiveThreshold: 0.5 })).toEqual([])
  })

  it('returns empty for all-silence', () => {
    expect(segmentProbs([0, 0, 0, 0], DEFAULT_VAD_SETTINGS)).toEqual([])
  })

  it('ends at the last speech frame, not padded by the redemption window', () => {
    // 5 speech frames (0..4), then 10 silent frames. Frame = 96 ms.
    const probs = [0.9, 0.9, 0.9, 0.9, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    const [seg] = segmentProbs(probs, { ...DEFAULT_VAD_SETTINGS, redemptionMs: 250, minSpeechMs: 150 })
    expect(seg).toBeDefined()
    // End should be frame 5 (right after last speech frame 4) = 5 * 96 ms, NOT the redemption
    // expiry a few frames later.
    expect(seg!.end).toBeCloseTo((5 * 96) / 1000, 6)
    expect(seg!.start).toBeCloseTo(0, 6)
  })
})

describe('mergeVadSegments', () => {
  it('coalesces overlapping and near-touching segments across channels', () => {
    const merged = mergeVadSegments([
      [{ start: 0.0, end: 1.0 }, { start: 3.0, end: 4.0 }],
      [{ start: 0.9, end: 1.5 }, { start: 3.02, end: 3.5 }],  // 3.02 within 0.05 of 3.0..4.0
    ])
    expect(merged).toEqual([
      { start: 0.0, end: 1.5 },
      { start: 3.0, end: 4.0 },
    ])
  })

  it('keeps well-separated segments distinct and sorted', () => {
    const merged = mergeVadSegments([
      [{ start: 5.0, end: 6.0 }],
      [{ start: 0.0, end: 1.0 }],
    ])
    expect(merged).toEqual([
      { start: 0.0, end: 1.0 },
      { start: 5.0, end: 6.0 },
    ])
  })

  it('returns empty for no speech', () => {
    expect(mergeVadSegments([[], []])).toEqual([])
  })
})
