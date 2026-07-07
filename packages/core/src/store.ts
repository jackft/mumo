import * as Y from 'yjs'
import { TypedEmitter } from './events.js'
import { TimeIntervalTree } from './interval-tree.js'
import type {
  ID, AnnotationJSON, AnchorJSON, AnnotationFeatures,
  TierDefJSON, VocabularyJSON, LinguisticTypeJSON,
  MetricType, PatternSchemaJSON, PatternJSON,
  PatternGroupType, ParticipantJSON, SymbolDef, NoteEntry,
} from './types.js'
export type { AnnotationFeatures }
export type { SymbolDef }
export type { ParticipantJSON }
import { newId } from './id.js'
import { applySuggestedChange } from './suggestions.js'
import type { TokenizeOpts } from './tokenize.js'
export type { TokenizeOpts }
import type { PMNode } from './utils.js'

// Annotation model

export interface Annotation {
  id: ID
  type: string
  anchors: AnchorJSON[]
  features: AnnotationFeatures
}

export interface Relation {
  id: ID
  type: string
  source: ID
  target: ID
}

export type TierConstraint = 'time_subdivision' | 'included_in' | 'symbolic_association' | 'symbolic_subdivision'

export interface ConstraintViolation {
  kind: 'out_of_parent' | 'sibling_overlap' | 'symbolic_no_time'
  message: string
}

export interface TierDef {
  id: ID
  name: string
  parentTierId?: ID
  linguisticTypeId: ID
  participant?: string
  annotator?: string
  defaultLocale?: string
  /** If true, this tier mirrors PM utterance nodes - one annotation per utterance, same ID. */
  isUttTier?: boolean
  /** If true, utterance-level SA annotations on this tier are shown inline in the transcript editor. */
  inlineGloss?: boolean
  /** If set, tier lane renders as a track visualization backed by this track. */
  trackRef?: { trackSetId: ID; trackId: ID }
}

export const DEFAULT_LT_ID = 'default-lt'
export const TOKEN_LT_ID    = 'lt-token'
export const TOKEN_LT_II_ID = 'lt-token-ii'
/** Returns true for any linguisticTypeId that marks a tier as the PM token layer. */
export function isTokenLtId(id: string): boolean { return id === TOKEN_LT_ID || id === TOKEN_LT_II_ID }


export interface LinguisticType {
  id: ID
  name: string
  constraint?: TierConstraint
  vocabularyId?: ID
}

export interface VocabEntry {
  id: ID
  value: string
  description?: string
  langRef?: string
}

export interface ControlledVocabulary {
  id: ID
  name: string
  entries: VocabEntry[]
  extRefUrl?: string
}

export interface TextletCode {
  value: string
  vocabEntryId?: string
  vocabId?: string
}

// Pattern model

export type { MetricType }

export interface MetricSchema {
  id: ID
  name: string
  type: MetricType
  vocabularyId?: ID
  required?: boolean
}

export interface SlotSchema {
  id: ID
  name: string
  label?: string
  variadic?: boolean
  style?: import('./types.js').SlotTextStyle
  anchorKind: 'span' | 'utterance' | 'pattern' | 'any'
  required?: boolean
  metrics: MetricSchema[]
}

export interface PatternSchema {
  id: ID
  name: string
  description?: string
  color?: number
  slots: SlotSchema[]
  hotkey?: string
}

export interface MetricValue {
  schemaId: ID
  value: string | boolean | number | null
}

export interface SlotInstance {
  id: ID
  schemaSlotId: ID
  annotationId: ID
  metrics: MetricValue[]
}

export interface Pattern {
  id: ID
  schemaId: ID
  slots: SlotInstance[]
  notes?: Record<string, NoteEntry[]>
}

// Slots/notes live in separate Y maps so concurrent edits to different slots merge cleanly.
// Legacy docs may carry embedded slots/notes here; migrated on first write.
interface PatternMeta {
  id: ID
  schemaId: ID
  /** Legacy embedded slots (pre per-slot storage). Present = not yet migrated. */
  slots?: SlotInstance[]
  /** Legacy embedded notes (pre per-slot storage). */
  notes?: Record<string, NoteEntry[]>
}

/** Slot instance as stored in yPatternSlots; ord preserves array order. */
interface StoredSlot extends SlotInstance {
  ord: number
}

export type { PatternGroupType }

export interface PatternGroupNode {
  patternId: ID
  children?: PatternGroupNode[]
}

export interface PatternGroup {
  id: ID
  type: PatternGroupType
  label?: string
  patternIds?: ID[]
  root?: PatternGroupNode
}

// Bookmark model

export interface Bookmark {
  id: ID
  label: string
  startSeconds: number
  endSeconds: number
  // explicit undefined is allowed: passing { note: undefined } to
  // updateBookmark clears the field via spread merge
  note?: string | undefined
  code?: string | undefined
  createdAt?: number
}

export type { NoteEntry }

// Suggestion model

export type SuggestedChange =
  | { type: 'textlet:add';         annotation: Annotation }
  | { type: 'textlet:delete';      textletId: ID }
  | { type: 'textlet:add-code';    textletId: ID; code: TextletCode }
  | { type: 'textlet:remove-code'; textletId: ID; code: TextletCode }
  | { type: 'pattern:add';           patternId: ID; schemaId: ID; note?: string }
  | { type: 'pattern:delete';        patternId: ID }
  | { type: 'pattern:fill-slot';     patternId: ID; slot: SlotInstance; pendingAnnotation?: Annotation }
  | { type: 'pattern:fill-metric';   patternId: ID; slotSchemaId: ID; metricId: ID; value: string | boolean | number | null }
  | { type: 'annotation:add';      annotation: Annotation }
  | { type: 'annotation:delete';   annotationId: ID }
  | { type: 'annotation:update';   annotationId: ID; patch: Partial<Omit<Annotation, 'id'>> }
  | { type: 'pm:replace';          uttId: ID; fromOffset: number; toOffset: number; replacement: string }
  | { type: 'utt:set-participant'; uttId: ID; participant: string }
  | { type: 'utt:set-time';        uttId: ID; startTime: number; endTime: number }

export interface Suggestion {
  id: ID
  authorId: string        // e.g. 'user:alice'
  createdAt: number       // ms since epoch
  change: SuggestedChange
  note?: string           // rationale or comment
}

// Events

type StoreEvents = {
  'annotation:add': [annotation: Annotation]
  'annotation:update': [annotation: Annotation]
  'annotation:remove': [id: ID]
  'annotations:changed': []
  'relation:add': [relation: Relation]
  'relation:remove': [id: ID]
  'tier:add': [tier: TierDef]
  'tier:update': [tier: TierDef]
  'tier:remove': [id: ID]
  'tiers:changed': []
  'vocabulary:add': [vocab: ControlledVocabulary]
  'vocabulary:update': [vocab: ControlledVocabulary]
  'vocabulary:remove': [id: ID]
  'linguistic-type:add': [lt: LinguisticType]
  'linguistic-type:update': [lt: LinguisticType]
  'linguistic-type:remove': [id: ID]
  'pattern-schema:add': [schema: PatternSchema]
  'pattern-schema:update': [schema: PatternSchema]
  'pattern-schema:remove': [id: ID]
  'pattern:add': [pattern: Pattern]
  'pattern:update': [pattern: Pattern]
  'pattern:remove': [id: ID]
  'pattern-group:add': [group: PatternGroup]
  'pattern-group:update': [group: PatternGroup]
  'pattern-group:remove': [id: ID]
  'suggestion:add': [suggestion: Suggestion]
  'suggestion:pre-accept': [suggestion: Suggestion]
  'suggestion:pre-reject': [suggestion: Suggestion]
  'suggestion:remove': [id: ID]
  'suggestions:changed': []
  'bookmark:add': [c: Bookmark]
  'bookmark:update': [c: Bookmark]
  'bookmark:remove': [id: ID]
  'bookmarks:changed': []
  'participant:changed': []
  'doc:change': [doc: PMNode]
  'token-times:changed': [ids: Set<ID>]
  'reset': []
}

// Origins

/** Yjs transaction origin used for user-initiated mutations (tracked by UndoManager). */
export const USER_ORIGIN: unique symbol = Symbol('user')

/** Yjs transaction origin used for file loads (not tracked by UndoManager). */
export const LOAD_ORIGIN: unique symbol = Symbol('load')

/** Yjs transaction origin used for live drag ticks (not tracked by UndoManager). */
export const DRAG_ORIGIN: unique symbol = Symbol('drag')

// Helpers

function removePatternFromTree(node: PatternGroupNode, patternId: ID): PatternGroupNode {
  const children = node.children
    ?.filter(c => c.patternId !== patternId)
    .map(c => removePatternFromTree(c, patternId))
  const result: PatternGroupNode = { patternId: node.patternId }
  if (children !== undefined) result.children = children
  return result
}

// Store

export class AnnotationStore extends TypedEmitter<StoreEvents> {
  readonly ydoc: Y.Doc

