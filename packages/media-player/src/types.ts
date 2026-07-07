import type { SpectrogramTile, WaveformBins } from '@mumo/timeline'

export type { SpectrogramTile, WaveformBins }

export interface SpectrogramSettings {
  windowLengthSec: number
  hopSec: number
  maxFreqHz: number
  window: 'hann' | 'hamming' | 'gaussian'
  dynamicRangeDb: number
  gamma: number
  scale: 'linear' | 'mel'
  melBands: number
  monoMix: boolean
}

export const PREVIEW_SPEC_SETTINGS: SpectrogramSettings = {
  windowLengthSec: 0.020, hopSec: 0.010, maxFreqHz: 8000, window: 'gaussian', dynamicRangeDb: 70,
  gamma: 1.2, scale: 'linear', melBands: 80, monoMix: false,
}

export const SPEC_PRESETS = [
  { label: 'Wide-band',   windowLengthSec: 0.005, hopSec: 0.0025, maxFreqHz: 5000,  window: 'gaussian', dynamicRangeDb: 70, gamma: 1.2, scale: 'linear', melBands: 80, monoMix: false },
  { label: 'Narrow-band', windowLengthSec: 0.020, hopSec: 0.010,  maxFreqHz: 5000,  window: 'gaussian', dynamicRangeDb: 70, gamma: 1.2, scale: 'linear', melBands: 80, monoMix: false },
  { label: 'Broad-band',  windowLengthSec: 0.010, hopSec: 0.005,  maxFreqHz: 5500,  window: 'gaussian', dynamicRangeDb: 70, gamma: 1.2, scale: 'linear', melBands: 80, monoMix: false },
  { label: 'Full range',  windowLengthSec: 0.010, hopSec: 0.005,  maxFreqHz: 22050, window: 'hann',     dynamicRangeDb: 70, gamma: 1.2, scale: 'linear', melBands: 80, monoMix: false },
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
      type: 'initStream'
      settings: SpectrogramSettings
      pluginSettings?: Record<string, unknown>
    }
  | {
      type: 'chunk'
      channelData: Float32Array[]
      sampleRate: number
      channelCount: number
    }
  | {
      type: 'finalizeStream'
      duration: number
    }
  | {
      type: 'reanalyze'
      settings: SpectrogramSettings
    }

export interface VadSegment { start: number; end: number }

export interface FrameStat {
  frameNum:     number
  tSec:         number
  interFrameMs: number  // wall-clock ms since previous rendered frame; >33ms = dropped frame at 30fps
  queueDepth:   number
}

export type WorkerResponse =
  | { type: 'decoded'; sampleRate: number; channelCount: number; duration: number }
  | { type: 'waveform'; channelIndex: number; bins: WaveformBins }
  | { type: 'spectrogramOverview'; channelIndex: number; tile: SpectrogramTile }
  | { type: 'spectrogramTile'; channelIndex: number; tile: SpectrogramTile }
  | { type: 'progress'; done: number; total: number }
  | { type: 'onsets'; channelIndex: number; timestamps: Float32Array; strengths: Float32Array; bandTimestamps: Float32Array[]; bandStrengths: Float32Array[] }
  | { type: 'vad'; segments: VadSegment[] }
  | { type: 'error'; message: string }
  | { type: 'custom'; pluginId: string; data: unknown }
