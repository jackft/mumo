import type {
  AnnotationStore, Annotation, TierDef, TierConstraint,
  Pattern, PatternSchema, SlotSchema, SlotInstance, MetricValue,
} from './store.js'
import type { TokenStore } from './token-store.js'
import type { TokenRecord, ID, UtteranceAttrs, AnchorJSON } from './types.js'
import type { PMNode } from './utils.js'

// Resolve which utterance an annotation belongs to across all historical field names.
export function utteranceRefOf(ann: Annotation): ID | undefined {
  if (ann.features.blockNodeId)  return ann.features.blockNodeId
  if (ann.features.utteranceId)  return ann.features.utteranceId
  for (const a of ann.anchors) {
    if (a.type === 'utterance') return a.uttId
    if (a.type === 'block')     return a.blockId
  }
  return undefined
}

// TokenView

export class TokenView {
  constructor(
    private readonly _record: TokenRecord,
    private readonly _ctx: MumoContext,
  ) {}

  get id():   ID                  { return this._record.id }
  get text(): string              { return this._record.text }
  get kind(): TokenRecord['kind'] { return this._record.kind }

  /** The raw TokenRecord. */
  get record(): TokenRecord { return this._record }

  /** Attrs of the containing utterance, or null if the block is not in the doc. */
  get utterance(): UtteranceAttrs | null {
    return this._ctx._uttAttrs(this._record.uttId)
  }

  /** 0-based index among non-ws tokens in this utterance. */
  get index(): number {
    const tokens = this._ctx._tokenStore?.getUttTokens(this._record.uttId) ?? []
    return tokens.filter(t => t.kind !== 'ws').findIndex(t => t.id === this._record.id)
  }

  /** Symbolic annotations anchored to this token (POS tags, glosses, etc.). */
  get tierAnnotations(): AnnotationView[] {
    return this._ctx.annotationsForToken(this._record.id)
  }

  /** Stored time. Either side may be null (open boundary). */
  get time(): { start: number | null; end: number | null } | null {
    return this._ctx._store.getTokenTime(this._record.id) ?? null
  }

  /** Token time clamped to utterance bounds. Open boundaries filled from utterance edges. */
  get boundedTime(): { start: number; end: number } | null {
    const utt  = this.utterance
    const uttS = utt?.startTimeSeconds ?? null
    const uttE = utt?.endTimeSeconds ?? null
    const stored = this.time

    const start = (stored?.start !== null && stored?.start !== undefined)
      ? stored.start : uttS
    const end = (stored?.end !== null && stored?.end !== undefined)
      ? stored.end : uttE

    if (start === null || end === null) return null
    return {
      start: uttS !== null ? Math.max(start, uttS) : start,
      end:   uttE !== null ? Math.min(end,   uttE) : end,
    }
  }
}

// AnnotationView

export class AnnotationView {
  constructor(
    private readonly _ann: Annotation,
    private readonly _ctx: MumoContext,
  ) {}

  get id():       ID                      { return this._ann.id }
  get type():     string                  { return this._ann.type }
  get features(): Record<string, unknown> { return this._ann.features }
  get anchors():  AnchorJSON[]            { return this._ann.anchors }

  /** The raw Annotation object. */
  get annotation(): Annotation { return this._ann }

  /** Resolved time. Symbolic annotations walk the parent chain to find a time anchor. */
  get time(): { start: number; end: number } | null {
    return this._ctx._resolveAnnotationTime(this._ann, new Set())
  }

  /** Patterns that have a slot pointing to this annotation. */
  get patterns(): PatternView[] {
    return this._ctx.patternsForAnnotation(this._ann.id)
  }

  /** The utterance this annotation falls within. */
  get utterance(): UtteranceAttrs | null {
    return this._ctx._utteranceForAnnotation(this._ann)
  }

  /** Direct child annotations. */
  get children(): AnnotationView[] {
    return this._ctx._store.childrenOf(this._ann.id)
      .map(child => new AnnotationView(child, this._ctx))
  }