  private yAnnotations:     Y.Map<Annotation>
  private yRelations:       Y.Map<Relation>
  private yTiers:           Y.Map<TierDef>
  private yVocabularies:    Y.Map<ControlledVocabulary>
  private yLinguisticTypes: Y.Map<LinguisticType>
  private yPatternSchemas:    Y.Map<PatternSchema>
  private yPatterns:          Y.Map<PatternMeta>
  // Per-slot pattern storage: key = "${patternId}:${slotInstanceId}"
  private yPatternSlots:      Y.Map<StoredSlot>
  // Per-author pattern notes: key = "${patternId}:${authorId}"
  private yPatternNotes:      Y.Map<NoteEntry[]>
  private yPatternGroups:     Y.Map<PatternGroup>
  private ySuggestions:     Y.Map<Suggestion>
  private yBookmarks:           Y.Map<Bookmark>
  private yTokenTimes:      Y.Map<{ start: number | null; end: number | null}>
  // Ordered annotation lists: key = "${tierId}:${parentAnnId ?? ''}", value = Y.Array<annId>
  private yAnnotationLists: Y.Map<Y.Array<ID>>
  private yParticipants:    Y.Map<ParticipantJSON>
  private yConfig:          Y.Map<unknown>

  private timeIndex              = new TimeIntervalTree<ID>()
  private _childrenIndex         = new Map<ID, Set<ID>>()            // parentAnnId -> child ann IDs
  private _tokenChildrenIndex    = new Map<ID, Set<ID>>()            // tokenNodeId  -> child ann IDs
  private _annsByTier            = new Map<ID, Set<ID>>()
  private _tierChildrenIndex     = new Map<ID | undefined, TierDef[]>() // parentTierId -> child tiers
  private _relationsByEndpoint   = new Map<ID, Set<ID>>()            // ann/entity ID -> relation IDs
  private _annsByMark            = new Map<ID, Set<ID>>()            // markId -> ann IDs
  private _slotsByPattern        = new Map<ID, Map<ID, StoredSlot>>()   // patternId -> slotInstanceId -> slot
  private _notesByPattern        = new Map<ID, Map<string, NoteEntry[]>>() // patternId -> authorId -> notes

  /** Optional: inject track presence bounds for annotation time validation. */
  trackPresenceProvider: ((trackSetId: ID, trackId: ID) => { startSeconds: number; endSeconds: number } | null) | null = null

  constructor(ydoc: Y.Doc = new Y.Doc()) {
    super()
    this.ydoc             = ydoc
    this.yAnnotations     = ydoc.getMap('annotations')
    this.yRelations       = ydoc.getMap('relations')
    this.yTiers           = ydoc.getMap('tiers')
    this.yVocabularies    = ydoc.getMap('vocabularies')
    this.yLinguisticTypes = ydoc.getMap('linguisticTypes')
    this.yPatternSchemas    = ydoc.getMap('patternSchemas')
    this.yPatterns          = ydoc.getMap('patterns')
    this.yPatternSlots      = ydoc.getMap('patternSlots')
    this.yPatternNotes      = ydoc.getMap('patternNotes')
    this.yPatternGroups     = ydoc.getMap('patternGroups')
    this.ySuggestions     = ydoc.getMap('suggestions')
    this.yBookmarks           = ydoc.getMap('bookmarks')
    this.yTokenTimes      = ydoc.getMap('tokenTimes')
    this.yAnnotationLists = ydoc.getMap('annotationLists')
    this.yParticipants    = ydoc.getMap('participants')
    this.yConfig          = ydoc.getMap('config')

    this._setupObservers()
    this._rebuildIndexes()
  }

  /** Returns all Y types owned by this store (for UndoManager scope). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getYTypes(): Y.AbstractType<any>[] {
    return [
      this.yAnnotations, this.yRelations, this.yTiers, this.yVocabularies,
      this.yLinguisticTypes, this.yPatternSchemas, this.yPatterns,
      this.yPatternSlots, this.yPatternNotes, this.yPatternGroups,
      this.ySuggestions, this.yBookmarks, this.yTokenTimes, this.yAnnotationLists, this.yParticipants,
    ]
  }

  // Annotation list helpers

  private _listKey(tierId: ID, parentAnnId: ID | undefined): string {
    return `${tierId}:${parentAnnId ?? ''}`
  }

  private _getList(tierId: ID, parentAnnId: ID | undefined): Y.Array<ID> | undefined {
    return this.yAnnotationLists.get(this._listKey(tierId, parentAnnId))
  }

  /** Must be called inside a Yjs transaction. */
  private _getOrCreateList(tierId: ID, parentAnnId: ID | undefined): Y.Array<ID> {
    const key = this._listKey(tierId, parentAnnId)
    let list = this.yAnnotationLists.get(key)
    if (!list) {
      list = new Y.Array<ID>()
      this.yAnnotationLists.set(key, list)
    }
    return list
  }

  private _rebuildIndexes(): void {
    this.timeIndex.clear()
    this._childrenIndex.clear()
    this._tokenChildrenIndex.clear()
    this._annsByTier.clear()
    this._tierChildrenIndex.clear()
    this._relationsByEndpoint.clear()
    this._annsByMark.clear()
    this._slotsByPattern.clear()
    this._notesByPattern.clear()
    for (const tier of this.yTiers.values()) this._addToTierChildrenIndex(tier)
    for (const ann of this.yAnnotations.values()) {
      for (const a of ann.anchors) {
        if (a.type === 'time') this.timeIndex.insert(a.start, a.end, ann.id)
      }
      this._addToChildIndex(ann.id, ann.features.parentAnnId, ann.features.tokenNodeId)
      this._addToTierIndex(ann.id, ann.features.tierId)
      this._addToMarkIndex(ann)
    }
    for (const rel of this.yRelations.values()) this._addToRelationIndex(rel)
    for (const [key, slot] of this.yPatternSlots) this._addToSlotIndex(key, slot)
    for (const [key, notes] of this.yPatternNotes) this._addToNotesIndex(key, notes)
  }

  private _addToRelationIndex(rel: Relation): void {
    for (const endpoint of [rel.source, rel.target]) {
      let set = this._relationsByEndpoint.get(endpoint)
      if (!set) { set = new Set(); this._relationsByEndpoint.set(endpoint, set) }
      set.add(rel.id)
    }
  }

  private _removeFromRelationIndex(rel: Relation): void {
    for (const endpoint of [rel.source, rel.target]) {
      const set = this._relationsByEndpoint.get(endpoint)
      if (!set) continue
      set.delete(rel.id)
      if (set.size === 0) this._relationsByEndpoint.delete(endpoint)
    }
  }

  private _addToMarkIndex(ann: Annotation): void {
    for (const a of ann.anchors) {
      if (a.type !== 'mark') continue
      let set = this._annsByMark.get(a.markId)
      if (!set) { set = new Set(); this._annsByMark.set(a.markId, set) }
      set.add(ann.id)
    }
  }

  private _removeFromMarkIndex(ann: Annotation): void {
    for (const a of ann.anchors) {
      if (a.type !== 'mark') continue
      const set = this._annsByMark.get(a.markId)
      if (!set) continue
      set.delete(ann.id)
      if (set.size === 0) this._annsByMark.delete(a.markId)
    }
  }

  private _addToSlotIndex(key: string, slot: StoredSlot): void {
    const patternId = key.slice(0, key.indexOf(':'))
    let map = this._slotsByPattern.get(patternId)
    if (!map) { map = new Map(); this._slotsByPattern.set(patternId, map) }
    map.set(slot.id, slot)
  }

  private _removeFromSlotIndex(key: string, slot: StoredSlot): void {
    const patternId = key.slice(0, key.indexOf(':'))
    const map = this._slotsByPattern.get(patternId)
    if (!map) return
    map.delete(slot.id)
    if (map.size === 0) this._slotsByPattern.delete(patternId)
  }

  private _addToNotesIndex(key: string, notes: NoteEntry[]): void {
    const sep = key.indexOf(':')
    const patternId = key.slice(0, sep)
    const authorId  = key.slice(sep + 1)
    let map = this._notesByPattern.get(patternId)
    if (!map) { map = new Map(); this._notesByPattern.set(patternId, map) }
    map.set(authorId, notes)
  }

  private _removeFromNotesIndex(key: string): void {
    const sep = key.indexOf(':')
    const patternId = key.slice(0, sep)
    const map = this._notesByPattern.get(patternId)
    if (!map) return
    map.delete(key.slice(sep + 1))
    if (map.size === 0) this._notesByPattern.delete(patternId)
  }

  private _addToChildIndex(childId: ID, parentAnnId: ID | undefined, tokenNodeId?: ID): void {
    if (parentAnnId) {
      let set = this._childrenIndex.get(parentAnnId)
      if (!set) { set = new Set(); this._childrenIndex.set(parentAnnId, set) }
      set.add(childId)
    }
    if (tokenNodeId) {
      let set = this._tokenChildrenIndex.get(tokenNodeId)
      if (!set) { set = new Set(); this._tokenChildrenIndex.set(tokenNodeId, set) }
      set.add(childId)
    }
  }

  private _removeFromChildIndex(childId: ID, parentAnnId: ID | undefined, tokenNodeId?: ID): void {
    if (parentAnnId) this._childrenIndex.get(parentAnnId)?.delete(childId)
    if (tokenNodeId)  this._tokenChildrenIndex.get(tokenNodeId)?.delete(childId)
  }

  private _addToTierIndex(annId: ID, tierId: ID | undefined): void {
    if (!tierId) return
    let set = this._annsByTier.get(tierId)
    if (!set) { set = new Set(); this._annsByTier.set(tierId, set) }
    set.add(annId)
  }

  private _removeFromTierIndex(annId: ID, tierId: ID | undefined): void {
    if (!tierId) return
    this._annsByTier.get(tierId)?.delete(annId)
  }

  private _addToTierChildrenIndex(tier: TierDef): void {
    const key = tier.parentTierId
    let arr = this._tierChildrenIndex.get(key)
    if (!arr) { arr = []; this._tierChildrenIndex.set(key, arr) }
    arr.push(tier)
  }

