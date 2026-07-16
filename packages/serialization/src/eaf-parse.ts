/**
 * EAF/ETF parser: ELAN Annotation Format 3.0 XML → mumo.
 *
 * Heuristic for "transcript tiers":
 *   - Tiers whose TIER_ID matches \`utterance:<participant>\` become utterance nodes
 *   - Tiers whose TIER_ID matches `evt:<participant>:<tier>` become event nodes
 *   - All other tiers become TierDef + Annotation records in the store
 *
 * REF annotations store no time anchor — time is derived at render time
 * from the parent annotation via docToTimeline.
 */

import { XMLParser } from 'fast-xml-parser'
import { newId, tokenizeString, DEFAULT_PUNCT_CHARS } from '@mumo/core'
import type {
  AnnotationJSON, TierDefJSON, VocabularyJSON, LinguisticTypeJSON, AnchorJSON, TokenRecord, ParticipantJSON,
} from '@mumo/core'
import type { EAFDocument, EAFTier, EAFAnnotation, EAFAlignableAnnotation, EAFLinguisticType, EAFMediaDescriptor } from './types.js'
import { buildTimeMap } from './time-slots.js'

// XML → EAFDocument

const EAF_ARRAY_TAGS = new Set([
  'TIME_SLOT', 'TIER', 'ANNOTATION', 'LINGUISTIC_TYPE', 'CONTROLLED_VOCABULARY',
  'CV_ENTRY_ML', 'CVE_VALUE', 'DESCRIPTION', 'MEDIA_DESCRIPTOR', 'EXTERNAL_REF', 'LANGUAGE', 'CONSTRAINT', 'PROPERTY',
])

const eafXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => EAF_ARRAY_TAGS.has(name),
  textNodeName: '#text',
  parseAttributeValue: false,
  trimValues: false,
})

// Get attribute value from a parsed element object (always returns string or undefined)
function ga(node: Record<string, unknown>, name: string): string | undefined {
  const v = node[`@_${name}`]
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return v != null ? String(v) : undefined
}

// Get text content from a parsed element (handles plain string, number, or {#text: ...})
function gt(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (typeof node === 'object' && '#text' in (node))
    return String((node as Record<string, string | number>)['#text'] ?? '')
  return ''
}

