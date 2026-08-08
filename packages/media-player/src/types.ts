import type { SpectrogramTile, WaveformBins } from '@mumo/timeline'

export type { SpectrogramTile, WaveformBins }

export interface SpectrogramSettings {
  windowLengthSec: number
  hopSec: number
  maxFreqHz: number       // upper frequency shown (display crop); also the analysis target
  viewMinHz: number       // lower frequency shown (display crop; 0 = DC)
  window: 'hann' | 'hamming' | 'gaussian'
  dynamicRangeDb: number
  gamma: number
  scale: 'linear' | 'mel'
  melBands: number
  monoMix: boolean
  preEmphasisDbPerOct: number  // per-frequency high-boost baked into the image (Praat: 6 dB/oct; 0 = off)
}

// Analysis stores bins up to this multiple of maxFreqHz (linear scale only) so the frequency
// window can be narrowed (or widened up to the ceiling) at DISPLAY time without re-decoding.
export const SPEC_FREQ_HEADROOM = 1.5

export const PREVIEW_SPEC_SETTINGS: SpectrogramSettings = {
  windowLengthSec: 0.020, hopSec: 0.010, maxFreqHz: 8000, viewMinHz: 0, window: 'gaussian', dynamicRangeDb: 70,
  gamma: 1.2, scale: 'linear', melBands: 80, monoMix: false, preEmphasisDbPerOct: 6.0,
}

export const SPEC_PRESETS = [
  { label: 'Wide-band',   windowLengthSec: 0.005, hopSec: 0.0025, maxFreqHz: 5000,  viewMinHz: 0, window: 'gaussian', dynamicRangeDb: 70, gamma: 1.2, scale: 'linear', melBands: 80, monoMix: false, preEmphasisDbPerOct: 6.0 },
  { label: 'Narrow-band', windowLengthSec: 0.020, hopSec: 0.010,  maxFreqHz: 5000,  viewMinHz: 0, window: 'gaussian', dynamicRangeDb: 70, gamma: 1.2, scale: 'linear', melBands: 80, monoMix: false, preEmphasisDbPerOct: 6.0 },
  { label: 'Broad-band',  windowLengthSec: 0.010, hopSec: 0.005,  maxFreqHz: 5500,  viewMinHz: 0, window: 'gaussian', dynamicRangeDb: 70, gamma: 1.2, scale: 'linear', melBands: 80, monoMix: false, preEmphasisDbPerOct: 6.0 },
  { label: 'Full range',  windowLengthSec: 0.010, hopSec: 0.005,  maxFreqHz: 22050, viewMinHz: 0, window: 'hann',     dynamicRangeDb: 70, gamma: 1.2, scale: 'linear', melBands: 80, monoMix: false, preEmphasisDbPerOct: 6.0 },
] as const satisfies Array<{ label: string } & SpectrogramSettings>

export const DEFAULT_SPEC_SETTINGS: SpectrogramSettings = { ...SPEC_PRESETS[1] }

export interface MediaState {
  mediaUrl: string
  kind: 'audio' | 'video'
  filename: string
  duration: number
  sampleRate: number
  channelCount: number
  activeChannel: readonly number[] | 'mix'
  muted: boolean
  volume: number
}

export interface MediaTrack {
  file: File
  path: string | null
  mediaUrl: string
  offsetSec: number
  mediaHash?: string
}

export type WorkerRequest =
  | {
      // Decode + analyze a media file entirely inside the worker (off the main thread).
      type: 'analyze'
      url: string
      settings: SpectrogramSettings
      pluginSettings?: Record<string, unknown>
    }
  | {
      type: 'reanalyze'
      settings: SpectrogramSettings
    }
  | {
      // Re-derive VAD segments from the cached per-frame speech probabilities using new
      // thresholds — no re-decode or model re-run, so it's instant.
      type: 'resegmentVad'
      vadSettings: VadSettings
    }
  | {
      // Re-run pitch detection with new settings (re-decodes the worker's stored URL).
      type: 'reanalyzePitch'
      pitchSettings: PitchSettings
      pluginSettings?: Record<string, unknown>
    }
  | {
      // Compute VAD as a deferred pass (re-decodes) so it doesn't delay spectrogram/waveform.
      type: 'analyzeVad'
      vadSettings: VadSettings
      pluginSettings?: Record<string, unknown>
    }

export interface VadSegment { start: number; end: number }

/** Silero VAD segmentation tuning. All operate on the cached per-frame speech probabilities, so
 *  changing them re-segments instantly (see resegmentVad). */
export interface VadSettings {
  positiveThreshold: number  // prob ≥ this opens a speech segment
  negativeThreshold: number  // prob < this (for redemptionMs) closes it
  redemptionMs: number       // pause tolerated before a segment ends (shorter → more segments)
  minSpeechMs: number        // discard speech shorter than this
}

export const DEFAULT_VAD_SETTINGS: VadSettings = {
  positiveThreshold: 0.3,
  negativeThreshold: 0.2,
  redemptionMs: 250,
  minSpeechMs: 150,
}

export interface FrameStat {
  frameNum:     number
  tSec:         number
  interFrameMs: number  // wall-clock ms since previous rendered frame; >33ms = dropped frame at 30fps
  queueDepth:   number
}

export type PitchBackend = 'yin' | 'swiftf0'

/** Derived per-channel pitch track. Computed in the worker; the host may persist the raw arrays to
 *  `.mumo` (pitch sidecars) and restore them on load, otherwise it's re-derived from audio. Explicit
 *  per-frame `times` (seconds, frame centers) so both backends' framings compose. `f0 = 0` marks an
 *  unvoiced frame; `confidence` is the backend's own [0,1] voicing/periodicity score. */
export interface PitchTrack {
  channelIndex: number
  backend: PitchBackend
  times: Float32Array
  f0: Float32Array
  confidence: Float32Array
}

/** Pitch detection tuning. `backend`/`minHz`/`maxHz`/`threshold` re-derive the track (a re-decode,
 *  like the spectrogram); `confidenceThreshold` is a render-time voicing gate (instant). */
export interface PitchSettings {
  backend: PitchBackend
  minHz: number            // YIN only (SwiftF0's range is fixed by the model)
  maxHz: number            // YIN only
  threshold: number        // YIN CMNDF aperiodicity threshold
  confidenceThreshold: number  // hide frames below this confidence (voicing gate)
}

export const DEFAULT_PITCH_SETTINGS: PitchSettings = {
  backend: 'swiftf0', minHz: 50, maxHz: 600, threshold: 0.15, confidenceThreshold: 0.5,
}

export type WorkerResponse =
  | { type: 'decoded'; sampleRate: number; channelCount: number; duration: number }
  | { type: 'waveform'; channelIndex: number; bins: WaveformBins }
  | { type: 'spectrogramOverview'; channelIndex: number; tile: SpectrogramTile }
  | { type: 'spectrogramTile'; channelIndex: number; tile: SpectrogramTile }
  | { type: 'progress'; done: number; total: number }
  | { type: 'onsets'; channelIndex: number; timestamps: Float32Array; strengths: Float32Array; bandTimestamps: Float32Array[]; bandStrengths: Float32Array[] }
  | { type: 'vad'; segments: VadSegment[] }
  | { type: 'vadProgress'; done: number; total: number }
  | { type: 'pitch'; channelIndex: number; track: PitchTrack }
  | { type: 'pitchProgress'; done: number; total: number }
  | { type: 'error'; message: string }
  | { type: 'custom'; pluginId: string; data: unknown }