  private _removeFromTierChildrenIndex(tier: TierDef): void {
    const arr = this._tierChildrenIndex.get(tier.parentTierId)
    if (!arr) return
    const i = arr.findIndex(t => t.id === tier.id)
    if (i !== -1) arr.splice(i, 1)
  }

  /** Untyped emit escape hatch for the generic observer helper. */
  private _emitAny(event: string, ...args: unknown[]): void {
    (this.emit as (e: string, ...a: unknown[]) => void)(event, ...args)
  }

  // Wires add/update/remove observers on a Y.Map. Omit names.update to skip update events.
  // Hooks run before events emit so indexes are updated first.
  private _observeSimple<T>(
    yMap: Y.Map<T>,
    names: { add: string; update?: string; remove: string; changed?: string },
    hooks: {
      added?:   (id: ID, value: T) => void
      updated?: (id: ID, oldValue: T, newValue: T) => void
      removed?: (id: ID, oldValue: T) => void
    } = {},
  ): void {
    yMap.observe((event, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      for (const [id, change] of event.changes.keys) {
        if (change.action === 'delete') {
          const old = change.oldValue as T
          hooks.removed?.(id, old)
          this._emitAny(names.remove, id)
        } else if (change.action === 'add') {
          const value = event.target.get(id) as T
          hooks.added?.(id, value)
          this._emitAny(names.add, value)
        } else {
          const value = event.target.get(id) as T
          hooks.updated?.(id, change.oldValue as T, value)
          if (names.update) this._emitAny(names.update, value)
        }
      }
      if (names.changed) this._emitAny(names.changed)
    })
  }

  private _setupObservers(): void {
    this.yAnnotations.observe((event, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      for (const [id, change] of event.changes.keys) {
        if (change.action === 'delete') {
          const old = change.oldValue as Annotation
          for (const a of old.anchors) {
            if (a.type === 'time') this.timeIndex.remove(a.start, a.end, id)
          }
          this._removeFromChildIndex(id, old.features.parentAnnId, old.features.tokenNodeId)
          this._removeFromTierIndex(id, old.features.tierId)
          this._removeFromMarkIndex(old)
          this._childrenIndex.delete(id)
          this._tokenChildrenIndex.delete(id)
          this.emit('annotation:remove', id)
        } else if (change.action === 'add') {
          const ann = event.target.get(id)!
          for (const a of ann.anchors) {
            if (a.type === 'time') this.timeIndex.insert(a.start, a.end, ann.id)
          }
          this._addToChildIndex(id, ann.features.parentAnnId, ann.features.tokenNodeId)
          this._addToTierIndex(id, ann.features.tierId)
          this._addToMarkIndex(ann)
          this.emit('annotation:add', ann)
        } else {
          const newVal = event.target.get(id)!
          const oldVal = change.oldValue as Annotation
          for (const a of oldVal.anchors) {
            if (a.type === 'time') this.timeIndex.remove(a.start, a.end, id)
          }
          for (const a of newVal.anchors) {
            if (a.type === 'time') this.timeIndex.insert(a.start, a.end, id)
          }
          this._removeFromMarkIndex(oldVal)
          this._addToMarkIndex(newVal)
          if (oldVal.features.parentAnnId !== newVal.features.parentAnnId ||
              oldVal.features.tokenNodeId !== newVal.features.tokenNodeId) {
            this._removeFromChildIndex(id, oldVal.features.parentAnnId, oldVal.features.tokenNodeId)
            this._addToChildIndex(id, newVal.features.parentAnnId, newVal.features.tokenNodeId)
          }
          if (oldVal.features.tierId !== newVal.features.tierId) {
            this._removeFromTierIndex(id, oldVal.features.tierId)
            this._addToTierIndex(id, newVal.features.tierId)
          }
          this.emit('annotation:update', newVal)
        }
      }
      this.emit('annotations:changed')
    })

    this.yTiers.observe((event, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      for (const [id, change] of event.changes.keys) {
        if (change.action === 'delete') {
          this._removeFromTierChildrenIndex(change.oldValue as TierDef)
          this.emit('tier:remove', id)
        } else if (change.action === 'add') {
          const tier = event.target.get(id)!
          this._addToTierChildrenIndex(tier)
          this.emit('tier:add', tier)
        } else {
          const old = change.oldValue as TierDef
          const next = event.target.get(id)!
          if (old.parentTierId !== next.parentTierId) {
            this._removeFromTierChildrenIndex(old)
            this._addToTierChildrenIndex(next)
          } else {
            const arr = this._tierChildrenIndex.get(next.parentTierId)
            if (arr) { const i = arr.findIndex(t => t.id === id); if (i !== -1) arr[i] = next }
          }
          this.emit('tier:update', next)
        }
      }
      this.emit('tiers:changed')
    })

    this._observeSimple(this.yRelations, { add: 'relation:add', remove: 'relation:remove' }, {
      added:   (_id, rel) => { this._addToRelationIndex(rel) },
      updated: (_id, oldRel, newRel) => { this._removeFromRelationIndex(oldRel); this._addToRelationIndex(newRel) },
      removed: (_id, rel) => { this._removeFromRelationIndex(rel) },
    })

    this._observeSimple(this.yVocabularies,    { add: 'vocabulary:add', update: 'vocabulary:update', remove: 'vocabulary:remove' })
    this._observeSimple(this.yLinguisticTypes, { add: 'linguistic-type:add', update: 'linguistic-type:update', remove: 'linguistic-type:remove' })
    this._observeSimple(this.yPatternSchemas,  { add: 'pattern-schema:add', update: 'pattern-schema:update', remove: 'pattern-schema:remove' })
    this._observeSimple(this.yPatternGroups,   { add: 'pattern-group:add', update: 'pattern-group:update', remove: 'pattern-group:remove' })
    this._observeSimple(this.yBookmarks,       { add: 'bookmark:add', update: 'bookmark:update', remove: 'bookmark:remove', changed: 'bookmarks:changed' })
    this._observeSimple(this.ySuggestions,     { add: 'suggestion:add', remove: 'suggestion:remove', changed: 'suggestions:changed' })

    // Pattern events carry the assembled Pattern (meta + per-slot/per-note entries).
    this.yPatterns.observe((event, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      for (const [id, change] of event.changes.keys) {
        if (change.action === 'delete') this.emit('pattern:remove', id)
        else if (change.action === 'add') this.emit('pattern:add', this._assemblePatternFromY(event.target.get(id)!))
        else this.emit('pattern:update', this._assemblePatternFromY(event.target.get(id)!))
      }
    })

    this.yPatternSlots.observe((event, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      const touched = new Set<ID>()
      for (const [key, change] of event.changes.keys) {
        if (change.action === 'delete') {
          this._removeFromSlotIndex(key, change.oldValue as StoredSlot)
        } else {
          if (change.action === 'update') this._removeFromSlotIndex(key, change.oldValue as StoredSlot)
          this._addToSlotIndex(key, event.target.get(key)!)
        }
        touched.add(key.slice(0, key.indexOf(':')))
      }
      for (const patternId of touched) {
        const meta = this.yPatterns.get(patternId)
        if (meta) this.emit('pattern:update', this._assemblePatternFromY(meta))
      }
    })

    this.yPatternNotes.observe((event, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      const touched = new Set<ID>()
      for (const [key, change] of event.changes.keys) {
        if (change.action === 'delete') this._removeFromNotesIndex(key)
        else this._addToNotesIndex(key, event.target.get(key)!)
        touched.add(key.slice(0, key.indexOf(':')))
      }
      for (const patternId of touched) {
        const meta = this.yPatterns.get(patternId)
        if (meta) this.emit('pattern:update', this._assemblePatternFromY(meta))
      }
    })

    this.yParticipants.observe((_, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      this.emit('participant:changed')
    })

    this.yTokenTimes.observe((event, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      this.emit('token-times:changed', event.keysChanged)
      this.emit('annotations:changed')
    })

    // observeDeep fires for content changes in any nested Y.Array (list reorders, undo/redo)
    this.yAnnotationLists.observeDeep((_, tr) => {
      if (tr.origin === LOAD_ORIGIN) return
      this.emit('annotations:changed')
    })
  }

  // --- Annotations ---

  // insertAfter: undefined = append, null = prepend, ID = insert after that sibling
  addAnnotation(
    type: string,
    anchors: AnchorJSON[],
    features: AnnotationFeatures = {},
    id: ID = newId(),
    insertAfter?: ID | null,
  ): Annotation {
    const ann: Annotation = { id, type, anchors, features }
    const tierId    = features.tierId
    const parentId  = features.parentAnnId
    this.ydoc.transact(() => {
      this.yAnnotations.set(id, ann)
      if (tierId) {
        const list = this._getOrCreateList(tierId, parentId)
        if (insertAfter === null) {
          list.insert(0, [id])
        } else if (insertAfter !== undefined) {
          const arr = list.toArray()
          const idx = arr.indexOf(insertAfter)
          if (idx === -1) list.push([id])
          else list.insert(idx + 1, [id])
        } else {
          list.push([id])
        }
      }
    }, USER_ORIGIN)
    return ann
  }

  /** Resolve a tier's constraint via its linguistic type. O(1). */
  resolveTierConstraint(tierId: ID | undefined): TierConstraint | undefined {
    if (!tierId) return undefined
    const tier = this.yTiers.get(tierId)
    if (!tier) return undefined
    return this.yLinguisticTypes.get(tier.linguisticTypeId)?.constraint
  }