export function parseXML(xml: string): EAFDocument {
  const parsed = eafXmlParser.parse(xml) as Record<string, unknown>
  const docEl  = (parsed['ANNOTATION_DOCUMENT'] ?? {}) as Record<string, unknown>
  const hdrEl  = (docEl['HEADER'] ?? {}) as Record<string, unknown>
  const toEl   = (docEl['TIME_ORDER'] ?? {}) as Record<string, unknown>

  const author = ga(docEl, 'AUTHOR')

  const timeSlots = ((toEl['TIME_SLOT'] ?? []) as Record<string, unknown>[]).map(el => ({
    id: ga(el, 'TIME_SLOT_ID') ?? '',
    value: ga(el, 'TIME_VALUE') !== undefined ? parseInt(ga(el, 'TIME_VALUE')!, 10) : null,
  }))

  const tiers: EAFTier[] = ((docEl['TIER'] ?? []) as Record<string, unknown>[]).map(tierEl => {
    const annotations: EAFAnnotation[] = ((tierEl['ANNOTATION'] ?? []) as Record<string, unknown>[])
      .flatMap((annEl): EAFAnnotation[] => {
        const al = annEl['ALIGNABLE_ANNOTATION'] as Record<string, unknown> | undefined
        if (al) {
          const cveRef = ga(al, 'CVE_REF')
          return [{
            kind: 'alignable',
            id:   ga(al, 'ANNOTATION_ID') ?? '',
            ts1:  ga(al, 'TIME_SLOT_REF1') ?? '',
            ts2:  ga(al, 'TIME_SLOT_REF2') ?? '',
            value: gt(al['ANNOTATION_VALUE']),
            ...(cveRef ? { cveRef } : {}),
          }]
        }
        const ref = annEl['REF_ANNOTATION'] as Record<string, unknown> | undefined
        if (ref) {
          const prev   = ga(ref, 'PREVIOUS_ANNOTATION')
          const cveRef = ga(ref, 'CVE_REF')
          return [{
            kind: 'ref',
            id:   ga(ref, 'ANNOTATION_ID') ?? '',
            ref:  ga(ref, 'ANNOTATION_REF') ?? '',
            ...(prev ? { prev } : {}),
            value: gt(ref['ANNOTATION_VALUE']),
            ...(cveRef ? { cveRef } : {}),
          }]
        }
        return []
      })

    const parentRef     = ga(tierEl, 'PARENT_REF')
    const participant   = ga(tierEl, 'PARTICIPANT')
    const annotator     = ga(tierEl, 'ANNOTATOR')
    const defaultLocale = ga(tierEl, 'DEFAULT_LOCALE')
    return {
      id: ga(tierEl, 'TIER_ID') ?? '',
      linguisticTypeRef: ga(tierEl, 'LINGUISTIC_TYPE_REF') ?? '',
      ...(parentRef     ? { parentRef }     : {}),
      ...(participant   ? { participant }   : {}),
      ...(annotator     ? { annotator }     : {}),
      ...(defaultLocale ? { defaultLocale } : {}),
      annotations,
    }
  })

  const linguisticTypes: EAFLinguisticType[] = ((docEl['LINGUISTIC_TYPE'] ?? []) as Record<string, unknown>[])
    .map(el => {
      const constraint = normalizeConstraint(ga(el, 'CONSTRAINTS') ?? null)
      const cvRef = ga(el, 'CONTROLLED_VOCABULARY_REF')
      return {
        id: ga(el, 'LINGUISTIC_TYPE_ID') ?? '',
        timeAlignable: ga(el, 'TIME_ALIGNABLE') === 'true',
        ...(constraint ? { constraint } : {}),
        ...(cvRef ? { cvRef } : {}),
      }
    })

  const vocabularies = ((docEl['CONTROLLED_VOCABULARY'] ?? []) as Record<string, unknown>[]).map(cv => {
    const extRef = ga(cv, 'EXT_REF')
    return {
      id: ga(cv, 'CV_ID') ?? '',
      entries: ((cv['CV_ENTRY_ML'] ?? []) as Record<string, unknown>[]).map(entry => {
        const cveValues = (entry['CVE_VALUE'] ?? []) as Record<string, unknown>[]
        const firstCve  = cveValues[0]
        const langRef   = firstCve ? ga(firstCve, 'LANG_REF') : undefined
        const descValues = (entry['DESCRIPTION'] ?? []) as Record<string, unknown>[]
        const description = gt(descValues[0]) || null
        return {
          id: ga(entry, 'CVE_ID') ?? '',
          value: gt(firstCve),
          ...(description ? { description } : {}),
          ...(langRef ? { langRef } : {}),
        }
      }),
      ...(extRef ? { extRef } : {}),
    }
  })

  const media = ((hdrEl['MEDIA_DESCRIPTOR'] ?? []) as Record<string, unknown>[]).map(el => {
    // ELAN writes MIME_TYPE="unknown" when it can't resolve one — treat as absent
    // so consumers fall back to extension-based detection.
    const mimeTypeRaw   = ga(el, 'MIME_TYPE')
    const mimeType      = mimeTypeRaw === 'unknown' ? undefined : mimeTypeRaw
    const relativeUrl   = ga(el, 'RELATIVE_MEDIA_URL')
    const timeOriginStr = ga(el, 'TIME_ORIGIN')
    const timeOrigin    = timeOriginStr !== undefined ? parseInt(timeOriginStr, 10) : undefined
    return {
      mediaUrl: ga(el, 'MEDIA_URL') ?? '',
      ...(mimeType    ? { mimeType }    : {}),
      ...(relativeUrl ? { relativeUrl } : {}),
      ...(timeOrigin !== undefined && !isNaN(timeOrigin) ? { timeOrigin } : {}),
    }
  })

  const externalRefs = ((docEl['EXTERNAL_REF'] ?? []) as Record<string, unknown>[]).map(el => ({
    id:    ga(el, 'EXT_REF_ID') ?? '',
    type:  ga(el, 'TYPE') ?? '',
    value: ga(el, 'VALUE') ?? '',
  }))

  const languages = ((docEl['LANGUAGE'] ?? []) as Record<string, unknown>[]).map(el => {
    const langLabel = ga(el, 'LANG_LABEL')
    const langDef   = ga(el, 'LANG_DEF')
    return {
      langId: ga(el, 'LANG_ID') ?? '',
      ...(langLabel ? { langLabel } : {}),
      ...(langDef   ? { langDef }   : {}),
    }
  })

  const properties: Array<{ name: string; value: string }> = ((hdrEl['PROPERTY'] ?? []) as Record<string, unknown>[])
    .map(el => ({ name: (ga(el, 'NAME') ?? '').trim(), value: gt(el).trim() }))
    .filter(p => p.name)

  return { timeSlots, tiers, linguisticTypes, vocabularies, media, externalRefs, languages, properties, ...(author ? { author } : {}) }
}

function normalizeConstraint(s: string | null): EAFLinguisticType['constraint'] {
  switch (s) {
    case 'Time_Subdivision':     return 'Time_Subdivision'
    case 'Included_In':          return 'Included_In'
    case 'Symbolic_Subdivision': return 'Symbolic_Subdivision'
    case 'Symbolic_Association': return 'Symbolic_Association'
    default:                     return undefined
  }
}

// EAFDocument → mumo

export interface ParseResult {
  /** ProseMirror doc JSON — pass to schema.nodeFromJSON() */
  doc: unknown
  /** Token records — load into TokenStore before creating the editor. */
  tokens: TokenRecord[]
  /** Token times keyed by token ID — load into AnnotationStore via loadTokenTimes(). */
  tokenTimes: Record<string, { start: number | null; end: number | null }>
  annotations: AnnotationJSON[]
  tiers: TierDefJSON[]
  vocabularies: VocabularyJSON[]
  linguisticTypes: LinguisticTypeJSON[]
  participants: ParticipantJSON[]
  /** EAF ANNOTATION_ID → freshly minted mumo ID (utterance blocks + store annotations).
   *  Lets mmeaf-parse restore original mumo IDs recorded in mm:id_map. */
  eafIdToMumoId: Record<string, string>
  /** MEDIA_DESCRIPTOR entries from the EAF header (includes TIME_ORIGIN offsets). */
  media: EAFMediaDescriptor[]
}

