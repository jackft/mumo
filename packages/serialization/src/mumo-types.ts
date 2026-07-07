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
}

export interface MumoImageEntry {
  path: string
  mediaTimeMs?: number
  label?: string
}

export interface MumoSpectrogramEntry {
  path: string
  mediaPath: string
  mediaHash: string
  params: Record<string, unknown>
}

export interface MumoTrackBufferEntry {
  path: string
  trackSetId: string
  trackId: string
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