  /** Return annotations in a tier's ordered list for a given parent (or root-level if parentAnnId is undefined). */
  getOrderedAnnotations(tierId: ID, parentAnnId?: ID): Annotation[] {
    const list = this._getList(tierId, parentAnnId)
    if (!list) return []
    return list.toArray()
      .map(id => this.yAnnotations.get(id))
      .filter(Boolean) as Annotation[]
  }

  // Returns a violation if [newStart, newEnd] overlaps any sibling's time anchor.
  private _findSiblingOverlap(
    sibIds: Iterable<ID> | undefined,
    annId: ID,
    newStart: number,
    newEnd: number,
    filter?: (sib: Annotation) => boolean,
  ): ConstraintViolation | null {
    if (!sibIds) return null
    for (const sibId of sibIds) {
      if (sibId === annId) continue
      const sib = this.yAnnotations.get(sibId)
      if (!sib || (filter && !filter(sib))) continue
      const sta = sib.anchors.find(a => a.type === 'time')
      if (!sta) continue
      if (newStart < sta.end && newEnd > sta.start) {
        return { kind: 'sibling_overlap', message: 'Annotation overlaps sibling' }
      }
    }
    return null
  }

  /** Validate proposed time bounds for an annotation against its tier constraint. O(siblings). */
  validateAnnotationTimes(annId: ID, newStart: number, newEnd: number): ConstraintViolation | null {
    const ann = this.yAnnotations.get(annId)
    if (!ann) return null

    const tierId = ann.features.tierId
    const constraint = this.resolveTierConstraint(tierId)
    if (!constraint) return null

    if (constraint === 'symbolic_association' || constraint === 'symbolic_subdivision') {
      return { kind: 'symbolic_no_time', message: 'Symbolic tiers have no independent time bounds' }
    }

    const { parentAnnId: parentId, tokenNodeId } = ann.features

    if (parentId) {
      // Standard ELAN parent-child: validate against the parent annotation's time bounds.
      const parent = this.yAnnotations.get(parentId)
      if (!parent) return null
      const pta = parent.anchors.find(a => a.type === 'time')
      if (!pta) return null

      if (newStart < pta.start || newEnd > pta.end) {
        return { kind: 'out_of_parent', message: `Must be within parent [${pta.start}, ${pta.end}]` }
      }

      if (constraint === 'time_subdivision') {
        return this._findSiblingOverlap(this._childrenIndex.get(parentId), annId, newStart, newEnd)
      }
    } else if (tokenNodeId) {
      // Token-subtier annotation: validate against the parent token's time bounds.
      const tokenTime = this.yTokenTimes.get(tokenNodeId)
      if (tokenTime && tokenTime.start != null && tokenTime.end != null) {
        if (newStart < tokenTime.start || newEnd > tokenTime.end) {
          return { kind: 'out_of_parent', message: `Must be within token [${tokenTime.start}, ${tokenTime.end}]` }
        }

        if (constraint === 'time_subdivision') {
          return this._findSiblingOverlap(this._tokenChildrenIndex.get(tokenNodeId), annId, newStart, newEnd)
        }
      }
    } else if (tierId) {
      // No parent annotation: check if this tier's parent is a track-ref tier.
      const tier = this.yTiers.get(tierId)
      const parentTier = tier?.parentTierId ? this.yTiers.get(tier.parentTierId) : undefined
      if (parentTier?.trackRef && this.trackPresenceProvider) {
        const range = this.trackPresenceProvider(parentTier.trackRef.trackSetId, parentTier.trackRef.trackId)
        if (range && (newStart < range.startSeconds || newEnd > range.endSeconds)) {
          return {
            kind: 'out_of_parent',
            message: `Must be within track [${range.startSeconds.toFixed(2)}, ${range.endSeconds.toFixed(2)}]`,
          }
        }
      }

      if (constraint === 'time_subdivision') {
        // Sibling overlap among all annotations on the same tier that also have no parent.
        return this._findSiblingOverlap(
          this._annsByTier.get(tierId), annId, newStart, newEnd,
          sib => !sib.features.parentAnnId,
        )
      }
    }

    return null
  }

  private _clipToParentBounds(annId: ID, start: number, end: number): { start: number; end: number } | null {
    const ann = this.yAnnotations.get(annId)
    if (!ann) return null
    const parentId   = ann.features.parentAnnId
    const tokenNodeId = ann.features.tokenNodeId
    if (parentId) {
      const parent = this.yAnnotations.get(parentId)
      const pta = parent?.anchors.find(a => a.type === 'time')
      if (!pta) return null
      const clippedStart = Math.max(start, pta.start)
      const clippedEnd   = Math.min(end,   pta.end)
      if (clippedStart >= clippedEnd) return null
      return { start: clippedStart, end: clippedEnd }
    }
    if (tokenNodeId) {
      const tokenTime = this.yTokenTimes.get(tokenNodeId)
      if (!tokenTime || tokenTime.start == null || tokenTime.end == null) return null
      const clippedStart = Math.max(start, tokenTime.start)
      const clippedEnd   = Math.min(end,   tokenTime.end)
      if (clippedStart >= clippedEnd) return null
      return { start: clippedStart, end: clippedEnd }
    }
    const tierId = ann.features.tierId
    const tier = tierId ? this.yTiers.get(tierId) : undefined
    const parentTier = tier?.parentTierId ? this.yTiers.get(tier.parentTierId) : undefined
    if (parentTier?.trackRef && this.trackPresenceProvider) {
      const range = this.trackPresenceProvider(parentTier.trackRef.trackSetId, parentTier.trackRef.trackId)
      if (!range) return null
      const clippedStart = Math.max(start, range.startSeconds)
      const clippedEnd   = Math.min(end,   range.endSeconds)
      if (clippedStart >= clippedEnd) return null
      return { start: clippedStart, end: clippedEnd }
    }
    return null
  }

  updateAnnotation(id: ID, patch: Partial<Pick<Annotation, 'type' | 'anchors' | 'features'>>, origin: symbol = USER_ORIGIN, skipValidation = false): ConstraintViolation | null {
    const ann = this.yAnnotations.get(id)
    if (!ann) return null
    let effectivePatch = patch
    if (!skipValidation && patch.anchors) {
      const ta = patch.anchors.find(a => a.type === 'time')
      if (ta) {
        const violation = this.validateAnnotationTimes(id, ta.start, ta.end)
        if (violation) {
          if (violation.kind === 'out_of_parent') {
            const clipped = this._clipToParentBounds(id, ta.start, ta.end)
            if (!clipped) return violation
            effectivePatch = {
              ...patch,
              anchors: patch.anchors.map(a =>
                a.type === 'time' ? { ...a, start: clipped.start, end: clipped.end } : a
              ),
            }
            const recheck = this.validateAnnotationTimes(id, clipped.start, clipped.end)
            if (recheck) return recheck
          } else {
            return violation
          }
        }
      }
    }
    let updated = ann
    if (effectivePatch.anchors !== undefined) updated = { ...updated, anchors: effectivePatch.anchors }
    if (effectivePatch.type !== undefined) updated = { ...updated, type: effectivePatch.type }
    if (effectivePatch.features !== undefined) {
      const merged = { ...ann.features, ...effectivePatch.features }
      const features: AnnotationFeatures = {}
      for (const [k, v] of Object.entries(merged)) { if (v !== undefined) features[k] = v }
      updated = { ...updated, features }
    }
    if (updated === ann) return null
    const oldTier   = ann.features.tierId
    const oldParent = ann.features.parentAnnId
    const newTier   = updated.features.tierId
    const newParent = updated.features.parentAnnId
    this.ydoc.transact(() => {
      this.yAnnotations.set(id, updated)
      // Keep ordered-list membership in sync when the annotation moves to a
      // different tier or parent - the lists are keyed by (tierId, parentAnnId).
      if (oldTier !== newTier || oldParent !== newParent) {
        if (oldTier) {
          const oldList = this._getList(oldTier, oldParent)
          if (oldList) {
            const idx = oldList.toArray().indexOf(id)
            if (idx !== -1) oldList.delete(idx, 1)
          }
        }
        if (newTier) {
          const newList = this._getOrCreateList(newTier, newParent)
          if (!newList.toArray().includes(id)) newList.push([id])
        }
      }
    }, origin)
    return null
  }

  removeAnnotation(id: ID): void {
    if (!this.yAnnotations.get(id)) return
    // Collect deletion order: leaves first, then ancestors (post-order DFS)
    const order: ID[] = []
    const visit = (annId: ID) => {
      for (const child of this.childrenOf(annId)) visit(child.id)
      order.push(annId)
    }
    visit(id)
    this.ydoc.transact(() => {
      for (const descId of order) this._removeSingle(descId)
    }, USER_ORIGIN)
  }

  private _removeSingle(id: ID): void {
    const ann = this.yAnnotations.get(id)
    if (!ann) return
    const { tierId, parentAnnId: parentId } = ann.features
    this.yAnnotations.delete(id)
    // Index may still list relations deleted earlier in this transaction
    // (observers run at transaction end); the extra delete is a no-op.
    for (const rid of this._relationsByEndpoint.get(id) ?? []) {
      this.yRelations.delete(rid)
    }
    if (tierId) {
      const list = this._getList(tierId, parentId)
      if (list) {
        const idx = list.toArray().indexOf(id)
        if (idx !== -1) list.delete(idx, 1)
      }
    }
  }

  getAnnotation(id: ID): Annotation | undefined {
    return this.yAnnotations.get(id)
  }