export interface TokenizationOpts {
  /** 'whitespace' (default) splits on whitespace runs; 'delimiter' splits on a custom string. */
  splitMode: 'whitespace' | 'delimiter'
  /** Delimiter string — used only when splitMode === 'delimiter'. */
  delimiter: string
  /** Characters to treat as punctuation (e.g. '.,;:!?'). Empty string = no punct handling. */
  punctuationChars: string
  /** true: strip punctuation tokens entirely; false (default): keep them as 'punct' kind tokens. */
  stripPunctuation: boolean
}

export const DEFAULT_TOKENIZATION: TokenizationOpts = {
  splitMode: 'whitespace',
  delimiter: ' ',
  punctuationChars: DEFAULT_PUNCT_CHARS,
  stripPunctuation: false,
}

export interface TokenTierEntry {
  tierId: string
  tokenization: TokenizationOpts
  /** Which transcript/event tier this token tier should be matched against for PM tokenization.
   *  If omitted, time-containment alone determines utterance membership. */
  transcriptTierId?: string
}

export interface EafTomumoopts {
  /** Override which EAF tier IDs become utterance nodes in the PM doc.
   *  If omitted, defaults to top-level tiers whose id starts with 'utterance:'. */
  transcriptTierIds?: string[]
  /** EAF tier IDs to treat as gloss/translation tiers linked to utterances.
   *  If omitted, defaults to symbolic-association/subdivision children of transcript tiers. */
  glossTierIds?: string[]
  /** Per-tier token configuration — preferred over tokenTierIds + tokenization. */
  tokenTiers?: TokenTierEntry[]
  /** @deprecated Use tokenTiers instead. */
  tokenTierIds?: string[]
  /** @deprecated Use tokenTiers instead. */
  tokenization?: TokenizationOpts
}

/** Split a string into TokenFragments using the given TokenizationOpts. */
export function eafTokenize(text: string, opts: TokenizationOpts = DEFAULT_TOKENIZATION): import('@mumo/core').TokenFragment[] {
  type TF = import('@mumo/core').TokenFragment
  const punct = opts.punctuationChars ? new Set(opts.punctuationChars.split('')) : new Set<string>()
  const result: TF[] = []

  function pushChunk(chunk: string) {
    if (!chunk) return
    if (punct.size === 0) {
      result.push({ kind: 'word', text: chunk })
      return
    }
    // Walk char by char: emit punct tokens or strip them, rest goes into word runs
    let wordStart = -1
    for (let i = 0; i <= chunk.length; i++) {
      const ch = i < chunk.length ? chunk[i]! : null
      if (ch !== null && !punct.has(ch)) {
        if (wordStart === -1) wordStart = i
      } else {
        if (wordStart !== -1) {
          result.push({ kind: 'word', text: chunk.slice(wordStart, i) })
          wordStart = -1
        }
        if (ch !== null && !opts.stripPunctuation) {
          result.push({ kind: 'punct', text: ch })
        }
      }
    }
  }

  if (opts.splitMode === 'delimiter' && opts.delimiter) {
    const parts = text.split(opts.delimiter)
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) result.push({ kind: 'ws', text: opts.delimiter })
      pushChunk(parts[i]!)
    }
  } else {
    // Whitespace mode
    const parts = text.split(/(\s+)/)
    for (const part of parts) {
      if (!part) continue
      if (/^\s+$/.test(part)) {
        result.push({ kind: 'ws', text: part })
      } else {
        pushChunk(part)
      }
    }
  }

  return result
}

/** Validate how well a tokenization scheme matches a token tier's annotations.
 *  Returns { matched, total } where matched/total is the fraction of word annotations
 *  that have a corresponding token in the tokenized utterance text.
 *
 *  Handles both:
 *  - Alignable annotation tiers: matched by time containment
 *  - Symbolic_Subdivision tiers (REF annotations): matched by text within parent utterance */
