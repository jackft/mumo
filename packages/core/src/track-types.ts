import type { ID } from './types.js'

// Keypoint schema

export interface KeypointSchemaJSON {
  ids: string[]
  edges: [string, string][]
  /** ID of the keypoint to use as the 2D trajectory anchor point. Defaults to ids[0]. */
  trajectoryKeypoint?: string
}

/** COCO 17-point person skeleton (center-normalized video coordinates). */
export const COCO_KEYPOINT_SCHEMA: KeypointSchemaJSON = {
  ids: [
    'nose',
    'left_eye', 'right_eye',
    'left_ear', 'right_ear',
    'left_shoulder', 'right_shoulder',
    'left_elbow', 'right_elbow',
    'left_wrist', 'right_wrist',
    'left_hip', 'right_hip',
    'left_knee', 'right_knee',
    'left_ankle', 'right_ankle',
  ],
  edges: [
    ['nose', 'left_eye'],       ['nose', 'right_eye'],
    ['left_eye', 'left_ear'],   ['right_eye', 'right_ear'],
    ['left_shoulder', 'right_shoulder'],
    ['left_shoulder', 'left_elbow'],   ['left_elbow', 'left_wrist'],
    ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
    ['left_shoulder', 'left_hip'],     ['right_shoulder', 'right_hip'],
    ['left_hip', 'right_hip'],
    ['left_hip', 'left_knee'],   ['left_knee', 'left_ankle'],
    ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
  ],
  trajectoryKeypoint: 'left_hip', // mid-body anchor; override per-schema as needed
}

// Track metadata

export type TrackType = 'bbox' | 'point' | 'keypoint'
export type CoordinateSpace = 'video' | 'world'

export interface TrackJSON {
  id: ID
  name: string
  type: TrackType
  coordinateSpace: CoordinateSpace
  /** First frame index (0-based) with detection data. */
  frameStart: number
  /** Number of frames in the detection buffer (frameEnd = frameStart + frameCount - 1). */
  frameCount: number
  /** Required when type === 'keypoint'. */
  keypointSchema?: KeypointSchemaJSON
  /** Which CoordinateFrame this track lives in. Required when coordinateSpace === 'world'. */
  coordinateFrameId?: ID
}

export interface TrackSetJSON {
  id: ID
  name: string
  /** Filename of the associated video (relative to the .mumo archive). */
  videoRef: string
  frameRate: number
  tracks: TrackJSON[]
}

// Coordinate frames (world-space maps)

export interface CoordinateFrameJSON {
  id: ID
  name: string
  /** Filename of the SVG map within the .mumo sidecar. */
  svgFile: string
  /** Human-readable unit label, e.g. 'meters'. */
  unit: string
  /** World-space bounding box of the map. */
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number }
  /**
   * Affine transform from SVG user-units to world coordinates:
   *   worldX = svgX * scaleX + translateX
   *   worldY = svgY * scaleY + translateY
   */
  svgToWorld: { translateX: number; translateY: number; scaleX: number; scaleY: number }
}