  allAnnotations(): Annotation[] {
    return Array.from(this.yAnnotations.values())
  }

  /** Return all annotations whose time anchor overlaps [start, end] (seconds). O(log n + k). */
  annotationsInRange(start: number, end: number): Annotation[] {
    return this.timeIndex.search(start, end)
      .map(id => this.yAnnotations.get(id))
      .filter(Boolean) as Annotation[]
  }

  /** Return all annotations whose time anchor contains the given time point. O(log n + k). */
  annotationsAtTime(t: number): Annotation[] {
    return this.annotationsInRange(t, t)
  }

  /** Return all annotations that have a mark anchor with the given mark ID. O(k). */
  byMarkId(markId: ID): Annotation[] {
    const ids = this._annsByMark.get(markId)
    if (!ids) return []
    const result: Annotation[] = []
    for (const id of ids) {
      const ann = this.yAnnotations.get(id)
      if (ann) result.push(ann)
    }
    return result
  }

  /** Direct children of an annotation or token (parentAnnId === id, or tokenNodeId === id). O(k). */
  childrenOf(id: ID): Annotation[] {
    const result: Annotation[] = []
    for (const index of [this._childrenIndex, this._tokenChildrenIndex]) {
      const childIds = index.get(id)
      if (!childIds) continue
      for (const cid of childIds) {
        const ann = this.yAnnotations.get(cid)
        if (ann) result.push(ann)
      }
    }
    return result
  }

  /** Parent annotation, or undefined if none. O(1). */
  parentOf(id: ID): Annotation | undefined {
    const ann = this.yAnnotations.get(id)
    if (!ann) return undefined
    const parentId = ann.features.parentAnnId
    return parentId ? this.yAnnotations.get(parentId) : undefined
  }

  /** Batch multiple store mutations into a single Yjs transaction (observers fire once). */
  transact(fn: () => void): void {
    this.ydoc.transact(fn, USER_ORIGIN)
  }

  // --- Token Times ---
  // A null on either side is a sentinel: the token's boundary is open and inherits
  // the utterance edge. { start: X, end: null } = left-anchored outer token;
  // { start: null, end: X } = right-anchored outer token. docToTimeline resolves
  // the open side from the adjacent timed token or the utterance boundary.

  setTokenTime(id: ID, start: number | null, end: number | null, origin: symbol = USER_ORIGIN): void {
    if (start != null && end != null && start > end) return
    this.ydoc.transact(() => { this.yTokenTimes.set(id, { start, end }) }, origin)
  }

  getTokenTime(id: ID): { start: number | null; end: number | null} | undefined {
    return this.yTokenTimes.get(id)
  }

  removeTokenTime(id: ID, origin: symbol = USER_ORIGIN): void {
    if (!this.yTokenTimes.has(id)) return
    this.ydoc.transact(() => { this.yTokenTimes.delete(id) }, origin)
  }

  /** Bulk-load token times from a serialized map. Uses LOAD_ORIGIN (not tracked by undo). */
  loadTokenTimes(times: Record<ID, { start: number | null; end: number | null }>): void {
    this.ydoc.transact(() => {
      this.yTokenTimes.clear()
      for (const [id, t] of Object.entries(times)) this.yTokenTimes.set(id, t)
    }, LOAD_ORIGIN)
  }

  // --- Tiers ---

  private _ensureDefaultLt(): void {
    if (!this.yLinguisticTypes.has(DEFAULT_LT_ID)) {
      this.yLinguisticTypes.set(DEFAULT_LT_ID, { id: DEFAULT_LT_ID, name: 'Default' })
    }
  }

  addTier(name: string, opts: { parentTierId?: ID; linguisticTypeId?: ID; constraint?: TierConstraint; participant?: string; annotator?: string; defaultLocale?: string; trackRef?: { trackSetId: ID; trackId: ID }; inlineGloss?: boolean; isUttTier?: boolean } = {}, id: ID = newId()): TierDef {
    const { constraint, linguisticTypeId: ltIdOpt, ...rest } = opts
    let linguisticTypeId = ltIdOpt
    if (constraint && !linguisticTypeId) {
      const lt = this.addLinguisticType(`lt-${name}`, { constraint })
      linguisticTypeId = lt.id
    }
    if (!linguisticTypeId) {
      this._ensureDefaultLt()
      linguisticTypeId = DEFAULT_LT_ID
    }
    const tier: TierDef = { id, name, ...rest, linguisticTypeId }
    this.ydoc.transact(() => { this.yTiers.set(id, tier) }, USER_ORIGIN)
    return tier
  }

  updateTier(id: ID, patch: Partial<Pick<TierDef, 'name' | 'linguisticTypeId' | 'inlineGloss' | 'isUttTier'>> & {
    parentTierId?: ID | undefined
    participant?: string | undefined
    trackRef?: { trackSetId: ID; trackId: ID } | undefined
  }): void {
    const tier = this.yTiers.get(id)
    if (!tier) return
    const next = { ...tier, ...patch }
    if ('parentTierId' in patch && patch.parentTierId === undefined) delete next.parentTierId
    if ('participant'  in patch && patch.participant  === undefined) delete next.participant
    if ('trackRef'     in patch && patch.trackRef     === undefined) delete next.trackRef
    this.ydoc.transact(() => { this.yTiers.set(id, next as TierDef) }, USER_ORIGIN)
  }

  removeTier(id: ID): void {
    if (!this.yTiers.has(id)) return
    this.ydoc.transact(() => { this.yTiers.delete(id) }, USER_ORIGIN)
  }

  // Deletes a tier, all descendants, and all their annotations in a single transaction.
  removeTierCascade(tierId: ID): void {
    if (!this.yTiers.has(tierId)) return

    // Collect the tier and all its descendants
    const tierIds = new Set<ID>()
    const collect = (id: ID) => {
      tierIds.add(id)
      for (const t of this._tierChildrenIndex.get(id) ?? []) collect(t.id)
    }
    collect(tierId)

    // Collect annotation IDs belonging to those tiers
    const annIds = new Set<ID>()
    for (const [id, ann] of this.yAnnotations) {
      if (tierIds.has(ann.features.tierId as ID)) annIds.add(id)
    }

    this.ydoc.transact(() => {
      // Delete annotations directly - no per-annotation list manipulation needed
      for (const id of annIds) this.yAnnotations.delete(id)

      // Delete ordered-list entries for these tiers in one pass
      for (const key of Array.from(this.yAnnotationLists.keys())) {
        const sep = key.indexOf(':')
        if (sep !== -1 && tierIds.has(key.slice(0, sep))) this.yAnnotationLists.delete(key)
      }

      // Delete relations in one pass using a Set lookup
      for (const [rid, rel] of this.yRelations) {
        if (annIds.has(rel.source) || annIds.has(rel.target)) this.yRelations.delete(rid)
      }

      // Delete the tiers themselves
      for (const id of tierIds) this.yTiers.delete(id)
    }, USER_ORIGIN)
  }

  getTier(id: ID): TierDef | undefined {
    return this.yTiers.get(id)
  }

  allTiers(): TierDef[] {
    return Array.from(this.yTiers.values())
  }

  /** Return tiers in depth-first order: parents before their children. */
  allTiersOrdered(): TierDef[] {
    const result: TierDef[] = []
    const walk = (parentId: ID | undefined) => {
      for (const t of this._tierChildrenIndex.get(parentId) ?? []) {
        result.push(t)
        walk(t.id)
      }
    }
    walk(undefined)
    return result
  }

  /** Return the immediate children of a tier (or all root tiers if parentId is undefined). */
  tierChildrenOf(parentId?: ID): TierDef[] {
    return this._tierChildrenIndex.get(parentId) ?? []
  }

  // --- Participants ---

  addParticipant(label: string, opts: Partial<Omit<ParticipantJSON, 'id' | 'label'>> = {}, id: ID = newId()): ParticipantJSON {
    const p: ParticipantJSON = { id, label, ...opts }
    this.ydoc.transact(() => { this.yParticipants.set(id, p) }, USER_ORIGIN)
    return p
  }

  updateParticipant(id: ID, patch: Partial<Omit<ParticipantJSON, 'id'>>): void {
    const p = this.yParticipants.get(id)
    if (!p) return
    this.ydoc.transact(() => { this.yParticipants.set(id, { ...p, ...patch }) }, USER_ORIGIN)
  }

  removeParticipant(id: ID): void {
    if (!this.yParticipants.has(id)) return
    this.ydoc.transact(() => { this.yParticipants.delete(id) }, USER_ORIGIN)
  }

  getParticipant(id: ID): ParticipantJSON | undefined {
    return this.yParticipants.get(id)
  }

  allParticipants(): ParticipantJSON[] {
    return Array.from(this.yParticipants.values())
  }

  // --- Relations ---

  addRelation(type: string, source: ID, target: ID, id: ID = newId()): Relation {
    const rel: Relation = { id, type, source, target }
    this.ydoc.transact(() => { this.yRelations.set(id, rel) }, USER_ORIGIN)
    return rel
  }

  removeRelation(id: ID): void {
    if (!this.yRelations.has(id)) return
    this.ydoc.transact(() => { this.yRelations.delete(id) }, USER_ORIGIN)
  }

  getRelation(id: ID): Relation | undefined {
    return this.yRelations.get(id)
  }

  allRelations(): Relation[] {
    return Array.from(this.yRelations.values())
  }

