/**
 * MMEAF parser: .mmeaf XML → mumo (extends EAF parse with mm: namespace data).
 *
 * Falls back gracefully to plain EAF parsing if no mm:mumo_data block is present.
 * When mm: data is present, recovers:
 *   - Word-level token IDs and per-token times (mm:transcript_structure)
 *   - Visualization blocks in document order (mm:transcript_structure mm:visualization)
 *   - Pattern schemas and patterns (mm:pattern_schemas, mm:patterns)
 *   - Mark-anchored textlet annotations with features (mm:textlets)
 *   - Participant metadata (mm:participants)
 */

import { XMLParser } from 'fast-xml-parser'
import { newId } from '@mumo/core'
import type { PatternSchemaJSON, PatternJSON, AnnotationJSON, AnchorJSON, TokenRecord, TierDefJSON, SymbolDef, ParticipantJSON, Suggestion, SuggestedChange, TextletCode, SlotInstance, MetricValue, NoteEntry } from '@mumo/core'
import { parseEAF } from './eaf-parse.js'
import type { ParseResult } from './eaf-parse.js'
import type { PMNodeJSON } from './types.js'

// XMLParser for mm: namespace data

const MM_ARRAY_TAGS = new Set([
  'mm:utt', 'mm:event', 'mm:visualization',
  'mm:t', 'mm:inline_mark', 'mm:xref', 'mm:image',
  'mm:mark',
  'mm:suggestion',
  'mm:textlet',
  'mm:pattern_schema', 'mm:slot', 'mm:metric',
  'mm:pattern', 'mm:slot_instance', 'mm:metric_value',
  'mm:symbol_def', 'mm:tier_ext',
  'mm:anchor', 'mm:pending_ann',
  'mm:code', 'mm:feature', 'mm:ann_feature',
  'mm:participant', 'mm:attr',
  'mm:annotation',
  'mm:bookmark',
  'mm:id', 'mm:vocab_id',
])

const mmXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => MM_ARRAY_TAGS.has(name),
  textNodeName: '#text',
  parseAttributeValue: false,
  trimValues: false,
})

type Rec = Record<string, unknown>

function ga(node: Rec, name: string): string | undefined {
  const v = node[`@_${name}`]
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return v != null ? String(v) : undefined
}

function gt(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (typeof node === 'object' && '#text' in (node))
    return String((node as Record<string, string | number>)['#text'] ?? '')
  return ''
}

// Parse mm:feature elements into a feature bag. Older files have no @_value_type (strings only).
function parseFeatureElems(els: Rec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const el of els) {
    const name = ga(el, 'name')
    if (!name) continue
    const raw = gt(el)
    const valueType = ga(el, 'value_type')
    if (valueType === 'number') {
      out[name] = Number(raw)
    } else if (valueType === 'boolean') {
      out[name] = raw === 'true'
    } else if (valueType === 'json') {
      try { out[name] = JSON.parse(raw) } catch { out[name] = raw }
    } else {
      out[name] = raw
    }
  }
  return out
}

// Helpers

function applyAnnotationMarkToContent(content: PMNodeJSON[], markId: string, start: number, end: number): PMNodeJSON[] {
  const result: PMNodeJSON[] = []
  let pos = 0
  for (const node of content) {
    if (node.type !== 'text' || !node.text) {
      result.push(node)
      continue
    }
    const nodeStart = pos
    const nodeEnd   = pos + node.text.length
    pos = nodeEnd
    if (nodeEnd <= start || nodeStart >= end) {
      result.push(node)
      continue
    }
    const overlapStart = Math.max(start, nodeStart)
    const overlapEnd   = Math.min(end, nodeEnd)
    const annMark = { type: 'annotation', attrs: { id: markId } }
    if (overlapStart > nodeStart) {
      const n: PMNodeJSON = { type: 'text', text: node.text.slice(0, overlapStart - nodeStart) }
      if (node.marks) n.marks = node.marks
      result.push(n)
    }
    result.push({
      type: 'text',
      text: node.text.slice(overlapStart - nodeStart, overlapEnd - nodeStart),
      marks: [...(node.marks ?? []), annMark],
    })
    if (overlapEnd < nodeEnd) {
      const n: PMNodeJSON = { type: 'text', text: node.text.slice(overlapEnd - nodeStart) }
      if (node.marks) n.marks = node.marks
      result.push(n)
    }
  }
  return result
}

function applySuggestionToContent(
  content: PMNodeJSON[],
  suggestionId: string,
  authorId: string,
  fromOffset: number,
  toOffset: number,
  insertText: string,
): PMNodeJSON[] {
  const insMark = { type: 'suggestion_insert', attrs: { suggestionId, authorId } }
  const delMark = { type: 'suggestion_delete', attrs: { suggestionId, authorId } }

  if (fromOffset === toOffset) {
    // Pure insert: inject at fromOffset without marking any existing text
    const result: PMNodeJSON[] = []
    let filteredPos = 0
    let done = false
    for (const node of content) {
      if (node.type !== 'text' || !node.text) { result.push(node); continue }
      if (node.marks?.some(m => m.type === 'suggestion_insert')) { result.push(node); continue }
      const text = node.text
      const baseMarks = node.marks
      const nodeStart = filteredPos
      const nodeEnd   = filteredPos + text.length
      filteredPos = nodeEnd
      if (!done && insertText && fromOffset <= nodeEnd) {
        if (fromOffset <= nodeStart) {
          if (insertText) result.push({ type: 'text', text: insertText, marks: [insMark] })
          done = true
          result.push(node)
        } else {
          const pivot = fromOffset - nodeStart
          const n1: PMNodeJSON = { type: 'text', text: text.slice(0, pivot) }
          if (baseMarks) n1.marks = baseMarks
          result.push(n1)
          if (insertText) result.push({ type: 'text', text: insertText, marks: [insMark] })
          done = true
          if (pivot < text.length) {
            const n2: PMNodeJSON = { type: 'text', text: text.slice(pivot) }
            if (baseMarks) n2.marks = baseMarks
            result.push(n2)
          }
        }
      } else {
        result.push(node)
      }
    }
    if (!done && insertText) result.push({ type: 'text', text: insertText, marks: [insMark] })
    return result
  }

  // Replace: mark [fromOffset, toOffset) with suggestion_delete, inject insert after toOffset
  const result: PMNodeJSON[] = []
  let filteredPos = 0
  let insertDone = false
  for (const node of content) {
    if (node.type !== 'text' || !node.text) { result.push(node); continue }
    if (node.marks?.some(m => m.type === 'suggestion_insert')) { result.push(node); continue }
    const text = node.text
    const baseMarks = node.marks ?? []
    const nodeStart = filteredPos
    const nodeEnd   = filteredPos + text.length
    filteredPos = nodeEnd

    if (!insertDone && insertText && toOffset <= nodeStart) {
      result.push({ type: 'text', text: insertText, marks: [insMark] })
      insertDone = true
    }

    if (nodeEnd <= fromOffset || nodeStart >= toOffset) {
      result.push(node)
      continue
    }

    if (nodeStart < fromOffset) {
      const n: PMNodeJSON = { type: 'text', text: text.slice(0, fromOffset - nodeStart) }
      if (baseMarks.length) n.marks = baseMarks
      result.push(n)
    }
    const delStart = Math.max(fromOffset, nodeStart)
    const delEnd   = Math.min(toOffset,   nodeEnd)
    result.push({ type: 'text', text: text.slice(delStart - nodeStart, delEnd - nodeStart), marks: [...baseMarks, delMark] })

    if (!insertDone && insertText && toOffset <= nodeEnd) {
      result.push({ type: 'text', text: insertText, marks: [insMark] })
      insertDone = true
    }
    if (toOffset < nodeEnd) {
      const n: PMNodeJSON = { type: 'text', text: text.slice(toOffset - nodeStart) }
      if (baseMarks.length) n.marks = baseMarks
      result.push(n)
    }
  }
  if (!insertDone && insertText) result.push({ type: 'text', text: insertText, marks: [insMark] })
  return result
}

