import { unzipSync, strFromU8 } from 'fflate'
import type { MumoManifest, MumoCVEntry } from './mumo-types.js'

export interface MumoUnpackResult {
  manifest: MumoManifest
  mmeaf: string
  images: Map<string, Uint8Array>
  /** Serialized JSON string for `TrackSetStore.loadJSON()`, or null if absent. */
  trackSetsJSON: string | null
  /** Detection buffers keyed by `"${trackSetId}/${trackId}"`. */
  trackBuffers: Map<string, Uint8Array>
  /** CV artifact entries — [] for old manifests (cv: null / legacy shape). */
  cvEntries: MumoCVEntry[]
  /** CV artifact bytes keyed by archive path. */
  cvFiles: Map<string, Uint8Array>
}

export function unpackMumo(data: Uint8Array): MumoUnpackResult {
  const files = unzipSync(data)

  const manifestRaw = files['manifest.json']
  if (!manifestRaw) throw new Error('.mumo: missing manifest.json')
  const manifest = JSON.parse(strFromU8(manifestRaw)) as MumoManifest

  const mmeafRaw = files[manifest.mmeaf]
  if (!mmeafRaw) throw new Error(`.mumo: missing ${manifest.mmeaf}`)
  const mmeaf = strFromU8(mmeafRaw)

  const images = new Map<string, Uint8Array>()
  for (const entry of manifest.images) {
    const raw = files[entry.path]
    if (raw) images.set(entry.path, raw)
  }

  let trackSetsJSON: string | null = null
  if (manifest.trackSets) {
    const raw = files[manifest.trackSets]
    if (raw) trackSetsJSON = strFromU8(raw)
  }

  const trackBuffers = new Map<string, Uint8Array>()
  for (const entry of manifest.trackBuffers ?? []) {
    const raw = files[entry.path]
    if (raw) trackBuffers.set(`${entry.trackSetId}/${entry.trackId}`, raw)
  }

  // Anything that is not an array is a legacy placeholder (null / MumoCVPaths).
  const cvEntries: MumoCVEntry[] = Array.isArray(manifest.cv) ? manifest.cv : []
  const cvFiles = new Map<string, Uint8Array>()
  for (const entry of cvEntries) {
    const raw = files[entry.path]
    if (raw) cvFiles.set(entry.path, raw)
  }

  return { manifest, mmeaf, images, trackSetsJSON, trackBuffers, cvEntries, cvFiles }
}