  /** Relations that have the given ID as source or target. O(k). */
  relationsFor(id: ID): Relation[] {
    const relIds = this._relationsByEndpoint.get(id)
    if (!relIds) return []
    const result: Relation[] = []
    for (const rid of relIds) {
      const rel = this.yRelations.get(rid)
      if (rel) result.push(rel)
    }
    return result
  }

  // --- Vocabularies ---

  addVocabulary(name: string, entries: VocabEntry[] = [], id: ID = newId()): ControlledVocabulary {
    const vocab: ControlledVocabulary = { id, name, entries: [...entries] }
    this.ydoc.transact(() => { this.yVocabularies.set(id, vocab) }, USER_ORIGIN)
    return vocab
  }

  updateVocabulary(id: ID, patch: Partial<Pick<ControlledVocabulary, 'name' | 'entries'>>): void {
    const vocab = this.yVocabularies.get(id)
    if (!vocab) return
    this.ydoc.transact(() => { this.yVocabularies.set(id, { ...vocab, ...patch }) }, USER_ORIGIN)
  }

  removeVocabulary(id: ID): void {
    if (!this.yVocabularies.has(id)) return
    this.ydoc.transact(() => { this.yVocabularies.delete(id) }, USER_ORIGIN)
  }

  getVocabulary(id: ID): ControlledVocabulary | undefined {
    return this.yVocabularies.get(id)
  }

  allVocabularies(): ControlledVocabulary[] {
    return Array.from(this.yVocabularies.values())
  }

  // --- Linguistic Types ---

  addLinguisticType(name: string, opts: { constraint?: TierConstraint; vocabularyId?: ID } = {}, id: ID = newId()): LinguisticType {
    const lt: LinguisticType = { id, name, ...opts }
    this.ydoc.transact(() => { this.yLinguisticTypes.set(id, lt) }, USER_ORIGIN)
    return lt
  }

  updateLinguisticType(id: ID, patch: Partial<Pick<LinguisticType, 'name' | 'constraint'>> & { vocabularyId?: ID | undefined }): void {
    const lt = this.yLinguisticTypes.get(id)
    if (!lt) return
    this.ydoc.transact(() => { this.yLinguisticTypes.set(id, { ...lt, ...patch } as LinguisticType) }, USER_ORIGIN)
  }

  removeLinguisticType(id: ID): void {
    if (!this.yLinguisticTypes.has(id)) return
    this.ydoc.transact(() => { this.yLinguisticTypes.delete(id) }, USER_ORIGIN)
  }

  getLinguisticType(id: ID): LinguisticType | undefined {
    return this.yLinguisticTypes.get(id)
  }

  allLinguisticTypes(): LinguisticType[] {
    return Array.from(this.yLinguisticTypes.values())
  }

  // --- Pattern Schemas ---

  addPatternSchema(schema: Omit<PatternSchema, 'id'>, id: ID = newId()): PatternSchema {
    const fs: PatternSchema = { id, ...schema }
    this.ydoc.transact(() => { this.yPatternSchemas.set(id, fs) }, USER_ORIGIN)
    return fs
  }

  updatePatternSchema(id: ID, patch: Partial<Omit<PatternSchema, 'id'>>): void {
    const fs = this.yPatternSchemas.get(id)
    if (!fs) return
    this.ydoc.transact(() => { this.yPatternSchemas.set(id, { ...fs, ...patch }) }, USER_ORIGIN)
  }

  removePatternSchema(id: ID): void {
    if (!this.yPatternSchemas.has(id)) return
    this.ydoc.transact(() => {
      this.yPatternSchemas.delete(id)
      const doomed = new Set<ID>()
      for (const [fid, meta] of this.yPatterns) {
        if (meta.schemaId === id) doomed.add(fid)
      }
      for (const fid of doomed) this.yPatterns.delete(fid)
      this._deletePatternKeys(doomed)
    }, USER_ORIGIN)
  }

  getPatternSchema(id: ID): PatternSchema | undefined {
    return this.yPatternSchemas.get(id)
  }

  allPatternSchemas(): PatternSchema[] {
    return Array.from(this.yPatternSchemas.values())
  }

  // --- Patterns ---
  //
  // A pattern is stored as three pieces so concurrent edits merge at slot
  // granularity instead of last-writer-wins on the whole pattern:
  //   yPatterns:     patternId -> { id, schemaId }            (meta)
  //   yPatternSlots: "patternId:slotInstanceId" -> StoredSlot (one entry per slot)
  //   yPatternNotes: "patternId:authorId" -> NoteEntry[]      (one entry per author)
  // Legacy documents carry slots/notes embedded in the meta; reads honour the
  // embedded form and the first write migrates it to per-key storage.

  private _slotKey(patternId: ID, slotInstanceId: ID): string { return `${patternId}:${slotInstanceId}` }
  private _noteKey(patternId: ID, authorId: string): string   { return `${patternId}:${authorId}` }

  private _assemble(
    meta: PatternMeta,
    storedSlots: Iterable<StoredSlot>,
    noteEntries: Iterable<[string, NoteEntry[]]>,
  ): Pattern {
    const slots: SlotInstance[] = meta.slots !== undefined
      ? meta.slots
      : [...storedSlots]
          .sort((a, b) => a.ord - b.ord || (a.id < b.id ? -1 : 1))
          .map(({ ord: _ord, ...slot }) => slot)
    const notes: Record<string, NoteEntry[]> = { ...(meta.notes ?? {}) }
    for (const [author, entries] of noteEntries) notes[author] = entries
    const pattern: Pattern = { id: meta.id, schemaId: meta.schemaId, slots }
    if (Object.keys(notes).length > 0) pattern.notes = notes
    return pattern
  }

  /** Assemble a Pattern using the in-memory indexes (fast path for reads). */
  private _assemblePattern(meta: PatternMeta): Pattern {
    return this._assemble(
      meta,
      this._slotsByPattern.get(meta.id)?.values() ?? [],
      this._notesByPattern.get(meta.id)?.entries() ?? [],
    )
  }

  // Read pattern from Y directly. Used in observers where other map indexes may not be updated yet.
  private _assemblePatternFromY(meta: PatternMeta): Pattern {
    const prefix = meta.id + ':'
    const slots: StoredSlot[] = []
    for (const [key, slot] of this.yPatternSlots) {
      if (key.startsWith(prefix)) slots.push(slot)
    }
    const notes: Array<[string, NoteEntry[]]> = []
    for (const [key, entries] of this.yPatternNotes) {
      if (key.startsWith(prefix)) notes.push([key.slice(prefix.length), entries])
    }
    return this._assemble(meta, slots, notes)
  }

  /** Slot entries for a pattern read directly from Yjs. Safe inside transactions. */
  private _ySlotEntries(patternId: ID): Array<[string, StoredSlot]> {
    const prefix = patternId + ':'
    const result: Array<[string, StoredSlot]> = []
    for (const [key, slot] of this.yPatternSlots) {
      if (key.startsWith(prefix)) result.push([key, slot])
    }
    return result
  }

  // Migrate legacy embedded slots/notes to per-key storage. Must run inside a Yjs transaction.
  private _migratePatternMeta(meta: PatternMeta): void {
    if (meta.slots === undefined && meta.notes === undefined) return
    const { slots, notes, ...rest } = meta
    ;(slots ?? []).forEach((s, i) => {
      this.yPatternSlots.set(this._slotKey(meta.id, s.id), { ...s, ord: i })
    })
    for (const [author, entries] of Object.entries(notes ?? {})) {
      this.yPatternNotes.set(this._noteKey(meta.id, author), entries)
    }
    this.yPatterns.set(meta.id, rest)
  }

  /** Delete all per-key slot/note entries for the given pattern IDs. In-transaction. */
  private _deletePatternKeys(patternIds: ReadonlySet<ID>): void {
    for (const key of Array.from(this.yPatternSlots.keys())) {
      const sep = key.indexOf(':')
      if (sep !== -1 && patternIds.has(key.slice(0, sep))) this.yPatternSlots.delete(key)
    }
    for (const key of Array.from(this.yPatternNotes.keys())) {
      const sep = key.indexOf(':')
      if (sep !== -1 && patternIds.has(key.slice(0, sep))) this.yPatternNotes.delete(key)
    }
  }

  addPattern(schemaId: ID, slots: SlotInstance[] = [], opts: { notes?: Record<string, NoteEntry[]> } = {}, id: ID = newId()): Pattern {
    this.ydoc.transact(() => {
      this.yPatterns.set(id, { id, schemaId })
      slots.forEach((s, i) => { this.yPatternSlots.set(this._slotKey(id, s.id), { ...s, ord: i }) })
      for (const [author, entries] of Object.entries(opts.notes ?? {})) {
        this.yPatternNotes.set(this._noteKey(id, author), entries)
      }
    }, USER_ORIGIN)
    return { id, schemaId, slots, ...opts }
  }

