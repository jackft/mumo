import type { PitchSettings, PitchTrack } from '../../types.js'
import { DEFAULT_PITCH_SETTINGS } from '../../types.js'
import type { SignalPlugin, SignalRun, StreamInit, AudioSegment, SignalPost } from './SignalPlugin.js'
import { getSampleBuffer } from './spectrogram.js'

// Rust YIN (audio-analysis-wasm SampleBuffer.compute_pitch) runs at 16 kHz. FRAME=1024 (64 ms)
// supports down to ~50 Hz (max lag 320 < FRAME/2); HOP=256 → 16 ms frame spacing.
const PITCH_SR = 16000
const FRAME = 1024
const HOP = 256

function readPitchSettings(pluginSettings: Record<string, unknown>): PitchSettings {
  return { ...DEFAULT_PITCH_SETTINGS, ...((pluginSettings as { __pitch?: Partial<PitchSettings> }).__pitch ?? {}) }
}

/**
 * Streaming box-filter resampler to 16 kHz producing a *continuous* stream (not fixed frames):
 * each `push` returns all output samples it can complete, carrying leftover input across calls so
 * the concatenation of pushes is a seamless resampling. Bounded memory. (The frame-emitting
 * `Resampler16k` in sileroVad is shaped for the VAD model; pitch needs a continuous stream.)
 */
export class ContinuousResampler16k {
  private inBuf = new Float32Array(0)
  private inBase = 0        // global native index of inBuf[0]
  private outIndex = 0      // next global 16 kHz output index to produce
  private readonly ratio: number  // native samples per output sample

  constructor(nativeRate: number) { this.ratio = nativeRate / PITCH_SR }

  push(input: Float32Array): Float32Array {
    if (input.length > 0) {
      const buf = new Float32Array(this.inBuf.length + input.length)
      buf.set(this.inBuf); buf.set(input, this.inBuf.length)
      this.inBuf = buf
    }
    const end = this.inBase + this.inBuf.length
    const out: number[] = []
    // Complete every output sample whose native window [lo, hi) is fully buffered.
    let hi = Math.round((this.outIndex + 1) * this.ratio)
    while (hi <= end) {
      const lo = Math.round(this.outIndex * this.ratio)
      let sum = 0, num = 0
      for (let i = lo; i < hi; i++) { sum += this.inBuf[i - this.inBase]!; num++ }
      out.push(num > 0 ? sum / num : 0)
      this.outIndex++
      hi = Math.round((this.outIndex + 1) * this.ratio)
    }
    // Drop native consumed by completed outputs, keeping the tail the next output needs.
    const keepFrom = Math.round(this.outIndex * this.ratio)
    if (keepFrom > this.inBase) { this.inBuf = this.inBuf.subarray(keepFrom - this.inBase); this.inBase = keepFrom }
    return Float32Array.from(out)
  }
}

// SwiftF0: 16 kHz mono in, internal STFT (hop 256 → 16 ms frames), frame center offset 127.5.
// Processed in non-overlapping 30 s chunks (a multiple of the hop) to bound memory.
const SWIFT_HOP = 256
const SWIFT_PAD = 127.5
const SWIFT_CHUNK = 30 * PITCH_SR
const SWIFT_MIN = FRAME  // don't run the model on a tail shorter than one STFT window

type Ort = typeof import('onnxruntime-web')

interface VadAssetsLike { modelUrl: string; wasmBase: string }
function readPitchAssets(pluginSettings: Record<string, unknown>): VadAssetsLike | undefined {
  return (pluginSettings as { __pitchAssets?: VadAssetsLike }).__pitchAssets
}

function appendF32(a: Float32Array, b: Float32Array): Float32Array {
  if (b.length === 0) return a
  const out = new Float32Array(a.length + b.length)
  out.set(a); out.set(b, a.length)
  return out
}

interface ChannelPitch {
  resampler: ContinuousResampler16k
  carry: Float32Array
  start16k: number      // global 16 kHz sample index of carry[0] (SwiftF0 frame-time base)
  f0: number[]
  confidence: number[]
  times: number[]
}

function makeChannels(init: StreamInit): ChannelPitch[] {
  return Array.from({ length: init.channelCount }, () => ({
    resampler: new ContinuousResampler16k(init.sampleRate), carry: new Float32Array(0), start16k: 0, f0: [], confidence: [], times: [],
  }))
}

function postTrack(post: SignalPost, ch: number, backend: PitchTrack['backend'], c: ChannelPitch): void {
  const f0 = Float32Array.from(c.f0), confidence = Float32Array.from(c.confidence), times = Float32Array.from(c.times)
  post({ type: 'pitch', channelIndex: ch, track: { channelIndex: ch, backend, times, f0, confidence } }, [times.buffer, f0.buffer, confidence.buffer])
}

// Progress by owned samples processed vs the file's estimated total. `done()` posts 100% so the
// bar clears even when pitch is skipped (WASM/model unavailable).
function makeProgress(init: StreamInit, post: SignalPost) {
  const total = Math.max(1, Math.round(init.durationSec * init.sampleRate))
  let processed = 0
  return {
    tick(ownedSamples: number): void { processed += ownedSamples; post({ type: 'pitchProgress', done: Math.min(processed, total), total }) },
    done(): void { post({ type: 'pitchProgress', done: total, total }) },
  }
}

