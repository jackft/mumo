import * as Y from 'yjs'
import { TypedEmitter } from './events.js'
import { newId } from './id.js'
import { LOAD_ORIGIN, USER_ORIGIN } from './store.js'
import type { ID } from './types.js'
import type {
  TrackSetJSON, CoordinateFrameJSON,
  TrackType, CoordinateSpace, KeypointSchemaJSON,
} from './track-types.js'

// Runtime interfaces (match JSON types; separated so we can add methods later)

export interface TrackSet {
  id: ID
  name: string
  videoRef: string
  frameRate: number
  tracks: Track[]
}

export interface Track {
  id: ID
  name: string
  type: TrackType
  coordinateSpace: CoordinateSpace
  frameStart: number
  frameCount: number
  keypointSchema?: KeypointSchemaJSON
  coordinateFrameId?: ID
}

export interface CoordinateFrame {
  id: ID
  name: string
  svgFile: string
  unit: string
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number }
  svgToWorld: { translateX: number; translateY: number; scaleX: number; scaleY: number }
}

// Detection views  (returned from buffer reads; never stored)

export interface BBoxDetection {
  type: 'bbox'
  frame: number
  /** Center-normalized [0, 1] coordinates. */
  cx: number; cy: number; w: number; h: number
  conf: number
}

export interface PointDetection {
  type: 'point'
  frame: number
  /** Normalized [0, 1] or world-unit coordinates depending on CoordinateSpace. */
  x: number; y: number
  conf: number
}

export interface KeypointDetection {
  type: 'keypoint'
  frame: number
  keypoints: Array<{ id: string; x: number; y: number; conf: number }>
}

export type TrackDetection = BBoxDetection | PointDetection | KeypointDetection

/** Normalized 2D position used for trajectory rendering on video/map canvas. */
export interface TrajectoryPoint { frame: number; x: number; y: number }

// Float32Array detection buffer (not exported)
// Layout per track type, per frame:
//   bbox:     [cx, cy, w, h, conf]            stride = 5
//   point:    [x, y, conf]                    stride = 3
//   keypoint: [x0,y0,v0, x1,y1,v1, ...]      stride = keypointCount * 3
//
// NaN in the first slot of a frame = no detection at that frame.

const BBOX_STRIDE  = 5
const POINT_STRIDE = 3

class TrackDataBuffer {
  readonly data: Float32Array
  readonly stride: number
  readonly track: Track

  constructor(track: Track) {
    this.track = track
    const kpCount = track.keypointSchema?.ids.length ?? 0
    this.stride = track.type === 'bbox'     ? BBOX_STRIDE
                : track.type === 'point'    ? POINT_STRIDE
                : kpCount * 3
    this.data = new Float32Array(track.frameCount * this.stride).fill(NaN)
  }

  static fromExisting(track: Track, src: Float32Array): TrackDataBuffer {
    const buf = new TrackDataBuffer(track)
    buf.data.set(src.subarray(0, buf.data.length))
    return buf
  }

  private frameToOffset(frame: number): number {
    return (frame - this.track.frameStart) * this.stride
  }

  private inBounds(frame: number): boolean {
    const f = frame - this.track.frameStart
    return f >= 0 && f < this.track.frameCount
  }

  hasDetection(frame: number): boolean {
    if (!this.inBounds(frame)) return false
    return !isNaN(this.data[this.frameToOffset(frame)]!)
  }

  getDetection(frame: number): TrackDetection | null {
    if (!this.inBounds(frame)) return null
    const off = this.frameToOffset(frame)
    const d = this.data
    if (isNaN(d[off]!)) return null

    if (this.track.type === 'bbox') {
      return {
        type: 'bbox', frame,
        cx: d[off]!, cy: d[off + 1]!, w: d[off + 2]!, h: d[off + 3]!, conf: d[off + 4]!,
      }
    }

    if (this.track.type === 'point') {
      return { type: 'point', frame, x: d[off]!, y: d[off + 1]!, conf: d[off + 2]! }
    }

    // keypoint
    const ids = this.track.keypointSchema?.ids ?? []
    const keypoints = ids.map((id, k) => ({
      id, x: d[off + k * 3]!, y: d[off + k * 3 + 1]!, conf: d[off + k * 3 + 2]!,
    }))
    return { type: 'keypoint', frame, keypoints }
  }

  /** Write values for a single frame. values must match stride length. */
  setDetection(frame: number, values: ArrayLike<number>): void {
    if (!this.inBounds(frame)) return
    this.data.set(values, this.frameToOffset(frame))
  }