  updatePattern(id: ID, patch: { slots?: SlotInstance[]; notes?: Record<string, NoteEntry[]> }): void {
    const meta = this.yPatterns.get(id)
    if (!meta) return
    if (patch.slots === undefined && patch.notes === undefined) return
    this.ydoc.transact(() => {
      this._migratePatternMeta(meta)
      if (patch.slots !== undefined) {
        const nextIds = new Set(patch.slots.map(s => s.id))
        for (const [key, slot] of this._ySlotEntries(id)) {
          if (!nextIds.has(slot.id)) this.yPatternSlots.delete(key)
        }
        patch.slots.forEach((s, i) => {
          const key = this._slotKey(id, s.id)
          const next: StoredSlot = { ...s, ord: i }
          const cur = this.yPatternSlots.get(key)
          if (!cur || JSON.stringify(cur) !== JSON.stringify(next)) this.yPatternSlots.set(key, next)
        })
      }
      if (patch.notes !== undefined) {
        const prefix = id + ':'
        for (const key of Array.from(this.yPatternNotes.keys())) {
          if (key.startsWith(prefix) && !(key.slice(prefix.length) in patch.notes)) {
            this.yPatternNotes.delete(key)
          }
        }
        for (const [author, entries] of Object.entries(patch.notes)) {
          const key = this._noteKey(id, author)
          const cur = this.yPatternNotes.get(key)
          if (!cur || JSON.stringify(cur) !== JSON.stringify(entries)) this.yPatternNotes.set(key, entries)
        }
      }
    }, USER_ORIGIN)
  }

  // Fill one slot without rewriting the others - concurrent fills of different slots merge cleanly.
  fillPatternSlot(patternId: ID, slot: SlotInstance): void {
    const meta = this.yPatterns.get(patternId)
    if (!meta) return
    this.ydoc.transact(() => {
      this._migratePatternMeta(meta)
      let ord: number | null = null
      let maxOrd = -1
      for (const [key, existing] of this._ySlotEntries(patternId)) {
        maxOrd = Math.max(maxOrd, existing.ord)
        if (existing.schemaSlotId === slot.schemaSlotId) {
          if (ord === null || existing.ord < ord) ord = existing.ord
          this.yPatternSlots.delete(key)
        }
      }
      this.yPatternSlots.set(this._slotKey(patternId, slot.id), { ...slot, ord: ord ?? maxOrd + 1 })
    }, USER_ORIGIN)
  }

  /** Set one metric value on the slot instance for the given schema slot. */
  setPatternSlotMetric(patternId: ID, slotSchemaId: ID, metricId: ID, value: string | boolean | number | null): void {
    const meta = this.yPatterns.get(patternId)
    if (!meta) return
    this.ydoc.transact(() => {
      this._migratePatternMeta(meta)
      for (const [key, slot] of this._ySlotEntries(patternId)) {
        if (slot.schemaSlotId !== slotSchemaId) continue
        const metrics = slot.metrics.filter(m => m.schemaId !== metricId)
        metrics.push({ schemaId: metricId, value })
        this.yPatternSlots.set(key, { ...slot, metrics })
        return
      }
    }, USER_ORIGIN)
  }

  addPatternNote(id: ID, authorId: string, text: string): void {
    const meta = this.yPatterns.get(id)
    if (!meta) return
    this.ydoc.transact(() => {
      this._migratePatternMeta(meta)
      const key = this._noteKey(id, authorId)
      const entries = [...(this.yPatternNotes.get(key) ?? []), { text, createdAt: Date.now() }]
      this.yPatternNotes.set(key, entries)
    }, USER_ORIGIN)
  }

  updatePatternNote(id: ID, authorId: string, index: number, text: string): void {
    const meta = this.yPatterns.get(id)
    if (!meta) return
    this.ydoc.transact(() => {
      this._migratePatternMeta(meta)
      const key = this._noteKey(id, authorId)
      const entries: NoteEntry[] = [...(this.yPatternNotes.get(key) ?? [])]
      if (index < 0 || index >= entries.length) return
      entries[index] = { createdAt: entries[index]!.createdAt, text }
      this.yPatternNotes.set(key, entries)
    }, USER_ORIGIN)
  }

  deletePatternNote(id: ID, authorId: string, index: number): void {
    const meta = this.yPatterns.get(id)
    if (!meta) return
    this.ydoc.transact(() => {
      this._migratePatternMeta(meta)
      const key = this._noteKey(id, authorId)
      const entries = (this.yPatternNotes.get(key) ?? []).filter((_, i) => i !== index)
      if (entries.length > 0) this.yPatternNotes.set(key, entries)
      else this.yPatternNotes.delete(key)
    }, USER_ORIGIN)
  }

  removePattern(id: ID): void {
    if (!this.yPatterns.has(id)) return
    this.ydoc.transact(() => {
      this.yPatterns.delete(id)
      this._deletePatternKeys(new Set([id]))
      for (const [gid, group] of this.yPatternGroups) {
        let updated: PatternGroup | null = null
        if (group.type === 'set' && group.patternIds) {
          const idx = group.patternIds.indexOf(id)
          if (idx !== -1) updated = { ...group, patternIds: group.patternIds.filter(fid => fid !== id) }
        } else if (group.type === 'tree' && group.root) {
          const newRoot = removePatternFromTree(group.root, id)
          if (newRoot !== group.root) updated = { ...group, root: newRoot }
        }
        if (updated) this.yPatternGroups.set(gid, updated)
      }
    }, USER_ORIGIN)
  }

  getPattern(id: ID): Pattern | undefined {
    const meta = this.yPatterns.get(id)
    return meta ? this._assemblePattern(meta) : undefined
  }

  allPatterns(): Pattern[] {
    return Array.from(this.yPatterns.values()).map(meta => this._assemblePattern(meta))
  }

  patternsForSchema(schemaId: ID): Pattern[] {
    return this.allPatterns().filter(f => f.schemaId === schemaId)
  }

  // --- Pattern Groups ---

  addPatternGroup(type: PatternGroupType, opts: { label?: string; patternIds?: ID[]; root?: PatternGroupNode } = {}, id: ID = newId()): PatternGroup {
    const group: PatternGroup = { id, type, ...opts }
    this.ydoc.transact(() => { this.yPatternGroups.set(id, group) }, USER_ORIGIN)
    return group
  }

  updatePatternGroup(id: ID, patch: Partial<Omit<PatternGroup, 'id'>>): void {
    const group = this.yPatternGroups.get(id)
    if (!group) return
    this.ydoc.transact(() => { this.yPatternGroups.set(id, { ...group, ...patch }) }, USER_ORIGIN)
  }

  clearPatternGroupRoot(id: ID): void {
    const group = this.yPatternGroups.get(id)
    if (!group) return
    const { root: _removed, ...rest } = group
    this.ydoc.transact(() => { this.yPatternGroups.set(id, rest) }, USER_ORIGIN)
  }

  removePatternGroup(id: ID): void {
    if (!this.yPatternGroups.has(id)) return
    this.ydoc.transact(() => { this.yPatternGroups.delete(id) }, USER_ORIGIN)
  }

  getPatternGroup(id: ID): PatternGroup | undefined {
    return this.yPatternGroups.get(id)
  }

  allPatternGroups(): PatternGroup[] {
    return Array.from(this.yPatternGroups.values())
  }

  // --- Bookmarks ---

  addBookmark(label: string, startSeconds: number, endSeconds: number, opts: { note?: string | undefined; code?: string | undefined } = {}, id: ID = newId()): Bookmark {
    const bm: Bookmark = { id, label, startSeconds, endSeconds, ...opts, createdAt: Date.now() }
    this.ydoc.transact(() => { this.yBookmarks.set(id, bm) }, USER_ORIGIN)
    return bm
  }

  updateBookmark(id: ID, patch: Partial<Pick<Bookmark, 'label' | 'startSeconds' | 'endSeconds' | 'note' | 'code'>>): void {
    const bm = this.yBookmarks.get(id)
    if (!bm) return
    const next: Bookmark = { ...bm, ...patch }
    this.ydoc.transact(() => { this.yBookmarks.set(id, next) }, USER_ORIGIN)
  }

  removeBookmark(id: ID): void {
    if (!this.yBookmarks.has(id)) return
    this.ydoc.transact(() => { this.yBookmarks.delete(id) }, USER_ORIGIN)
  }

  getBookmark(id: ID): Bookmark | undefined {
    return this.yBookmarks.get(id)
  }

  allBookmarks(): Bookmark[] {
    return Array.from(this.yBookmarks.values()).sort((a, b) => a.startSeconds - b.startSeconds)
  }

  // --- Config ---

  getTokenizerConfig(): TokenizeOpts {
    return (this.yConfig.get('tokenizerConfig') as TokenizeOpts | undefined) ?? {}
  }

  setTokenizerConfig(opts: TokenizeOpts): void {
    this.ydoc.transact(() => {
      this.yConfig.set('tokenizerConfig', opts)
    }, USER_ORIGIN)
  }

  getSymbolDefs(): SymbolDef[] {
    return (this.yConfig.get('symbolDefs') as SymbolDef[] | undefined) ?? []
  }

  setSymbolDefs(defs: SymbolDef[]): void {
    this.ydoc.transact(() => {
      this.yConfig.set('symbolDefs', defs)
    }, USER_ORIGIN)
  }

  /** CSS font-family string for the transcript. Empty string means use the built-in default. */
  getTranscriptFont(): string {
    return (this.yConfig.get('transcriptFont') as string | undefined) ?? ''
  }

  setTranscriptFont(family: string): void {
    this.ydoc.transact(() => {
      if (family) {
        this.yConfig.set('transcriptFont', family)
      } else {
        this.yConfig.delete('transcriptFont')
      }
    }, USER_ORIGIN)
  }

  // --- Serialization ---

