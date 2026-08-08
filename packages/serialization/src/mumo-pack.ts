import { zipSync, strToU8 } from 'fflate'
import type { MumoManifest, MumoImageEntry, MumoSpectrogramEntry, MumoTrackBufferEntry, MumoPitchEntry, MumoCVEntry } from './mumo-types.js'

export interface MumoImageInput {
  filename: string
  data: Uint8Array
  mediaTimeMs?: number
  label?: string
}

export interface MumoSpectrogramInput {
  mediaPath: string
  mediaHash: string
  params: Record<string, unknown>
}

export interface MumoTrackBufferInput {
  trackSetId: string
  trackId: string
  /** Raw Float32Array bytes (little-endian). */
  data: Uint8Array
}

export interface MumoPitchInput {
  /** Media file path (or filename) this channel belongs to. */
  mediaKey: string
  channelIndex: number
  numFrames: number
  /** PitchSettings used to compute this channel. */
  settings: Record<string, unknown>
  /** Whether the pitch overlay was toggled on for this channel's waveform lane. */
  enabled?: boolean
  /** Raw Float32Array bytes (little-endian): [times, f0, confidence] concatenated. */
  data: Uint8Array
}

export interface MumoCVInput {
  filename: string
  data: Uint8Array
  /** Free-form artifact kind, e.g. 'homography', 'detections', 'segmentation'. */
  kind: string
  label?: string
  /** Producer-specific metadata (model name, video ref, frame range, …). */
  params?: Record<string, unknown>
}

export interface MumoPackInput {
  mmeaf: string
  images?: MumoImageInput[]
  spectrograms?: MumoSpectrogramInput[]
  mediaPaths?: string[]
  /**
   * Serialized JSON string from `TrackSetStore.toJSON()`.
   * Omit when there are no track sets.
   */
  trackSetsJSON?: string
  /** One entry per track with a populated detection buffer. */
  trackBuffers?: MumoTrackBufferInput[]
  /** One entry per audio channel with a computed pitch track. */
  pitch?: MumoPitchInput[]
  /** Computer-vision artifacts, stored under cv/ in the archive. */
  cvArtifacts?: MumoCVInput[]
}

export function packMumo(input: MumoPackInput): Uint8Array {
  const files: Record<string, Uint8Array> = {}

  const mmeafPath = 'project.mmeaf'
  files[mmeafPath] = strToU8(input.mmeaf)

  const imageEntries: MumoImageEntry[] = []
  for (const img of input.images ?? []) {
    const path = `images/${img.filename}`
    files[path] = img.data
    const entry: MumoImageEntry = { path }
    if (img.mediaTimeMs !== undefined) entry.mediaTimeMs = img.mediaTimeMs
    if (img.label !== undefined) entry.label = img.label
    imageEntries.push(entry)
  }

  const spectrogramEntries: MumoSpectrogramEntry[] = []
  for (const spec of input.spectrograms ?? []) {
    spectrogramEntries.push({
      mediaPath: spec.mediaPath,
      mediaHash: spec.mediaHash,
      params: spec.params,
    })
  }

  let trackSetsPath: string | undefined
  if (input.trackSetsJSON) {
    trackSetsPath = 'track-sets.json'
    files[trackSetsPath] = strToU8(input.trackSetsJSON)
  }

  const trackBufferEntries: MumoTrackBufferEntry[] = []
  for (const buf of input.trackBuffers ?? []) {
    const path = `track-buffers/${buf.trackSetId}/${buf.trackId}.f32`
    files[path] = buf.data
    trackBufferEntries.push({ path, trackSetId: buf.trackSetId, trackId: buf.trackId })
  }

  const pitchEntries: MumoPitchEntry[] = []
  let pitchIdx = 0
  for (const p of input.pitch ?? []) {
    const path = `pitch/${pitchIdx++}.f32`
    files[path] = p.data
    pitchEntries.push({
      path,
      mediaKey: p.mediaKey,
      channelIndex: p.channelIndex,
      numFrames: p.numFrames,
      settings: p.settings,
      ...(p.enabled ? { enabled: true } : {}),
    })
  }

  const cvEntries: MumoCVEntry[] = []
  for (const cv of input.cvArtifacts ?? []) {
    const path = `cv/${cv.filename}`
    files[path] = cv.data
    cvEntries.push({
      path,
      kind: cv.kind,
      ...(cv.label !== undefined ? { label: cv.label } : {}),
      ...(cv.params !== undefined ? { params: cv.params } : {}),
    })
  }

  const manifest: MumoManifest = {
    version: 1,
    mmeaf: mmeafPath,
    images: imageEntries,
    spectrograms: spectrogramEntries,
    ...(cvEntries.length ? { cv: cvEntries } : {}),
    ...(input.mediaPaths?.length ? { mediaPaths: input.mediaPaths } : {}),
    ...(trackSetsPath ? { trackSets: trackSetsPath } : {}),
    ...(trackBufferEntries.length ? { trackBuffers: trackBufferEntries } : {}),
    ...(pitchEntries.length ? { pitch: pitchEntries } : {}),
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))

  return zipSync(files)
}
