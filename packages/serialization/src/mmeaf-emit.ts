/**
 * MMEAF emitter: mumo → .mmeaf XML (superset of EAF 3.0).
 *
 * Adds a <mm:mumo_data> block to the standard EAF output that preserves:
 *   - Word-level token IDs and structure (mm:transcript_structure)
 *   - Pattern schemas and patterns (mm:pattern_schemas, mm:patterns)
 *   - Annotation mark spans in the PM doc (mm:marks)
 *   - Mark-anchored textlet annotations with features (mm:textlets)
 *   - Participant metadata (mm:participants)
 *
 * The mm: namespace elements are ignored by ELAN, so the output is still
 * valid EAF that can be opened by ELAN 6.x.
 *
 * Within mm:transcript_structure, utterances / events / visualizations are
 * grouped by element type (all mm:utt, then mm:event, then mm:visualization)
 * rather than strictly interleaved. The parser reconstructs document order
 * from the `order` attribute, so this grouping is semantically equivalent.
 */

import type { AnnotationStore, TokenStore } from '@mumo/core'
import type { PMNodeJSON } from './types.js'
import { eafXmlBuilder, buildEAFDocumentObject } from './eaf-emit.js'
import type { EmitEAFOptions } from './eaf-emit.js'
import { IdMap } from './id-map.js'

export type EmitMMEAFOptions = EmitEAFOptions

// PM attrs and annotation features are JSON scalars in practice; `x ?? ''`
// types as `{}` under strict lint, so coerce through one audited helper.
function attrStr(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return fallback
}

const NO_SKIP: ReadonlySet<string> = new Set()

// Strings are plain text (no @_value_type, matching older files); numbers/booleans carry the attr.
function featureElems(features: Record<string, unknown>, skip: ReadonlySet<string> = NO_SKIP): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const [name, v] of Object.entries(features)) {
    if (skip.has(name) || v === undefined || v === null) continue
    const el: Record<string, unknown> = { '@_name': name }
    if (typeof v === 'string') {
      el['#text'] = v
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      el['@_value_type'] = typeof v
      el['#text'] = String(v)
    } else {
      el['@_value_type'] = 'json'
      el['#text'] = JSON.stringify(v)
    }
    out.push(el)
  }
  return out
}

