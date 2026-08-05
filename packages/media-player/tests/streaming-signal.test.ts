import { describe, it, expect } from 'vitest'
import { spectrogramPlugin, specFrameParams } from '../src/plugins/signal/spectrogram.ts'
import { waveformPlugin } from '../src/plugins/signal/waveform.ts'
import { SegmentProducer } from '../src/segmenter.ts'
import { DEFAULT_SPEC_SETTINGS } from '../src/types.ts'
import type { SignalPlugin } from '../src/plugins/signal/SignalPlugin.ts'
import type { WorkerResponse } from '../src/types.ts'

// The worker decodes the file in ~90 s segments so full-file PCM is never resident. These tests
// drive the streaming plugins through SegmentProducer at different segment sizes and assert the
// segmented output is byte-identical to the whole-file (single-segment) output. WASM never loads
// in node, so this exercises the JS fallback path.

const TILE_FRAMES = 2048

interface Collected {
  tiles: Map<string, Uint8Array>       // `${ch}:${tileIndex}` -> rawDb
  tileDims: Map<string, [number, number]>
  tileTimeEnd: Map<string, number>
  overview: Map<number, Uint8Array>
  overviewMeta: Map<number, { width: number; timeEnd: number }>
  waveform: Map<number, { peakPos: Float32Array; peakNeg: Float32Array; rms: Float32Array; binCount: number }>
  lastProgress: { done: number; total: number } | null
}

/** Build a deterministic, per-channel-distinct signal with a slow amplitude envelope. */
function makeSignal(channelCount: number, totalSamples: number, sampleRate: number): Float32Array[] {
  return Array.from({ length: channelCount }, (_, ch) => {
    const s = new Float32Array(totalSamples)
    const f0 = 220 + ch * 110
    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t + ch)
      s[i] = env * (0.6 * Math.sin(2 * Math.PI * f0 * t) + 0.3 * Math.sin(2 * Math.PI * f0 * 2.5 * t + 1))
    }
    return s
  })
}

/** Run a plugin over the signal, cutting into segments of `segFrames` frames, collecting posts. */
async function run(
  plugin: SignalPlugin, signal: Float32Array[], sampleRate: number,
  totalFrames: number, hop: number, windowSize: number, segFrames: number, durationSec: number,
): Promise<Collected> {
  const channelCount = signal.length
  const out: Collected = { tiles: new Map(), tileDims: new Map(), tileTimeEnd: new Map(), overview: new Map(), overviewMeta: new Map(), waveform: new Map(), lastProgress: null }
  const post = (msg: WorkerResponse): void => {
    if (msg.type === 'spectrogramTile') {
      const key = `${msg.channelIndex}:${msg.tile.tileIndex}`
      out.tiles.set(key, msg.tile.rawDb as Uint8Array)
      out.tileDims.set(key, [msg.tile.width, msg.tile.height])
      out.tileTimeEnd.set(key, msg.tile.timeEnd)
    } else if (msg.type === 'spectrogramOverview') {
      out.overview.set(msg.channelIndex, msg.tile.rawDb as Uint8Array)
      out.overviewMeta.set(msg.channelIndex, { width: msg.tile.width, timeEnd: msg.tile.timeEnd })
    } else if (msg.type === 'waveform') {
      out.waveform.set(msg.channelIndex, { peakPos: msg.bins.peakPos, peakNeg: msg.bins.peakNeg, rms: msg.bins.rms, binCount: msg.bins.binCount })
    } else if (msg.type === 'progress') {
      out.lastProgress = { done: msg.done, total: msg.total }
    }
  }

  const runInst = plugin.createRun(
    { sampleRate, channelCount, durationSec, settings: DEFAULT_SPEC_SETTINGS, pluginSettings: {}, trigger: 'analyze' }, post,
  )
  const producer = new SegmentProducer(channelCount, hop, windowSize, segFrames, totalFrames)

  // Feed decoded PCM in small irregular chunks, draining ready segments as we go.
  let pos = 0
  const chunkSizes = [1000, 1500, 777, 2048, 333]
  let ci = 0
  const total = signal[0]!.length
  const drain = async (final: boolean): Promise<void> => {
    let seg
    while ((seg = producer.tryCut(final)) !== null) await runInst.pushSegment(seg)
  }
  while (pos < total) {
    const n = Math.min(chunkSizes[ci++ % chunkSizes.length]!, total - pos)
    const perCh = signal.map(ch => ch.subarray(pos, pos + n))
    producer.add(perCh.map(a => Float32Array.from(a)), n)
    pos += n
    await drain(false)
  }
  await drain(true)
  await runInst.finish()
  return out
}

function expectUint8Equal(a: Uint8Array, b: Uint8Array, label: string): void {
  expect(a.length, `${label} length`).toBe(b.length)
  // Fast path: find first mismatch for a useful message.
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { expect.fail(`${label} differs at ${i}: ${a[i]} vs ${b[i]}`) }
  }
}