  /**
   * Returns trajectory anchor positions over [frameStart, frameEnd] (inclusive).
   * For bbox: center. For point: the point. For keypoint: trajectoryKeypoint (or ids[0]).
   */
  trajectory(frameStart: number, frameEnd: number): TrajectoryPoint[] {
    const lo = Math.max(frameStart, this.track.frameStart)
    const hi = Math.min(frameEnd, this.track.frameStart + this.track.frameCount - 1)
    const result: TrajectoryPoint[] = []

    const rootId = this.track.keypointSchema?.trajectoryKeypoint ?? this.track.keypointSchema?.ids[0]
    const rootIdx = rootId ? (this.track.keypointSchema?.ids.indexOf(rootId) ?? 0) : 0

    for (let f = lo; f <= hi; f++) {
      const off = this.frameToOffset(f)
      const d = this.data
      if (isNaN(d[off]!)) continue

      if (this.track.type === 'bbox') {
        result.push({ frame: f, x: d[off]!, y: d[off + 1]! })
      } else if (this.track.type === 'point') {
        result.push({ frame: f, x: d[off]!, y: d[off + 1]! })
      } else {
        const kOff = off + rootIdx * 3
        result.push({ frame: f, x: d[kOff]!, y: d[kOff + 1]! })
      }
    }

    return result
  }
}

// Events

type TrackStoreEvents = {
  'track-set:add':         [set: TrackSet]
  'track-set:update':      [set: TrackSet]
  'track-set:remove':      [id: ID]
  /** Fired after detection buffer for a track is loaded from sidecar. */
  'track-set:data-loaded': [trackSetId: ID, trackId: ID]
  'coordinate-frame:add':    [frame: CoordinateFrame]
  'coordinate-frame:update': [frame: CoordinateFrame]
  'coordinate-frame:remove': [id: ID]
  'reset': []
}

// TrackSetStore

export class TrackSetStore extends TypedEmitter<TrackStoreEvents> {
  readonly ydoc: Y.Doc

  private yTrackSets:        Y.Map<TrackSet>
  private yCoordinateFrames: Y.Map<CoordinateFrame>

  /** Detection buffers keyed by `"${trackSetId}/${trackId}"`. */
  private readonly _buffers = new Map<string, TrackDataBuffer>()

  constructor(ydoc: Y.Doc = new Y.Doc()) {
    super()
    this.ydoc              = ydoc
    this.yTrackSets        = ydoc.getMap('trackSets')
    this.yCoordinateFrames = ydoc.getMap('coordinateFrames')
    this._setupObservers()
  }

  /** Y types owned by this store - pass to UndoManager if undo is desired. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getYTypes(): Y.AbstractType<any>[] {
    return [this.yTrackSets, this.yCoordinateFrames]
  }

  private _key(trackSetId: ID, trackId: ID): string {
    return `${trackSetId}/${trackId}`
  }

  private _setupObservers(): void {
    this.yTrackSets.observe((event, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      for (const [id, change] of event.changes.keys) {
        if (change.action === 'delete') this.emit('track-set:remove', id)
        else if (change.action === 'add') this.emit('track-set:add', event.target.get(id)!)
        else this.emit('track-set:update', event.target.get(id)!)
      }
    })

    this.yCoordinateFrames.observe((event, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      for (const [id, change] of event.changes.keys) {
        if (change.action === 'delete') this.emit('coordinate-frame:remove', id)
        else if (change.action === 'add') this.emit('coordinate-frame:add', event.target.get(id)!)
        else this.emit('coordinate-frame:update', event.target.get(id)!)
      }
    })
  }

  // --- Track Sets ---

  addTrackSet(name: string, videoRef: string, frameRate: number, id: ID = newId()): TrackSet {
    const ts: TrackSet = { id, name, videoRef, frameRate, tracks: [] }
    this.ydoc.transact(() => { this.yTrackSets.set(id, ts) }, USER_ORIGIN)
    return ts
  }

  /**
   * Add a track to an existing TrackSet and allocate its detection buffer.
   * Detection data must be loaded separately via setDetection() or loadBuffer().
   */
  addTrack(trackSetId: ID, track: Omit<Track, 'id'>, id: ID = newId()): Track | null {
    const ts = this.yTrackSets.get(trackSetId)
    if (!ts) return null
    const t: Track = { id, ...track }
    this._buffers.set(this._key(trackSetId, id), new TrackDataBuffer(t))
    this.ydoc.transact(() => {
      this.yTrackSets.set(trackSetId, { ...ts, tracks: [...ts.tracks, t] })
    }, USER_ORIGIN)
    return t
  }

  removeTrackSet(id: ID): void {
    const ts = this.yTrackSets.get(id)
    if (!ts) return
    for (const t of ts.tracks) this._buffers.delete(this._key(id, t.id))
    this.ydoc.transact(() => { this.yTrackSets.delete(id) }, USER_ORIGIN)
  }

  getTrackSet(id: ID): TrackSet | undefined  { return this.yTrackSets.get(id) }
  allTrackSets(): TrackSet[]                 { return Array.from(this.yTrackSets.values()) }

