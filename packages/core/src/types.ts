export type ID = string

export interface NoteEntry {
  text: string
  createdAt: number
}

import type { TrackSetJSON, CoordinateFrameJSON } from './track-types.js'
export type { TrackSetJSON, CoordinateFrameJSON }

export interface UtteranceAttrs {
  id: ID
  participant: string
  startTimeSeconds: number | null
  endTimeSeconds: number | null
}

export interface TokenRecord {
  id: ID
  uttId: ID
  kind: 'word' | 'ws' | 'punct' | 'action' | 'gap'
  text: string
  startOffset: number
  endOffset: number
}

export interface AnnotationMarkAttrs {
  id: ID
}

export interface ParticipantJSON {
  id: ID
  label: string
  attrs?: Record<string, string>
}

export interface TierDefJSON {
  id: ID
  name: string
  parentTierId?: ID
  linguisticTypeId?: ID
  participant?: string
  annotator?: string
  defaultLocale?: string
  /** If true, utterance-level SA annotations on this tier are shown inline in the transcript editor. */
  inlineGloss?: boolean
  /** If set, tier lane renders as a track visualization backed by this track. */
  trackRef?: { trackSetId: ID; trackId: ID }
}

export interface LinguisticTypeJSON {
  id: ID
  name: string
  constraint?: 'time_subdivision' | 'included_in' | 'symbolic_association' | 'symbolic_subdivision'
  vocabularyId?: ID
}

export interface VocabEntryJSON {
  id: ID
  value: string
  description?: string
  langRef?: string
}

export interface VocabularyJSON {
  id: ID
  name: string
  entries: VocabEntryJSON[]
  extRefUrl?: string  // EAF EXTERNAL_REF value (URL to external .ecv file)
}

export interface SymbolDef {
  unicode: string
  shortcut?: string
  description?: string
}

export type MetricType = 'categorical' | 'text' | 'boolean' | 'participant'

export interface MetricSchemaJSON {
  id: ID
  name: string
  type: MetricType
  vocabularyId?: ID
  required?: boolean
}

export interface SlotTextStyle {
  textColor?: string
  backgroundColor?: string
  borderColor?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}

export interface SlotSchemaJSON {
  id: ID
  name: string
  label?: string
  anchorKind: 'span' | 'utterance' | 'pattern' | 'any'
  required?: boolean
  variadic?: boolean
  style?: SlotTextStyle
  metrics: MetricSchemaJSON[]
}

export interface PatternSchemaJSON {
  id: ID
  name: string
  description?: string
  color?: number
  slots: SlotSchemaJSON[]
  hotkey?: string
}

export interface MetricValueJSON {
  schemaId: ID
  value: string | boolean | number | null
}

export interface SlotInstanceJSON {
  id: ID
  schemaSlotId: ID
  annotationId: ID
  metrics: MetricValueJSON[]
}

export interface PatternJSON {
  id: ID
  schemaId: ID
  slots: SlotInstanceJSON[]
  notes?: Record<string, NoteEntry[]>
}

export type PatternGroupType = 'set' | 'tree'

export interface PatternGroupNodeJSON {
  patternId: ID
  children?: PatternGroupNodeJSON[]
}

export interface PatternGroupJSON {
  id: ID
  type: PatternGroupType
  label?: string
  patternIds?: ID[]
  root?: PatternGroupNodeJSON
}

export interface BookmarkJSON {
  id: ID
  label: string
  startSeconds: number
  endSeconds: number
  note?: string
  code?: string
  createdAt?: number
}

export interface DocumentJSON {
  version: 1
  doc: unknown // ProseMirror JSON
  annotations: AnnotationJSON[]
  tiers: TierDefJSON[]
  vocabularies: VocabularyJSON[]
  linguisticTypes: LinguisticTypeJSON[]
  patternSchemas: PatternSchemaJSON[]
  patterns: PatternJSON[]
  bookmarks?: BookmarkJSON[]
  participants?: ParticipantJSON[]
  trackSets?: TrackSetJSON[]
  coordinateFrames?: CoordinateFrameJSON[]
}

// Free-form feature bag. Named keys are structural (store indexes them); arbitrary keys also allowed.
export interface AnnotationFeatures {
  /** Tier this annotation belongs to (drives ordered lists + tier index). */
  tierId?: ID
  /** Parent annotation for ELAN-style child tiers (drives children index). */
  parentAnnId?: ID
  /** Parent token for token-subtier annotations (drives token-children index). */
  tokenNodeId?: ID
  /** Utterance reference used by symbolic utterance-level annotations. */
  utteranceId?: ID
  /** Legacy spelling of utteranceId (written by EAF import); prefer utteranceId. */
  blockNodeId?: ID
  [key: string]: unknown
}

export interface AnnotationJSON {
  id: ID
  type: string
  anchors: AnchorJSON[]
  features: AnnotationFeatures
}

export type AnchorJSON =
  | { type: 'mark'; markId: ID }
  | { type: 'word-range'; fromWordId: ID; toWordId: ID }
  | { type: 'time'; start: number; end: number }
  | { type: 'utterance'; uttId: ID }
  | { type: 'token'; tokenId: ID; startOffset?: number; endOffset?: number }
  | { type: 'block'; blockId: ID }
  | {
      type: 'track-segment'
      trackSetId: ID
      trackId: ID
      frameStart: number
      frameEnd: number
      /** Optional keypoint IDs when the annotation refers to specific body parts. */
      keypointIds?: string[]
    }

export interface RelationJSON {
  id: ID
  type: string
  source: ID
  target: ID
}