function expectFloatEqual(a: Float32Array, b: Float32Array, label: string): void {
  expect(a.length, `${label} length`).toBe(b.length)
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { expect.fail(`${label} differs at ${i}: ${a[i]} vs ${b[i]}`) }
  }
}

describe('streaming signal analysis is segmentation-invariant', () => {
  const sampleRate = 16000
  const channelCount = 2
  const { hop, windowSize } = specFrameParams(DEFAULT_SPEC_SETTINGS, sampleRate)

  // Size the signal to span several tiles so multi-segment cuts land on real tile boundaries.
  const targetFrames = TILE_FRAMES * 3 + 137   // not a tile multiple -> exercises a short final tile
  const totalSamples = (targetFrames - 1) * hop + windowSize + 91  // +91: partial trailing frame
  const durationSec = totalSamples / sampleRate
  const totalFrames = Math.max(1, Math.floor((totalSamples - windowSize) / hop) + 1)

  const signal = makeSignal(channelCount, totalSamples, sampleRate)

  it('sanity: spans multiple tiles', () => {
    expect(totalFrames).toBeGreaterThan(TILE_FRAMES * 3)
  })

  it('spectrogram tiles + overview match across segment sizes', { timeout: 60000 }, async () => {
    const whole = await run(spectrogramPlugin, signal, sampleRate, totalFrames, hop, windowSize, totalFrames, durationSec)
    const oneTile = await run(spectrogramPlugin, signal, sampleRate, totalFrames, hop, windowSize, TILE_FRAMES, durationSec)
    const twoTile = await run(spectrogramPlugin, signal, sampleRate, totalFrames, hop, windowSize, TILE_FRAMES * 2, durationSec)

    for (const [label, segmented] of [['1-tile', oneTile], ['2-tile', twoTile]] as const) {
      expect(segmented.tiles.size, `${label} tile count`).toBe(whole.tiles.size)
      for (const [key, rawDb] of whole.tiles) {
        const other = segmented.tiles.get(key)
        expect(other, `${label} missing tile ${key}`).toBeDefined()
        expect(segmented.tileDims.get(key), `${label} dims ${key}`).toEqual(whole.tileDims.get(key))
        expectUint8Equal(other!, rawDb, `${label} tile ${key}`)
      }
      for (const [ch, ov] of whole.overview) {
        expectUint8Equal(segmented.overview.get(ch)!, ov, `${label} overview ch${ch}`)
      }
    }
  })

  it('overview extent + progress reconcile to actual frames when duration is over-reported', { timeout: 60000 }, async () => {
    // Simulate a container that reports 40% more audio than it actually decodes (the condition
    // that previously stretched the overview and pinned progress below 100%).
    const inflatedDuration = durationSec * 1.4
    const inflatedSamples = Math.round(inflatedDuration * sampleRate)
    const inflatedFrames = Math.max(1, Math.floor((inflatedSamples - windowSize) / hop) + 1)
    const actualFrames = totalFrames  // frames the (real) signal actually yields

    const res = await run(spectrogramPlugin, signal, sampleRate, inflatedFrames, hop, windowSize, TILE_FRAMES * 2, inflatedDuration)

    // Overview ends at the real content, not the inflated duration.
    const expectedEnd = actualFrames * (hop / sampleRate)
    for (const [, meta] of res.overviewMeta) {
      expect(meta.timeEnd).toBeCloseTo(expectedEnd, 3)
      expect(meta.timeEnd).toBeLessThan(inflatedDuration - 0.5)
      expect(meta.width).toBeLessThanOrEqual(Math.ceil(actualFrames / Math.ceil(inflatedFrames / Math.min(inflatedFrames, 4096))))
    }
    // No tile extends past the real content end.
    for (const [, te] of res.tileTimeEnd) expect(te).toBeLessThanOrEqual(expectedEnd + 1e-6)
    // Progress bar reaches 100% despite the over-estimate.
    expect(res.lastProgress).not.toBeNull()
    expect(res.lastProgress!.done).toBe(res.lastProgress!.total)
  })

  it('waveform bins match across segment sizes', async () => {
    const whole = await run(waveformPlugin, signal, sampleRate, totalFrames, hop, windowSize, totalFrames, durationSec)
    const small = await run(waveformPlugin, signal, sampleRate, totalFrames, hop, windowSize, TILE_FRAMES, durationSec)

    for (const [ch, w] of whole.waveform) {
      const s = small.waveform.get(ch)!
      expect(s.binCount, `waveform binCount ch${ch}`).toBe(w.binCount)
      expectFloatEqual(s.peakPos, w.peakPos, `waveform peakPos ch${ch}`)
      expectFloatEqual(s.peakNeg, w.peakNeg, `waveform peakNeg ch${ch}`)
      expectFloatEqual(s.rms, w.rms, `waveform rms ch${ch}`)
    }
  })
})