export function validateTokenTierMatch(
  tokenTier: import('./types.js').EAFTier,
  transcriptTier: import('./types.js').EAFTier,
  timeMap: Map<string, number>,
  opts: TokenizationOpts,
): { matched: number; total: number } {
  type AlignableAnn = import('./types.js').EAFAlignableAnnotation
  type RefAnn = import('./types.js').EAFRefAnnotation

  const refAnns = tokenTier.annotations.filter((a): a is RefAnn => a.kind === 'ref')
  if (refAnns.length > 0) {
    // Symbolic_Subdivision: parent utterance ID is ann.ref — match by text
    const uttById = new Map(transcriptTier.annotations.map(a => [a.id, a.value]))
    const byParent = new Map<string, string[]>()
    for (const ann of refAnns) {
      const group = byParent.get(ann.ref) ?? []
      group.push(ann.value)
      byParent.set(ann.ref, group)
    }
    let matched = 0, total = 0
    for (const [parentId, values] of byParent) {
      const uttText = uttById.get(parentId)
      if (uttText === undefined) continue
      const bag = eafTokenize(uttText, opts).filter(t => t.kind !== 'ws').map(t => t.text)
      for (const val of values) {
        total++
        const idx = bag.indexOf(val)
        if (idx !== -1) { matched++; bag.splice(idx, 1) }
      }
    }
    return { matched, total }
  }

  // Build utterances from the transcript tier
  const utterances = transcriptTier.annotations
    .filter((a): a is AlignableAnn => a.kind === 'alignable')
    .map(a => {
      const s = timeMap.get(a.ts1), e = timeMap.get(a.ts2)
      return s !== undefined && e !== undefined ? { text: a.value, start: s, end: e } : null
    })
    .filter((x): x is { text: string; start: number; end: number } => x !== null)

  // Build word annotations from the token tier, sorted by start time
  const wordAnns = tokenTier.annotations
    .filter((a): a is AlignableAnn => a.kind === 'alignable')
    .map(a => {
      const s = timeMap.get(a.ts1), e = timeMap.get(a.ts2)
      return s !== undefined && e !== undefined ? { value: a.value, start: s, end: e } : null
    })
    .filter((x): x is { value: string; start: number; end: number } => x !== null)
    .sort((a, b) => a.start - b.start)

  let matched = 0, total = 0

  for (const utt of utterances) {
    const uttWords = wordAnns.filter(w => w.start >= utt.start - 0.001 && w.end <= utt.end + 0.001)
    if (uttWords.length === 0) continue
    const tokens = eafTokenize(utt.text, opts)
      .filter(t => t.kind !== 'ws')
      .map(t => t.text)
    const bag = [...tokens]
    for (const w of uttWords) {
      total++
      const idx = bag.indexOf(w.value)
      if (idx !== -1) { matched++; bag.splice(idx, 1) }
    }
  }

  return { matched, total }
}

