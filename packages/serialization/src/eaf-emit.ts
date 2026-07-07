/**
 * EAF/ETF emitter: mumo → ELAN Annotation Format 3.0 XML.
 *
 * Strategy:
 *   - utterance nodes  → ALIGNABLE_ANNOTATIONs on `speaker:<label>` tiers
 *   - event nodes      → ALIGNABLE_ANNOTATIONs on `evt:<participant>:<tier>` tiers
 *   - word tokens      → ALIGNABLE_ANNOTATIONs on child word tiers (opt-in)
 *   - annotation store → TIER / LINGUISTIC_TYPE / CONTROLLED_VOCABULARY elements
 *   - symbolic_association / symbolic_subdivision → REF_ANNOTATIONs
 *   - patterns, textlets → lost (warn); preserved only in .mmeaf
 */

import { XMLBuilder } from 'fast-xml-parser'
import type { AnnotationStore, TierConstraint, TokenStore } from '@mumo/core'
import type { PMNodeJSON } from './types.js'
import { TimeSlotPool } from './time-slots.js'
import { IdMap } from './id-map.js'

// Constraint stereotype mapping

const CONSTRAINT_MAP: Record<TierConstraint, string> = {
  time_subdivision:    'Time_Subdivision',
  included_in:         'Included_In',
  symbolic_association:'Symbolic_Association',
  symbolic_subdivision:'Symbolic_Subdivision',
}

// XMLBuilder setup (exported so mmeaf-emit can share the same builder)

// eslint-disable-next-line @typescript-eslint/no-deprecated -- fast-xml-parser deprecated XMLBuilder in favor of the separate fast-xml-builder package; migrate when we next touch XML deps
export const eafXmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressBooleanAttributes: false,
})

// Helpers

function isoDate(): string {
  return new Date().toISOString().slice(0, 19)
}

// Main export options

export interface EmitEAFOptions {
  includeWords?: boolean    // emit word-level token tiers (default: false)
  tokenStore?: TokenStore   // required when includeWords is true
  mediaUrl?: string         // MEDIA_DESCRIPTOR URL
  relativeMediaUrl?: string // RELATIVE_MEDIA_URL (relative path for ELAN portability)
  extractedFrom?: string    // EXTRACTED_FROM attribute on MEDIA_DESCRIPTOR
  mimeType?: string
  timeOrigin?: number       // TIME_ORIGIN in milliseconds (media offset)
  isTemplate?: boolean      // emit ETF (no annotations, no time slots)
  author?: string
  language?: string         // BCP47 tag for document language (e.g. 'en', 'fr')
  additionalMedia?: Array<{ mediaUrl: string; mimeType?: string; timeOrigin?: number; relativeMediaUrl?: string }>
}

// buildEAFDocumentObject — returns the raw JS object before XMLBuilder
// (exported so mmeaf-emit can inject mm: data before a single build call)

