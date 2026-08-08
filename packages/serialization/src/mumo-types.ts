export interface MumoManifest {
  version: 1
  mmeaf: string
  images: MumoImageEntry[]
  spectrograms: MumoSpectrogramEntry[]
  /**
   * Computer-vision artifacts (homographies, detection dumps, segmentation
   * masks, …) stored under cv/ in the archive. Omitted when there are none.
   * Old manifests may carry `null` or a legacy MumoCVPaths object here —
   * readers must treat anything that is not an array as empty.
   */
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  cv?: MumoCVEntry[] | MumoCVPaths | null
  mediaPaths?: string[]
  /** Path to track-sets.json (TrackSet + CoordinateFrame metadata). */
  trackSets?: string
  /** Per-track binary detection buffer entries (raw Float32Array bytes). */
  trackBuffers?: MumoTrackBufferEntry[]
  /** Per-channel pitch (f0) tracks (raw Float32Array bytes). Omitted when there are none. */
  pitch?: MumoPitchEntry[]
}

export interface MumoImageEntry {
  path: string
  mediaTimeMs?: number
  label?: string
}

export interface MumoSpectrogramEntry {
  /** Absent in new files; present in old files that stored a PNG in the archive. */
  path?: string
  mediaPath: string
  mediaHash: string
  params: Record<string, unknown>
}

export interface MumoTrackBufferEntry {
  path: string
  trackSetId: string
  trackId: string
}

/**
 * A per-channel pitch track. The sidecar file holds the three equal-length arrays concatenated as
 * little-endian Float32 — `[times(numFrames), f0(numFrames), confidence(numFrames)]` — so the file
 * is `3 * numFrames * 4` bytes. Matched back to media on load by `mediaKey` (the media file path,
 * else its filename) + `channelIndex` — NOT the per-session player id, and NOT a content hash
 * (which isn't reliably available: desktop reload streams from a path with an empty File object).
 */
export interface MumoPitchEntry {
  path: string          // archive path, e.g. "pitch/0.f32"
  mediaKey: string      // media file path (or filename) this channel belongs to
  channelIndex: number
  numFrames: number
  /** PitchSettings used to compute this channel (backend, minHz, maxHz, threshold, confidenceThreshold). */
  settings: Record<string, unknown>
  /** Whether the pitch overlay was toggled on for this channel's waveform lane (restored on load). */
  enabled?: boolean
}

/** A computer-vision artifact stored in the archive. */
export interface MumoCVEntry {
  /** Location inside the archive, e.g. "cv/homography.json". */
  path: string
  /** Free-form artifact kind, e.g. 'homography', 'detections', 'segmentation'. */
  kind: string
  label?: string
  /** Producer-specific metadata (model name, video ref, frame range, …). */
  params?: Record<string, unknown>
}

/** @deprecated Pre-MumoCVEntry placeholder — kept only so old manifests parse without error. */
export interface MumoCVPaths {
  homography: string | null
  annotations: string | null
}
