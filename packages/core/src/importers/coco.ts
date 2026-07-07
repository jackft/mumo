/**
 * COCO JSON importer for bounding-box and keypoint tracking data.
 *
 * Expects multi-frame COCO output with `track_id` on each annotation (e.g. ByteTrack,
 * OC-SORT, ViTPose with tracking). If `track_id` is absent, each annotation becomes
 * its own single-frame track.
 *
 * Pixel coordinates are normalized to center-based [0, 1] on import.
 */

import type { TrackSetStore, TrackSet } from '../track-store.js'
import type { KeypointSchemaJSON } from '../track-types.js'

// COCO JSON shapes

interface CocoImage {
  id: number
  file_name?: string
  width?: number
  height?: number
  /** Non-standard field emitted by some tracking tools. */
  frame_id?: number
}

interface CocoAnnotation {
  id: number
  image_id: number
  category_id: number
  /** [x_left, y_top, width, height] in pixels. */
  bbox?: [number, number, number, number]
  /** Flat [x, y, visibility, ...] array; visibility: 0=absent, 1=occluded, 2=visible. */
  keypoints?: number[]
  score?: number
  /** Non-standard field emitted by tracking algorithms (ByteTrack, OC-SORT, etc.). */
  track_id?: number
}

interface CocoCategory {
  id: number
  name: string
  keypoints?: string[]
  /** 1-indexed pairs. */
  skeleton?: [number, number][]
}

interface CocoJSON {
  images: CocoImage[]
  annotations: CocoAnnotation[]
  categories?: CocoCategory[]
}

// Public API

export interface CocoImportOpts {
  /** Parsed COCO JSON object or a raw JSON string. */
  data: string | object
  /** Name for the resulting TrackSet (shown in the tier list). */
  name: string
  /** Filename of the associated video within the .mumo archive. */
  videoRef: string
  /** Frame rate in Hz. */
  frameRate: number
  /**
   * Video pixel dimensions, needed to normalize coordinates.
   * Falls back to the `width`/`height` fields of the first COCO image if omitted.
   */
  videoWidth?: number
  videoHeight?: number
}

export function importCoco(store: TrackSetStore, opts: CocoImportOpts): TrackSet {
  const json = (
    typeof opts.data === 'string' ? JSON.parse(opts.data) : opts.data
  ) as CocoJSON

  // --- Frame index mapping ---
  // Sort by image.id; use image.frame_id when present, otherwise positional 0-based index.
  const sortedImages = [...json.images].sort((a, b) => a.id - b.id)
  const imageToFrame = new Map<number, number>()
  for (let i = 0; i < sortedImages.length; i++) {
    const img = sortedImages[i]!
    imageToFrame.set(img.id, img.frame_id ?? i)
  }

  // Video dimensions
  const firstImg = sortedImages[0]
  const vW = opts.videoWidth  ?? firstImg?.width  ?? 1
  const vH = opts.videoHeight ?? firstImg?.height ?? 1

  // Category map
  const catMap = new Map<number, CocoCategory>()
  for (const cat of json.categories ?? []) catMap.set(cat.id, cat)

  // Group annotations by track_id; fall back to annotation.id for untracked datasets.
  const trackGroups = new Map<number, CocoAnnotation[]>()
  for (const ann of json.annotations) {
    const tid = ann.track_id ?? ann.id
    const existing = trackGroups.get(tid)
    if (existing) existing.push(ann)
    else trackGroups.set(tid, [ann])
  }

  const ts = store.addTrackSet(opts.name, opts.videoRef, opts.frameRate)

  for (const [tid, anns] of trackGroups) {
    const catId    = anns[0]!.category_id
    const cat      = catMap.get(catId)
    const hasKps   = anns.some(a => a.keypoints && a.keypoints.length > 0)
    const trackType = hasKps ? 'keypoint' : 'bbox'

    // Frame range
    let frameMin = Infinity, frameMax = -Infinity
    for (const ann of anns) {
      const f = imageToFrame.get(ann.image_id)
      if (f === undefined) continue
      if (f < frameMin) frameMin = f
      if (f > frameMax) frameMax = f
    }
    if (!isFinite(frameMin)) continue

    // Build keypoint schema from COCO category
    let schema: KeypointSchemaJSON | undefined
    if (trackType === 'keypoint' && cat?.keypoints) {
      const ids = cat.keypoints
      const edges: [string, string][] = []
      for (const [a, b] of cat.skeleton ?? []) {
        const ka = ids[a - 1], kb = ids[b - 1]
        if (ka && kb) edges.push([ka, kb])
      }
      schema = { ids, edges }
    }

    const track = store.addTrack(ts.id, {
      name: `track-${tid}`,
      type: trackType,
      coordinateSpace: 'video',
      frameStart: frameMin,
      frameCount: frameMax - frameMin + 1,
      ...(schema !== undefined ? { keypointSchema: schema } : {}),
    })
    if (!track) continue

    for (const ann of anns) {
      const frame = imageToFrame.get(ann.image_id)
      if (frame === undefined) continue
      const conf = ann.score ?? 1.0

      if (trackType === 'bbox') {
        const [xl, yt, bw, bh] = ann.bbox!
        store.setDetection(ts.id, track.id, frame, [
          (xl + bw / 2) / vW,
          (yt + bh / 2) / vH,
          bw / vW,
          bh / vH,
          conf,
        ])
      } else {
        const kps = ann.keypoints!
        const K   = schema!.ids.length
        const values = new Array<number>(K * 3).fill(0)
        for (let k = 0; k < K; k++) {
          const base = k * 3
          values[base]     = (kps[base]     ?? 0) / vW
          values[base + 1] = (kps[base + 1] ?? 0) / vH
          // COCO visibility: 0=absent, 1=occluded, 2=visible. Store raw as conf;
          // the 0.3 draw threshold skips only v=0 (absent).
          values[base + 2] = kps[base + 2] ?? 0
        }
        store.setDetection(ts.id, track.id, frame, values)
      }
    }
  }

  return store.getTrackSet(ts.id) ?? ts
}
