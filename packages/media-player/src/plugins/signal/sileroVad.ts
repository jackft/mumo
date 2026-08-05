import type { VadSegment, VadSettings } from '../../types.js'
import { DEFAULT_VAD_SETTINGS } from '../../types.js'
import type { SignalPlugin, SignalRun, StreamInit, AudioSegment, SignalPost } from './SignalPlugin.js'
import { mergeVadSegments } from './vad.js'

// The Silero legacy model runs on 1536-sample frames at 16 kHz (96 ms per frame). A 16 kHz sample
// count divided by 16 gives milliseconds (16000 samples/s ÷ 1000 = 16 samples/ms).
const TARGET_RATE = 16000
const FRAME_SAMPLES = 1536
const MS_PER_FRAME = FRAME_SAMPLES / 16  // 96

/** URLs for the ONNX model + ort wasm, resolved on the main thread (see SignalBroker) where
 *  document.baseURI reliably points at the app root in dev, web, and packaged Electron. */
export interface VadAssets { modelUrl: string; wasmBase: string }

function readVadSettings(pluginSettings: Record<string, unknown>): VadSettings {
  return { ...DEFAULT_VAD_SETTINGS, ...((pluginSettings as { __vadSettings?: Partial<VadSettings> }).__vadSettings ?? {}) }
}

/**
 * Streaming resampler to 16 kHz that emits complete `frameSize`-sample frames. Each output sample
 * is the average of the native samples in its window — the same box-filter downsampling vad-web
 * feeds Silero (a crude anti-alias; plain interpolation would alias and degrade the model). Input
 * is fed segment-by-segment; only a fraction of a frame of leftover is buffered, so memory stays
 * O(frameSize) — the full-resolution audio is never resident.
 */
export class Resampler16k {
  private inBuf = new Float32Array(0)

  constructor(private readonly nativeRate: number, private readonly frameSize = FRAME_SAMPLES) {}

  private hasEnoughForFrame(): boolean {
    return (this.inBuf.length * TARGET_RATE) / this.nativeRate >= this.frameSize
  }

  private generateFrame(): Float32Array {
    const out = new Float32Array(this.frameSize)
    let inputIndex = 0
    for (let o = 0; o < this.frameSize; o++) {
      let sum = 0, num = 0
      const bound = Math.min(this.inBuf.length, ((o + 1) * this.nativeRate) / TARGET_RATE)
      while (inputIndex < bound) { sum += this.inBuf[inputIndex]!; num++; inputIndex++ }
      out[o] = num > 0 ? sum / num : 0
    }
    this.inBuf = this.inBuf.slice(inputIndex)
    return out
  }

  push(input: Float32Array): Float32Array[] {
    if (input.length === 0) return []
    const buf = new Float32Array(this.inBuf.length + input.length)
    buf.set(this.inBuf); buf.set(input, this.inBuf.length)
    this.inBuf = buf

    const frames: Float32Array[] = []
    while (this.hasEnoughForFrame()) frames.push(this.generateFrame())
    return frames
  }
}

/**
 * Hysteresis segmentation over one channel's per-frame speech probabilities — a compact port of
 * vad-web's FrameProcessor (minus the audio-buffer payload we don't need). A segment opens once a
 * frame exceeds `positiveThreshold` and closes after `redemptionMs` of sub-`negativeThreshold`
 * frames; segments shorter than `minSpeechMs` of speech are discarded. Operating on the cached
 * probs means re-running this with new settings is instant — no decode or model inference.
 */
export function segmentProbs(probs: Float32Array | number[], s: VadSettings): VadSegment[] {
  const redemptionFrames = Math.max(1, Math.round(s.redemptionMs / MS_PER_FRAME))
  const minSpeechFrames = Math.max(1, Math.round(s.minSpeechMs / MS_PER_FRAME))
  const toSec = (frame: number): number => (frame * MS_PER_FRAME) / 1000
  const segments: VadSegment[] = []
  let speaking = false, redemption = 0, speechFrames = 0, startFrame = 0, lastSpeechFrame = 0
  for (let f = 0; f < probs.length; f++) {
    const prob = probs[f]!
    const isSpeech = prob >= s.positiveThreshold
    if (isSpeech) { speechFrames++; redemption = 0; lastSpeechFrame = f }
    if (isSpeech && !speaking) { speaking = true; startFrame = f }
    if (prob < s.negativeThreshold && speaking && ++redemption >= redemptionFrames) {
      redemption = 0
      speaking = false
      // End at the last frame that actually contained speech, not the redemption-expiry frame —
      // the ~redemptionMs grace only decides *whether* to end, it shouldn't pad the reported end.
      if (speechFrames >= minSpeechFrames) segments.push({ start: toSec(startFrame), end: toSec(lastSpeechFrame + 1) })
      speechFrames = 0
    }
    if (!speaking) speechFrames = 0
  }
  if (speaking && speechFrames >= minSpeechFrames) segments.push({ start: toSec(startFrame), end: toSec(lastSpeechFrame + 1) })
  return segments
}

