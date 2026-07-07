// PM-free entry point. No runtime dep on prosemirror-model/state.
// Standalone consumers (scripts, servers) can use stores/tokenizer/query without the editor stack.
// The full @mumo/core entry re-exports everything here plus the PM schema and plugins.

export { importCoco, importMot } from './importers/index.js'
export type { CocoImportOpts, MotImportOpts } from './importers/index.js'
export { TrackSetStore } from './track-store.js'
export type {
  TrackSet, Track, CoordinateFrame,
  BBoxDetection, PointDetection, KeypointDetection, TrackDetection,
  TrajectoryPoint,
} from './track-store.js'
export { COCO_KEYPOINT_SCHEMA } from './track-types.js'
export type {
  TrackType, CoordinateSpace, KeypointSchemaJSON,
  TrackSetJSON, TrackJSON, CoordinateFrameJSON,
} from './track-types.js'
export { newId } from './id.js'
export { tokenizeString, parseGapDuration, DEFAULT_PUNCT_CHARS } from './tokenize.js'
export type { TokenFragment, TokenKind, TokenizeOpts } from './tokenize.js'
export { TokenStore } from './token-store.js'
export type { RebuildResult } from './token-store.js'
export { AnnotationStore, USER_ORIGIN, LOAD_ORIGIN, DRAG_ORIGIN, DEFAULT_LT_ID, TOKEN_LT_ID, TOKEN_LT_II_ID, isTokenLtId } from './store.js'
export type {
  Annotation, Relation,
  TierDef, TierConstraint,
  ControlledVocabulary, VocabEntry, TextletCode,
  LinguisticType,
  MetricType, MetricSchema, SlotSchema, PatternSchema,
  MetricValue, SlotInstance, Pattern,
  PatternGroupType, PatternGroupNode, PatternGroup,
  ConstraintViolation,
  SuggestedChange, Suggestion,
  Bookmark,
} from './store.js'
export { applySuggestedChange } from './suggestions.js'
export { TypedEmitter } from './events.js'
export { TimeIntervalTree } from './interval-tree.js'
export { TimeKeeper } from './time-keeper.js'
export type { SlotTextStyle } from './types.js'
export type * from './types.js'
export { baseTextContent, patternLabel, getMarkText, getWordRangeText, getTokenText, getUttLabel, patternDocPos, patternLineNums, sortPatternsByDocPos } from './utils.js'
export type { PMNode } from './utils.js'
export { MumoContext, TokenView, AnnotationView, SlotView, PatternView, utteranceRefOf } from './query.js'
export { orderTiersDepthFirst, buildTierDepths } from './tier-utils.js'
export { buildPermalink, parsePermalink, docKeyForPath } from './permalink.js'
export type { PermalinkTarget, PermalinkRefType } from './permalink.js'
