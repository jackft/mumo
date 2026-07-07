import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import { unpackMumo } from '@mumo/serialization'
import { parseMMEAF } from '@mumo/serialization'
import type { AnnotationJSON, PatternJSON, PatternSchemaJSON, TokenRecord } from '@mumo/core'
import type Database from 'better-sqlite3'
import { getFolders, rebuildFts } from './collection-db.js'

export interface SyncResult {
  scanned: number
  updated: number
  removed: number
}

export async function syncFolders(db: Database.Database, folders?: string[]): Promise<SyncResult> {
  const targets = folders ?? getFolders(db)
  let scanned = 0
  let updated = 0
  let removed = 0

  const seenPaths = new Set<string>()

  for (const folder of targets) {
    let entries: string[]
    try {
      const all = await fs.readdir(folder)
      entries = all.filter(e => e.endsWith('.mumo'))
    } catch {
      continue
    }

    for (const entry of entries) {
      const filePath = join(folder, entry)
      seenPaths.add(filePath)
      scanned++

      let mtime: number
      try {
        const stat = await fs.stat(filePath)
        mtime = stat.mtimeMs
      } catch {
        continue
      }

      const existing = db.prepare(
        'SELECT id, mtime FROM documents WHERE path = ?'
      ).get(filePath) as { id: number; mtime: number } | undefined

      if (existing && existing.mtime === mtime) continue

      try {
        const indexed = await indexDocument(db, folder, filePath, mtime)
        if (indexed) updated++
      } catch {
        // skip unreadable / corrupt files
      }
    }
  }

  // Remove DB entries for files that no longer exist
  const allDocs = db.prepare(
    'SELECT id, path FROM documents'
  ).all() as { id: number; path: string }[]

  for (const doc of allDocs) {
    if (!seenPaths.has(doc.path)) {
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id)
      removed++
    }
  }

  if (updated > 0 || removed > 0) rebuildFts(db)

  return { scanned, updated, removed }
}