export function eafTomumo(eaf: EAFDocument, opts: EafTomumoopts = {}): ParseResult {
  // Shared lookup tables
  const timeMap   = buildTimeMap(eaf.timeSlots)
  const annIdMap  = new Map<string, string>()  // EAF annotation ID → mumo ID
  const tierIdMap = new Map<string, string>()  // EAF tier ID → mumo tier definition ID
  const ltById    = new Map(eaf.linguisticTypes.map(l => [l.id, l]))
  const SYNTHETIC_LT_IDS = new Set(['lt-utterance', 'lt-token', 'lt-token-ts', 'lt-token-ii'])

  // Tier classification
  const transcriptTierIds = new Set(
    opts.transcriptTierIds
      ? opts.transcriptTierIds
      : eaf.tiers.filter(t => !t.parentRef && (t.id.startsWith('utterance:') || t.linguisticTypeRef === 'lt-utterance')).map(t => t.id)
  )
  // Bare participant labels (e.g. 'A', 'B') extracted from transcript tier IDs.
  // Used to skip ghost tiers whose ID matches a participant label directly.
  const participantLabels = new Set<string>()
  for (const tid of transcriptTierIds) {
    if (tid.startsWith('utterance:')) participantLabels.add(tid.slice('utterance:'.length))
  }
  const glossTierSet = opts.glossTierIds ? new Set(opts.glossTierIds) : null

  // Normalize token tier config: prefer tokenTiers, fall back to deprecated tokenTierIds+tokenization
  const resolvedTokenTiers: TokenTierEntry[] = opts.tokenTiers
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    ?? (opts.tokenTierIds?.map(id => ({ tierId: id, tokenization: opts.tokenization ?? DEFAULT_TOKENIZATION })) ?? [])
  const tokenTierSet        = new Set(resolvedTokenTiers.map(t => t.tierId))
  const tierTokenization    = new Map(resolvedTokenTiers.map(t => [t.tierId, t.tokenization]))
  // transcript tier ID → tokenization (for PM token creation)
  const transcriptTokenizationMap = new Map<string, TokenizationOpts>()
  for (const { transcriptTierId, tokenization } of resolvedTokenTiers) {
    if (transcriptTierId && !transcriptTokenizationMap.has(transcriptTierId)) {
      transcriptTokenizationMap.set(transcriptTierId, tokenization)
    }
  }

  // Accumulation arrays
  const pmBlocks:     unknown[]        = []
  const tokenRecords: TokenRecord[]    = []
  const tiers:        TierDefJSON[]    = []
  const annotations:  AnnotationJSON[] = []

  // Build
  addTranscriptBlocks()
  sortPmBlocks()
  const doc = { type: 'doc', content: pmBlocks }

  const { tokenTimes, eafAnnToPmToken } = collectTokenTimes()

  collectTiers()
  collectAnnotations(eafAnnToPmToken)
  linkTimeAlignedChildren()
  fillMissingAnnotations(eafAnnToPmToken)

  return {
    doc,
    tokens:          tokenRecords,
    tokenTimes,
    annotations,
    tiers,
    linguisticTypes: collectLinguisticTypes(),
    vocabularies:    collectVocabularies(),
    participants:    collectParticipants(),
    eafIdToMumoId:   Object.fromEntries(annIdMap),
    media:           eaf.media,
  }

  // Inner functions

  function mumoAnnId(eafId: string): string {
    let id = annIdMap.get(eafId)
    if (!id) { id = newId(); annIdMap.set(eafId, id) }
    return id
  }

  function addBlockTokens(blockId: string, text: string, transcriptTierId: string): void {
    const scheme = transcriptTokenizationMap.get(transcriptTierId)
    const frags = scheme ? eafTokenize(text, scheme) : tokenizeString(text)
    let offset = 0
    for (const frag of frags) {
      tokenRecords.push({
        id: newId(), uttId: blockId, kind: frag.kind, text: frag.text,
        startOffset: offset, endOffset: offset + frag.text.length,
      })
      offset += frag.text.length
    }
  }

  function isTokenTier(eafTierId: string, ltRef: string): boolean {
    return tokenTierSet.has(eafTierId) || ltRef === 'lt-token' || ltRef === 'lt-token-ts' || ltRef === 'lt-token-ii'
  }

  // Symbolic-association or symbolic-subdivision LT (no independent time anchor).
  function isSymbolicLt(lt: { constraint?: string } | undefined): boolean {
    return lt?.constraint === 'Symbolic_Association' || lt?.constraint === 'Symbolic_Subdivision'
  }

  function transcriptParticipant(parentTierId: string): string | undefined {
    const t = eaf.tiers.find(x => x.id === parentTierId)
    if (!t) return undefined
    if (t.id.startsWith('utterance:')) return t.id.slice('utterance:'.length)
    return t.participant ?? undefined
  }

  function resolveIsGloss(tierId: string, parentIsTranscript: boolean, lt: { constraint?: string } | undefined): boolean {
    if (glossTierSet) return glossTierSet.has(tierId)
    return parentIsTranscript && isSymbolicLt(lt)
  }

  // Phase 1: PM blocks

  function addTranscriptBlocks(): void {
    for (const tier of eaf.tiers) {
      if (!transcriptTierIds.has(tier.id)) continue
      const participant = tier.id.startsWith('utterance:')
        ? tier.id.slice('utterance:'.length)
        : (tier.participant ?? 'unknown')
      // The node's tier attr holds the *base* name: '' for default utterance:<p> tiers,
      // and custom TIER_IDs with any :<participant> suffix stripped — lane IDs re-derive
      // the suffix, so storing the full TIER_ID would double it (utterance:ACT:ACT).
      const tierBase = tier.id.startsWith('utterance:')
        ? ''
        : (participant && tier.id.endsWith(`:${participant}`)
            ? tier.id.slice(0, -(participant.length + 1))
            : tier.id)

      for (const ann of tier.annotations) {
        if (ann.kind !== 'alignable') continue
        const s = timeMap.get(ann.ts1)
        const e = timeMap.get(ann.ts2)
        if (s === undefined || e === undefined) continue

        const mid = mumoAnnId(ann.id)
        addBlockTokens(mid, ann.value, tier.id)
        pmBlocks.push({
          type: 'utterance',
          attrs: { id: mid, tier: tierBase, participant, startTimeSeconds: +s.toFixed(3), endTimeSeconds: +e.toFixed(3) },
          content: ann.value ? [{ type: 'text', text: ann.value }] : [],
        })
      }
    }
  }


  function sortPmBlocks(): void {
    ;(pmBlocks as Array<{ attrs: { startTimeSeconds: number } }>)
      .sort((a, b) => a.attrs.startTimeSeconds - b.attrs.startTimeSeconds)
    if (pmBlocks.length === 0) {
      pmBlocks.push({
        type: 'utterance',
        attrs: { id: newId(), participant: 'unknown', startTimeSeconds: null, endTimeSeconds: null },
        content: [],
      })
    }
  }

  // Phase 2: Token times
  // Match EAF word sub-tier annotations to PM tokens by text + time containment.
  // Also builds eafAnnToPmToken for downstream child-tier linking.

  function collectTokenTimes(): { tokenTimes: Record<string, { start: number; end: number }>; eafAnnToPmToken: Map<string, string> } {
    const tokenTimes: Record<string, { start: number; end: number }> = {}
    const eafAnnToPmToken = new Map<string, string>()

    // Build utterance time ranges for time-containment matching
    const uttTimeRange = new Map<string, { start: number; end: number }>()
    for (const tier of eaf.tiers) {
      if (!transcriptTierIds.has(tier.id)) continue
      for (const ann of tier.annotations) {
        if (ann.kind !== 'alignable') continue
        const s = timeMap.get(ann.ts1)
        const e = timeMap.get(ann.ts2)
        if (s !== undefined && e !== undefined) uttTimeRange.set(ann.id, { start: s, end: e })
      }
    }

    // Index tokenRecords by uttId for fast lookup
    const tokensByUtt = new Map<string, TokenRecord[]>()
    for (const tok of tokenRecords) {
      let arr = tokensByUtt.get(tok.uttId)
      if (!arr) { arr = []; tokensByUtt.set(tok.uttId, arr) }
      arr.push(tok)
    }

    const assignedTokenIds = new Set<string>()

    for (const tier of eaf.tiers) {
      if (!isTokenTier(tier.id, tier.linguisticTypeRef)) continue

      const tierOpts = tierTokenization.get(tier.id) ?? DEFAULT_TOKENIZATION
      const lt = ltById.get(tier.linguisticTypeRef)

      if (lt?.constraint === 'Symbolic_Subdivision') {
        // REF annotation token tier: match by text within parent utterance (no time alignment)
        for (const ann of tier.annotations) {
          if (ann.kind !== 'ref') continue
          const uttMumoId = annIdMap.get(ann.ref)
          if (!uttMumoId) continue
          const tokens = (tokensByUtt.get(uttMumoId) ?? [])
            .filter(t => {
              if (t.kind === 'ws') return false
              if (t.kind === 'punct' && tierOpts.stripPunctuation) return false
              return true
            })
          const match = tokens.find(t => t.text === ann.value && !assignedTokenIds.has(t.id))
          if (match) {
            assignedTokenIds.add(match.id)
            eafAnnToPmToken.set(ann.id, match.id)
            // No tokenTimes entry — Symbolic_Subdivision has no independent time alignment
          }
        }
      } else {
        // Sort word annotations by start time so we match tokens left-to-right
        const wordAnns = tier.annotations
          .filter((a): a is EAFAlignableAnnotation => a.kind === 'alignable')
          .map(a => ({ ann: a, start: timeMap.get(a.ts1), end: timeMap.get(a.ts2) }))
          .filter((x): x is { ann: EAFAlignableAnnotation; start: number; end: number } =>
            x.start !== undefined && x.end !== undefined)
          .sort((a, b) => a.start - b.start)

        for (const { ann, start, end } of wordAnns) {
          // Find utterance by time containment
          let uttMumoId: string | undefined
          for (const [eafUttId, range] of uttTimeRange) {
            if (start >= range.start - 0.001 && end <= range.end + 0.001) {
              uttMumoId = annIdMap.get(eafUttId)
              break
            }
          }
          if (!uttMumoId) continue

          const tokens = (tokensByUtt.get(uttMumoId) ?? [])
            .filter(t => {
              if (t.kind === 'ws') return false
              if (t.kind === 'punct' && tierOpts.stripPunctuation) return false
              return true
            })
          const match = tokens.find(t => t.text === ann.value && !assignedTokenIds.has(t.id))
          if (match) {
            assignedTokenIds.add(match.id)
            tokenTimes[match.id] = { start: +start.toFixed(3), end: +end.toFixed(3) }
            eafAnnToPmToken.set(ann.id, match.id)
          }
        }
      }
    }

    return { tokenTimes, eafAnnToPmToken }
  }

  // Phase 3: Store tiers

  function collectTiers(): void {
    for (const tier of eaf.tiers) {
      if (transcriptTierIds.has(tier.id)) continue
      // Skip ghost tiers whose ID is exactly a participant label with no parent tier.
      // These appear in files from older exports where bare-label lt-token tiers leaked
      // through a round-trip and ended up with the Default linguistic type.
      if (!tier.parentRef && participantLabels.has(tier.id)) continue
      const parentIsTranscript = !!tier.parentRef && transcriptTierIds.has(tier.parentRef)
      const lt = ltById.get(tier.linguisticTypeRef)
      const isGloss = resolveIsGloss(tier.id, parentIsTranscript, lt)
      // Skip non-gloss, non-token children of transcript tiers
      if (parentIsTranscript && !isGloss && !isTokenTier(tier.id, tier.linguisticTypeRef)) continue

      const mumoTierId = newId()
      tierIdMap.set(tier.id, mumoTierId)

      const participant = parentIsTranscript ? transcriptParticipant(tier.parentRef!) : (tier.participant ?? undefined)
      const tierDef: TierDefJSON = {
        id: mumoTierId,
        name: tier.id,
        // Token tiers are the PM word layer — mark with lt-token so the UI renders them
        // as such. Included_In keeps its own LT id; lt-token-ts (Time_Subdivision) maps
        // back to lt-token — internally the stored token times carry the promotion.
        ...(isTokenTier(tier.id, tier.linguisticTypeRef)
          ? { linguisticTypeId: tier.linguisticTypeRef === 'lt-token-ii' ? 'lt-token-ii' : 'lt-token' }
          : (lt && !SYNTHETIC_LT_IDS.has(lt.id) ? { linguisticTypeId: lt.id } : {})),
        ...(participant ? { participant } : {}),
        ...(tier.annotator     ? { annotator: tier.annotator }         : {}),
        ...(tier.defaultLocale ? { defaultLocale: tier.defaultLocale } : {}),
        // Gloss tiers (SA/SS children of transcript tiers) show inline in the transcript editor
        ...(isGloss ? { inlineGloss: true } : {}),
      }
      tiers.push(tierDef)
    }

    // Second pass: resolve parentTierId for non-transcript-child tiers
    for (const tier of eaf.tiers) {
      if (!tier.parentRef || transcriptTierIds.has(tier.parentRef)) continue
      const tierDef = tiers.find(t => t.name === tier.id)
      if (!tierDef) continue
      const parentMumoId = tierIdMap.get(tier.parentRef)
      if (parentMumoId) Object.assign(tierDef, { parentTierId: parentMumoId })
    }
  }

  // Phase 4: Store annotations

  function collectAnnotations(eafAnnToPmToken: Map<string, string>): void {
    // Process tiers in parent-before-child order so parent annotations are
    // already in annIdMap when child REF annotations reference them via ann.ref.
    const byId = new Map(eaf.tiers.map(t => [t.id, t]))
    const visited = new Set<string>()
    const tiersInOrder: typeof eaf.tiers = []
    function visitTier(id: string) {
      if (visited.has(id)) return
      visited.add(id)
      const t = byId.get(id)
      if (!t) return
      if (t.parentRef) visitTier(t.parentRef)
      tiersInOrder.push(t)
    }
    for (const tier of eaf.tiers) visitTier(tier.id)

    for (const tier of tiersInOrder) {
      if (transcriptTierIds.has(tier.id)) continue
      // Token tier annotations are represented as PM tokens — no store annotations
      if (isTokenTier(tier.id, tier.linguisticTypeRef)) continue

      const parentIsTranscript = !!tier.parentRef && transcriptTierIds.has(tier.parentRef)
      const lt = ltById.get(tier.linguisticTypeRef)
      const isGloss = resolveIsGloss(tier.id, parentIsTranscript, lt)
      if (parentIsTranscript && !isGloss) continue

      const parentIsTokenTier = !!tier.parentRef && isTokenTier(
        tier.parentRef,
        eaf.tiers.find(t => t.id === tier.parentRef)?.linguisticTypeRef ?? '',
      )

      const mumoTierId = tierIdMap.get(tier.id)
      if (!mumoTierId) continue

      for (const ann of tier.annotations) {
        const mid = mumoAnnId(ann.id)
        const anchors: AnchorJSON[] = []
        const features: Record<string, unknown> = {
          tierId: mumoTierId,
          eafAnnotationId: ann.id,
        }

        if (ann.kind === 'alignable') {
          const s = timeMap.get(ann.ts1)
          const e = timeMap.get(ann.ts2)
          if (s !== undefined && e !== undefined) {
            anchors.push({ type: 'time', start: +s.toFixed(3), end: +e.toFixed(3) })
          }
        } else {
          // REF annotation: link to parent
          if (isGloss && parentIsTranscript) {
            features['blockNodeId'] = mumoAnnId(ann.ref)
          } else if (parentIsTokenTier) {
            // Child of a token tier: link to the PM token, not a store annotation
            const pmTokenId = eafAnnToPmToken.get(ann.ref)
            if (!pmTokenId) continue  // parent word had no PM match — drop this annotation
            features['tokenNodeId'] = pmTokenId
          } else {
            // Only link to parent if its annotation was actually collected.
            // If ann.ref points to a skipped tier, annIdMap has no entry → drop
            // this annotation rather than create a dangling parentAnnId.
            const parentMumoId = annIdMap.get(ann.ref)
            if (!parentMumoId) continue
            features['parentAnnId'] = parentMumoId
          }
          if ('prev' in ann && ann.prev) {
            const prevMumoId = annIdMap.get(ann.prev)
            if (prevMumoId) features['previousAnnId'] = prevMumoId
          }
        }
        if (ann.cveRef) features['cveRef'] = ann.cveRef

        annotations.push({ id: mid, type: ann.value, anchors, features })
      }
    }
  }

  // Phase 4b: Link time-aligned child annotations to their parents
  //
  // Time_Subdivision and Included_In tiers store annotations as ALIGNABLE_ANNOTATION
  // in EAF (they have their own time slots), not REF_ANNOTATION. So parentAnnId is
  // not set during the main annotation loop. Do a second pass now that all annotations
  // are collected (regardless of tier order in the file) and infer parentAnnId by
  // finding the parent annotation whose time span contains the child's.
  function linkTimeAlignedChildren(): void {
    // Build a per-tier index: tierId → annotations sorted by start time
    const byTier = new Map<string, AnnotationJSON[]>()
    for (const ann of annotations) {
      const tid = ann.features.tierId
      if (!tid) continue
      let arr = byTier.get(tid)
      if (!arr) { arr = []; byTier.set(tid, arr) }
      arr.push(ann)
    }

    for (const tier of eaf.tiers) {
      if (!tier.parentRef) continue
      const lt = ltById.get(tier.linguisticTypeRef)
      if (lt?.constraint !== 'Time_Subdivision' && lt?.constraint !== 'Included_In') continue

      const parentIsTranscript = transcriptTierIds.has(tier.parentRef)
      if (parentIsTranscript) continue
      const parentIsTokenTier = isTokenTier(
        tier.parentRef,
        eaf.tiers.find(t => t.id === tier.parentRef)?.linguisticTypeRef ?? '',
      )
      if (parentIsTokenTier) continue

      const mumoTierId       = tierIdMap.get(tier.id)
      const parentMumoTierId = tierIdMap.get(tier.parentRef)
      if (!mumoTierId || !parentMumoTierId) continue

      const parentAnns = byTier.get(parentMumoTierId) ?? []
      const childAnns  = byTier.get(mumoTierId) ?? []

      for (const child of childAnns) {
        if (child.features.parentAnnId) continue  // already linked
        const cta = child.anchors.find(a => a.type === 'time') as { start: number; end: number } | undefined
        if (!cta) continue
        const parent = parentAnns.find(p => {
          const pta = p.anchors.find(a => a.type === 'time') as { start: number; end: number } | undefined
          return pta != null && pta.start <= cta.start && pta.end >= cta.end
        })
        if (parent) child.features['parentAnnId'] = parent.id
      }
    }
  }

  // EAF files often have incomplete annotation lists — e.g. a POS tier where only
  // a fraction of tokens were labeled. Import all that exist, then synthesize empty
  // annotations for every token that has no entry so the tier is fully populated.
  function fillMissingAnnotations(eafAnnToPmToken: Map<string, string>): void {
    for (const tier of eaf.tiers) {
      if (transcriptTierIds.has(tier.id)) continue
      if (isTokenTier(tier.id, tier.linguisticTypeRef)) continue
      if (!tier.parentRef) continue

      const parentIsTokenTier = isTokenTier(
        tier.parentRef,
        eaf.tiers.find(t => t.id === tier.parentRef)?.linguisticTypeRef ?? '',
      )
      if (!parentIsTokenTier) continue

      const lt = ltById.get(tier.linguisticTypeRef)
      if (!isSymbolicLt(lt)) continue

      const mumoTierId = tierIdMap.get(tier.id)
      if (!mumoTierId) continue

      // Token IDs already covered by imported annotations for this tier
      const coveredTokenIds = new Set(
        annotations
          .filter(a => a.features.tierId === mumoTierId && a.features.tokenNodeId)
          .map(a => a.features.tokenNodeId as string)
      )

      // Walk parent token tier in EAF order; synthesize for any unrepresented PM token
      const parentEafTier = eaf.tiers.find(t => t.id === tier.parentRef)
      for (const tokenAnn of (parentEafTier?.annotations ?? [])) {
        const pmTokenId = eafAnnToPmToken.get(tokenAnn.id)
        if (!pmTokenId || coveredTokenIds.has(pmTokenId)) continue
        coveredTokenIds.add(pmTokenId)
        annotations.push({
          id: newId(),
          type: '',
          anchors: [],
          features: { tierId: mumoTierId, tokenNodeId: pmTokenId },
        })
      }
    }
  }

  // Phase 5: Metadata

  function collectLinguisticTypes(): LinguisticTypeJSON[] {
    return eaf.linguisticTypes
      .filter(lt => !SYNTHETIC_LT_IDS.has(lt.id))
      .map(lt => {
        const constraint = lt.constraint ? constraintFromEAF(lt.constraint) : undefined
        return {
          id: lt.id,
          name: lt.id,
          ...(constraint ? { constraint } : {}),
          ...(lt.cvRef ? { vocabularyId: lt.cvRef } : {}),
        }
      })
  }

  function collectVocabularies(): VocabularyJSON[] {
    const extRefById = new Map(eaf.externalRefs.map(r => [r.id, r]))
    return eaf.vocabularies.map(cv => {
      const extRefUrl = cv.extRef ? extRefById.get(cv.extRef)?.value : undefined
      return {
        id: cv.id,
        name: cv.id,
        entries: cv.entries.map(e => ({
          id: e.id,
          value: e.value,
          ...(e.description ? { description: e.description } : {}),
        })),
        ...(extRefUrl ? { extRefUrl } : {}),
      }
    })
  }

  // Use speaker:X and evt:X:name patterns as primary label source; fall back to PARTICIPANT attribute.
  function collectParticipants(): ParticipantJSON[] {
    const participantMap = new Map<string, ParticipantJSON>()
    for (const tier of eaf.tiers) {
      let label: string | undefined
      if (tier.id.startsWith('utterance:'))   label = tier.id.slice('utterance:'.length)
      else if (tier.id.startsWith('evt:'))    label = tier.id.split(':')[1]
      else if (tier.participant)              label = tier.participant
      if (!label || participantMap.has(label)) continue
      participantMap.set(label, { id: newId(), label })
    }
    return [...participantMap.values()]
  }
}

// Convenience: parse XML string end-to-end

export function parseEAF(xml: string, opts?: EafTomumoopts): ParseResult {
  return eafTomumo(parseXML(xml), opts)
}

/** Parse an ETF template file — same as parseEAF but signals template intent.
 *  Returns tiers, linguisticTypes, vocabularies; doc will contain no utterances. */
export function parseETF(xml: string): ParseResult {
  return eafTomumo(parseXML(xml))
}

// Helpers

function constraintFromEAF(c: EAFLinguisticType['constraint']): LinguisticTypeJSON['constraint'] {
  switch (c) {
    case 'Time_Subdivision':     return 'time_subdivision'
    case 'Included_In':          return 'included_in'
    case 'Symbolic_Association': return 'symbolic_association'
    case 'Symbolic_Subdivision': return 'symbolic_subdivision'
    default:                     return undefined
  }
}
