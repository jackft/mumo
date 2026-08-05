import type { WorkerResponse, SpectrogramSettings } from '../../types.js'

export type SignalPost = (msg: WorkerResponse, transfer?: Transferable[]) => void

/** Per-run context. No PCM here — audio arrives segment by segment via {@link SignalRun.pushSegment}. */
export interface StreamInit {
  sampleRate: number
  channelCount: number
  /** Total media duration in seconds (from container metadata), known up front. */
  durationSec: number
  settings: SpectrogramSettings
  pluginSettings: Record<string, unknown>
  trigger: 'analyze' | 'reanalyze'
}

/**
 * A contiguous window of decoded PCM produced by the worker.
 *
 * `channels[c]` covers absolute sample range `[startSample, startSample + channels[c].length)`.
 * Segments are aligned to the spectrogram frame/tile grid and carry a trailing window overlap so
 * the last owned frame is complete — that overlap is re-sent at the start of the next segment.
 * `ownedSamples` is the count of leading, non-overlapping samples this segment owns; consumers that
 * don't care about frames (waveform, VAD downmix) must only read `[0, ownedSamples)` to avoid
 * double-counting the overlap.
 */
export interface AudioSegment {
  channels: Float32Array[]
  startSample: number    // absolute index of channels[c][0]  (== firstFrame * hop)
  ownedSamples: number   // leading non-overlapping samples owned by this segment
  firstFrame: number     // global spectrogram frame index of local frame 0
  frameCount: number     // complete frames owned by this segment
  isLast: boolean
}

/** A stateful analysis run: fed ordered segments, then finalized. */
export interface SignalRun {
  pushSegment(seg: AudioSegment): void | Promise<void>
  finish(): void | Promise<void>
}

export interface SignalPlugin {
  id: string
  createRun(init: StreamInit, post: SignalPost): SignalRun
}