  getTrack(trackSetId: ID, trackId: ID): Track | undefined {
    return this.yTrackSets.get(trackSetId)?.tracks.find(t => t.id === trackId)
  }

  // --- Detection data ---

  /**
   * Load a pre-built Float32Array for a track (called by the sidecar deserializer).
   * The array must be laid out as frameCount * stride floats with NaN = missing.
   */
  loadBuffer(trackSetId: ID, trackId: ID, data: Float32Array): void {
    const track = this.getTrack(trackSetId, trackId)
    if (!track) return
    this._buffers.set(this._key(trackSetId, trackId), TrackDataBuffer.fromExisting(track, data))
    this.emit('track-set:data-loaded', trackSetId, trackId)
  }

  /** Raw Float32Array for sidecar serialization. Do not mutate. */
  getBuffer(trackSetId: ID, trackId: ID): Float32Array | undefined {
    return this._buffers.get(this._key(trackSetId, trackId))?.data
  }

  getDetectionAt(trackSetId: ID, trackId: ID, frame: number): TrackDetection | null {
    return this._buffers.get(this._key(trackSetId, trackId))?.getDetection(frame) ?? null
  }

  /** Write a single frame's detection. values must match the track's stride length. */
  setDetection(trackSetId: ID, trackId: ID, frame: number, values: ArrayLike<number>): void {
    this._buffers.get(this._key(trackSetId, trackId))?.setDetection(frame, values)
  }

  /**
   * Trajectory anchor positions over a frame range (inclusive).
   * Omit frameStart/frameEnd to get the full track extent.
   * Used by the canvas overlay and map panel for rendering.
   */
  trajectory(
    trackSetId: ID, trackId: ID,
    frameStart?: number, frameEnd?: number,
  ): TrajectoryPoint[] {
    const buf = this._buffers.get(this._key(trackSetId, trackId))
    if (!buf) return []
    const lo = frameStart ?? buf.track.frameStart
    const hi = frameEnd   ?? (buf.track.frameStart + buf.track.frameCount - 1)
    return buf.trajectory(lo, hi)
  }

  /** Presence time range for timeline bar rendering. */
  presenceRange(trackSetId: ID, trackId: ID): { startSeconds: number; endSeconds: number } | null {
    const ts = this.yTrackSets.get(trackSetId)
    if (!ts) return null
    const track = ts.tracks.find(t => t.id === trackId)
    if (!track) return null
    return {
      startSeconds: track.frameStart / ts.frameRate,
      endSeconds:   (track.frameStart + track.frameCount) / ts.frameRate,
    }
  }

  // --- Coordinate Frames ---

  addCoordinateFrame(frame: Omit<CoordinateFrame, 'id'>, id: ID = newId()): CoordinateFrame {
    const cf: CoordinateFrame = { id, ...frame }
    this.ydoc.transact(() => { this.yCoordinateFrames.set(id, cf) }, USER_ORIGIN)
    return cf
  }

  updateCoordinateFrame(id: ID, patch: Partial<Omit<CoordinateFrame, 'id'>>): void {
    const cf = this.yCoordinateFrames.get(id)
    if (!cf) return
    this.ydoc.transact(() => { this.yCoordinateFrames.set(id, { ...cf, ...patch }) }, USER_ORIGIN)
  }

  removeCoordinateFrame(id: ID): void {
    if (!this.yCoordinateFrames.has(id)) return
    this.ydoc.transact(() => { this.yCoordinateFrames.delete(id) }, USER_ORIGIN)
  }

  getCoordinateFrame(id: ID): CoordinateFrame | undefined { return this.yCoordinateFrames.get(id) }
  allCoordinateFrames(): CoordinateFrame[]                { return Array.from(this.yCoordinateFrames.values()) }

  // --- Serialization (metadata only; detection buffers live in binary sidecar) ---

  toJSON(): { trackSets: TrackSetJSON[]; coordinateFrames: CoordinateFrameJSON[] } {
    return {
      trackSets:        this.allTrackSets(),
      coordinateFrames: this.allCoordinateFrames(),
    }
  }

  loadJSON(data: { trackSets?: TrackSetJSON[]; coordinateFrames?: CoordinateFrameJSON[] }): void {
    this.ydoc.transact(() => {
      this.yTrackSets.clear()
      this.yCoordinateFrames.clear()
      this._buffers.clear()

      for (const ts of data.trackSets ?? []) {
        this.yTrackSets.set(ts.id, ts)
        for (const t of ts.tracks) {
          // Allocate empty buffers; filled by loadBuffer() once the sidecar is read.
          this._buffers.set(this._key(ts.id, t.id), new TrackDataBuffer(t))
        }
      }

      for (const cf of data.coordinateFrames ?? []) {
        this.yCoordinateFrames.set(cf.id, cf)
      }
    }, LOAD_ORIGIN)

    this.emit('reset')
  }
}