// Public types & exports

export interface MMEAFParseResult extends ParseResult {
  patternSchemas: PatternSchemaJSON[]
  patterns: PatternJSON[]
  symbolDefs: SymbolDef[]
  transcriptFont: string
  suggestions: Suggestion[]
  bookmarks: import('@mumo/core').Bookmark[]
}

export function parseMMEAF(xml: string): MMEAFParseResult {
  const base = parseEAF(xml)

  const parsedMM = mmXmlParser.parse(xml) as Rec
  const docEl    = (parsedMM['ANNOTATION_DOCUMENT'] ?? {}) as Rec
  const mmDataEl = docEl['mm:mumo_data'] as Rec | undefined
  if (!mmDataEl) {
    return { ...base, patternSchemas: [], patterns: [], symbolDefs: [], transcriptFont: '', suggestions: [], bookmarks: [] }
  }

  const tsEl = mmDataEl['mm:transcript_structure'] as Rec | undefined

  type Block = { type: string; attrs: Record<string, unknown>; content: unknown[] }
  const baseDoc = base.doc as { type: string; content: Block[] }

  // Restore original mumo IDs from mm:id_map
  // parseEAF mints fresh IDs for utterance blocks and store annotations. Files
  // with an mm:id_map record the original mumo ID for each EAF ANNOTATION_ID —
  // compose the two mappings and rename everything back, so IDs (and therefore
  // permalinks and pattern slot references) survive save/load. Legacy files
  // without an id_map keep the fresh IDs and the heuristic remapping below.
  const idMapEl = mmDataEl['mm:id_map'] as Rec | undefined
  if (idMapEl) {
    const freshToOrig = new Map<string, string>()
    for (const el of ((idMapEl['mm:id'] ?? []) as Rec[])) {
      const eafId  = ga(el, 'eaf')
      const origId = ga(el, 'id')
      if (!eafId || !origId) continue
      const freshId = base.eafIdToMumoId[eafId]
      if (freshId && freshId !== origId) freshToOrig.set(freshId, origId)
    }
    if (freshToOrig.size > 0) {
      for (const block of baseDoc.content) {
        const orig = freshToOrig.get(block.attrs['id'] as string)
        if (orig) block.attrs['id'] = orig
      }
      for (const tok of base.tokens) {
        const orig = freshToOrig.get(tok.uttId)
        if (orig) tok.uttId = orig
      }
      for (const ann of base.annotations) {
        const origId = freshToOrig.get(ann.id)
        if (origId) ann.id = origId
        for (const key of ['parentAnnId', 'previousAnnId', 'blockNodeId', 'utteranceId'] as const) {
          const v = ann.features[key]
          const orig = typeof v === 'string' ? freshToOrig.get(v) : undefined
          if (orig) ann.features[key] = orig
        }
      }
    }
    // Vocabularies: EAF CV_ID is the vocab *name*; restore the mumo uuid so
    // pattern metric vocabularyId references resolve again after round-trip.
    const vocabIdByEaf = new Map<string, string>()
    for (const el of ((idMapEl['mm:vocab_id'] ?? []) as Rec[])) {
      const eafId  = ga(el, 'eaf')
      const origId = ga(el, 'id')
      if (eafId && origId) vocabIdByEaf.set(eafId, origId)
    }
    if (vocabIdByEaf.size > 0) {
      for (const v of base.vocabularies) {
        const orig = vocabIdByEaf.get(v.id)
        if (orig) v.id = orig
      }
      for (const lt of base.linguisticTypes) {
        const orig = lt.vocabularyId ? vocabIdByEaf.get(lt.vocabularyId) : undefined
        if (orig) lt.vocabularyId = orig
      }
    }
  }

  // images pool (needed for viz inline content)
  const imagesEl = mmDataEl['mm:images'] as Rec | undefined
  const imageMetaMap = new Map<string, { label: string; width: number; provenance: unknown }>()
  if (imagesEl) {
    for (const imgEl of ((imagesEl['mm:image'] ?? []) as Rec[])) {
      const id    = ga(imgEl, 'id') ?? ''
      const label = ga(imgEl, 'label') ?? ''
      const width = Number(ga(imgEl, 'width') ?? '150')
      const provEl = imgEl['mm:provenance'] as Rec | undefined
      let provenance = null
      if (provEl) {
        const kind = ga(provEl, 'kind')
        if (kind === 'screenshot') {
          provenance = { kind: 'screenshot', mediaPath: ga(provEl, 'media_path') ?? '', mediaTimeMs: Number(ga(provEl, 'media_time_ms') ?? '0') }
        } else if (kind === 'upload') {
          provenance = { kind: 'upload', filename: ga(provEl, 'filename') ?? '' }
        }
      }
      imageMetaMap.set(id, { label, width, provenance })
    }
  }

  // Build maps for matching transcript_structure elements to base blocks
  // Use arrays per key so multiple untimed utterances from the same participant
  // are matched sequentially (by order within each key group) rather than the
  // last-write-wins single-entry map that caused earlier utterances to be lost.
  const baseBlocksByKey = new Map<string, Block[]>()
  baseDoc.content.forEach(block => {
    if (block.type !== 'utterance') return
    const p  = (block.attrs['participant'] as string | undefined) ?? ''
    const s  = block.attrs['startTimeSeconds'] as number | null | undefined
    const ms = s != null ? Math.round(s * 1000) : null
    const key = `utterance:${p}::${ms ?? ''}`
    let arr = baseBlocksByKey.get(key)
    if (!arr) { arr = []; baseBlocksByKey.set(key, arr) }
    arr.push(block)
  })

  // block_id (from XML) → fresh ID assigned by parseEAF.
  // When mm:id_map restored the original IDs above, the stored block_id matches
  // a block directly and the mapping is identity. Otherwise (legacy files) fall
  // back to matching by participant+startMs, consuming blocks sequentially
  // within each key group so untimed utterances map correctly.
  const blockIdToFreshId = new Map<string, string>()
  const _blockKeyIdx     = new Map<string, number>()
  const _existingBlockIds = new Set<string>()
  for (const block of baseDoc.content) {
    const id = block.attrs['id'] as string | undefined
    if (id) _existingBlockIds.add(id)
  }
  if (tsEl) {
    for (const el of ((tsEl['mm:utt'] ?? []) as Rec[])) {
      const storedBid = ga(el, 'block_id') ?? ''
      if (storedBid && _existingBlockIds.has(storedBid)) {
        blockIdToFreshId.set(storedBid, storedBid)
        continue
      }
      const p       = ga(el, 'participant') ?? ''
      const rawMs   = ga(el, 'start_ms')
      const ms      = rawMs != null ? Number(rawMs) : null
      const key     = `utterance:${p}::${ms ?? ''}`
      const blocks  = baseBlocksByKey.get(key) ?? []
      const idx     = _blockKeyIdx.get(key) ?? 0
      const block   = blocks[idx]
      if (block && storedBid) {
        blockIdToFreshId.set(storedBid, block.attrs['id'] as string)
        _blockKeyIdx.set(key, idx + 1)
      }
    }
  }

  // Token + inline mark recovery
  const recoveredTokens: TokenRecord[] = []
  const recoveredTokenTimes: Record<string, { start: number | null; end: number | null }> = {}

  // annotation_ref back-references: annId → anchor to attach
  type PendingAnchor = { type: 'utterance'; uttId: string } | { type: 'token'; tokenId: string }
  const annRefAnchors = new Map<string, PendingAnchor>()

  // Build fresh-id → mm:utt element lookup using the already-correct blockIdToFreshId map.
  const freshIdToMmElem = new Map<string, Rec>()
  if (tsEl) {
    for (const el of ((tsEl['mm:utt'] ?? []) as Rec[])) {
      const storedBid = ga(el, 'block_id') ?? ''
      const freshId   = blockIdToFreshId.get(storedBid)
      if (freshId) freshIdToMmElem.set(freshId, el)
    }
  }

  baseDoc.content.forEach((block) => {
    if (block.type !== 'utterance') return
    const blockId = (block.attrs['id'] as string | undefined) ?? ''
    const mmEl    = freshIdToMmElem.get(blockId)
    if (!mmEl) return

    // Collect utterance-level annotation_ref
    const uttRef = ga(mmEl, 'annotation_ref')
    if (uttRef) annRefAnchors.set(uttRef, { type: 'utterance', uttId: blockId })

    const contOf = ga(mmEl, 'continuation_of')
    if (contOf) block.attrs['continuationOfId'] = contOf

    let offset = 0
    for (const tok of ((mmEl['mm:t'] ?? []) as Rec[])) {
      const kind       = (ga(tok, 'type') ?? 'word') as TokenRecord['kind']
      const id         = ga(tok, 'id') ?? newId()
      const startMsStr = ga(tok, 'start_ms')
      const endMsStr   = ga(tok, 'end_ms')
      const text       = gt(tok)

      // Collect token-level annotation_ref
      const tokRef = ga(tok, 'annotation_ref')
      if (tokRef) annRefAnchors.set(tokRef, { type: 'token', tokenId: id })

      recoveredTokens.push({
        id, uttId: blockId, kind, text,
        startOffset: offset, endOffset: offset + text.length,
      })
      if (startMsStr != null || endMsStr != null) {
        recoveredTokenTimes[id] = {
          start: startMsStr != null ? Number(startMsStr) / 1000 : null,
          end:   endMsStr   != null ? Number(endMsStr)   / 1000 : null,
        }
      }
      offset += text.length
    }

    const markEls = ((mmEl['mm:inline_mark'] ?? []) as Rec[])
    if (markEls.length > 0) {
      type InlineMark = { offset: number; node: PMNodeJSON }
      const marks: InlineMark[] = []
      for (const el of markEls) {
        const type       = ga(el, 'type')
        const charOffset = Number(ga(el, 'char_offset') ?? '0')
        if (type === 'overlap_bracket') {
          marks.push({ offset: charOffset, node: { type: 'overlap_bracket', attrs: { id: ga(el, 'group_id') ?? '', kind: ga(el, 'kind') ?? 'start' } } })
        } else if (type === 'anchor') {
          marks.push({ offset: charOffset, node: { type: 'anchor', attrs: { id: ga(el, 'id') ?? '', delimiter: ga(el, 'delimiter') ?? '*', kind: ga(el, 'kind') ?? 'start' } } })
        } else if (type === 'inline_ann') {
          marks.push({ offset: charOffset, node: { type: 'inline_ann', attrs: { id: ga(el, 'id') ?? '', value: ga(el, 'value') ?? '', vizId: ga(el, 'viz_id') || null } } })
        }
      }
      marks.sort((a, b) => a.offset - b.offset)

      if (marks.length > 0) {
        const plainText = (block.content as PMNodeJSON[])
          .filter(n => n.type === 'text')
          .map(n => n.text ?? '')
          .join('')
        const newContent: PMNodeJSON[] = []
        let pos = 0
        for (const mark of marks) {
          const slice = plainText.slice(pos, mark.offset)
          if (slice) newContent.push({ type: 'text', text: slice })
          newContent.push(mark.node)
          pos = mark.offset
        }
        const tail = plainText.slice(pos)
        if (tail) newContent.push({ type: 'text', text: tail })
        block.content = newContent
      }
    }
  })

  const tokens     = recoveredTokens.length > 0 ? recoveredTokens : base.tokens
  const tokenTimes = Object.keys(recoveredTokenTimes).length > 0 ? recoveredTokenTimes : base.tokenTimes

  if (recoveredTokens.length > 0) {
    const baseTokByKey = new Map<string, string>()
    for (const tok of base.tokens) baseTokByKey.set(`${tok.uttId}:${tok.startOffset}:${tok.text}`, tok.id)
    const freshToOriginal = new Map<string, string>()
    for (const rec of recoveredTokens) {
      const freshId = baseTokByKey.get(`${rec.uttId}:${rec.startOffset}:${rec.text}`)
      if (freshId) freshToOriginal.set(freshId, rec.id)
    }
    if (freshToOriginal.size > 0) {
      for (const ann of base.annotations) {
        const wid = ann.features['tokenNodeId']
        if (!wid) continue
        const orig = freshToOriginal.get(wid)
        if (orig) (ann.features)['tokenNodeId'] = orig
      }
    }
  }

  // Rebuild doc in transcript_structure order, inserting viz blocks

  function parseVizInlineContent(el: Rec): PMNodeJSON[] {
    type VizInline = { charOffset: number; node: PMNodeJSON }
    const inlines: VizInline[] = []

    for (const xref of ((el['mm:xref'] ?? []) as Rec[])) {
      const imageId    = ga(xref, 'image_id') ?? ''
      const charOffset = Number(ga(xref, 'char_offset') ?? '0')
      const imgMeta = imageMetaMap.get(imageId)
      if (imgMeta) inlines.push({ charOffset, node: { type: 'image', attrs: { id: imageId, label: imgMeta.label, width: imgMeta.width, provenance: imgMeta.provenance } } })
    }

    for (const mark of ((el['mm:inline_mark'] ?? []) as Rec[])) {
      const markType   = ga(mark, 'type')
      const charOffset = Number(ga(mark, 'char_offset') ?? '0')
      if (markType === 'overlap_bracket') {
        inlines.push({ charOffset, node: { type: 'overlap_bracket', attrs: { id: ga(mark, 'group_id') ?? '', kind: ga(mark, 'kind') ?? 'start' } } })
      } else if (markType === 'anchor') {
        inlines.push({ charOffset, node: { type: 'anchor', attrs: { id: ga(mark, 'id') ?? '', delimiter: ga(mark, 'delimiter') ?? '*', kind: ga(mark, 'kind') ?? 'start' } } })
      } else if (markType === 'inline_ann') {
        inlines.push({ charOffset, node: { type: 'inline_ann', attrs: { id: ga(mark, 'id') ?? '', value: ga(mark, 'value') ?? '', vizId: ga(mark, 'viz_id') || null } } })
      }
    }

    return inlines.sort((a, b) => a.charOffset - b.charOffset).map(i => i.node)
  }

  const vizArr   = tsEl ? ((tsEl['mm:visualization'] ?? []) as Rec[]) : []
  const hasTsViz = vizArr.length > 0

  if (hasTsViz) {
    type TsChild = { order: number; tag: string; el: Rec }
    const allTsChildren: TsChild[] = [
      ...(((tsEl!['mm:utt'] ?? []) as Rec[]).map((el, i) => ({
        order: parseInt(ga(el, 'order') ?? String(i * 2), 10),
        tag: 'utt', el,
      }))),
      ...(vizArr.map((el, i) => ({
        order: parseInt(ga(el, 'order') ?? String(i * 2 + 1), 10),
        tag: 'viz', el,
      }))),
    ].sort((a, b) => a.order - b.order)

    const orderedContent: Block[] = []

    // Build a blockId → block lookup for O(1) access in the ordering loop.
    const _blockByFreshId = new Map<string, Block>()
    for (const block of baseDoc.content) {
      const id = block.attrs['id'] as string | undefined
      if (id) _blockByFreshId.set(id, block)
    }
    const placedFreshIds = new Set<string>()

    for (const { tag, el } of allTsChildren) {
      if (tag === 'utt') {
        const storedBid = ga(el, 'block_id') ?? ''
        const freshId   = blockIdToFreshId.get(storedBid)
        const block     = freshId ? _blockByFreshId.get(freshId) : undefined
        if (block && freshId && !placedFreshIds.has(freshId)) {
          orderedContent.push(block)
          placedFreshIds.add(freshId)
        }

      } else if (tag === 'viz') {
        const id               = ga(el, 'block_id') ?? newId()
        const vizType          = ga(el, 'type') ?? 'screenshot'
        const label            = ga(el, 'label') ?? ''
        const participant      = ga(el, 'participant') ?? ''
        const tier             = ga(el, 'tier') ?? ''
        const dependent        = ga(el, 'dependent') === 'true'
        const parentBlockId    = ga(el, 'parent_block_id') ?? null
        const startMsStr       = ga(el, 'start_ms')
        const endMsStr         = ga(el, 'end_ms')
        const startTimeSeconds = startMsStr != null ? Number(startMsStr) / 1000 : null
        const endTimeSeconds   = endMsStr   != null ? Number(endMsStr)   / 1000 : null
        const parentNodeId     = parentBlockId ? (blockIdToFreshId.get(parentBlockId) ?? null) : null

        orderedContent.push({
          type: 'visualization',
          attrs: { id, type: vizType, label, startTimeSeconds, endTimeSeconds, participant, tier, dependent, parentNodeId },
          content: parseVizInlineContent(el),
        })
      }
    }

    for (const block of baseDoc.content) {
      if (block.type !== 'utterance') continue
      const freshId = block.attrs['id'] as string | undefined
      if (freshId && !placedFreshIds.has(freshId)) orderedContent.push(block)
    }

    baseDoc.content = orderedContent
  }

  // Annotation marks: restore PM annotation mark spans in the doc
  const marksEl = mmDataEl['mm:marks'] as Rec | undefined
  if (marksEl) {
    const blockById = new Map<string, { content: unknown[] }>()
    for (const block of baseDoc.content) {
      const id = block.attrs['id'] as string | undefined
      if (id) blockById.set(id, block)
    }
    for (const el of ((marksEl['mm:mark'] ?? []) as Rec[])) {
      const markId        = ga(el, 'id') ?? ''
      const storedBlockId = ga(el, 'block_id') ?? ''
      const start         = Number(ga(el, 'start') ?? '0')
      const end           = Number(ga(el, 'end') ?? '0')
      if (!markId || !storedBlockId || start >= end) continue
      const freshBlockId = blockIdToFreshId.get(storedBlockId) ?? storedBlockId
      const block = blockById.get(freshBlockId)
      if (!block) continue
      block.content = applyAnnotationMarkToContent(block.content as PMNodeJSON[], markId, start, end)
    }
  }

  // Pattern schemas
  const patternSchemasEl = mmDataEl['mm:pattern_schemas'] as Rec | undefined
  const patternSchemas: PatternSchemaJSON[] = []
  for (const el of (((patternSchemasEl?.['mm:pattern_schema'] ?? [])) as Rec[])) {
    const slots = (((el['mm:slot'] ?? [])) as Rec[]).map(slotEl => {
      const styleEl = slotEl['mm:style'] as Rec | undefined
      const style = styleEl ? {
        ...(ga(styleEl, 'text_color')       ? { textColor:       ga(styleEl, 'text_color')! }       : {}),
        ...(ga(styleEl, 'background_color') ? { backgroundColor: ga(styleEl, 'background_color')! } : {}),
        ...(ga(styleEl, 'border_color')     ? { borderColor:     ga(styleEl, 'border_color')! }     : {}),
        ...(ga(styleEl, 'bold')        === 'true' ? { bold:        true } : {}),
        ...(ga(styleEl, 'italic')      === 'true' ? { italic:      true } : {}),
        ...(ga(styleEl, 'underline')   === 'true' ? { underline:   true } : {}),
        ...(ga(styleEl, 'strikethrough') === 'true' ? { strikethrough: true } : {}),
      } : undefined
      const metrics = (((slotEl['mm:metric'] ?? [])) as Rec[]).map(mEl => {
        const vocabAttr = ga(mEl, 'vocabulary_id')
        return {
          id:   ga(mEl, 'id') ?? newId(),
          name: ga(mEl, 'name') ?? '',
          type: (ga(mEl, 'type') ?? 'text') as 'text' | 'boolean' | 'categorical' | 'participant',
          ...(vocabAttr ? { vocabularyId: vocabAttr } : {}),
        }
      })
      return {
        id:         ga(slotEl, 'id') ?? newId(),
        name:       ga(slotEl, 'name') ?? '',
        anchorKind: (() => { const raw = ga(slotEl, 'anchor_kind') ?? 'textlet'; return (raw === 'span' ? 'textlet' : raw) as 'textlet' | 'utterance' | 'tier' | 'pattern' | 'any' })(),
        ...(ga(slotEl, 'tier_id')             ? { tierId: ga(slotEl, 'tier_id')! }    : {}),
        ...(ga(slotEl, 'required')  === 'true' ? { required:  true }                  : {}),
        ...(ga(slotEl, 'variadic')  === 'true' ? { variadic:  true }                  : {}),
        ...(ga(slotEl, 'label')               ? { label: ga(slotEl, 'label')! }       : {}),
        ...(style && Object.keys(style).length > 0 ? { style } : {}),
        metrics,
      }
    })
    const descAttr   = ga(el, 'description')
    const colorAttr  = ga(el, 'color')
    const hotkeyAttr = ga(el, 'hotkey')
    patternSchemas.push({
      id:   ga(el, 'id') ?? newId(),
      name: ga(el, 'name') ?? '',
      slots,
      ...(descAttr             ? { description: descAttr }            : {}),
      ...(colorAttr != null    ? { color: Number(colorAttr) }         : {}),
      ...(hotkeyAttr           ? { hotkey: hotkeyAttr }               : {}),
    })
  }

  // Patterns
  const patternsEl = mmDataEl['mm:patterns'] as Rec | undefined
  const patterns: PatternJSON[] = []
  for (const el of (((patternsEl?.['mm:pattern'] ?? [])) as Rec[])) {
    const slots = (((el['mm:slot_instance'] ?? [])) as Rec[]).map(siEl => {
      const metrics = (((siEl['mm:metric_value'] ?? [])) as Rec[]).map(mvEl => ({
        schemaId: ga(mvEl, 'schema_id') ?? '',
        value:    ga(mvEl, 'value') ?? '',
      }))
      return {
        id:           ga(siEl, 'id') ?? newId(),
        schemaSlotId: ga(siEl, 'schema_slot_id') ?? '',
        annotationId: ga(siEl, 'annotation_id') ?? '',
        metrics,
      }
    })
    const noteEls = Array.isArray(el['mm:note']) ? (el['mm:note'] as Rec[])
      : el['mm:note'] ? [el['mm:note'] as Rec] : []
    const notes: Record<string, NoteEntry[]> = {}
    for (const ne of noteEls) {
      const author = ga(ne, 'author') ?? 'unknown'
      const text = (ne['#text'] as string | undefined) ?? ''
      if (!text) continue
      const createdAt = parseInt(ga(ne, 'created_at') ?? '0', 10) || Date.now()
      if (!notes[author]) notes[author] = []
      notes[author].push({ text, createdAt })
    }
    patterns.push({
      id:       ga(el, 'id') ?? newId(),
      schemaId: ga(el, 'schema_id') ?? '',
      slots,
      ...(Object.keys(notes).length ? { notes } : {}),
    })
  }

  // Textlets
  const textletsEl = mmDataEl['mm:textlets'] as Rec | undefined
  const textletAnnotations: AnnotationJSON[] = []
  for (const el of (((textletsEl?.['mm:textlet'] ?? [])) as Rec[])) {
    const id     = ga(el, 'id') ?? newId()
    const markId = ga(el, 'mark_id') ?? ''
    const type   = ga(el, 'type') ?? 'textlet'
    const features: Record<string, unknown> = {}
    const noteEls = Array.isArray(el['mm:note']) ? (el['mm:note'] as Rec[])
      : el['mm:note'] ? [el['mm:note'] as Rec] : []
    const codesEl = el['mm:codes'] as Rec | undefined
    const featureEls = ((el['mm:feature'] ?? [])) as Rec[]
    if (noteEls.length > 0) {
      const notes: Record<string, NoteEntry[]> = {}
      for (const ne of noteEls) {
        const author = ga(ne, 'author') ?? 'unknown'
        const text = (ne['#text'] as string | undefined) ?? ''
        if (!text) continue
        const createdAt = parseInt(ga(ne, 'created_at') ?? '0', 10) || Date.now()
        if (!notes[author]) notes[author] = []
        notes[author].push({ text, createdAt })
      }
      if (Object.keys(notes).length) features['notes'] = notes
    }
    if (codesEl) {
      const codes = (((codesEl['mm:code'] ?? [])) as unknown[]).map(c => {
        const value = gt(c)
        if (!value) return null
        const vocabEntryId = (typeof c === 'object' && c !== null) ? ga(c as Rec, 'vocab_entry_id') : undefined
        const vocabId      = (typeof c === 'object' && c !== null) ? ga(c as Rec, 'vocab_id')       : undefined
        return vocabEntryId ? { value, vocabEntryId, ...(vocabId ? { vocabId } : {}) } : { value }
      }).filter((c): c is { value: string; vocabEntryId?: string; vocabId?: string } => c != null)
      if (codes.length > 0) features['codes'] = codes
    }
    Object.assign(features, parseFeatureElems(featureEls))
    textletAnnotations.push({
      id, type,
      anchors: [{ type: 'mark', markId }],
      features,
    })
  }

  // Store-only annotations (pattern slots, utterance/token/time-anchored)
  const annotationsEl = mmDataEl['mm:annotations'] as Rec | undefined
  const uttTokAnnotations: AnnotationJSON[] = []
  for (const el of (((annotationsEl?.['mm:annotation'] ?? [])) as Rec[])) {
    const id   = ga(el, 'id') ?? newId()
    const type = ga(el, 'type') ?? 'annotation'
    const features = parseFeatureElems((el['mm:feature'] ?? []) as Rec[])
    const anchors: AnchorJSON[] = ((el['mm:anchor'] ?? []) as Rec[]).flatMap((a): AnchorJSON[] => {
      const aType = ga(a, 'type') ?? ''
      if (aType === 'utterance') {
        const uttId = ga(a, 'utt_id') ?? ''
        return [{ type: 'utterance', uttId: blockIdToFreshId.get(uttId) ?? uttId }]
      }
      if (aType === 'token')      return [{ type: 'token', tokenId: ga(a, 'token_id') ?? '' }]
      if (aType === 'time')       return [{ type: 'time', start: Number(ga(a, 'start_ms') ?? '0') / 1000, end: Number(ga(a, 'end_ms') ?? '0') / 1000 }]
      if (aType === 'word_range') return [{ type: 'word-range', fromWordId: ga(a, 'from_word_id') ?? '', toWordId: ga(a, 'to_word_id') ?? '' }]
      return []
    })
    // Legacy files carry anchors as annotation_ref attrs on mm:utt / mm:t instead
    if (anchors.length === 0) {
      const pending = annRefAnchors.get(id)
      if (pending) anchors.push(pending)
    }
    uttTokAnnotations.push({ id, type, anchors, features })
  }
  // Remap stored block IDs in utteranceId/blockNodeId features to fresh PM IDs.
  // parseEAF assigns new IDs to utterances; the stored IDs are stale after round-trip.
  for (const ann of uttTokAnnotations) {
    const uttId = ann.features['utteranceId']
    if (uttId) {
      const freshId = blockIdToFreshId.get(uttId)
      if (freshId) ann.features['utteranceId'] = freshId
    }
    const bnId = ann.features['blockNodeId']
    if (bnId) {
      const freshId = blockIdToFreshId.get(bnId)
      if (freshId) ann.features['blockNodeId'] = freshId
    }
  }

  // Participants
  const participantsEl = mmDataEl['mm:participants'] as Rec | undefined
  const mmParticipants: ParticipantJSON[] = []
  if (participantsEl) {
    for (const el of (((participantsEl['mm:participant'] ?? [])) as Rec[])) {
      const id    = ga(el, 'id') ?? newId()
      const label = ga(el, 'label') ?? id
      const attrEls = ((el['mm:attr'] ?? [])) as Rec[]
      const attrs: Record<string, string> = {}
      for (const aEl of attrEls) {
        const name = ga(aEl, 'name')
        const val  = gt(aEl)
        if (name) attrs[name] = val
      }
      mmParticipants.push({ id, label, ...(Object.keys(attrs).length > 0 ? { attrs } : {}) })
    }
  }

  // Tier extensions
  const tierExtMap  = new Map<string, Partial<TierDefJSON>>()
  const tierExtsEl  = mmDataEl['mm:tier_extensions'] as Rec | undefined
  if (tierExtsEl) {
    for (const el of (((tierExtsEl['mm:tier_ext'] ?? [])) as Rec[])) {
      const key = ga(el, 'tier_key') ?? ''
      if (!key) continue
      const ext: Partial<TierDefJSON> = {}
      const trackSetId = ga(el, 'track_set_id')
      const trackId    = ga(el, 'track_id')
      if (trackSetId && trackId) ext.trackRef = { trackSetId, trackId }
      if (ga(el, 'is_utt_tier') === 'true') ext.isUttTier = true
      if (Object.keys(ext).length > 0) tierExtMap.set(key, ext)
    }
  }
  const tiers: TierDefJSON[] = tierExtMap.size > 0
    ? base.tiers.map(t => {
        const ext = tierExtMap.get(t.name)
        return ext ? { ...t, ...ext } : t
      })
    : base.tiers

  // Font config
  const fontConfigEl   = mmDataEl['mm:font_config'] as Rec | undefined
  const transcriptFont = fontConfigEl ? (ga(fontConfigEl, 'transcript_font') ?? '') : ''

  // Symbol defs
  const symbolDefs: SymbolDef[] = []
  const symbolDefsEl = mmDataEl['mm:symbol_defs'] as Rec | undefined
  if (symbolDefsEl) {
    for (const el of (((symbolDefsEl['mm:symbol_def'] ?? [])) as Rec[])) {
      const unicode     = ga(el, 'unicode') ?? ''
      const shortcut    = ga(el, 'shortcut')
      const description = ga(el, 'description')
      const def: SymbolDef = { unicode }
      if (shortcut)    def.shortcut    = shortcut
      if (description) def.description = description
      symbolDefs.push(def)
    }
  }

  // Suggestions
  const suggestionsEl = mmDataEl['mm:suggestions'] as Rec | undefined
  const suggestions: Suggestion[] = []
  if (suggestionsEl) {
    const blockById = new Map<string, Block>()
    for (const block of baseDoc.content) {
      const id = block.attrs['id'] as string | undefined
      if (id) blockById.set(id, block)
    }
    for (const el of ((suggestionsEl['mm:suggestion'] ?? []) as Rec[])) {
      const storedId      = ga(el, 'id') ?? newId()
      const storedBlockId = ga(el, 'block_id') ?? ''
      const authorId      = ga(el, 'author_id') ?? ''
      const note          = ga(el, 'note')
      const createdAt     = ga(el, 'created_at') != null ? Number(ga(el, 'created_at')) : Date.now()
      const freshBlockId  = blockIdToFreshId.get(storedBlockId) ?? storedBlockId

      const sugType = ga(el, 'type')

      if (sugType === 'set_participant') {
        const participant = ga(el, 'participant') ?? ''
        const change: SuggestedChange = { type: 'utt:set-participant', uttId: freshBlockId, participant }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

      } else if (sugType === 'set_time') {
        const startMs = Number(ga(el, 'start_ms') ?? '0')
        const endMs   = Number(ga(el, 'end_ms')   ?? '0')
        const change: SuggestedChange = { type: 'utt:set-time', uttId: freshBlockId, startTime: startMs / 1000, endTime: endMs / 1000 }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

      } else if (sugType === 'add_annotation') {
        const annEl  = el['mm:ann'] as Rec | undefined
        if (annEl) {
          const annId      = ga(annEl, 'id') ?? newId()
          const annType    = ga(annEl, 'ann_type') ?? ''
          const tierId     = ga(annEl, 'tier_id')
          const startMsStr = ga(annEl, 'start_ms')
          const endMsStr   = ga(annEl, 'end_ms')
          const features = parseFeatureElems((annEl['mm:feature'] ?? []) as Rec[])
          if (tierId) features['tierId'] = tierId
          const anchors = (startMsStr != null && endMsStr != null)
            ? [{ type: 'time' as const, start: Number(startMsStr) / 1000, end: Number(endMsStr) / 1000 }]
            : []
          const change: SuggestedChange = { type: 'annotation:add', annotation: { id: annId, type: annType, anchors, features } }
          suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })
        }

      } else if (sugType === 'update_annotation_time') {
        const annotationId = ga(el, 'annotation_id') ?? ''
        const startMs      = Number(ga(el, 'start_ms') ?? '0')
        const endMs        = Number(ga(el, 'end_ms')   ?? '0')
        const ta = { type: 'time' as const, start: startMs / 1000, end: endMs / 1000 }
        // Merge with existing annotation anchors so non-time anchors are preserved
        const existingAnchors = base.annotations.find(a => a.id === annotationId)?.anchors ?? []
        const mergedAnchors = [...existingAnchors.filter(a => a.type !== 'time'), ta]
        const change: SuggestedChange = { type: 'annotation:update', annotationId, patch: { anchors: mergedAnchors } }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

      } else if (sugType === 'update_annotation_type') {
        const annotationId = ga(el, 'annotation_id') ?? ''
        const annType      = ga(el, 'ann_type') ?? ''
        const change: SuggestedChange = { type: 'annotation:update', annotationId, patch: { type: annType } }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

      } else if (sugType === 'delete_annotation') {
        const annotationId = ga(el, 'annotation_id') ?? ''
        const change: SuggestedChange = { type: 'annotation:delete', annotationId }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

      } else if (sugType === 'add_textlet') {
        const tlEl = el['mm:textlet_ann'] as Rec | undefined
        if (tlEl) {
          const annId      = ga(tlEl, 'id') ?? newId()
          const annType    = ga(tlEl, 'ann_type') ?? ''
          const fromWordId = ga(tlEl, 'from_word_id')
          const toWordId   = ga(tlEl, 'to_word_id')
          const markId     = ga(tlEl, 'mark_id')
          const features = parseFeatureElems((tlEl['mm:feature'] ?? []) as Rec[])
          const anchors = (fromWordId && toWordId)
            ? [{ type: 'word-range' as const, fromWordId, toWordId }]
            : markId ? [{ type: 'mark' as const, markId }] : []
          const change: SuggestedChange = { type: 'textlet:add', annotation: { id: annId, type: annType, anchors, features } }
          suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })
        }

      } else if (sugType === 'delete_textlet') {
        const textletId = ga(el, 'textlet_id') ?? ''
        const change: SuggestedChange = { type: 'textlet:delete', textletId }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

      } else if (sugType === 'add_code' || sugType === 'remove_code') {
        const textletId    = ga(el, 'textlet_id') ?? ''
        const codeEl       = ((el['mm:code'] ?? []) as Rec[])[0]  // mm:code is always-array tag
        const codeValue    = codeEl ? gt(codeEl) : ''
        const vocabEntryId = codeEl ? ga(codeEl, 'vocab_entry_id') : undefined
        const vocabId      = codeEl ? ga(codeEl, 'vocab_id')       : undefined
        const code: TextletCode = { value: codeValue, ...(vocabEntryId ? { vocabEntryId } : {}), ...(vocabId ? { vocabId } : {}) }
        const change: SuggestedChange = sugType === 'add_code'
          ? { type: 'textlet:add-code', textletId, code }
          : { type: 'textlet:remove-code', textletId, code }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

      } else if (sugType === 'add_frame') {
        const patternId   = ga(el, 'frame_id') ?? newId()
        const schemaId  = ga(el, 'schema_id') ?? ''
        const frameNote = ga(el, 'frame_note')
        const change: SuggestedChange = { type: 'pattern:add', patternId, schemaId, ...(frameNote ? { note: frameNote } : {}) }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

      } else if (sugType === 'delete_frame') {
        const patternId = ga(el, 'frame_id') ?? ''
        const change: SuggestedChange = { type: 'pattern:delete', patternId }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

      } else if (sugType === 'fill_slot') {
        const patternId = ga(el, 'frame_id') ?? ''
        const siEl    = ((el['mm:slot_instance'] ?? []) as Rec[])[0]
        if (siEl) {
          const slotId       = ga(siEl, 'id') ?? newId()
          const schemaSlotId = ga(siEl, 'schema_slot_id') ?? ''
          const annotationId = ga(siEl, 'annotation_id') ?? ''
          const metrics: MetricValue[] = ((siEl['mm:metric_value'] ?? []) as Rec[]).map(mv => ({
            schemaId: ga(mv, 'schema_id') ?? '',
            value:    ga(mv, 'value') ?? '',
          }))
          const slot: SlotInstance = { id: slotId, schemaSlotId, annotationId, metrics }

          let pendingAnnotation: AnnotationJSON | undefined
          const paEl = ((el['mm:pending_ann'] ?? []) as Rec[])[0]
          if (paEl) {
            const paId      = ga(paEl, 'id') ?? newId()
            const paType    = ga(paEl, 'ann_type') ?? ''
            const anchors: AnchorJSON[] = ((paEl['mm:anchor'] ?? []) as Rec[]).flatMap((a): AnchorJSON[] => {
              const aType = ga(a, 'type') ?? ''
              if (aType === 'utterance')  return [{ type: 'utterance' as const, uttId: ga(a, 'utt_id') ?? '' }]
              if (aType === 'token')      return [{ type: 'token' as const, tokenId: ga(a, 'token_id') ?? '' }]
              if (aType === 'time')       return [{ type: 'time' as const, start: Number(ga(a, 'start_ms') ?? '0') / 1000, end: Number(ga(a, 'end_ms') ?? '0') / 1000 }]
              if (aType === 'mark')       return [{ type: 'mark' as const, markId: ga(a, 'mark_id') ?? '' }]
              if (aType === 'word_range') return [{ type: 'word-range' as const, fromWordId: ga(a, 'from_word_id') ?? '', toWordId: ga(a, 'to_word_id') ?? '' }]
              return []
            })
            const features = parseFeatureElems((paEl['mm:feature'] ?? []) as Rec[])
            pendingAnnotation = { id: paId, type: paType, anchors, features }
          }

          const change: SuggestedChange = { type: 'pattern:fill-slot', patternId, slot, ...(pendingAnnotation ? { pendingAnnotation } : {}) }
          suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })
        }

      } else if (sugType === 'fill_metric') {
        const patternId     = ga(el, 'frame_id') ?? ''
        const slotSchemaId = ga(el, 'schema_slot_id') ?? ''
        const metricId    = ga(el, 'metric_id') ?? ''
        const valueStr    = ga(el, 'value') ?? ''
        const valueType   = ga(el, 'value_type') ?? 'string'
        const value: string | boolean | number | null =
          valueType === 'boolean' ? valueStr === 'true'
          : valueType === 'number' ? parseFloat(valueStr)
          : valueType === 'null'   ? null
          : valueStr
        const change: SuggestedChange = { type: 'pattern:fill-metric', patternId, slotSchemaId, metricId, value }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

      } else {
        // pm:replace (no type attr, or unrecognised — default for backwards compat)
        const fromOffset = Number(ga(el, 'from_offset') ?? '0')
        const toOffset   = Number(ga(el, 'to_offset')   ?? '0')
        const insertEl   = el['mm:insert'] as Rec | undefined
        const insertText = insertEl ? gt(insertEl) : ''
        const change: SuggestedChange = { type: 'pm:replace', uttId: freshBlockId, fromOffset, toOffset, replacement: insertText }
        suggestions.push({ id: storedId, authorId, createdAt, change, ...(note ? { note } : {}) })

        const block = blockById.get(freshBlockId)
        if (block) {
          block.content = applySuggestionToContent(
            block.content as PMNodeJSON[], storedId, authorId, fromOffset, toOffset, insertText,
          )
        }
      }
    }
  }

  // mm:bookmarks

  const bookmarks: import('@mumo/core').Bookmark[] = []
  const bookmarksEl = mmDataEl['mm:bookmarks'] as Rec | undefined
  if (bookmarksEl) {
    const bmEls = Array.isArray(bookmarksEl['mm:bookmark']) ? (bookmarksEl['mm:bookmark'] as Rec[]) : []
    for (const el of bmEls) {
      const id           = ga(el, 'id') ?? ''
      const label        = ga(el, 'label') ?? ''
      const startMs      = Number(ga(el, 'start_ms') ?? '0')
      const endMs        = Number(ga(el, 'end_ms')   ?? '0')
      const createdAtRaw = ga(el, 'created_at')
      const note         = ga(el, 'note')
      const code         = ga(el, 'code')
      const bm: import('@mumo/core').Bookmark = {
        id,
        label,
        startSeconds: startMs / 1000,
        endSeconds:   endMs   / 1000,
        ...(createdAtRaw ? { createdAt: Number(createdAtRaw) } : {}),
        ...(note ? { note } : {}),
        ...(code ? { code } : {}),
      }
      bookmarks.push(bm)
    }
  }

  return {
    ...base,
    tiers,
    doc: baseDoc,
    annotations: [...base.annotations, ...textletAnnotations, ...uttTokAnnotations],
    tokens,
    tokenTimes,
    participants: mmParticipants.length > 0 ? mmParticipants : base.participants,
    patternSchemas,
    patterns,
    symbolDefs,
    transcriptFont,
    suggestions,
    bookmarks,
  }
}

/** Parse an MMETF template file — same as parseMMEAF, signals template intent. */
export function parseMMETF(xml: string): MMEAFParseResult {
  return parseMMEAF(xml)
}
