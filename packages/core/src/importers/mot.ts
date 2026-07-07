/**
 * MOT (Multiple Object Tracking) CSV importer.
 *
 * Expects the standard MOT benchmark format:
 *   <frame>, <id>, <bb_left>, <bb_top>, <bb_width>, <bb_height>, <conf>, <x>, <y>, <z>
 *
 * Frames are 1-indexed in the file; converted to 0-based on import.
 * Pixel coordinates are normalized to center-based [0, 1] using videoWidth/videoHeight.
 * World-space columns (x, y, z) are ignored; use the COCO or DLC importer for world tracks.
 */

import type { TrackSetStore, TrackSet } from '../track-store.js'

export interface MotImportOpts {
  /** Raw MOT CSV string (may include comment lines starting with '#'). */
  csv: string
  /** Name for the resulting TrackSet. */
  name: string
  /** Filename of the associated video within the .mumo archive. */
  videoRef: string
  /** Frame rate in Hz. */
  frameRate: number
  /** Video pixel width for coordinate normalization. */
  videoWidth: number
  /** Video pixel height for coordinate normalization. */
  videoHeight: number
}

interface MotRow {
  frame: number
  id:    number
  xl:    number
  yt:    number
  bw:    number
  bh:    number
  conf:  number
}

export function importMot(store: TrackSetStore, opts: MotImportOpts): TrackSet {
  const rows: MotRow[] = []

  for (const line of opts.csv.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const c = trimmed.split(',')
    const frame = parseInt(c[0]!, 10) - 1  // MOT is 1-indexed -> 0-based
    const id    = parseInt(c[1]!, 10)
    const xl    = parseFloat(c[2]!)
    const yt    = parseFloat(c[3]!)
    const bw    = parseFloat(c[4]!)
    const bh    = parseFloat(c[5]!)
    const rawConf = parseFloat(c[6]!)

    if (isNaN(frame) || isNaN(id)) continue

    rows.push({
      frame, id, xl, yt, bw, bh,
      // conf=-1 is the MOT convention for "ignored/not evaluated"; treat as 1.0
      conf: isNaN(rawConf) || rawConf < 0 ? 1.0 : rawConf,
    })
  }

  // Group detections by track id
  const trackMap = new Map<number, MotRow[]>()
  for (const row of rows) {
    const existing = trackMap.get(row.id)
    if (existing) existing.push(row)
    else trackMap.set(row.id, [row])
  }

  const { videoWidth: vW, videoHeight: vH } = opts
  const ts = store.addTrackSet(opts.name, opts.videoRef, opts.frameRate)

  for (const [id, detections] of trackMap) {
    let frameMin = Infinity, frameMax = -Infinity
    for (const d of detections) {
      if (d.frame < frameMin) frameMin = d.frame
      if (d.frame > frameMax) frameMax = d.frame
    }
    if (!isFinite(frameMin)) continue

    const track = store.addTrack(ts.id, {
      name: `track-${id}`,
      type: 'bbox',
      coordinateSpace: 'video',
      frameStart: frameMin,
      frameCount: frameMax - frameMin + 1,
    })
    if (!track) continue

    for (const det of detections) {
      store.setDetection(ts.id, track.id, det.frame, [
        (det.xl + det.bw / 2) / vW,
        (det.yt + det.bh / 2) / vH,
        det.bw / vW,
        det.bh / vH,
        det.conf,
      ])
    }
  }

  return store.getTrackSet(ts.id) ?? ts
}
