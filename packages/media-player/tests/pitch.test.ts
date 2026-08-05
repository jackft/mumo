import { describe, it, expect } from 'vitest'
import { ContinuousResampler16k } from '../src/plugins/signal/pitch.ts'

// The YIN plugin itself needs the Rust/WASM SampleBuffer (browser/worker only); here we cover the
// pure streaming resampler that feeds it. It must produce a continuous 16 kHz stream whose result
// is identical regardless of how the input is chunked.

function runChunked(nativeRate: number, totalSamples: number, chunk: number): Float32Array {
  const r = new ContinuousResampler16k(nativeRate)
  const out: number[] = []
  for (let pos = 0; pos < totalSamples; pos += chunk) {
    const n = Math.min(chunk, totalSamples - pos)
    const buf = new Float32Array(n)
    for (let i = 0; i < n; i++) buf[i] = Math.sin((pos + i) * 0.02)
    for (const v of r.push(buf)) out.push(v)
  }
  return Float32Array.from(out)
}

describe('ContinuousResampler16k', () => {
  it('produces ~ duration * 16000 output samples (48k downsample)', () => {
    const seconds = 2
    const out = runChunked(48000, 48000 * seconds, 48000 * seconds)
    expect(Math.abs(out.length - 16000 * seconds)).toBeLessThanOrEqual(1)
  })

  it('is chunking-invariant (big vs small vs tiny chunks give identical output)', () => {
    const total = 48000  // 1 s
    const big = runChunked(48000, total, total)
    const small = runChunked(48000, total, 1000)
    const tiny = runChunked(48000, total, 333)
    expect(small.length).toBe(big.length)
    expect(tiny.length).toBe(big.length)
    for (let i = 0; i < big.length; i++) {
      expect(small[i]).toBeCloseTo(big[i]!, 6)
      expect(tiny[i]).toBeCloseTo(big[i]!, 6)
    }
  })

  it('preserves a constant signal', () => {
    const r = new ContinuousResampler16k(44100)
    const out = r.push(new Float32Array(44100).fill(0.5))
    expect(out.length).toBeGreaterThan(0)
    for (const v of out) expect(v).toBeCloseTo(0.5, 6)
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(2)
  })
})