  toJSON(): {
    annotations: AnnotationJSON[]
    tiers: TierDefJSON[]; vocabularies: VocabularyJSON[]; linguisticTypes: LinguisticTypeJSON[]
    patternSchemas: PatternSchemaJSON[]; patterns: PatternJSON[]
    bookmarks: Bookmark[]
    participants: ParticipantJSON[]
    tokenTimes: Record<ID, { start: number | null; end: number | null }>
    tokenizerConfig?: TokenizeOpts
  } {
    const tokenTimes: Record<ID, { start: number | null; end: number | null }> = {}
    for (const [id, t] of this.yTokenTimes) tokenTimes[id] = t

    // Emit annotations in list order (parent tiers before child tiers) so that
    // loadJSON can reconstruct the ordered lists correctly on round-trip.
    const ordered: Annotation[] = []
    const seen = new Set<ID>()
    for (const tier of this.allTiersOrdered()) {
      for (const [key, list] of this.yAnnotationLists) {
        if (!key.startsWith(tier.id + ':')) continue
        for (const id of (list).toArray()) {
          const ann = this.yAnnotations.get(id)
          if (ann && !seen.has(id)) { seen.add(id); ordered.push(ann) }
        }
      }
    }
    // Include any annotations not in any list (no tierId, or old documents)
    for (const ann of this.yAnnotations.values()) {
      if (!seen.has(ann.id)) ordered.push(ann)
    }

    const tokenizerConfig = this.yConfig.get('tokenizerConfig') as TokenizeOpts | undefined
    const symbolDefs      = this.yConfig.get('symbolDefs') as SymbolDef[] | undefined
    const transcriptFont  = this.yConfig.get('transcriptFont') as string | undefined

    return {
      annotations: ordered,
      tiers: this.allTiers(),
      vocabularies: this.allVocabularies(),
      linguisticTypes: this.allLinguisticTypes(),
      patternSchemas: this.allPatternSchemas(),
      patterns: this.allPatterns(),
      bookmarks: this.allBookmarks(),
      participants: this.allParticipants(),
      tokenTimes,
      ...(tokenizerConfig ? { tokenizerConfig } : {}),
      ...(symbolDefs ? { symbolDefs } : {}),
      ...(transcriptFont ? { transcriptFont } : {}),
    }
  }

  loadJSON(data: {
    annotations: AnnotationJSON[]
    tiers?: TierDefJSON[]; vocabularies?: VocabularyJSON[]; linguisticTypes?: LinguisticTypeJSON[]
    patternSchemas?: PatternSchemaJSON[]; patterns?: PatternJSON[]
    bookmarks?: Bookmark[]
    participants?: ParticipantJSON[]
    tokenTimes?: Record<ID, { start: number | null; end: number | null }>
    tokenizerConfig?: TokenizeOpts
    symbolDefs?: SymbolDef[]
    transcriptFont?: string
  }): void {
    this.ydoc.transact(() => {
      this.yAnnotations.clear()
      this.yRelations.clear()
      this.yAnnotationLists.clear()
      this.yTiers.clear()
      this.yVocabularies.clear()
      this.yLinguisticTypes.clear()
      this.yPatternSchemas.clear()
      this.yPatterns.clear()
      this.yPatternSlots.clear()
      this.yPatternNotes.clear()
      this.yPatternGroups.clear()
      this.yBookmarks.clear()
      this.yParticipants.clear()
      this.yTokenTimes.clear()
      this.yConfig.delete('tokenizerConfig')
      this.yConfig.delete('symbolDefs')
      this.yConfig.delete('transcriptFont')
      if (data.tokenizerConfig) this.yConfig.set('tokenizerConfig', data.tokenizerConfig)
      if (data.symbolDefs) this.yConfig.set('symbolDefs', data.symbolDefs)
      if (data.transcriptFont) this.yConfig.set('transcriptFont', data.transcriptFont)
      for (const tier of data.tiers ?? []) {
        const tierDef: TierDef = { ...tier, linguisticTypeId: tier.linguisticTypeId ?? DEFAULT_LT_ID }
        this.yTiers.set(tier.id, tierDef)
      }
      for (const vocab of data.vocabularies ?? []) this.yVocabularies.set(vocab.id, vocab)
      for (const lt of data.linguisticTypes ?? []) this.yLinguisticTypes.set(lt.id, lt)
      for (const fs of data.patternSchemas ?? []) this.yPatternSchemas.set(fs.id, fs)
      for (const pattern of data.patterns ?? []) {
        this.yPatterns.set(pattern.id, { id: pattern.id, schemaId: pattern.schemaId })
        pattern.slots.forEach((s, i) => {
          this.yPatternSlots.set(this._slotKey(pattern.id, s.id), { ...s, ord: i })
        })
        for (const [author, entries] of Object.entries(pattern.notes ?? {})) {
          this.yPatternNotes.set(this._noteKey(pattern.id, author), entries)
        }
      }
      for (const bm of data.bookmarks ?? []) this.yBookmarks.set(bm.id, bm)
      for (const p of data.participants ?? []) {
        // Guard against corrupt records where label was stored as an object instead of a string.
        const label = typeof p.label === 'string' ? p.label : ((p.label as { label?: string } | null)?.label ?? '')
        this.yParticipants.set(p.id, label === p.label ? p : { ...p, label })
      }
      for (const [id, t] of Object.entries(data.tokenTimes ?? {})) this.yTokenTimes.set(id, t)
      // Load annotations in their given order and build ordered lists from that order.
      // toJSON emits annotations in list order so round-trips are stable.
      for (const ann of data.annotations) {
        this.yAnnotations.set(ann.id, ann)
        const tierId   = ann.features.tierId
        const parentId = ann.features.parentAnnId
        if (tierId) {
          const key = this._listKey(tierId, parentId)
          let list = this.yAnnotationLists.get(key)
          if (!list) { list = new Y.Array<ID>(); this.yAnnotationLists.set(key, list) }
          list.push([ann.id])
        }
      }
    }, LOAD_ORIGIN)

    this._rebuildIndexes()
    this.emit('reset')
  }

  // --- Suggestions ---

  addSuggestion(change: SuggestedChange, authorId: string, note?: string, id: ID = newId()): Suggestion {
    const s: Suggestion = { id, authorId, createdAt: Date.now(), change, ...(note ? { note } : {}) }
    this.ydoc.transact(() => { this.ySuggestions.set(id, s) }, USER_ORIGIN)
    return s
  }

  /** Update the `change` field of an existing suggestion in-place (e.g. while accumulating keystrokes). */
  updateSuggestionChange(id: ID, change: SuggestedChange): boolean {
    const s = this.ySuggestions.get(id)
    if (!s) return false
    this.ydoc.transact(() => { this.ySuggestions.set(id, { ...s, change }) }, USER_ORIGIN)
    return true
  }

  /** Accept: apply the change to the live store and remove the suggestion atomically. */
  acceptSuggestion(id: ID): void {
    const s = this.getSuggestion(id)
    if (!s) return

    // Cascade: ensure dependencies are accepted first.
    if (s.change.type === 'pattern:fill-slot' || s.change.type === 'pattern:fill-metric') {
      const { patternId } = s.change
      if (!this.yPatterns.get(patternId)) {
        const addSug = this.allSuggestions().find(
          x => x.change.type === 'pattern:add' && x.change.patternId === patternId
        )
        if (addSug) this.acceptSuggestion(addSug.id)
      }
    }
    if (s.change.type === 'pattern:fill-metric') {
      const { patternId, slotSchemaId } = s.change
      const pattern = this.getPattern(patternId)
      if (pattern && !pattern.slots.find(sl => sl.schemaSlotId === slotSchemaId)) {
        const slotSug = this.allSuggestions().find(
          x => x.change.type === 'pattern:fill-slot' &&
            x.change.patternId === patternId &&
            x.change.slot.schemaSlotId === slotSchemaId
        )
        if (slotSug) this.acceptSuggestion(slotSug.id)
      }
    }

    this.emit('suggestion:pre-accept', s)
    // Re-read after pre-accept: the handler may have updated the suggestion (e.g. anchor conversion).
    const latest = this.ySuggestions.get(id) ?? s
    this.ydoc.transact(() => {
      applySuggestedChange(this, latest.change)
      this.ySuggestions.delete(id)
    }, USER_ORIGIN)
  }

  /** Reject: discard the suggestion without touching the live store. */
  rejectSuggestion(id: ID): void {
    const s = this.getSuggestion(id)
    if (!s) return
    // Cascade: rejecting a pattern:add also rejects all dependent fill-slot/fill-metric suggestions.
    if (s.change.type === 'pattern:add') {
      const { patternId } = s.change
      for (const dep of this.allSuggestions()) {
        if (
          (dep.change.type === 'pattern:fill-slot' || dep.change.type === 'pattern:fill-metric') &&
          dep.change.patternId === patternId
        ) {
          this.rejectSuggestion(dep.id)
        }
      }
    }
    this.emit('suggestion:pre-reject', s)
    this.ydoc.transact(() => { this.ySuggestions.delete(id) }, USER_ORIGIN)
  }

  getSuggestion(id: ID): Suggestion | undefined {
    return this.ySuggestions.get(id)
  }

  allSuggestions(): Suggestion[] {
    return Array.from(this.ySuggestions.values())
  }

  getSuggestionsByAuthor(authorId: string): Suggestion[] {
    return this.allSuggestions().filter(s => s.authorId === authorId)
  }

  /** All pending suggestions that reference a given pattern ID. */
  suggestionsForPattern(patternId: ID): Suggestion[] {
    return this.allSuggestions().filter(s => {
      const c = s.change
      return (
        (c.type === 'pattern:add'          && c.patternId === patternId) ||
        (c.type === 'pattern:delete'       && c.patternId === patternId) ||
        (c.type === 'pattern:fill-slot'    && c.patternId === patternId) ||
        (c.type === 'pattern:fill-metric'  && c.patternId === patternId)
      )
    })
  }

}