export function buildEAFDocumentObject(
  doc: PMNodeJSON,
  store: AnnotationStore,
  opts: EmitEAFOptions = {},
  idMap: IdMap = new IdMap(),
): { '?xml': Record<string, unknown>; ANNOTATION_DOCUMENT: Record<string, unknown> } {
  const {
    includeWords = false,
    tokenStore,
    mediaUrl = '',
    relativeMediaUrl = '',
    extractedFrom = '',
    mimeType = '',
    timeOrigin,
    isTemplate = false,
    author = 'mumo',
    language,
    additionalMedia,
  } = opts

  const pool   = new TimeSlotPool()

  // Pass 1: collect transcript tiers and annotations from PM doc

  type AnnRow = {
    mumoId: string
    ts1?: string; ts2?: string          // for alignable
    value: string
  }
  const tierRows        = new Map<string, AnnRow[]>()
  const tierKind        = new Map<string, 'utterance'>()
  const tierParticipant = new Map<string, string>()

  const transcriptLtId     = 'lt-utterance'
  const transcriptWordLtId = 'lt-token'

  function ensureTierRows(tierId: string): AnnRow[] {
    let rows = tierRows.get(tierId)
    if (!rows) { rows = []; tierRows.set(tierId, rows) }
    return rows
  }

  if (!isTemplate) {
    for (const node of doc.content ?? []) {
      if (node.type === 'utterance') {
        const attrs = node.attrs ?? {}
        const participant: string = (attrs['participant'] as string | undefined) ?? 'unknown'
        const tierAttr: string    = (attrs['tier']        as string | undefined) ?? ''
        const tierId = tierAttr || `participant:${participant}`
        tierKind.set(tierId, 'utterance')
        if (participant && participant !== 'unknown') tierParticipant.set(tierId, participant)
        const s: number | null = (attrs['startTimeSeconds'] as number | null) ?? null
        const e: number | null = (attrs['endTimeSeconds']   as number | null) ?? null
        if (s === null) continue
        const ts1     = pool.id(s)
        const ts2     = pool.id(e ?? s + 1)
        const blockId = attrs['id'] as string
        ensureTierRows(tierId).push({ mumoId: blockId, ts1, ts2, value: baseTextContent(node) })

        if (includeWords && tokenStore) {
          for (const tok of tokenStore.getUttTokens(blockId)) {
            const t = store.getTokenTime(tok.id)
            if (!t || t.start === null || t.end === null) continue
            ensureTierRows(`words:${tierId}`).push({
              mumoId: tok.id,
              ts1: pool.id(t.start),
              ts2: pool.id(t.end),
              value: tok.text,
            })
          }
        }

      }
    }
  }

  // Pass 2: store tiers

  const allTiers        = store.allTiers()
  const linguisticTypes = store.allLinguisticTypes()
  const vocabularies    = store.allVocabularies()
  const annotations     = store.allAnnotations()

  const ltWordTiers   = !isTemplate ? allTiers.filter(t => t.linguisticTypeId === 'lt-token' || t.linguisticTypeId === 'lt-token-ii') : []
  const hasLtWordTier = ltWordTiers.length > 0 && !!tokenStore

  const annsByTier = new Map<string, typeof annotations>()
  for (const ann of annotations) {
    const tierId = ann.features['tierId']
    if (!tierId) continue
    let arr = annsByTier.get(tierId)
    if (!arr) { arr = []; annsByTier.set(tierId, arr) }
    arr.push(ann)
  }

  // Pre-register stable EAF IDs from import so roundtrip preserves annotation ID references.
  for (const ann of annotations) {
    const preferredId = ann.features['eafAnnotationId'] as string | undefined
    if (preferredId) idMap.eafId(ann.id, preferredId)
  }

  // Pre-register ALL time anchors so TIME_ORDER is complete
  if (!isTemplate) {
    for (const ann of annotations) {
      const timeAnchor = ann.anchors.find(a => a.type === 'time')
      if (timeAnchor?.type === 'time') {
        pool.id(timeAnchor.start)
        pool.id(timeAnchor.end)
      }
    }
  }

  // vocab-id → EAF CV_ID (used in both LINGUISTIC_TYPE and CONTROLLED_VOCABULARY sections)
  const vocabEafId = new Map<string, string>()
  for (const vocab of vocabularies) vocabEafId.set(vocab.id, vocab.name || vocab.id)

  // HEADER

  const headerObj: Record<string, unknown> = {
    '@_MEDIA_FILE': '',
    '@_TIME_UNITS': 'milliseconds',
  }
  const descriptors: Record<string, unknown>[] = []
  if (mediaUrl) {
    const d: Record<string, unknown> = { '@_MEDIA_URL': mediaUrl }
    if (mimeType)                                          d['@_MIME_TYPE']          = mimeType
    if (timeOrigin !== undefined && timeOrigin !== 0)      d['@_TIME_ORIGIN']        = String(Math.round(timeOrigin))
    if (extractedFrom)                                     d['@_EXTRACTED_FROM']     = extractedFrom
    if (relativeMediaUrl)                                  d['@_RELATIVE_MEDIA_URL'] = relativeMediaUrl
    descriptors.push(d)
  }
  for (const m of additionalMedia ?? []) {
    if (!m.mediaUrl) continue
    const d: Record<string, unknown> = { '@_MEDIA_URL': m.mediaUrl }
    if (m.mimeType)                                            d['@_MIME_TYPE']          = m.mimeType
    if (m.timeOrigin !== undefined && m.timeOrigin !== 0)      d['@_TIME_ORIGIN']        = String(Math.round(m.timeOrigin))
    if (m.relativeMediaUrl)                                    d['@_RELATIVE_MEDIA_URL'] = m.relativeMediaUrl
    descriptors.push(d)
  }
  if (descriptors.length === 1)    headerObj['MEDIA_DESCRIPTOR'] = descriptors[0]
  else if (descriptors.length > 1) headerObj['MEDIA_DESCRIPTOR'] = descriptors

  // TIME_ORDER

  const timeOrderObj = !isTemplate
    ? {
        TIME_SLOT: pool.sorted().map(s => ({
          '@_TIME_SLOT_ID': s.id,
          ...(s.ms !== null ? { '@_TIME_VALUE': String(s.ms) } : {}),
        })),
      }
    : undefined

  // TIER elements

  const tierElems: Record<string, unknown>[] = []

  // Speaker transcript tiers
  for (const [tierId, rows] of tierRows) {
    if (tierId.startsWith('tokens:')) continue
    if (!tierKind.has(tierId)) continue
    const tp    = tierParticipant.get(tierId)
    const tierObj: Record<string, unknown> = { '@_LINGUISTIC_TYPE_REF': transcriptLtId, '@_TIER_ID': tierId }
    if (tp) tierObj['@_PARTICIPANT'] = tp
    tierObj['ANNOTATION'] = rows.map(row => ({
      ALIGNABLE_ANNOTATION: {
        '@_ANNOTATION_ID':   idMap.eafId(row.mumoId),
        '@_TIME_SLOT_REF1':  row.ts1!,
        '@_TIME_SLOT_REF2':  row.ts2!,
        ANNOTATION_VALUE:    row.value,
      },
    }))
    tierElems.push(tierObj)
  }

  // Word tiers (child of speaker/event tiers)
  if (includeWords) {
    for (const [tierId, rows] of tierRows) {
      if (!tierId.startsWith('tokens:')) continue
      const parentId = tierId.slice('tokens:'.length)
      if (!tierKind.has(parentId)) continue
      tierElems.push({
        '@_LINGUISTIC_TYPE_REF': transcriptWordLtId,
        '@_TIER_ID':             tierId,
        '@_PARENT_TIER':         parentId,
        ANNOTATION: rows.map(row => ({
          ALIGNABLE_ANNOTATION: {
            '@_ANNOTATION_ID':  idMap.eafId(row.mumoId),
            '@_TIME_SLOT_REF1': row.ts1!,
            '@_TIME_SLOT_REF2': row.ts2!,
            ANNOTATION_VALUE:   row.value,
          },
        })),
      })
    }
  }

  // Lt-word (token) tiers from EAF import — emit as REF_ANNOTATIONs
  if (hasLtWordTier) {
    for (const tier of ltWordTiers) {
      const participant = tier.participant ?? ''
      const eafTierId   = tier.name || tier.id
      const tierObj: Record<string, unknown> = {
        '@_LINGUISTIC_TYPE_REF': transcriptWordLtId,
        '@_TIER_ID':             eafTierId,
        '@_PARENT_REF':          `participant:${participant}`,
      }
      if (tier.participant)    tierObj['@_PARTICIPANT']    = tier.participant
      if (tier.annotator)      tierObj['@_ANNOTATOR']      = tier.annotator
      if (tier.defaultLocale)  tierObj['@_DEFAULT_LOCALE'] = tier.defaultLocale

      const annElems: Record<string, unknown>[] = []
      for (const block of doc.content ?? []) {
        if (block.type !== 'utterance') continue
        const blockParticipant = (block.attrs?.['participant'] as string | undefined) ?? 'unknown'
        if (blockParticipant !== participant) continue
        const s = block.attrs?.['startTimeSeconds'] as number | null | undefined
        if (s == null) continue
        const uttPmId  = (block.attrs?.['id'] as string | undefined) ?? ''
        const uttEafId = idMap.eafId(uttPmId)

        let prevTokEafId: string | undefined
        for (const tok of tokenStore.getUttTokens(uttPmId)) {
          const tokEafId = idMap.eafId(tok.id)
          const refAnn: Record<string, unknown> = {
            '@_ANNOTATION_ID':  tokEafId,
            '@_ANNOTATION_REF': uttEafId,
            ANNOTATION_VALUE:   tok.text,
          }
          if (prevTokEafId) refAnn['@_PREVIOUS_ANNOTATION'] = prevTokEafId
          annElems.push({ REF_ANNOTATION: refAnn })
          prevTokEafId = tokEafId
        }
      }
      tierObj['ANNOTATION'] = annElems
      tierElems.push(tierObj)
    }
  }

  // Participant labels derived from transcript tier IDs (used to suppress ghost tiers below)
  const participantLabels = new Set<string>()
  for (const tierId of tierKind.keys()) {
    if (tierId.startsWith('participant:')) participantLabels.add(tierId.slice('participant:'.length))
    else if (tierId.startsWith('utt:'))    participantLabels.add(tierId.slice('utt:'.length))
  }

  // Store annotation tiers
  for (const tier of allTiers) {
    if (tier.linguisticTypeId === 'lt-token' || tier.linguisticTypeId === 'lt-token-ii') continue
    // isUttTier tiers are internal utterance-mirror tiers used by createUttSyncPlugin.
    // Utterances are already emitted as EAF transcript tiers via the PM doc path above,
    // so emitting isUttTier tiers again would produce duplicate TIER/ANNOTATION elements
    // (with identical IDs, since annotation IDs mirror PM node IDs).
    if (tier.isUttTier) continue
    const tierAnns   = annsByTier.get(tier.id) ?? []
    const lt         = linguisticTypes.find(l => l.id === tier.linguisticTypeId) ?? null
    const constraint = lt?.constraint
    const isRef      = constraint === 'symbolic_association' || constraint === 'symbolic_subdivision'
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const ltRef      = lt?.name ?? tier.linguisticTypeId ?? `lt-${tier.name || tier.id}`
    const eafTierId  = tier.name || tier.id

    // Skip ghost participant-mirror tiers: no parent, name matches a participant label, all
    // annotations empty. These are artifacts of older exports that should not perpetuate.
    if (!tier.parentTierId && participantLabels.has(eafTierId) && tierAnns.every(a => !a.type || a.type.trim() === '')) continue

    const tierObj: Record<string, unknown> = {
      '@_LINGUISTIC_TYPE_REF': ltRef,
      '@_TIER_ID':             eafTierId,
    }
    if (tier.parentTierId) {
      const parentTier = allTiers.find(t => t.id === tier.parentTierId)
      tierObj['@_PARENT_REF'] = parentTier?.name || tier.parentTierId
    }
    if (tier.participant)    tierObj['@_PARTICIPANT']    = tier.participant
    if (tier.annotator)      tierObj['@_ANNOTATOR']      = tier.annotator
    if (tier.defaultLocale)  tierObj['@_DEFAULT_LOCALE'] = tier.defaultLocale

    if (!isTemplate) {
      const sortedAnns = isRef && constraint === 'symbolic_subdivision'
        ? sortByPrevChain(tierAnns)
        : tierAnns

      const annElems: Record<string, unknown>[] = []
      for (const ann of sortedAnns) {
        const eafId = idMap.eafId(ann.id)

        if (isRef) {
          const parentId    = ann.features['parentAnnId']
          const tokenNodeId  = ann.features['tokenNodeId']
          const parentEafId = parentId   ? idMap.eafId(parentId)
                            : tokenNodeId ? idMap.eafId(tokenNodeId)
                            : ''
          // Skip ref annotations with no resolvable parent — they'd emit ANNOTATION_REF=""
          // which is invalid (xs:IDREF must be non-empty and reference an existing ID).
          if (!parentEafId) continue
          const cveRef = ann.features['cveRef'] as string | undefined
          const refAnn: Record<string, unknown> = {
            '@_ANNOTATION_ID':  eafId,
            '@_ANNOTATION_REF': parentEafId,
            ANNOTATION_VALUE:   ann.type,
          }
          if (constraint === 'symbolic_subdivision') {
            const prevId = ann.features['previousAnnId'] as string | undefined
            if (prevId) refAnn['@_PREVIOUS_ANNOTATION'] = idMap.eafId(prevId)
          }
          if (cveRef) refAnn['@_CVE_REF'] = cveRef
          annElems.push({ REF_ANNOTATION: refAnn })
        } else {
          const timeAnchor = ann.anchors.find(a => a.type === 'time')
          if (!timeAnchor) continue
          const cveRef = ann.features['cveRef'] as string | undefined
          const alignAnn: Record<string, unknown> = {
            '@_ANNOTATION_ID':  eafId,
            '@_TIME_SLOT_REF1': pool.id(timeAnchor.start),
            '@_TIME_SLOT_REF2': pool.id(timeAnchor.end),
            ANNOTATION_VALUE:   ann.type,
          }
          if (cveRef) alignAnn['@_CVE_REF'] = cveRef
          annElems.push({ ALIGNABLE_ANNOTATION: alignAnn })
        }
      }
      tierObj['ANNOTATION'] = annElems
    }

    tierElems.push(tierObj)
  }

  // LINGUISTIC_TYPE elements

  const ltElems: Record<string, unknown>[] = []

  ltElems.push({ '@_LINGUISTIC_TYPE_ID': transcriptLtId, '@_TIME_ALIGNABLE': 'true', '@_GRAPHIC_REFERENCES': 'false' })
  if (includeWords) {
    ltElems.push({ '@_LINGUISTIC_TYPE_ID': transcriptWordLtId, '@_TIME_ALIGNABLE': 'true',  '@_CONSTRAINTS': 'Time_Subdivision',     '@_GRAPHIC_REFERENCES': 'false' })
  } else if (hasLtWordTier) {
    ltElems.push({ '@_LINGUISTIC_TYPE_ID': transcriptWordLtId, '@_TIME_ALIGNABLE': 'false', '@_CONSTRAINTS': 'Symbolic_Subdivision', '@_GRAPHIC_REFERENCES': 'false' })
  }
  for (const lt of linguisticTypes) {
    const ltEafId      = lt.name || lt.id
    const timeAlignable = (lt.constraint === 'time_subdivision' || lt.constraint === 'included_in') ? 'true' : 'false'
    const ltObj: Record<string, unknown> = {
      '@_LINGUISTIC_TYPE_ID':  ltEafId,
      '@_TIME_ALIGNABLE':      timeAlignable,
      '@_GRAPHIC_REFERENCES':  'false',
    }
    if (lt.constraint)    ltObj['@_CONSTRAINTS']              = CONSTRAINT_MAP[lt.constraint]
    if (lt.vocabularyId)  ltObj['@_CONTROLLED_VOCABULARY_REF'] = vocabEafId.get(lt.vocabularyId) ?? lt.vocabularyId
    ltElems.push(ltObj)
  }

  // CONSTRAINT declarations (fixed set)

  const constraintElems = [
    { '@_DESCRIPTION': "Time subdivision of parent annotation's time interval, no time gaps allowed within this interval", '@_STEREOTYPE': 'Time_Subdivision' },
    { '@_DESCRIPTION': "Temporal subdivision of parent annotation's time interval, gaps are allowed",                      '@_STEREOTYPE': 'Included_In' },
    { '@_DESCRIPTION': '1-1 association with a parent annotation',                                                         '@_STEREOTYPE': 'Symbolic_Association' },
    { '@_DESCRIPTION': 'Symbolic subdivision of a parent annotation. Annotations refering to the same parent are ordered', '@_STEREOTYPE': 'Symbolic_Subdivision' },
  ]

  // CONTROLLED_VOCABULARY

  const externalRefs: Array<{ id: string; url: string }> = []
  const extRefIdByVocab = new Map<string, string>()
  let extRefCounter = 1
  for (const vocab of vocabularies) {
    if (!vocab.extRefUrl) continue
    const erId = `er${extRefCounter++}`
    extRefIdByVocab.set(vocab.id, erId)
    externalRefs.push({ id: erId, url: vocab.extRefUrl })
  }

  const langRef = language ?? 'und'

  const cvElems: Record<string, unknown>[] = vocabularies.map(vocab => {
    const cvEafId = vocabEafId.get(vocab.id) ?? vocab.id
    const erId    = extRefIdByVocab.get(vocab.id)
    const cvObj: Record<string, unknown> = { '@_CV_ID': cvEafId }
    if (erId) cvObj['@_EXT_REF'] = erId
    cvObj['CV_ENTRY_ML'] = vocab.entries.map(entry => {
      const entryObj: Record<string, unknown> = {
        '@_CVE_ID':  entry.id,
        CVE_VALUE: { '@_LANG_REF': langRef, '#text': entry.value },
      }
      if (entry.description) entryObj['DESCRIPTION'] = { '@_LANG_REF': langRef, '#text': entry.description }
      return entryObj
    })
    return cvObj
  })

  // EXTERNAL_REF declarations

  const extRefElems = externalRefs.map(er => ({
    '@_EXT_REF_ID': er.id,
    '@_TYPE':       'ecv',
    '@_VALUE':      er.url,
  }))

  // Assemble document object (EAF element order must be preserved)
  // EAF 3.0 schema sequence: HEADER, TIME_ORDER, TIER, LINGUISTIC_TYPE,
  // CONSTRAINT, LANGUAGE, CONTROLLED_VOCABULARY, EXTERNAL_REF

  const annotationDoc = {
    '@_AUTHOR':                        author,
    '@_DATE':                          isoDate(),
    '@_FORMAT':                        '3.0',
    '@_VERSION':                       '3.0',
    '@_xmlns:xsi':                     'http://www.w3.org/2001/XMLSchema-instance',
    '@_xsi:noNamespaceSchemaLocation': 'http://www.mpi.nl/tools/elan/EAFv3.0.xsd',
    HEADER:                            headerObj,
    ...(timeOrderObj            ? { TIME_ORDER:            timeOrderObj }                    : {}),
    ...(tierElems.length > 0    ? { TIER:                  tierElems }                       : {}),
    LINGUISTIC_TYPE:                   ltElems,
    CONSTRAINT:                        constraintElems,
    ...(language                ? { LANGUAGE:              { '@_LANG_ID': language } }       : {}),
    ...(cvElems.length > 0      ? { CONTROLLED_VOCABULARY: cvElems }                         : {}),
    ...(extRefElems.length > 0  ? { EXTERNAL_REF:          extRefElems }                     : {}),
  }

  return {
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    ANNOTATION_DOCUMENT: annotationDoc,
  }
}