export function emitMMEAF(
  doc: PMNodeJSON,
  store: AnnotationStore,
  opts: EmitMMEAFOptions = {},
  tokenStore?: TokenStore,
): string {
  const idMap  = new IdMap()

  // Pass tokenStore so lt-token TIER elements are emitted when child store tiers (e.g. POS)
  // reference token annotations via tokenNodeId. Without this, PARENT_REF and ANNOTATION_REF
  // in those child tiers point to non-existent EAF IDs and the annotations are dropped on reload.
  const docObj = buildEAFDocumentObject(doc, store, tokenStore ? { ...opts, tokenStore } : opts, idMap)

  // Inject mm: namespace onto ANNOTATION_DOCUMENT
  docObj.ANNOTATION_DOCUMENT['@_xmlns:mm'] = 'https://mumo.io/ns/mmeaf/1'

  // Build annotation_ref lookup maps
  const uttAnnRef = new Map<string, string>() // uttId → annotationId
  const tokAnnRef = new Map<string, string>() // tokenId → annotationId
  for (const ann of store.allAnnotations()) {
    for (const anchor of ann.anchors) {
      if (anchor.type === 'utterance') uttAnnRef.set(anchor.uttId, ann.id)
      else if (anchor.type === 'token') tokAnnRef.set(anchor.tokenId, ann.id)
    }
  }

  const mumoData: Record<string, unknown> = { '@_format_version': '1' }

  // mm:id_map
  // EAF ANNOTATION_IDs are sequential ("a1", "a2", …) and mumo IDs are not valid
  // xsd:ID values, so the EAF layer can't carry them. Record the pairing here so
  // the parser can restore original mumo IDs instead of minting fresh ones.
  // Vocabularies get the same treatment: EAF CV_ID is the vocab *name*, so the
  // mumo uuid (referenced by pattern metric vocabularyId) must be recorded too.
  {
    const idElems = idMap.entries()
      .filter(([mumoId, eafId]) => mumoId !== eafId)
      .map(([mumoId, eafId]) => ({ '@_eaf': eafId, '@_id': mumoId }))
    const vocabIdElems = store.allVocabularies()
      .filter(v => (v.name || v.id) !== v.id)
      .map(v => ({ '@_eaf': v.name, '@_id': v.id }))
    if (idElems.length > 0 || vocabIdElems.length > 0) {
      const idMapObj: Record<string, unknown> = {}
      if (idElems.length > 0)      idMapObj['mm:id']       = idElems
      if (vocabIdElems.length > 0) idMapObj['mm:vocab_id'] = vocabIdElems
      mumoData['mm:id_map'] = idMapObj
    }
  }

  // mm:transcript_structure
  // Collect blocks by type; parser sorts by the `order` attribute.

  const uttElems:  Record<string, unknown>[] = []
  const vizElems:  Record<string, unknown>[] = []
  let blockOrder = 0

  for (const node of doc.content ?? []) {
    const a       = node.attrs ?? {}
    const blockId = (a['id'] as string | undefined) ?? ''
    const startMs = a['startTimeSeconds'] != null ? String(Math.round((a['startTimeSeconds'] as number) * 1000)) : undefined
    const endMs   = a['endTimeSeconds']   != null ? String(Math.round((a['endTimeSeconds']   as number) * 1000)) : undefined

    if (node.type === 'utterance') {
      const annRef = uttAnnRef.get(blockId)

      // mm:t token elements
      const tokenElems: Record<string, unknown>[] = []
      for (const tok of tokenStore?.getUttTokens(blockId) ?? []) {
        const t           = store.getTokenTime(tok.id)
        const tStartMs    = (t != null && t.start !== null) ? String(Math.round(t.start * 1000)) : undefined
        const tEndMs      = (t != null && t.end   !== null) ? String(Math.round(t.end   * 1000)) : undefined
        const tokAnnRefId = tokAnnRef.get(tok.id)
        const tokObj: Record<string, unknown> = { '@_type': tok.kind, '@_id': tok.id, '#text': tok.text }
        if (tokAnnRefId)          tokObj['@_annotation_ref'] = tokAnnRefId
        if (tStartMs !== undefined) tokObj['@_start_ms']     = tStartMs
        if (tEndMs   !== undefined) tokObj['@_end_ms']       = tEndMs
        tokenElems.push(tokObj)
      }

      // mm:inline_mark elements
      const inlineMarkElems: Record<string, unknown>[] = []
      let charOffset = 0
      for (const inline of node.content ?? []) {
        if (inline.type === 'text') {
          charOffset += (inline.text ?? '').length
        } else if (inline.type === 'overlap_bracket') {
          const ia = inline.attrs ?? {}
          inlineMarkElems.push({
            '@_type':       'overlap_bracket',
            '@_group_id':   attrStr(ia['id']),
            '@_kind':       attrStr(ia['kind'], 'start'),
            '@_char_offset': String(charOffset),
          })
        } else if (inline.type === 'anchor') {
          const ia = inline.attrs ?? {}
          inlineMarkElems.push({
            '@_type':        'anchor',
            '@_id':          attrStr(ia['id']),
            '@_delimiter':   attrStr(ia['delimiter']),
            '@_kind':        attrStr(ia['kind'], 'start'),
            '@_char_offset': String(charOffset),
          })
        } else if (inline.type === 'inline_ann') {
          const ia = inline.attrs ?? {}
          const markObj: Record<string, unknown> = {
            '@_type':        'inline_ann',
            '@_id':          attrStr(ia['id']),
            '@_value':       attrStr(ia['value']),
            '@_char_offset': String(charOffset),
          }
          if (ia['vizId']) markObj['@_viz_id'] = attrStr(ia['vizId'])
          inlineMarkElems.push(markObj)
        }
      }

      const blockObj: Record<string, unknown> = {
        '@_order':    String(blockOrder++),
        '@_block_id': blockId,
        '@_participant': attrStr(a['participant']),
      }
      if (startMs !== undefined) blockObj['@_start_ms'] = startMs
      if (endMs   !== undefined) blockObj['@_end_ms']   = endMs
      if (annRef)                blockObj['@_annotation_ref'] = annRef
      const uttTier   = (a['tier']   as string | undefined) ?? ''
      const uttTierId = (a['tierId'] as string | undefined) ?? null
      if (uttTier)   blockObj['@_tier']    = uttTier
      if (uttTierId) blockObj['@_tier_id'] = uttTierId
      const contOfId = (a['continuationOfId'] as string | undefined) ?? null
      if (contOfId)  blockObj['@_continuation_of'] = contOfId
      if (tokenElems.length > 0)     blockObj['mm:t']           = tokenElems
      if (inlineMarkElems.length > 0) blockObj['mm:inline_mark'] = inlineMarkElems

      uttElems.push(blockObj)

    } else if (node.type === 'visualization') {
      const xrefElems: Record<string, unknown>[] = []
      const inlineMarkElems: Record<string, unknown>[] = []
      let charOffset = 0

      for (const inline of node.content ?? []) {
        if (inline.type === 'text') {
          charOffset += (inline.text ?? '').length
        } else if (inline.type === 'image') {
          const ia = inline.attrs ?? {}
          xrefElems.push({
            '@_image_id':    attrStr(ia['id']),
            '@_char_offset': String(charOffset),
          })
        } else if (inline.type === 'overlap_bracket') {
          const ia = inline.attrs ?? {}
          inlineMarkElems.push({
            '@_type':        'overlap_bracket',
            '@_group_id':    attrStr(ia['id']),
            '@_kind':        attrStr(ia['kind'], 'start'),
            '@_char_offset': String(charOffset),
          })
        } else if (inline.type === 'anchor') {
          const ia = inline.attrs ?? {}
          inlineMarkElems.push({
            '@_type':        'anchor',
            '@_id':          attrStr(ia['id']),
            '@_delimiter':   attrStr(ia['delimiter']),
            '@_kind':        attrStr(ia['kind'], 'start'),
            '@_char_offset': String(charOffset),
          })
        } else if (inline.type === 'inline_ann') {
          const ia = inline.attrs ?? {}
          const markObj: Record<string, unknown> = {
            '@_type':        'inline_ann',
            '@_id':          attrStr(ia['id']),
            '@_value':       attrStr(ia['value']),
            '@_char_offset': String(charOffset),
          }
          if (ia['vizId']) markObj['@_viz_id'] = attrStr(ia['vizId'])
          inlineMarkElems.push(markObj)
        }
      }

      const vizObj: Record<string, unknown> = {
        '@_order':       String(blockOrder++),
        '@_block_id':    blockId,
        '@_type':        attrStr(a['type'], 'screenshot'),
        '@_label':       attrStr(a['label']),
        '@_participant': attrStr(a['participant']),
        '@_tier':        attrStr(a['tier']),
      }
      if (a['dependent'])    vizObj['@_dependent']       = 'true'
      if (a['parentNodeId']) vizObj['@_parent_block_id'] = attrStr(a['parentNodeId'])
      if (startMs !== undefined) vizObj['@_start_ms'] = startMs
      if (endMs   !== undefined) vizObj['@_end_ms']   = endMs
      if (xrefElems.length > 0)       vizObj['mm:xref']        = xrefElems
      if (inlineMarkElems.length > 0) vizObj['mm:inline_mark'] = inlineMarkElems
      vizElems.push(vizObj)
    }
  }

  const transcriptStructure: Record<string, unknown> = {}
  if (uttElems.length > 0) transcriptStructure['mm:utt']           = uttElems
  if (vizElems.length > 0) transcriptStructure['mm:visualization'] = vizElems
  mumoData['mm:transcript_structure'] = transcriptStructure

  // mm:images

  const allVizImages: PMNodeJSON[] = []
  for (const viz of (doc.content ?? []).filter(n => n.type === 'visualization')) {
    for (const inline of viz.content ?? []) {
      if (inline.type === 'image') allVizImages.push(inline)
    }
  }
  if (allVizImages.length > 0) {
    mumoData['mm:images'] = {
      'mm:image': allVizImages.map(img => {
        const ia   = img.attrs ?? {}
        const prov = ia['provenance'] as { kind: string; mediaPath?: string; mediaTimeMs?: number; filename?: string } | null | undefined
        const imgObj: Record<string, unknown> = {
          '@_id':    attrStr(ia['id']),
          '@_label': attrStr(ia['label']),
          '@_width': attrStr(ia['width'], '150'),
        }
        if (prov?.kind === 'screenshot') {
          imgObj['mm:provenance'] = {
            '@_kind':          'screenshot',
            '@_media_path':    prov.mediaPath ?? '',
            '@_media_time_ms': String(prov.mediaTimeMs ?? 0),
          }
        } else if (prov?.kind === 'upload') {
          imgObj['mm:provenance'] = { '@_kind': 'upload', '@_filename': prov.filename ?? '' }
        }
        return imgObj
      }),
    }
  }

  // mm:pattern_schemas

  const patternSchemas = store.allPatternSchemas()
  if (patternSchemas.length > 0) {
    mumoData['mm:pattern_schemas'] = {
      'mm:pattern_schema': patternSchemas.map(schema => {
        const schemaObj: Record<string, unknown> = { '@_id': schema.id, '@_name': schema.name }
        if (schema.description) schemaObj['@_description'] = schema.description
        if (schema.color != null) schemaObj['@_color'] = String(schema.color)
        if (schema.hotkey)        schemaObj['@_hotkey'] = schema.hotkey

        schemaObj['mm:slot'] = schema.slots.map(slot => {
          const slotObj: Record<string, unknown> = {
            '@_id':          slot.id,
            '@_name':        slot.name,
            '@_anchor_kind': slot.anchorKind,
          }
          if (slot.tierId)   slotObj['@_tier_id']   = slot.tierId
          if (slot.required) slotObj['@_required'] = 'true'
          if (slot.variadic) slotObj['@_variadic'] = 'true'
          if (slot.label)    slotObj['@_label']    = slot.label

          if (slot.style) {
            const s = slot.style
            const styleObj: Record<string, unknown> = {}
            if (s.textColor)       styleObj['@_text_color']        = s.textColor
            if (s.backgroundColor) styleObj['@_background_color']  = s.backgroundColor
            if (s.borderColor)     styleObj['@_border_color']      = s.borderColor
            if (s.bold)            styleObj['@_bold']        = 'true'
            if (s.italic)          styleObj['@_italic']      = 'true'
            if (s.underline)       styleObj['@_underline']   = 'true'
            if (s.strikethrough)   styleObj['@_strikethrough'] = 'true'
            slotObj['mm:style'] = styleObj
          }
          if (slot.metrics.length > 0) {
            slotObj['mm:metric'] = slot.metrics.map(metric => {
              const metricObj: Record<string, unknown> = {
                '@_id':   metric.id,
                '@_name': metric.name,
                '@_type': metric.type,
              }
              if (metric.vocabularyId) metricObj['@_vocabulary_id'] = metric.vocabularyId
              return metricObj
            })
          }
          return slotObj
        })
        return schemaObj
      }),
    }
  }

  // mm:patterns

  const patterns = store.allPatterns()
  if (patterns.length > 0) {
    mumoData['mm:patterns'] = {
      'mm:pattern': patterns.map(pattern => {
        const frameObj: Record<string, unknown> = { '@_id': pattern.id, '@_schema_id': pattern.schemaId }
        if (pattern.notes && Object.keys(pattern.notes).length > 0) {
          frameObj['mm:note'] = Object.entries(pattern.notes).flatMap(([author, entries]) =>
            entries.map(e => ({ '@_author': author, '@_created_at': e.createdAt, '#text': e.text }))
          )
        }
        frameObj['mm:slot_instance'] = pattern.slots.map(slot => {
          const siObj: Record<string, unknown> = {
            '@_id':            slot.id,
            '@_schema_slot_id': slot.schemaSlotId,
            '@_annotation_id': slot.annotationId,
          }
          if (slot.metrics.length > 0) {
            siObj['mm:metric_value'] = slot.metrics.map(mv => ({
              '@_schema_id': mv.schemaId,
              '@_value':     String(mv.value ?? ''),
            }))
          }
          return siObj
        })
        return frameObj
      }),
    }
  }

  // mm:suggestions
  // pm:replace: derived from suggestion_delete/insert marks in the PM doc JSON.
  // Offsets are in filtered-text space (suggestion_insert excluded), matching
  // the token offsets produced by TokenStore.
  // utt:set-participant, utt:set-time, annotation:add/update/delete: stored
  // only in the AnnotationStore (no PM marks).

  const suggestionElems: Record<string, unknown>[] = []

  for (const node of doc.content ?? []) {
    if (node.type !== 'utterance') continue
    const blockId = (node.attrs?.['id'] as string | undefined) ?? ''
    type SugGroup = { authorId: string; deleteStart: number | null; deleteEnd: number | null; insertText: string; insertOnlyAt: number }
    const groups = new Map<string, SugGroup>()
    let filteredOff = 0

    for (const inline of node.content ?? []) {
      if (inline.type !== 'text' || !inline.text) continue
      const sugIns = inline.marks?.find(m => m.type === 'suggestion_insert')
      const sugDel = inline.marks?.find(m => m.type === 'suggestion_delete')
      if (sugIns) {
        const sid  = attrStr(sugIns.attrs?.['suggestionId'])
        const auth = attrStr(sugIns.attrs?.['authorId'])
        let g = groups.get(sid)
        if (!g) { g = { authorId: auth, deleteStart: null, deleteEnd: null, insertText: '', insertOnlyAt: filteredOff }; groups.set(sid, g) }
        g.insertText += inline.text
        // suggestion_insert does NOT advance filteredOff
      } else if (sugDel) {
        const sid  = attrStr(sugDel.attrs?.['suggestionId'])
        const auth = attrStr(sugDel.attrs?.['authorId'])
        let g = groups.get(sid)
        if (!g) { g = { authorId: auth, deleteStart: filteredOff, deleteEnd: filteredOff, insertText: '', insertOnlyAt: filteredOff }; groups.set(sid, g) }
        if (g.deleteStart === null) g.deleteStart = filteredOff
        g.deleteEnd = filteredOff + inline.text.length
        filteredOff += inline.text.length
      } else {
        filteredOff += inline.text.length
      }
    }

    for (const [sid, g] of groups) {
      const from = g.deleteStart ?? g.insertOnlyAt
      const to   = g.deleteEnd   ?? g.insertOnlyAt
      const sugObj: Record<string, unknown> = {
        '@_id':          sid,
        '@_block_id':    blockId,
        '@_author_id':   g.authorId,
        '@_from_offset': String(from),
        '@_to_offset':   String(to),
      }
      const storeSug = store.getSuggestion(sid)
      if (storeSug?.note)       sugObj['@_note']       = storeSug.note
      if (storeSug?.createdAt)  sugObj['@_created_at'] = String(storeSug.createdAt)
      if (g.insertText) sugObj['mm:insert'] = { '#text': g.insertText }
      suggestionElems.push(sugObj)
    }
  }

  for (const sug of store.allSuggestions()) {
    const c = sug.change
    const base: Record<string, unknown> = { '@_id': sug.id, '@_author_id': sug.authorId }
    if (sug.note)      base['@_note']       = sug.note
    if (sug.createdAt) base['@_created_at'] = String(sug.createdAt)

    if (c.type === 'utt:set-participant') {
      suggestionElems.push({ ...base, '@_block_id': c.uttId, '@_type': 'set_participant', '@_participant': c.participant })

    } else if (c.type === 'utt:set-time') {
      suggestionElems.push({
        ...base,
        '@_block_id': c.uttId,
        '@_type':     'set_time',
        '@_start_ms': String(Math.round(c.startTime * 1000)),
        '@_end_ms':   String(Math.round(c.endTime   * 1000)),
      })

    } else if (c.type === 'annotation:add') {
      const a  = c.annotation
      const ta = a.anchors.find(x => x.type === 'time')
      const annObj: Record<string, unknown> = {
        '@_id':       a.id,
        '@_ann_type': a.type,
      }
      const tierId = a.features['tierId']
      if (tierId) annObj['@_tier_id'] = tierId
      if (ta) {
        annObj['@_start_ms'] = String(Math.round(ta.start * 1000))
        annObj['@_end_ms']   = String(Math.round(ta.end   * 1000))
      }
      const otherFeatureElems = featureElems(a.features, new Set(['tierId']))
      if (otherFeatureElems.length > 0) annObj['mm:feature'] = otherFeatureElems
      suggestionElems.push({ ...base, '@_type': 'add_annotation', 'mm:ann': annObj })

    } else if (c.type === 'annotation:update') {
      const ta = c.patch.anchors?.find(x => x.type === 'time')
      if (ta) {
        suggestionElems.push({
          ...base,
          '@_type':          'update_annotation_time',
          '@_annotation_id': c.annotationId,
          '@_start_ms':      String(Math.round(ta.start * 1000)),
          '@_end_ms':        String(Math.round(ta.end   * 1000)),
        })
      } else if (c.patch.type !== undefined) {
        suggestionElems.push({ ...base, '@_type': 'update_annotation_type', '@_annotation_id': c.annotationId, '@_ann_type': c.patch.type })
      }

    } else if (c.type === 'annotation:delete') {
      suggestionElems.push({ ...base, '@_type': 'delete_annotation', '@_annotation_id': c.annotationId })

    } else if (c.type === 'textlet:add') {
      const a = c.annotation
      const wrAnchor    = a.anchors.find(x => x.type === 'word-range') as { type: 'word-range'; fromWordId: string; toWordId: string } | undefined
      const markAnchor  = a.anchors.find(x => x.type === 'mark')       as { type: 'mark'; markId: string }                            | undefined
      const tlObj: Record<string, unknown> = { '@_id': a.id, '@_ann_type': a.type }
      if (wrAnchor) {
        tlObj['@_from_word_id'] = wrAnchor.fromWordId
        tlObj['@_to_word_id']   = wrAnchor.toWordId
      } else if (markAnchor) {
        tlObj['@_mark_id'] = markAnchor.markId
      }
      const featElems = featureElems(a.features)
      if (featElems.length > 0) tlObj['mm:feature'] = featElems
      suggestionElems.push({ ...base, '@_type': 'add_textlet', 'mm:textlet_ann': tlObj })

    } else if (c.type === 'textlet:delete') {
      suggestionElems.push({ ...base, '@_type': 'delete_textlet', '@_textlet_id': c.textletId })

    } else if (c.type === 'textlet:add-code' || c.type === 'textlet:remove-code') {
      const codeObj: Record<string, unknown> = { '#text': c.code.value }
      if (c.code.vocabEntryId) codeObj['@_vocab_entry_id'] = c.code.vocabEntryId
      if (c.code.vocabId)      codeObj['@_vocab_id']       = c.code.vocabId
      suggestionElems.push({
        ...base,
        '@_type':       c.type === 'textlet:add-code' ? 'add_code' : 'remove_code',
        '@_textlet_id': c.textletId,
        'mm:code':      codeObj,
      })

    } else if (c.type === 'pattern:add') {
      const sugObj: Record<string, unknown> = { ...base, '@_type': 'add_frame', '@_frame_id': c.patternId, '@_schema_id': c.schemaId }
      if (c.note) sugObj['@_frame_note'] = c.note
      suggestionElems.push(sugObj)

    } else if (c.type === 'pattern:delete') {
      suggestionElems.push({ ...base, '@_type': 'delete_frame', '@_frame_id': c.patternId })

    } else if (c.type === 'pattern:fill-slot') {
      const siObj: Record<string, unknown> = {
        '@_id':             c.slot.id,
        '@_schema_slot_id': c.slot.schemaSlotId,
        '@_annotation_id':  c.slot.annotationId,
      }
      if (c.slot.metrics.length > 0) {
        siObj['mm:metric_value'] = c.slot.metrics.map(mv => ({
          '@_schema_id': mv.schemaId,
          '@_value':     String(mv.value ?? ''),
        }))
      }
      const sugObj: Record<string, unknown> = { ...base, '@_type': 'fill_slot', '@_frame_id': c.patternId, 'mm:slot_instance': siObj }
      if (c.pendingAnnotation) {
        const pa = c.pendingAnnotation
        const paObj: Record<string, unknown> = { '@_id': pa.id, '@_ann_type': pa.type }
        if (pa.anchors.length > 0) {
          paObj['mm:anchor'] = pa.anchors.flatMap((a): Record<string, string>[] => {
            if (a.type === 'utterance')  return [{ '@_type': 'utterance',  '@_utt_id':       a.uttId }]
            if (a.type === 'token')      return [{ '@_type': 'token',      '@_token_id':     a.tokenId }]
            if (a.type === 'time')       return [{ '@_type': 'time',       '@_start_ms': String(Math.round(a.start * 1000)), '@_end_ms': String(Math.round(a.end * 1000)) }]
            if (a.type === 'mark')       return [{ '@_type': 'mark',       '@_mark_id':      a.markId }]
            if (a.type === 'word-range') return [{ '@_type': 'word_range', '@_from_word_id': a.fromWordId, '@_to_word_id': a.toWordId }]
            return []
          })
        }
        const paFeatureElems = featureElems(pa.features)
        if (paFeatureElems.length > 0) paObj['mm:feature'] = paFeatureElems
        sugObj['mm:pending_ann'] = paObj
      }
      suggestionElems.push(sugObj)

    } else if (c.type === 'pattern:fill-metric') {
      const valueType = c.value === null ? 'null' : typeof c.value
      suggestionElems.push({
        ...base,
        '@_type':           'fill_metric',
        '@_frame_id':       c.patternId,
        '@_schema_slot_id': c.slotSchemaId,
        '@_metric_id':      c.metricId,
        '@_value':          String(c.value ?? ''),
        '@_value_type':     valueType,
      })
    }
  }

  if (suggestionElems.length > 0) {
    mumoData['mm:suggestions'] = { 'mm:suggestion': suggestionElems }
  }

  // mm:marks

  const markSpans = new Map<string, { blockId: string; start: number; end: number }>()
  for (const node of doc.content ?? []) {
    if (node.type !== 'utterance' && node.type !== 'visualization') continue
    const blockId = (node.attrs?.['id'] as string | undefined) ?? ''
    let charOffset = 0
    for (const inline of node.content ?? []) {
      if (inline.type === 'text' && inline.text) {
        const nodeStart = charOffset
        const nodeEnd   = charOffset + inline.text.length
        for (const mark of inline.marks ?? []) {
          if (mark.type === 'annotation' && mark.attrs?.['id']) {
            const markId   = attrStr(mark.attrs['id'])
            const existing = markSpans.get(markId)
            if (existing) {
              existing.start = Math.min(existing.start, nodeStart)
              existing.end   = Math.max(existing.end,   nodeEnd)
            } else {
              markSpans.set(markId, { blockId, start: nodeStart, end: nodeEnd })
            }
          }
        }
        charOffset += inline.text.length
      }
    }
  }
  if (markSpans.size > 0) {
    mumoData['mm:marks'] = {
      'mm:mark': [...markSpans.entries()].map(([markId, span]) => ({
        '@_id':       markId,
        '@_block_id': span.blockId,
        '@_start':    String(span.start),
        '@_end':      String(span.end),
      })),
    }
  }

  // mm:textlets

  type TC = { value: string; vocabEntryId?: string; vocabId?: string }
  const textlets = store.allAnnotations().filter(a => a.anchors.some(x => x.type === 'mark'))
  if (textlets.length > 0) {
    const textletElems: Record<string, unknown>[] = []
    for (const ann of textlets) {
      const markAnchor = ann.anchors.find(a => a.type === 'mark')
      if (!markAnchor) continue
      const textletObj: Record<string, unknown> = {
        '@_id':      ann.id,
        '@_mark_id': markAnchor.markId,
        '@_type':    ann.type,
      }
      const rawNotes = (ann.features['notes'] ?? {}) as Record<string, { text: string; createdAt: number }[]>
      const rawCodes = Array.isArray(ann.features['codes']) ? ann.features['codes'] as (string | TC)[] : undefined

      if (Object.keys(rawNotes).length > 0) {
        textletObj['mm:note'] = Object.entries(rawNotes).flatMap(([author, entries]) =>
          entries.map(e => ({ '@_author': author, '@_created_at': e.createdAt, '#text': e.text }))
        )
      }

      if (rawCodes && rawCodes.length > 0) {
        textletObj['mm:codes'] = {
          'mm:code': rawCodes.map(code => {
            const value  = typeof code === 'string' ? code : code.value
            const codeObj: Record<string, unknown> = { '#text': value }
            if (typeof code !== 'string' && code.vocabEntryId) codeObj['@_vocab_entry_id'] = code.vocabEntryId
            if (typeof code !== 'string' && code.vocabId)      codeObj['@_vocab_id']       = code.vocabId
            return codeObj
          }),
        }
      }

      const tlFeatureElems = featureElems(ann.features, new Set(['notes', 'codes']))
      if (tlFeatureElems.length > 0) textletObj['mm:feature'] = tlFeatureElems

      textletElems.push(textletObj)
    }
    if (textletElems.length > 0) mumoData['mm:textlets'] = { 'mm:textlet': textletElems }
  }

  // mm:annotations
  // Everything not covered elsewhere: tier annotations live in the EAF layer,
  // mark-anchored annotations in mm:textlets. The rest — pattern slot annotations
  // (feature-only refs like utteranceId/tokenId/patternId) and utterance/token/
  // time/word-range-anchored annotations — are preserved here, with anchors
  // emitted as mm:anchor children so any number of annotations can reference
  // the same utterance or token.

  const storeOnlyAnnotations = store.allAnnotations().filter(a =>
    !a.features['tierId'] &&
    !a.anchors.some(x => x.type === 'mark')
  )
  if (storeOnlyAnnotations.length > 0) {
    mumoData['mm:annotations'] = {
      'mm:annotation': storeOnlyAnnotations.map(ann => {
        const annObj: Record<string, unknown> = { '@_id': ann.id, '@_type': ann.type }
        const anchorElems = ann.anchors.flatMap((a): Record<string, string>[] => {
          if (a.type === 'utterance')  return [{ '@_type': 'utterance',  '@_utt_id':       a.uttId }]
          if (a.type === 'token')      return [{ '@_type': 'token',      '@_token_id':     a.tokenId }]
          if (a.type === 'time')       return [{ '@_type': 'time',       '@_start_ms': String(Math.round(a.start * 1000)), '@_end_ms': String(Math.round(a.end * 1000)) }]
          if (a.type === 'word-range') return [{ '@_type': 'word_range', '@_from_word_id': a.fromWordId, '@_to_word_id': a.toWordId }]
          return []
        })
        if (anchorElems.length > 0) annObj['mm:anchor'] = anchorElems
        const annFeatureElems = featureElems(ann.features)
        if (annFeatureElems.length > 0) annObj['mm:feature'] = annFeatureElems
        return annObj
      }),
    }
  }

  // mm:bookmarks

  const bookmarks = store.allBookmarks()
  if (bookmarks.length > 0) {
    mumoData['mm:bookmarks'] = {
      'mm:bookmark': bookmarks.map(bm => {
        const bmObj: Record<string, unknown> = {
          '@_id':       bm.id,
          '@_label':    bm.label,
          '@_start_ms': String(Math.round(bm.startSeconds * 1000)),
          '@_end_ms':   String(Math.round(bm.endSeconds   * 1000)),
        }
        if (bm.createdAt) bmObj['@_created_at'] = bm.createdAt
        if (bm.note)      bmObj['@_note']        = bm.note
        if (bm.code)      bmObj['@_code']        = bm.code
        return bmObj
      }),
    }
  }

  // mm:participants

  const participants = store.allParticipants()
  if (participants.length > 0) {
    mumoData['mm:participants'] = {
      'mm:participant': participants.map(p => {
        const rawLabel = typeof p.label === 'string' ? p.label : ((p.label as { label?: string } | null)?.label ?? '')
        const partObj: Record<string, unknown> = { '@_id': p.id, '@_label': rawLabel }
        if (p.attrs && Object.keys(p.attrs).length > 0) {
          partObj['mm:attr'] = Object.entries(p.attrs).map(([k, v]) => ({
            '@_name': k,
            '#text':  v,
          }))
        }
        return partObj
      }),
    }
  }

  // mm:font_config

  const transcriptFont = store.getTranscriptFont()
  if (transcriptFont) {
    mumoData['mm:font_config'] = { '@_transcript_font': transcriptFont }
  }

  // mm:symbol_defs

  const symbolDefs = store.getSymbolDefs()
  if (symbolDefs.length > 0) {
    mumoData['mm:symbol_defs'] = {
      'mm:symbol_def': symbolDefs.map(def => {
        const defObj: Record<string, unknown> = { '@_unicode': def.unicode }
        if (def.shortcut)    defObj['@_shortcut']    = def.shortcut
        if (def.description) defObj['@_description'] = def.description
        return defObj
      }),
    }
  }

  // mm:tier_extensions

  const tiersWithExt = store.allTiers().filter(t => t.trackRef || t.isUttTier)
  if (tiersWithExt.length > 0) {
    mumoData['mm:tier_extensions'] = {
      'mm:tier_ext': tiersWithExt.map(tier => {
        const extObj: Record<string, unknown> = { '@_tier_key': tier.name || tier.id }
        if (tier.trackRef) {
          extObj['@_track_set_id'] = tier.trackRef.trackSetId
          extObj['@_track_id']     = tier.trackRef.trackId
        }
        if (tier.isUttTier) extObj['@_is_utt_tier'] = 'true'
        return extObj
      }),
    }
  }

  // Attach mm:mumo_data and build

  docObj.ANNOTATION_DOCUMENT['mm:mumo_data'] = mumoData

  return eafXmlBuilder.build(docObj)
}

export function emitMMETF(store: AnnotationStore, opts: Omit<EmitMMEAFOptions, 'isTemplate'> = {}): string {
  const emptyDoc: PMNodeJSON = { type: 'doc', content: [] }
  return emitMMEAF(emptyDoc, store, { ...opts, isTemplate: true })
}