async function indexDocument(
  db: Database.Database,
  folder: string,
  filePath: string,
  mtime: number,
): Promise<boolean> {
  const raw = await fs.readFile(filePath)
  const unpacked = unpackMumo(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
  const parsed = parseMMEAF(unpacked.mmeaf)

  const title = basename(filePath, '.mumo')
  const now   = Date.now()

  db.transaction(() => {
    // Ensure folder is registered
    db.prepare('INSERT OR IGNORE INTO watched_folders (path) VALUES (?)').run(folder)
    const folderRow = db.prepare('SELECT id FROM watched_folders WHERE path = ?').get(folder) as { id: number }

    // Upsert document
    db.prepare(`
      INSERT INTO documents (folder_id, path, title, mtime, indexed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        folder_id  = excluded.folder_id,
        title      = excluded.title,
        mtime      = excluded.mtime,
        indexed_at = excluded.indexed_at
    `).run(folderRow.id, filePath, title, mtime, now)

    const docRow = db.prepare('SELECT id FROM documents WHERE path = ?').get(filePath) as { id: number }
    const docId  = docRow.id

    // Clear dependent rows
    db.prepare('DELETE FROM document_metadata  WHERE document_id = ?').run(docId)
    db.prepare('DELETE FROM participants        WHERE document_id = ?').run(docId)
    db.prepare('DELETE FROM utterances          WHERE document_id = ?').run(docId)
    db.prepare('DELETE FROM pattern_schemas     WHERE document_id = ?').run(docId)
    db.prepare('DELETE FROM patterns            WHERE document_id = ?').run(docId)
    db.prepare('DELETE FROM tier_annotations    WHERE document_id = ?').run(docId)
    db.prepare('DELETE FROM bookmarks           WHERE document_id = ?').run(docId)

    // Participants
    const insertParticipant = db.prepare('INSERT INTO participants (document_id, label) VALUES (?, ?)')
    const insertParticipantAttr = db.prepare('INSERT INTO participant_attrs (participant_id, key, value) VALUES (?, ?, ?)')
    for (const p of parsed.participants) {
      const label = typeof p.label === 'string' ? p.label : ''
      const { lastInsertRowid } = insertParticipant.run(docId, label)
      const pid = Number(lastInsertRowid)
      for (const [key, value] of Object.entries(p.attrs ?? {})) {
        insertParticipantAttr.run(pid, key, value)
      }
    }

    // Utterances (indexed for search; timed rows also feed bookmark excerpts)
    type InlineNode = {
      type: string
      text?: string
      marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
      content?: InlineNode[]
    }
    const insertUtt = db.prepare(`
      INSERT INTO utterances (document_id, utterance_id, pos, speaker, start_s, end_s, text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const uttRows: Array<{ utteranceId: string; speaker: string; startS: number; endS: number; text: string }> = []
    const uttById = new Map<string, { speaker: string; startS: number | null; endS: number | null; text: string }>()
    // annotation-mark ID → containing utterance + the exact text the mark covers
    const markUtt = new Map<string, { uttId: string; texts: string[] }>()

    const collectMarks = (n: InlineNode, uttId: string): void => {
      if (n.text) {
        for (const mark of n.marks ?? []) {
          if (mark.type === 'annotation' && typeof mark.attrs?.['id'] === 'string') {
            let entry = markUtt.get(mark.attrs['id'])
            if (!entry) { entry = { uttId, texts: [] }; markUtt.set(mark.attrs['id'], entry) }
            entry.texts.push(n.text)
          }
        }
      }
      for (const child of n.content ?? []) collectMarks(child, uttId)
    }

    // Utterance content is plain text nodes (tokens live in parsed.tokens);
    // harvest all text recursively so nested shapes keep working too
    const collectText = (n: InlineNode): string =>
      (n.text ?? '') + (n.content ?? []).map(collectText).join('')

    let pos = 0
    for (const block of (parsed.doc as { content?: Array<{ type: string; attrs?: Record<string, unknown>; content?: InlineNode[] }> }).content ?? []) {
      if (block.type !== 'utterance') continue
      const attrs   = block.attrs ?? {}
      const uttId   = (attrs['id'] as string | undefined) ?? ''
      // speaker identity: participant attr, falling back to the tier attr
      // ('speaker:A' / 'utt:A' forms) when participant is unset or 'unknown'
      const participant = (attrs['participant'] as string | undefined) ?? ''
      const tier        = (attrs['tier'] as string | undefined) ?? ''
      const speaker = participant && participant !== 'unknown'
        ? participant
        : tier.replace(/^(?:speaker|utt):/, '')
      const startS  = attrs['startTimeSeconds'] != null ? Number(attrs['startTimeSeconds']) : null
      const endS    = attrs['endTimeSeconds']   != null ? Number(attrs['endTimeSeconds'])   : null
      const parts: string[] = []
      for (const inline of block.content ?? []) {
        parts.push(collectText(inline))
        collectMarks(inline, uttId)
      }
      const text = parts.join('').replace(/\s+/g, ' ').trim()
      insertUtt.run(docId, uttId, pos++, speaker, startS, endS, text)
      uttById.set(uttId, { speaker, startS, endS, text })
      if (startS !== null && endS !== null) {
        uttRows.push({ utteranceId: uttId, speaker, startS, endS, text })
      }
    }

    // Pattern schemas
    const insertSchema = db.prepare('INSERT INTO pattern_schemas (document_id, name) VALUES (?, ?)')
    const schemaNames = new Set<string>()
    for (const ps of parsed.patternSchemas) {
      if (!schemaNames.has(ps.name)) {
        insertSchema.run(docId, ps.name)
        schemaNames.add(ps.name)
      }
    }

    // Pattern instances and tier annotations — both resolve annotation
    // anchors to time span / speaker / utterance
    const resolveAnnotation = makeAnnotationResolver(parsed, uttById, markUtt)
    indexPatterns(db, docId, parsed, resolveAnnotation)
    indexTierAnnotations(db, docId, parsed, resolveAnnotation)

    // Bookmarks
    const insertBookmark = db.prepare(`
      INSERT INTO bookmarks (bookmark_id, document_id, label, start_s, end_s, created_at, note, code, transcript_excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const bm of parsed.bookmarks) {
      const excerpt = uttRows
        .filter(u => u.endS >= bm.startSeconds && u.startS <= bm.endSeconds)
        .map(u => u.text)
        .join(' ')

      insertBookmark.run(
        bm.id, docId, bm.label,
        bm.startSeconds, bm.endSeconds,
        bm.createdAt ?? null,
        bm.note ?? null,
        bm.code ?? null,
        excerpt  || null,
      )
    }
  })()

  return true
}

interface ParsedForPatterns {
  patterns: PatternJSON[]
  patternSchemas: PatternSchemaJSON[]
  annotations: AnnotationJSON[]
  tiers: Array<{ id: string; name: string; participant?: string }>
  tokens: TokenRecord[]
  tokenTimes: Record<string, { start: number | null; end: number | null }>
}

type UttInfoMap = Map<string, { speaker: string; startS: number | null; endS: number | null; text: string }>

interface ResolvedAnchor {
  startS:  number | null
  endS:    number | null
  speaker: string | null
  text:    string
  uttIds:  Set<string>   // PM utterance IDs this anchor touches
}

function makeAnnotationResolver(
  parsed: ParsedForPatterns,
  uttById: UttInfoMap,
  markUtt: Map<string, { uttId: string; texts: string[] }>,
): (annId: string, seen?: Set<string>) => ResolvedAnchor {
  const tokenById   = new Map<string, TokenRecord>()
  const tokenIndex  = new Map<string, number>()
  parsed.tokens.forEach((t, i) => { tokenById.set(t.id, t); tokenIndex.set(t.id, i) })
  const tokenTimes  = parsed.tokenTimes
  const annById     = new Map(parsed.annotations.map(a => [a.id, a]))

  // utterances with times, in document order — for resolving time anchors to utterances
  const timedUtts = [...uttById.entries()]
    .filter(([, u]) => u.startS != null && u.endS != null)
    .map(([id, u]) => ({ id, startS: u.startS!, endS: u.endS! }))

  function resolveAnnotation(annId: string, seen: Set<string> = new Set()): ResolvedAnchor {
    const out: ResolvedAnchor = { startS: null, endS: null, speaker: null, text: '', uttIds: new Set() }
    if (seen.has(annId)) return out
    seen.add(annId)
    const ann = annById.get(annId)
    if (!ann) return out

    const mergeTime = (s: number | null | undefined, e: number | null | undefined): void => {
      if (s != null) out.startS = out.startS == null ? s : Math.min(out.startS, s)
      if (e != null) out.endS   = out.endS   == null ? e : Math.max(out.endS, e)
    }
    const useUtt = (uttId: string, wholeText: boolean): void => {
      const u = uttById.get(uttId)
      if (!u) return
      out.uttIds.add(uttId)
      if (out.speaker == null && u.speaker) out.speaker = u.speaker
      mergeTime(u.startS, u.endS)
      if (wholeText && !out.text) out.text = u.text
    }
    const uttFallbackTime = (uttId: string | undefined, s: number | null, e: number | null): void => {
      const u = uttId ? uttById.get(uttId) : undefined
      if (u && uttId) out.uttIds.add(uttId)
      if (u && out.speaker == null && u.speaker) out.speaker = u.speaker
      mergeTime(s ?? u?.startS, e ?? u?.endS)
    }

    for (const anchor of ann.anchors) {
      if (anchor.type === 'time') {
        mergeTime(anchor.start, anchor.end)
        for (const u of timedUtts) {
          if (u.endS >= anchor.start && u.startS <= anchor.end) out.uttIds.add(u.id)
        }
      } else if (anchor.type === 'utterance') {
        useUtt(anchor.uttId, true)
      } else if (anchor.type === 'block') {
        useUtt(anchor.blockId, true)
      } else if (anchor.type === 'token') {
        const tok = tokenById.get(anchor.tokenId)
        if (tok && !out.text) out.text = tok.text
        const ts = tokenTimes[anchor.tokenId]
        uttFallbackTime(tok?.uttId, ts?.start ?? null, ts?.end ?? null)
      } else if (anchor.type === 'word-range') {
        const fromIdx = tokenIndex.get(anchor.fromWordId)
        const toIdx   = tokenIndex.get(anchor.toWordId)
        if (fromIdx !== undefined && toIdx !== undefined) {
          const range = parsed.tokens.slice(Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx) + 1)
          if (!out.text) out.text = range.filter(t => t.kind !== 'ws').map(t => t.text).join(' ')
        }
        const fromT = tokenTimes[anchor.fromWordId]
        const toT   = tokenTimes[anchor.toWordId]
        uttFallbackTime(tokenById.get(anchor.fromWordId)?.uttId, fromT?.start ?? null, toT?.end ?? null)
      } else if (anchor.type === 'mark') {
        const m = markUtt.get(anchor.markId)
        if (m) {
          if (!out.text) out.text = m.texts.join('')
          useUtt(m.uttId, false)
        }
      }
      // track-segment anchors carry no transcript position — skipped
    }

    // symbolic (REF) annotations may carry no anchors of their own —
    // derive time/utterance from the parent annotation chain
    if (out.startS == null && out.uttIds.size === 0 && typeof ann.features['parentAnnId'] === 'string') {
      const parent = resolveAnnotation(ann.features['parentAnnId'], seen)
      out.startS  = parent.startS
      out.endS    = parent.endS
      if (out.speaker == null) out.speaker = parent.speaker
      for (const id of parent.uttIds) out.uttIds.add(id)
    }

    if (!out.text) out.text = ann.type
    return out
  }

  return resolveAnnotation
}

function indexPatterns(
  db: Database.Database,
  docId: number,
  parsed: ParsedForPatterns,
  resolveAnnotation: (annId: string) => ResolvedAnchor,
): void {
  const schemasById = new Map(parsed.patternSchemas.map(s => [s.id, s]))

  const insertPattern = db.prepare(`
    INSERT INTO patterns (pattern_id, document_id, schema_name, start_s, end_s, speakers, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const insertSlot           = db.prepare('INSERT INTO pattern_slots (pattern_rowid, slot_name, value_text) VALUES (?, ?, ?)')
  const insertSlotUtt        = db.prepare('INSERT INTO pattern_slot_utterances (slot_id, pattern_rowid, document_id, utterance_pm_id) VALUES (?, ?, ?, ?)')
  const insertMetric         = db.prepare('INSERT INTO pattern_metrics (pattern_rowid, slot_name, metric_name, value) VALUES (?, ?, ?, ?)')
  const insertPatternSpeaker = db.prepare('INSERT INTO pattern_speakers (pattern_rowid, speaker) VALUES (?, ?)')

  for (const pat of parsed.patterns) {
    const schema = schemasById.get(pat.schemaId)
    if (!schema) continue
    const slotSchemaById = new Map(schema.slots.map(s => [s.id, s]))

    let startS: number | null = null
    let endS:   number | null = null
    const speakers = new Set<string>()
    const slotRows: Array<{ slotName: string; valueText: string | null; uttIds: Set<string> }> = []
    const metricRows: Array<{ slotName: string; metricName: string; value: string | null }> = []
    const summaryParts: string[] = []

    for (const slot of pat.slots) {
      const slotSchema = slotSchemaById.get(slot.schemaSlotId)
      const slotName   = slotSchema?.label ?? slotSchema?.name ?? 'slot'
      const resolved   = resolveAnnotation(slot.annotationId)

      if (resolved.startS != null) startS = startS == null ? resolved.startS : Math.min(startS, resolved.startS)
      if (resolved.endS   != null) endS   = endS   == null ? resolved.endS   : Math.max(endS, resolved.endS)
      if (resolved.speaker) speakers.add(resolved.speaker)

      slotRows.push({ slotName, valueText: resolved.text || null, uttIds: resolved.uttIds })
      if (resolved.text) summaryParts.push(`${slotName}: ${resolved.text}`)

      for (const mv of slot.metrics) {
        const metricName = slotSchema?.metrics.find(m => m.id === mv.schemaId)?.name ?? 'metric'
        const value = mv.value == null ? null : String(mv.value)
        metricRows.push({ slotName, metricName, value })
        if (value) summaryParts.push(`${metricName}=${value}`)
      }
    }

    const { lastInsertRowid } = insertPattern.run(
      pat.id, docId, schema.name, startS, endS,
      speakers.size > 0 ? [...speakers].join(', ') : null,
      summaryParts.join(' · ') || null,
    )
    const patternRowid = Number(lastInsertRowid)
    for (const s of slotRows) {
      const slotId = Number(insertSlot.run(patternRowid, s.slotName, s.valueText).lastInsertRowid)
      for (const uttId of s.uttIds) insertSlotUtt.run(slotId, patternRowid, docId, uttId)
    }
    for (const m of metricRows) insertMetric.run(patternRowid, m.slotName, m.metricName, m.value)
    for (const sp of speakers)  insertPatternSpeaker.run(patternRowid, sp)
  }
}

function indexTierAnnotations(
  db: Database.Database,
  docId: number,
  parsed: ParsedForPatterns,
  resolveAnnotation: (annId: string) => ResolvedAnchor,
): void {
  const tierById = new Map(parsed.tiers.map(t => [t.id, t]))
  const insertAnn = db.prepare(`
    INSERT INTO tier_annotations (document_id, ann_id, tier_name, pos, participant, value, start_s, end_s, utterance_pm_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  interface Row { annId: string; tierName: string; participant: string | null; value: string; startS: number | null; endS: number | null; uttId: string | null; order: number }
  const rows: Row[] = []
  let order = 0
  for (const ann of parsed.annotations) {
    const tierId = ann.features['tierId']
    if (typeof tierId !== 'string' || !tierId) continue
    const tier = tierById.get(tierId)
    const tierName = tier?.name ?? tierId
    const resolved = resolveAnnotation(ann.id)
    const participant = tier?.participant || resolved.speaker || null
    const uttId = resolved.uttIds.values().next().value ?? null
    rows.push({ annId: ann.id, tierName, participant, value: ann.type, startS: resolved.startS, endS: resolved.endS, uttId, order: order++ })
  }

  // pos = order within (tier), by start time; untimed keep parse order at the end
  const byTier = new Map<string, Row[]>()
  for (const r of rows) {
    let arr = byTier.get(r.tierName)
    if (!arr) { arr = []; byTier.set(r.tierName, arr) }
    arr.push(r)
  }
  for (const arr of byTier.values()) {
    arr.sort((a, b) =>
      a.startS != null && b.startS != null ? a.startS - b.startS
      : a.startS != null ? -1 : b.startS != null ? 1
      : a.order - b.order)
    arr.forEach((r, pos) => {
      insertAnn.run(docId, r.annId, r.tierName, pos, r.participant, r.value, r.startS, r.endS, r.uttId)
    })
  }
}