// Per-channel speech probabilities from the most recent analyze, retained so a settings change can
// re-segment without re-decoding. Cleared when a new file is analyzed (the worker is recreated).
let _probCache: number[][] | null = null

/** Re-derive VAD segments from the cached probs with new settings and post them. No-op (leaves the
 *  existing VAD in place) if nothing has been analyzed yet. */
export function resegmentVad(settings: VadSettings, post: SignalPost): void {
  if (!_probCache) return
  post({ type: 'vad', segments: mergeVadSegments(_probCache.map(probs => segmentProbs(probs, settings))) })
}

type Ort = typeof import('onnxruntime-web')
type Tensor = import('onnxruntime-web').Tensor
interface ChannelVad {
  resampler: Resampler16k
  probs: number[]
  h: Tensor
  c: Tensor
}

/**
 * Per-channel Silero VAD, run in the streaming pipeline. Each decoded segment's owned samples are
 * resampled to 16 kHz and fed frame-by-frame to the Silero model (one shared, stateless ONNX
 * session; the recurrent h/c state is carried per channel), so no full-resolution audio is
 * retained. Per-channel speech segments are merged at finish. If the model or ort runtime can't
 * load, the run disables itself and posts nothing — the energy VAD emitted by the spectrogram
 * plugin then stands.
 */
export const sileroVadPlugin: SignalPlugin = {
  id: 'silero-vad',

  createRun(init: StreamInit, post: SignalPost): SignalRun {
    const assets = (init.pluginSettings as { __vad?: VadAssets }).__vad
    const settings = readVadSettings(init.pluginSettings)
    const nc = init.channelCount
    let disabled = init.trigger === 'reanalyze' || !assets
    let ort: Ort | null = null
    let session: import('onnxruntime-web').InferenceSession | null = null
    let sr: Tensor | null = null
    const chans: ChannelVad[] = []
    const total = Math.max(1, Math.round(init.durationSec * init.sampleRate))  // for the progress bar
    let processed = 0

    const zeroState = (): Tensor => new ort!.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64])

    const ready = (async () => {
      if (disabled) return
      try {
        ort = await import('onnxruntime-web')
        ort.env.wasm.numThreads = 1
        ort.env.wasm.wasmPaths = assets!.wasmBase
        const modelBytes = await (await fetch(assets!.modelUrl)).arrayBuffer()
        session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] })
        sr = new ort.Tensor('int64', [16000n])
        for (let ch = 0; ch < nc; ch++) {
          chans.push({ resampler: new Resampler16k(init.sampleRate), probs: [], h: zeroState(), c: zeroState() })
        }
      } catch (e) {
        disabled = true
        console.warn('[silero-vad] disabled, falling back to energy VAD:', e)
      }
    })()

    return {
      async pushSegment(seg: AudioSegment): Promise<void> {
        await ready
        if (disabled) return
        // Never let a VAD error abort the shared decode loop (which also drives spectrogram/
        // waveform); on failure, disable VAD and leave the energy fallback in place.
        try {
          for (let ch = 0; ch < nc; ch++) {
            const c = chans[ch]!
            const owned = seg.channels[ch]!.subarray(0, seg.ownedSamples)
            for (const frame of c.resampler.push(owned)) {
              const input = new ort!.Tensor('float32', frame, [1, frame.length])
              const out = await session!.run({ input, h: c.h, c: c.c, sr: sr! })
              c.h = out['hn']!; c.c = out['cn']!
              c.probs.push(out['output']!.data[0] as number)
            }
          }
        } catch (e) {
          disabled = true
          console.warn('[silero-vad] inference error, disabling VAD:', e)
        }
        processed += seg.ownedSamples
        post({ type: 'vadProgress', done: Math.min(processed, total), total })
      },

      async finish(): Promise<void> {
        await ready
        post({ type: 'vadProgress', done: total, total })  // always clear the bar (even if disabled)
        // Post even when disabled (empty) so the caller's "computing" state clears.
        if (disabled) { post({ type: 'vad', segments: [] }); return }
        // Cache the per-frame probs so a later settings change re-segments instantly.
        _probCache = chans.map(c => c.probs)
        post({ type: 'vad', segments: mergeVadSegments(chans.map(c => segmentProbs(c.probs, settings))) })
      },
    }
  },
}