  /** Parent annotation, or null for root-level annotations. */
  get parent(): AnnotationView | null {
    const p = this._ctx._store.parentOf(this._ann.id)
    return p ? new AnnotationView(p, this._ctx) : null
  }

  /** The tier this annotation belongs to. */
  get tier(): TierDef | null {
    const tierId = this._ann.features.tierId
    return tierId ? (this._ctx._store.getTier(tierId) ?? null) : null
  }

  /** The constraint of this annotation's tier (via its LinguisticType). */
  get constraint(): TierConstraint | null {
    const tierId = this._ann.features.tierId
    return this._ctx._store.resolveTierConstraint(tierId) ?? null
  }
}

// SlotView

export class SlotView {
  constructor(
    private readonly _slot: SlotInstance,
    private readonly _frameSchema: PatternSchema | null,
    private readonly _ctx: MumoContext,
  ) {}

  get id():           ID            { return this._slot.id }
  get schemaSlotId(): ID            { return this._slot.schemaSlotId }
  get metrics():      MetricValue[] { return this._slot.metrics }

  /** The raw SlotInstance. */
  get instance(): SlotInstance { return this._slot }

  /** SlotSchema definition for this slot. */
  get schema(): SlotSchema | null {
    return this._frameSchema?.slots.find(s => s.id === this._slot.schemaSlotId) ?? null
  }

  /** The annotation this slot points to. */
  get annotation(): AnnotationView | null {
    const ann = this._ctx._store.getAnnotation(this._slot.annotationId)
    return ann ? new AnnotationView(ann, this._ctx) : null
  }

  /** Resolved time span of this slot's annotation. */
  get time(): { start: number; end: number } | null {
    const ann = this._ctx._store.getAnnotation(this._slot.annotationId)
    if (!ann) return null
    return this._ctx._resolveAnnotationTime(ann, new Set())
  }

  /** The utterance this slot is anchored to. */
  get utterance(): UtteranceAttrs | null {
    const ann = this._ctx._store.getAnnotation(this._slot.annotationId)
    if (!ann) return null
    return this._ctx._utteranceForAnnotation(ann)
  }

  /**
   * EAF annotations for this slot via its utterance, falling back to time-overlap.
   * Optionally filtered by tier name.
   */
  annotationsOverlapping(tierName?: string): AnnotationView[] {
    const ann = this._ctx._store.getAnnotation(this._slot.annotationId)
    const utt = ann ? this._ctx._utteranceForAnnotation(ann) : null
    if (utt) {
      return this._ctx.annotationsForUtterance(utt.id, tierName)
    }
    const t = this.time
    if (!t) return []
    const anns = this._ctx.annotationsOverlapping(t.start, t.end)
    return tierName ? anns.filter(a => a.tier?.name === tierName) : anns
  }
}

// PatternView

export class PatternView {
  constructor(
    private readonly _frame: Pattern,
    private readonly _ctx: MumoContext,
  ) {}

  get id():   ID              { return this._frame.id }
  get notes(): Record<string, import('./types.js').NoteEntry[]> | undefined { return this._frame.notes }

  /** The raw Pattern object. */
  get pattern(): Pattern { return this._frame }

  /** The PatternSchema this pattern was created from. */
  get schema(): PatternSchema | null {
    return this._ctx._store.getPatternSchema(this._frame.schemaId) ?? null
  }

  /** SlotViews for all slots in this pattern. */
  get slots(): SlotView[] {
    const schema = this.schema
    return this._frame.slots.map(s => new SlotView(s, schema, this._ctx))
  }

  /** Bounding time box spanning all slot times in this pattern. */
  get time(): { start: number; end: number } | null {
    let start: number | null = null
    let end:   number | null = null
    for (const sv of this.slots) {
      const t = sv.time
      if (!t) continue
      if (start === null || t.start < start) start = t.start
      if (end   === null || t.end   > end)   end   = t.end
    }
    if (start === null || end === null) return null
    return { start, end }
  }