// Rust YIN — frame-local, synchronous. Continuous 16 kHz stream fed into compute_pitch as complete
// frames accumulate. Uniform frame grid (frame f centered at FRAME/2 + f*HOP).
function createYinRun(init: StreamInit, post: SignalPost, s: PitchSettings): SignalRun {
  const SB = getSampleBuffer()
  const nc = init.channelCount
  let disabled = SB === null
  if (SB === null) console.warn('[pitch] Rust/WASM not loaded — skipping YIN pitch')
  const chans = disabled ? [] : makeChannels(init)
  const progress = makeProgress(init, post)

  const drain = (c: ChannelPitch): void => {
    if (c.carry.length < FRAME) return
    const sb = new SB!(c.carry, FRAME, 0)
    try {
      const pr = sb.compute_pitch(HOP, FRAME, PITCH_SR, s.minHz, s.maxHz, s.threshold)
      try {
        const n = pr.num_frames
        if (n > 0) {
          const ph = pr.take_pitch_hz(), cf = pr.take_confidence()
          for (let i = 0; i < n; i++) { c.f0.push(ph[i]!); c.confidence.push(cf[i]!) }
          c.carry = c.carry.subarray(n * HOP)
        }
      } finally { pr.free() }
    } finally { sb.free() }
  }

  return {
    pushSegment(seg: AudioSegment): void {
      if (disabled) return
      try {
        for (let ch = 0; ch < nc; ch++) {
          const c = chans[ch]!
          c.carry = appendF32(c.carry, c.resampler.push(seg.channels[ch]!.subarray(0, seg.ownedSamples)))
          drain(c)
        }
      } catch (e) { disabled = true; console.warn('[pitch] YIN error, disabling:', e) }
      progress.tick(seg.ownedSamples)
    },
    finish(): void {
      progress.done()
      if (disabled) return
      const hopSec = HOP / PITCH_SR, t0Sec = (FRAME / 2) / PITCH_SR
      for (let ch = 0; ch < nc; ch++) {
        const c = chans[ch]!
        for (let f = 0; f < c.f0.length; f++) c.times.push(t0Sec + f * hopSec)
        postTrack(post, ch, 'yin', c)
      }
    },
  }
}

// SwiftF0 — ONNX (onnxruntime-web, shared with Silero). Stateless STFT, so 30 s chunks are run
// independently; each frame's absolute time comes from the chunk's global 16 kHz offset.
function createSwiftRun(init: StreamInit, post: SignalPost, assets: VadAssetsLike | undefined): SignalRun {
  const nc = init.channelCount
  let disabled = !assets
  if (!assets) console.warn('[pitch] SwiftF0 assets missing — skipping')
  const chans = disabled ? [] : makeChannels(init)
  const progress = makeProgress(init, post)
  let ort: Ort | null = null
  let session: import('onnxruntime-web').InferenceSession | null = null
  let inName = '', outPitch = '', outConf = ''

  const ready = (async () => {
    if (disabled) return
    try {
      ort = await import('onnxruntime-web')
      ort.env.wasm.numThreads = 1
      ort.env.wasm.wasmPaths = assets!.wasmBase
      const bytes = await (await fetch(assets!.modelUrl)).arrayBuffer()
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
      inName = session.inputNames[0]!; outPitch = session.outputNames[0]!; outConf = session.outputNames[1]!
    } catch (e) { disabled = true; console.warn('[pitch] SwiftF0 disabled, skipping:', e) }
  })()

  const runChunk = async (c: ChannelPitch, chunk: Float32Array, start16k: number): Promise<void> => {
    const t = new ort!.Tensor('float32', chunk, [1, chunk.length])
    const out = await session!.run({ [inName]: t })
    const pd = out[outPitch]!.data as Float32Array, cd = out[outConf]!.data as Float32Array
    for (let i = 0; i < pd.length; i++) {
      c.f0.push(pd[i]!); c.confidence.push(cd[i]!)
      c.times.push((start16k + i * SWIFT_HOP + SWIFT_PAD) / PITCH_SR)
    }
  }

  return {
    async pushSegment(seg: AudioSegment): Promise<void> {
      await ready
      if (disabled) return
      try {
        for (let ch = 0; ch < nc; ch++) {
          const c = chans[ch]!
          c.carry = appendF32(c.carry, c.resampler.push(seg.channels[ch]!.subarray(0, seg.ownedSamples)))
          while (c.carry.length >= SWIFT_CHUNK) {
            await runChunk(c, c.carry.subarray(0, SWIFT_CHUNK), c.start16k)
            c.carry = c.carry.subarray(SWIFT_CHUNK); c.start16k += SWIFT_CHUNK
          }
        }
      } catch (e) { disabled = true; console.warn('[pitch] SwiftF0 inference error, disabling:', e) }
      progress.tick(seg.ownedSamples)
    },
    async finish(): Promise<void> {
      await ready
      progress.done()
      if (disabled) return
      for (let ch = 0; ch < nc; ch++) {
        const c = chans[ch]!
        if (c.carry.length >= SWIFT_MIN) { try { await runChunk(c, c.carry, c.start16k) } catch { /* drop tail */ } }
        postTrack(post, ch, 'swiftf0', c)
      }
    },
  }
}

/**
 * Per-channel pitch detection in the streaming pipeline (RustYIN default, SwiftF0 optional). Each
 * segment's owned samples are resampled to a continuous 16 kHz stream and analyzed as they arrive,
 * so no full-resolution (or full 16 kHz) audio is retained. The derived track is transient — posted
 * at finish, re-derived on load, never persisted.
 */
export const pitchPlugin: SignalPlugin = {
  id: 'pitch',

  createRun(init: StreamInit, post: SignalPost): SignalRun {
    if (init.trigger === 'reanalyze') return { pushSegment() { /* pitch not part of spectrogram reanalyze */ }, finish() {} }
    const settings = readPitchSettings(init.pluginSettings)
    return settings.backend === 'swiftf0'
      ? createSwiftRun(init, post, readPitchAssets(init.pluginSettings))
      : createYinRun(init, post, settings)
  },
}
