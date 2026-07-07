export interface Lane {
  id: string
  label: string
  type: 'participant' | 'token' | 'annotation' | 'visualization' | 'track'
  participant: string   // used for color assignment
  depth?: number       // nesting depth for annotation child tiers (0 = root)
  color?: number       // Pixi hex color; assigned from categorical palette
}

export interface BarItem {
  id: string          // stable bar ID (== PM node ID or annotation ID)
  nodeId: string      // PM node ID or annotation store ID
  start: number       // seconds
  end: number         // seconds
  label: string
  laneId: string
  type: 'utterance' | 'token' | 'annotation' | 'track'
  placeholder?: boolean   // true when times are synthetic (no real timing data)
  summaryHidden?: boolean // true for token-level bars that should not appear in the overview strip
  color?: number          // overrides lane color; inherited from group by default
  parentNodeId?: string   // nodeId of direct parent bar (word/token → utt/evt; ann → parent ann/evt/token)
  constraint?: string     // tier constraint: 'time_subdivision' | 'included_in' | 'symbolic_association' | 'symbolic_subdivision'
  locked?: boolean        // if true, bar cannot be moved or resized (e.g. track presence bars)
  startTimed?: boolean    // for time_subdivision word bars: true if the left edge has a real stored time
  endTimed?: boolean      // for time_subdivision word bars: true if the right edge has a real stored time
  listIndex?: number      // position within the sibling list (symbolic/time subdivision and word tokens)
  /** Visual treatment for pending suggestions. */
  suggestionKind?: 'add' | 'move-new' | 'move-old' | 'delete' | 'update-label'
  suggestionId?: string   // ID of the Suggestion in the annotation store (for accept/reject)
}

// Relation arcs (dendrograms)

export interface ArcItem {
  id: string
  sourceBarId: string
  targetBarId: string
  label?: string
  color?: number   // PIXI hex; defaults to 0x888888
}

// Commit entries

export interface CommitEntry {
  nodeId: string
  start: number
  end: number
  origStart: number
  origEnd: number
}

// Tick marks
// Immutable point-in-time markers (e.g. screenshot timestamps). Displayed
// as small rug marks on the ruler. Selectable but not draggable.

export interface TickMark {
  id: string
  timeSeconds: number
  label?: string
  laneId?: string       // if set, render within this lane instead of on the ruler
  kind?: 'rug' | 'keyframe'   // 'rug' = small bottom-of-lane mark (default); 'keyframe' = diamond at lane centre
  minPxPerSec?: number  // hide when viewport zoom is below this threshold
}

// Motion curves
// Per-track dx/dy/velocity data rendered as inline curves inside lane bars.

export interface MotionCurve {
  laneId:   string
  times:    Float32Array  // seconds, sorted ascending
  dx:       Float32Array  // per-frame normalised delta-x (signed)
  dy:       Float32Array  // per-frame normalised delta-y (signed)
  velocity: Float32Array  // per-frame magnitude (always >= 0)
}

// Signal channels
// Rows displayed above the utterance lanes for time-aligned signal data.

export type SignalKind = 'waveform' | 'spectrogram' | 'series'

export interface WaveformBins {
  peakPos: Float32Array   // positive peaks per bin
  peakNeg: Float32Array   // negative peaks per bin (negative values)
  rms: Float32Array       // RMS per bin
  binDuration: number     // seconds per bin
  binCount: number
}

// Fixed quantization reference shared between the worker and the Timeline renderer.
// rawDb value 0 = SPEC_DB_FLOOR dB, value 255 = SPEC_DB_FLOOR + SPEC_DB_RANGE dB.
export const SPEC_DB_FLOOR = -160
export const SPEC_DB_RANGE = 160

// One chunk of a spectrogram along the time axis.
// Detail tiles carry `rawDb` (quantized dB, one byte per bin per frame).
// The Timeline colorises them adaptively using a per-viewport LUT.
// Overview tiles and legacy loaded tiles carry `pixels` (pre-rendered RGBA).
export interface SpectrogramTile {
  tileIndex: number
  width: number      // frames (time axis)
  height: number     // freq bins
  timeStart: number  // seconds
  timeEnd: number    // seconds
  rawDb?: Uint8Array          // detail tiles from worker
  pixels?: Uint8ClampedArray  // overview / legacy RGBA
}

export interface SignalChannel {
  id: string
  label: string
  kind: SignalKind
  height?: number                    // px, default 60
  color?: number                     // hex color for line/waveform
  // 'waveform': mirror waveform from peak/RMS bins
  waveformBins?: WaveformBins
  // 'waveform' / 'series': fallback [timeSeconds, value] pairs
  samples?: Array<[number, number]>
  // 'series': optional explicit y-axis range; auto-scaled if omitted
  yMin?: number
  yMax?: number
  // 'spectrogram': URL fallback (tiles are fed via Timeline methods)
  imageUrl?: string
  imageTimeStart?: number            // seconds; defaults to document start
  imageTimeEnd?: number              // seconds; defaults to document end
  /** Time offset in seconds — shifts the entire channel (waveform + spectrogram) forward in the timeline */
  timeOffset?: number
  // gamma applied to the normalised [0,1] value before colourmap; >1 suppresses noise, <1 boosts weak signals
  spectrogramGamma?: number
  // onset timestamps in seconds — used for snap-to-audio (must be sorted ascending)
  onsets?: Float32Array
  // parallel strength values in [0,1]: 1.0 = silence boundary, 0.2–0.7 = spectral flux
  onsetStrengths?: Float32Array
  // per-frequency-band onsets for frequency-sensitive snapping (low → high band)
  bandOnsets?: Float32Array[]
  bandOnsetStrengths?: Float32Array[]
  // upper frequency bound for spectrogram y-axis mapping and Hz ticks
  maxFreqHz?: number
  // how many dB below the viewport 95th-percentile peak to show (default 70)
  spectrogramDynamicRangeDb?: number
  // TextGrid-style annotation overlay
  // IDs of annotation tiers whose intervals should be shown as strips below
  // the signal (typically phoneme/word/utterance). Persisted configuration —
  // resolved tier data is carried in overlayTiers.
  overlayTierIds?: string[]
  // Resolved tier data — set by the app from the annotation store whenever
  // overlayTierIds or the underlying annotations change.
  overlayTiers?: TierIntervalOverlay[]
}

/** One tier's resolved interval data for the TextGrid overlay. */
export interface TierIntervalOverlay {
  tierId: string
  label: string
  intervals: ReadonlyArray<{ start: number; end: number; label: string }>
}