  /** EAF-tier annotations overlapping any slot in this pattern, optionally filtered by tier name. */
  annotationsOverlapping(tierName?: string): AnnotationView[] {
    const t = this.time
    if (!t) return []
    const anns = this._ctx.annotationsOverlapping(t.start, t.end)
    if (!tierName) return anns
    return anns.filter(a => a.tier?.name === tierName)
  }

  /** Get a slot by schema name, label, or 0-based index. */
  slot(nameOrIndex: string | number): SlotView | null {
    const schema = this.schema
    if (!schema) return null

    let slotDef: SlotSchema | undefined
    if (typeof nameOrIndex === 'number') {
      slotDef = schema.slots[nameOrIndex]
    } else {
      slotDef = schema.slots.find(s => s.name === nameOrIndex || s.label === nameOrIndex)
    }
    if (!slotDef) return null

    const instance = this._frame.slots.find(s => s.schemaSlotId === slotDef.id)
    if (!instance) return null
    return new SlotView(instance, schema, this._ctx)
  }
}

// MumoContext

export class MumoContext {
  /** Utterance attrs by node ID, computed once - _doc is an immutable snapshot. */
  private readonly _uttById = new Map<ID, UtteranceAttrs>()
  /** Utterances in document order (for time-overlap scans). */
  private readonly _utts: UtteranceAttrs[] = []

  constructor(
    private readonly _doc: PMNode,
    readonly _store: AnnotationStore,
    readonly _tokenStore?: TokenStore,
  ) {
    _doc.forEach(node => {
      const id = node.attrs['id'] as ID | null
      if (!id) return
      const utt: UtteranceAttrs = {
        id,
        participant: (node.attrs['participant'] as string | undefined) ?? '',
        startTimeSeconds: (node.attrs['startTimeSeconds'] as number | null) ?? null,
        endTimeSeconds:   (node.attrs['endTimeSeconds']   as number | null) ?? null,
      }
      this._uttById.set(id, utt)
      this._utts.push(utt)
    })
  }

  // Token queries

  token(id: ID): TokenView | null {
    const record = this._tokenStore?.getToken(id)
    return record ? new TokenView(record, this) : null
  }

  allTokens(): TokenView[] {
    return (this._tokenStore?.allTokens() ?? []).map(t => new TokenView(t, this))
  }

  // Annotation queries

  annotation(id: ID): AnnotationView | null {
    const ann = this._store.getAnnotation(id)
    return ann ? new AnnotationView(ann, this) : null
  }

  allAnnotations(): AnnotationView[] {
    return this._store.allAnnotations().map(a => new AnnotationView(a, this))
  }

  // Pattern queries

  pattern(id: ID): PatternView | null {
    const f = this._store.getPattern(id)
    return f ? new PatternView(f, this) : null
  }

  allPatterns(): PatternView[] {
    return this._store.allPatterns().map(f => new PatternView(f, this))
  }

  // Cross-reference queries

  /** Annotations whose time anchor overlaps [start, end] (seconds). */
  annotationsOverlapping(start: number, end: number): AnnotationView[] {
    return this._store.annotationsInRange(start, end)
      .map(ann => new AnnotationView(ann, this))
  }

  /** Patterns with at least one slot overlapping [start, end], optionally filtered by schema name. */
  patternsOverlapping(start: number, end: number, schemaName?: string): PatternView[] {
    let patterns = this._store.allPatterns()
    if (schemaName !== undefined) {
      const schema = this._store.allPatternSchemas().find(s => s.name === schemaName)
      if (!schema) return []
      patterns = patterns.filter(f => f.schemaId === schema.id)
    }
    return patterns
      .filter(f => {
        const t = new PatternView(f, this).time
        return t !== null && t.start < end && t.end > start
      })
      .map(f => new PatternView(f, this))
  }

