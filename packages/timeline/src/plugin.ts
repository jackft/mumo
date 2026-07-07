import type { BarItem, SignalChannel } from './types.js'

export type SnapMode = 'all' | 'vad' | 'waveform' | 'spectrogram'

export interface SnapCtx {
  zone: string
  signals: SignalChannel[]
  vadSegments: Array<{ start: number; end: number }>
  mouseFreqFraction: number | null
  /** All bars currently in the timeline (unfiltered — includes words, placeholders). */
  bars: BarItem[]
}

export interface SnapPlugin {
  /** Which zones activate this plugin. Omit to match all zones. */
  zones?: string[]
  /**
   * Optional kind tag used for mode-based filtering.
   * Built-in values: 'boundary' | 'vad' | 'onset'.
   * Custom plugins without a kind run in all modes.
   */
  kind?: string
  snap(t: number, radiusSec: number, ctx: SnapCtx): number | null
}