// emitEAF / emitETF

export function emitEAF(
  doc: PMNodeJSON,
  store: AnnotationStore,
  opts: EmitEAFOptions = {},
): string {
  return eafXmlBuilder.build(buildEAFDocumentObject(doc, store, opts))
}

export function emitETF(store: AnnotationStore, opts: Omit<EmitEAFOptions, 'isTemplate'> = {}): string {
  const emptyDoc: PMNodeJSON = { type: 'doc', content: [] }
  return emitEAF(emptyDoc, store, { ...opts, isTemplate: true })
}

// Helpers

/** Concatenated text of a node, skipping text nodes with suggestion_insert mark. */
function baseTextContent(node: PMNodeJSON): string {
  if (node.text !== undefined) {
    if (node.marks?.some(m => m.type === 'suggestion_insert')) return ''
    return node.text
  }
  return (node.content ?? []).map(baseTextContent).join('')
}

function sortByPrevChain(anns: ReturnType<AnnotationStore['allAnnotations']>) {
  const heads  = anns.filter(a => !a.features['previousAnnId'])
  const result: typeof anns = []
  for (const head of heads) {
    let cur: (typeof anns)[number] | undefined = head
    while (cur) {
      result.push(cur)
      const next = anns.find(a => a.features['previousAnnId'] === cur!.id)
      cur = next
    }
  }
  for (const a of anns) {
    if (!result.includes(a)) result.push(a)
  }
  return result
}