  /**
   * Annotations overlapping the utterance's time span plus their ref/symbolic children.
   * Optionally filtered by tier name.
   */
  annotationsForUtterance(uttId: ID, tierName?: string): AnnotationView[] {
    const utt = this._uttAttrs(uttId)
    if (!utt || utt.startTimeSeconds === null || utt.endTimeSeconds === null) return []
    let aligned = this.annotationsOverlapping(utt.startTimeSeconds, utt.endTimeSeconds)
    if (tierName) aligned = aligned.filter(a => a.tier?.name === tierName)
    const seen = new Set(aligned.map(a => a.id))
    const result = [...aligned]
    for (const ann of aligned) {
      for (const child of ann.children) {
        if (!seen.has(child.id)) {
          seen.add(child.id)
          result.push(child)
        }
      }
    }
    return result
  }

  /** Symbolic annotations anchored to this token (POS tags, glosses, etc.). */
  annotationsForToken(tokenId: ID): AnnotationView[] {
    return this._store.childrenOf(tokenId)
      .map(ann => new AnnotationView(ann, this))
  }

  /** All patterns that have a slot pointing to the given annotation ID. */
  patternsForAnnotation(annId: ID): PatternView[] {
    return this._store.allPatterns()
      .filter(f => f.slots.some(s => s.annotationId === annId))
      .map(f => new PatternView(f, this))
  }

  // Internal helpers

  /** @internal Resolve which utterance a given annotation belongs to. */
  _utteranceForAnnotation(ann: Annotation): UtteranceAttrs | null {
    // 1. Direct utterance/block reference in features or anchors
    const directId = utteranceRefOf(ann)
    if (directId) {
      const utt = this._uttAttrs(directId)
      if (utt) return utt
    }
    // 2. Fall back to time overlap
    const t = this._resolveAnnotationTime(ann, new Set())
    if (!t) return null
    return this._uttByTime(t.start, t.end)
  }

  /** @internal Find the first utterance whose time span overlaps [start, end]. */
  _uttByTime(start: number, end: number): UtteranceAttrs | null {
    for (const utt of this._utts) {
      const s = utt.startTimeSeconds
      const e = utt.endTimeSeconds
      if (s !== null && e !== null && s <= end && e >= start) return utt
    }
    return null
  }

  /** @internal */
  _uttAttrs(uttId: ID): UtteranceAttrs | null {
    return this._uttById.get(uttId) ?? null
  }

  /** @internal Walk parent chain to resolve a concrete time span. */
  _resolveAnnotationTime(ann: Annotation, visited: Set<ID>): { start: number; end: number } | null {
    if (visited.has(ann.id)) return null  // cycle guard
    visited.add(ann.id)

    // 1. Own time anchor
    const timeAnchor = ann.anchors.find(
      (a): a is Extract<AnchorJSON, { type: 'time' }> => a.type === 'time'
    )
    if (timeAnchor) return { start: timeAnchor.start, end: timeAnchor.end }

    // 2. Token time (symbolic tier anchored to a token)
    const tokenNodeId = ann.features.tokenNodeId
    if (tokenNodeId) {
      const tt = this._store.getTokenTime(tokenNodeId)
      if (tt && tt.start !== null && tt.end !== null)
        return { start: tt.start, end: tt.end }
    }

    // 3. Parent annotation (symbolic tier referencing another annotation)
    const parentAnnId = ann.features.parentAnnId
    if (parentAnnId) {
      const parent = this._store.getAnnotation(parentAnnId)
      if (parent) return this._resolveAnnotationTime(parent, visited)
    }

    // 4. Utterance / block reference (in features or in the anchors array)
    const blockId = utteranceRefOf(ann)
    if (blockId) {
      const utt = this._uttAttrs(blockId)
      if (utt && utt.startTimeSeconds !== null && utt.endTimeSeconds !== null)
        return { start: utt.startTimeSeconds, end: utt.endTimeSeconds }
    }

    return null
  }
}
