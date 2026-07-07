# @mumo/core — AnnotationStore

`AnnotationStore` wraps a single `Y.Doc`. All mutable state lives inside it.
This document describes what each Y type holds, the in-memory indexes, transaction origins, ordering, and the event contract.

---

## Y.Doc maps

| Map name            | Y type                      | Value type              | Key |
|---------------------|-----------------------------|-------------------------|-----|
| `annotations`       | `Y.Map<Annotation>`         | `Annotation`            | annotation ID |
| `relations`         | `Y.Map<Relation>`           | `Relation`              | relation ID |
| `tiers`             | `Y.Map<TierDef>`            | `TierDef`               | tier ID |
| `vocabularies`      | `Y.Map<ControlledVocabulary>` | `ControlledVocabulary` | vocab ID |
| `linguisticTypes`   | `Y.Map<LinguisticType>`     | `LinguisticType`        | LT ID |
| `patternSchemas`    | `Y.Map<PatternSchema>`      | `PatternSchema`         | schema ID |
| `patterns`          | `Y.Map<PatternMeta>`        | `PatternMeta`           | pattern ID |
| `patternSlots`      | `Y.Map<StoredSlot>`         | `StoredSlot`            | `"${patternId}:${slotInstanceId}"` |
| `patternNotes`      | `Y.Map<NoteEntry[]>`        | `NoteEntry[]`           | `"${patternId}:${authorId}"` |
| `patternGroups`     | `Y.Map<PatternGroup>`       | `PatternGroup`          | group ID |
| `suggestions`       | `Y.Map<Suggestion>`         | `Suggestion`            | suggestion ID |
| `bookmarks`         | `Y.Map<Bookmark>`           | `Bookmark`              | bookmark ID |
| `tokenTimes`        | `Y.Map<{start,end}>`        | `{start: number\|null, end: number\|null}` | token node ID |
| `annotationLists`   | `Y.Map<Y.Array<ID>>`        | ordered sibling list    | `"${tierId}:${parentAnnId \| ''}"` |
| `participants`      | `Y.Map<ParticipantJSON>`    | `ParticipantJSON`       | participant ID |
| `config`            | `Y.Map<unknown>`            | config values           | config key (`tokenizerConfig`, `symbolDefs`, `transcriptFont`) |

All values are plain JSON objects — no nested Y types except `annotationLists` (values are `Y.Array<ID>`) and `config` (open value type).

`patternSlots` and `patternNotes` use compound keys so concurrent edits to different slots or authors merge cleanly without full-pattern rewrites.

---

## Transaction origins

Three origin symbols control which mutations are tracked by the `UndoManager`.

| Symbol | Constant | Tracked by undo | Used for |
|--------|----------|----------------|----------|
| `Symbol('user')` | `USER_ORIGIN` | yes | All user-initiated edits (drag, type, delete) |
| `Symbol('load')` | `LOAD_ORIGIN` | no | File loads, `loadJSON` |
| `Symbol('drag')` | `DRAG_ORIGIN` | no | Live drag ticks (position updates during active drag; final commit uses USER_ORIGIN) |

Observers skip `LOAD_ORIGIN` transactions; they emit no store events on bulk load.

---

## Annotation data model

```
Annotation {
  id: ID                         // nanoid, unique across the doc
  type: string                   // semantic label (e.g. "stroke", "gesture")
  anchors: AnchorJSON[]          // at most one per anchor type in practice
  features: AnnotationFeatures   // open bag; well-known keys listed below
}
```

**Well-known `features` keys:**

| Key | Type | Meaning |
|-----|------|---------|
| `tierId` | `ID` | Which tier this annotation belongs to |
| `parentAnnId` | `ID` | Parent annotation (symbolic/included_in child) |
| `tokenNodeId` | `ID` | PM token node this annotation is anchored to |

**Anchor types:**

```typescript
{ type: 'time';  start: number; end: number }  // seconds, float
{ type: 'mark';  markId: ID }                  // PM mark node ID
```

---

## Ordered annotation lists (`annotationLists`)

Annotations within a tier are ordered. The order is stored separately from `yAnnotations` so Yjs list operations (insert, move) are CRDT-safe.

**Key format:** `"${tierId}:${parentAnnId ?? ''}"`

- Root annotations of tier `t`: key `"${t.id}:"`
- Children of annotation `p` in tier `t`: key `"${t.id}:${p.id}"`

The list stores annotation IDs only. `yAnnotations` is the source of truth for annotation data. The list provides canonical display order.

`getOrderedAnnotations(tierId, parentAnnId?)` returns annotations in list order, falling back to unordered iteration for documents that predate the list mechanism.

`addAnnotation` accepts an optional `insertAfter` parameter:
- `undefined` → append (default)
- `null` → prepend
- `ID` → insert after that sibling

---

## In-memory indexes (not persisted, rebuilt on load)

Rebuilt from Y maps on construction and `loadJSON`:

| Index | Type | Content |
|-------|------|---------|
| `timeIndex` | `TimeIntervalTree<ID>` | Time anchor → annotation IDs. Used for range/point queries. |
| `_childrenIndex` | `Map<ID, Set<ID>>` | `parentAnnId → child annotation IDs` |
| `_tokenChildrenIndex` | `Map<ID, Set<ID>>` | `tokenNodeId → annotation IDs anchored there` |
| `_annsByTier` | `Map<ID, Set<ID>>` | `tierId → annotation IDs in that tier` |
| `_tierChildrenIndex` | `Map<ID\|undefined, TierDef[]>` | `parentTierId → child TierDefs` |
| `_relationsByEndpoint` | `Map<ID, Set<ID>>` | `ann/entity ID → relation IDs` |
| `_annsByMark` | `Map<ID, Set<ID>>` | `markId → annotation IDs` |
| `_slotsByPattern` | `Map<ID, Map<ID, StoredSlot>>` | `patternId → slotInstanceId → slot` |
| `_notesByPattern` | `Map<ID, Map<string, NoteEntry[]>>` | `patternId → authorId → notes` |

All indexes are kept in sync incrementally by Yjs observers on each transaction.

---

## Tier model

```
TierDef {
  id: ID
  name: string
  parentTierId?: ID          // EAF PARENT_REF; annotation parent, not visual
  linguisticTypeId: ID       // required — resolved via LinguisticType for constraint + vocab
  participant?: string
  annotator?: string
  defaultLocale?: string
  isUttTier?: boolean        // mirrors PM utterance nodes — one annotation per utterance, same ID
  inlineGloss?: boolean      // SA annotations shown inline in the transcript editor
  trackRef?: { trackSetId: ID; trackId: ID }  // renders as track visualization
}
```

`resolveTierConstraint(tierId)` walks `tier.linguisticTypeId → LinguisticType.constraint`. Always use this instead of reading `.constraint` directly.

**Constraint semantics (mirrors ELAN):**

| Constraint | Meaning |
|------------|---------|
| `time_subdivision` | Child fills parent's time span; siblings may not overlap |
| `included_in` | Child is within parent's time span; siblings may overlap |
| `symbolic_association` | 1-1 with parent; no independent time |
| `symbolic_subdivision` | Ordered chain of children; no independent time |

---

## Event contract

Events fire after every Yjs transaction (except `LOAD_ORIGIN`). Listeners should be idempotent.

```
'annotation:add'          → Annotation
'annotation:update'       → Annotation        (new value)
'annotation:remove'       → ID
'annotations:changed'     → ()                fires after any annotation map / annotationLists / tokenTimes change
'relation:add'            → Relation
'relation:remove'         → ID
'tier:add'                → TierDef
'tier:update'             → TierDef
'tier:remove'             → ID
'tiers:changed'           → ()
'vocabulary:add/update/remove'
'linguistic-type:add/update/remove'
'pattern-schema:add/update/remove'
'pattern:add/update/remove'
'pattern-group:add/update/remove'
'suggestion:add'          → Suggestion
'suggestion:pre-accept'   → Suggestion        fires before the suggestion is applied
'suggestion:pre-reject'   → Suggestion        fires before the suggestion is removed
'suggestion:remove'       → ID
'suggestions:changed'     → ()
'bookmark:add/update/remove'
'bookmarks:changed'       → ()
'participant:changed'     → ()
'doc:change'              → PMNode            PM document changed
'token-times:changed'     → Set<ID>           set of affected token node IDs
'reset'                   → ()                after loadJSON; all prior state is gone
```

`annotations:changed` is the coarse event for anything that affects rendered annotation positions. Use it for view refresh; use fine-grained events for model sync.

When batching multiple mutations, wrap in `store.transact(fn)` — Yjs observers fire once at the end of the transaction, so only one `annotations:changed` is emitted.

---

## Serialization

`toJSON()` emits annotations in list order (parents before children, preserving sibling order within each tier) and includes all store state: annotations, relations, tiers, vocabularies, linguistic types, patterns, pattern schemas, pattern groups, bookmarks, participants, token times, and config.

`loadJSON()` reconstructs all of this atomically using `LOAD_ORIGIN` (not tracked by undo). It emits `'reset'` after loading; all prior state is gone.

For incremental token time updates, use `setTokenTime()` (tracked by undo) or `loadTokenTimes()` (bulk load with `LOAD_ORIGIN`, not tracked).

---

## Constraint enforcement

`validateAnnotationTimes(annId, start, end)` returns a `ConstraintViolation | null`.

`updateAnnotation` calls this automatically for time anchor patches. On `out_of_parent` violations it clips the annotation to the parent bounds and re-validates. On `sibling_overlap` it rejects the update.

Pass `skipValidation: true` to `updateAnnotation` to bypass (used internally during undo replay).

`trackPresenceProvider` can be injected by the app to enforce track-based time boundaries (used when a tier has a `trackRef`).
