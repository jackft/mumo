import Database from 'better-sqlite3'
import { join } from 'node:path'
import { app } from 'electron'

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!_db) throw new Error('Collection DB not initialized')
  return _db
}

export function initDb(): void {
  const dbPath = join(app.getPath('userData'), 'collection.db')
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  registerRegexp(_db)
  migrate(_db)
}

/** value REGEXP ? — case-insensitive JS regex, invalid patterns throw (caught by search wrappers). */
export function registerRegexp(db: Database.Database): void {
  db.function('regexp', { deterministic: true }, (pattern, value) =>
    value != null && new RegExp(pattern as string, 'i').test(value as string) ? 1 : 0)
}

// Bump when indexed shapes change. The DB is a cache rebuilt from .mumo files,
// so migration is simply: drop the indexed tables and let the next sync
// reindex everything against the new schema. watched_folders and
// saved_queries are user data, not derived cache — they survive.
const SCHEMA_VERSION = 6

const INDEXED_TABLES = [
  'document_metadata', 'participant_attrs', 'participants',
  'pattern_slot_utterances', 'pattern_speakers', 'pattern_metrics', 'pattern_slots',
  'patterns', 'patterns_fts', 'pattern_schemas',
  'tier_annotations_fts', 'tier_annotations',
  'utterances_fts', 'utterances', 'bookmarks_fts', 'bookmarks', 'documents',
]

function migrate(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as { v: number | null }
  if ((row.v ?? 0) < SCHEMA_VERSION) {
    for (const t of INDEXED_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`)
    db.prepare('DELETE FROM _schema_version').run()
    db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS watched_folders (
      id    INTEGER PRIMARY KEY,
      path  TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id          INTEGER PRIMARY KEY,
      folder_id   INTEGER NOT NULL REFERENCES watched_folders(id) ON DELETE CASCADE,
      path        TEXT UNIQUE NOT NULL,
      title       TEXT,
      mtime       INTEGER NOT NULL,
      indexed_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_metadata (
      id          INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      value       TEXT
    );

    CREATE TABLE IF NOT EXISTS participants (
      id          INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      label       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participant_attrs (
      id               INTEGER PRIMARY KEY,
      participant_id   INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      key              TEXT NOT NULL,
      value            TEXT
    );

    CREATE TABLE IF NOT EXISTS utterances (
      id           INTEGER PRIMARY KEY,
      document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      utterance_id TEXT NOT NULL,
      pos          INTEGER NOT NULL,
      speaker      TEXT,
      start_s      REAL,
      end_s        REAL,
      text         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pattern_schemas (
      id          INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      name        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      rowid        INTEGER PRIMARY KEY,
      bookmark_id  TEXT UNIQUE NOT NULL,
      document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      label        TEXT NOT NULL,
      start_s      REAL NOT NULL,
      end_s        REAL NOT NULL,
      created_at   INTEGER,
      note         TEXT,
      code         TEXT,
      transcript_excerpt TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
      label,
      note,
      code,
      transcript_excerpt,
      content=bookmarks,
      content_rowid=rowid
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS utterances_fts USING fts5(
      text,
      content=utterances,
      content_rowid=id
    );

    CREATE TABLE IF NOT EXISTS patterns (
      rowid       INTEGER PRIMARY KEY,
      pattern_id  TEXT NOT NULL,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      schema_name TEXT NOT NULL,
      start_s     REAL,
      end_s       REAL,
      speakers    TEXT,
      summary     TEXT
    );

    CREATE TABLE IF NOT EXISTS pattern_slots (
      id            INTEGER PRIMARY KEY,
      pattern_rowid INTEGER NOT NULL REFERENCES patterns(rowid) ON DELETE CASCADE,
      slot_name     TEXT NOT NULL,
      value_text    TEXT
    );

    CREATE TABLE IF NOT EXISTS pattern_metrics (
      id            INTEGER PRIMARY KEY,
      pattern_rowid INTEGER NOT NULL REFERENCES patterns(rowid) ON DELETE CASCADE,
      slot_name     TEXT NOT NULL,
      metric_name   TEXT NOT NULL,
      value         TEXT
    );

    CREATE TABLE IF NOT EXISTS pattern_slot_utterances (
      id              INTEGER PRIMARY KEY,
      slot_id         INTEGER NOT NULL REFERENCES pattern_slots(id) ON DELETE CASCADE,
      pattern_rowid   INTEGER NOT NULL REFERENCES patterns(rowid) ON DELETE CASCADE,
      document_id     INTEGER NOT NULL,
      utterance_pm_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_queries (
      id         INTEGER PRIMARY KEY,
      name       TEXT UNIQUE NOT NULL,
      query_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pattern_speakers (
      id            INTEGER PRIMARY KEY,
      pattern_rowid INTEGER NOT NULL REFERENCES patterns(rowid) ON DELETE CASCADE,
      speaker       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tier_annotations (
      id              INTEGER PRIMARY KEY,
      document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ann_id          TEXT NOT NULL,
      tier_name       TEXT NOT NULL,
      pos             INTEGER NOT NULL,   -- order within (document, tier), by start time
      participant     TEXT,
      value           TEXT NOT NULL,
      start_s         REAL,
      end_s           REAL,
      utterance_pm_id TEXT
    );

    CREATE TABLE IF NOT EXISTS collections (
      id         INTEGER PRIMARY KEY,
      name       TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_items (
      id            INTEGER PRIMARY KEY,
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,       -- utterance | annotation | pattern | bookmark | span
      doc_path      TEXT NOT NULL,       -- stable across reindex (unlike documents.id)
      ref_id        TEXT,                -- utterance_pm_id / ann_id / pattern_id / bookmark_id
      start_s       REAL,
      end_s         REAL,
      label         TEXT,                -- display text captured when added
      note          TEXT,
      added_at      INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS tier_annotations_fts USING fts5(
      value,
      content=tier_annotations,
      content_rowid=id
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS patterns_fts USING fts5(
      schema_name,
      speakers,
      summary,
      content=patterns,
      content_rowid=rowid
    );
  `)
}

export function rebuildFts(db: Database.Database): void {
  db.exec(`
    INSERT INTO bookmarks_fts(bookmarks_fts) VALUES('rebuild');
    INSERT INTO utterances_fts(utterances_fts) VALUES('rebuild');
    INSERT INTO patterns_fts(patterns_fts) VALUES('rebuild');
    INSERT INTO tier_annotations_fts(tier_annotations_fts) VALUES('rebuild');
  `)
}

// Folder management

export function getFolders(db: Database.Database): string[] {
  return (db.prepare('SELECT path FROM watched_folders ORDER BY path').all() as { path: string }[]).map(r => r.path)
}

export function addFolder(db: Database.Database, folderPath: string): void {
  db.prepare('INSERT OR IGNORE INTO watched_folders (path) VALUES (?)').run(folderPath)
}

export function removeFolder(db: Database.Database, folderPath: string): void {
  db.prepare('DELETE FROM watched_folders WHERE path = ?').run(folderPath)
}

// Search

export interface CollectionQuery {
  text?:           string
  folder?:         string
  docPath?:        string
  participants?:   string[]   // document-level: docs containing these participants
  speakers?:       string[]   // utterance-level: rows spoken by these speakers
  schemaNames?:    string[]   // pattern-level: instances of these schemas
  metrics?:        Array<{ name: string; values: string[] }>   // pattern-level: metric equals one of values (AND across entries)
  tierNames?:      string[]   // annotation-level: annotations on these tiers
  useRegex?:       boolean    // text fields are regexes (table scan) instead of FTS expressions
  codes?:          string[]
  limit?:          number
  offset?:         number
}

export interface FolderDocument {
  folderPath: string
  docPath:    string
  docTitle:   string | null
}

export function getFolderDocuments(db: Database.Database): FolderDocument[] {
  return (db.prepare(`
    SELECT wf.path AS folderPath, d.path AS docPath, d.title AS docTitle
    FROM documents d
    JOIN watched_folders wf ON wf.id = d.folder_id
    ORDER BY wf.path, d.path
  `).all() as { folderPath: string; docPath: string; docTitle: string | null }[])
}

export interface CollectionBookmark {
  bookmarkId: string
  label:      string
  startS:     number
  endS:       number
  note:       string | null
  code:       string | null
  createdAt:  number | null
  excerpt:    string | null   // transcript text overlapping the bookmark span
  snippet:    string | null   // FTS highlight over the excerpt, null without a text query
  docPath:    string
  docTitle:   string | null
}

export interface CollectionSearchResult {
  total: number
  error?: string   // FTS syntax error etc. — results empty, message for the UI
  items: CollectionBookmark[]
}

export function search(db: Database.Database, q: CollectionQuery): CollectionSearchResult {
  const limit  = q.limit  ?? 100
  const offset = q.offset ?? 0
  const params: unknown[] = []

  const joins: string[] = []
  const wheres: string[] = []
  const hasText = !!q.text?.trim()

  if (q.text?.trim()) {
    // NB: FTS tables must be referenced un-aliased — `alias MATCH ?` is a SQLite error
    joins.push('JOIN bookmarks_fts ON bookmarks_fts.rowid = f.rowid')
    wheres.push('bookmarks_fts MATCH ?')
    params.push(q.text.trim())
  }

  if (q.folder) {
    joins.push('JOIN watched_folders wf ON wf.id = d.folder_id')
    wheres.push('wf.path = ?')
    params.push(q.folder)
  }

  if (q.docPath) {
    wheres.push('d.path = ?')
    params.push(q.docPath)
  }

  for (const participant of q.participants ?? []) {
    joins.push(
      `JOIN participants p_${params.length} ON p_${params.length}.document_id = d.id AND p_${params.length}.label = ?`
    )
    params.push(participant)
  }

  if (q.codes?.length) {
    wheres.push(`f.code IN (${q.codes.map(() => '?').join(',')})`)
    params.push(...q.codes)
  }

  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
  const joinClause  = joins.join('\n')

  const baseSql = `
    FROM bookmarks f
    JOIN documents d ON d.id = f.document_id
    ${joinClause}
    ${whereClause}
  `

  try {
    const total = (db.prepare(`SELECT COUNT(*) as n ${baseSql}`).get(...params) as { n: number }).n

    // column 3 of bookmarks_fts = transcript_excerpt
    const snippetCol = hasText ? `snippet(bookmarks_fts, 3, '[', ']', '…', 14)` : 'NULL'
    const items = db.prepare(`
      SELECT f.bookmark_id, f.label, f.start_s, f.end_s, f.note, f.code, f.created_at,
             f.transcript_excerpt AS excerpt, ${snippetCol} AS snip, d.path, d.title
      ${baseSql}
      ORDER BY d.mtime DESC, f.start_s ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{
      bookmark_id: string; label: string; start_s: number; end_s: number
      note: string | null; code: string | null; created_at: number | null
      excerpt: string | null; snip: string | null; path: string; title: string | null
    }>

    return {
      total,
      items: items.map(r => ({
        bookmarkId: r.bookmark_id,
        label:      r.label,
        startS:     r.start_s,
        endS:       r.end_s,
        note:       r.note,
        code:       r.code,
        createdAt:  r.created_at,
        excerpt:    r.excerpt,
        // snippet() returns '' when the match wasn't in this column; treat as absent
        snippet:    r.snip?.trim() ? r.snip : null,
        docPath:    r.path,
        docTitle:   r.title,
      })),
    }
  } catch (e) {
    return { total: 0, items: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// Utterance search

export interface CollectionUtterance {
  utteranceId: string
  speaker:     string | null
  startS:      number | null
  endS:        number | null
  text:        string
  snippet:     string | null   // FTS match highlight ([…] around hits), null without a text query
  docPath:     string
  docTitle:    string | null
}

export interface UtteranceSearchResult {
  total: number
  error?: string   // FTS syntax error etc. — results empty, message for the UI
  items: CollectionUtterance[]
}

export function searchUtterances(db: Database.Database, q: CollectionQuery): UtteranceSearchResult {
  const limit  = q.limit  ?? 100
  const offset = q.offset ?? 0
  const params: unknown[] = []

  const joins: string[] = []
  const wheres: string[] = []
  const hasText = !!q.text?.trim()
  const useFts = hasText && !q.useRegex

  if (hasText) {
    if (q.useRegex) {
      wheres.push('u.text REGEXP ?')
      params.push(q.text!.trim())
    } else {
      joins.push('JOIN utterances_fts ON utterances_fts.rowid = u.id')
      wheres.push('utterances_fts MATCH ?')
      params.push(q.text!.trim())
    }
  }

  if (q.folder) {
    joins.push('JOIN watched_folders wf ON wf.id = d.folder_id')
    wheres.push('wf.path = ?')
    params.push(q.folder)
  }

  if (q.docPath) {
    wheres.push('d.path = ?')
    params.push(q.docPath)
  }

  if (q.speakers?.length) {
    wheres.push(`u.speaker IN (${q.speakers.map(() => '?').join(',')})`)
    params.push(...q.speakers)
  }

  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
  const baseSql = `
    FROM utterances u
    JOIN documents d ON d.id = u.document_id
    ${joins.join('\n')}
    ${whereClause}
  `

  try {
    const total = (db.prepare(`SELECT COUNT(*) as n ${baseSql}`).get(...params) as { n: number }).n

    const snippetCol = useFts ? `snippet(utterances_fts, 0, '[', ']', '…', 14)` : 'NULL'
    const items = db.prepare(`
      SELECT u.utterance_id, u.speaker, u.start_s, u.end_s, u.text, ${snippetCol} AS snip, d.path, d.title
      ${baseSql}
      ORDER BY d.mtime DESC, u.start_s ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{
      utterance_id: string; speaker: string | null; start_s: number | null; end_s: number | null
      text: string; snip: string | null; path: string; title: string | null
    }>

    return {
      total,
      items: items.map(r => ({
        utteranceId: r.utterance_id,
        speaker:     r.speaker,
        startS:      r.start_s,
        endS:        r.end_s,
        text:        r.text,
        snippet:     r.snip,
        docPath:     r.path,
        docTitle:    r.title,
      })),
    }
  } catch (e) {
    return { total: 0, items: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// Tier annotation search

export interface CollectionAnnotation {
  annId:       string
  tierName:    string
  participant: string | null
  value:       string
  snippet:     string | null
  startS:      number | null
  endS:        number | null
  uttText:     string | null   // text of the containing utterance, if linked
  docPath:     string
  docTitle:    string | null
}

export interface AnnotationSearchResult {
  total: number
  error?: string
  items: CollectionAnnotation[]
}

export function searchAnnotations(db: Database.Database, q: CollectionQuery): AnnotationSearchResult {
  const limit  = q.limit  ?? 100
  const offset = q.offset ?? 0
  const params: unknown[] = []
  const joins: string[] = []
  const wheres: string[] = []
  const hasText = !!q.text?.trim()
  const useFts = hasText && !q.useRegex

  if (hasText) {
    if (q.useRegex) {
      wheres.push('ta.value REGEXP ?')
      params.push(q.text!.trim())
    } else {
      joins.push('JOIN tier_annotations_fts ON tier_annotations_fts.rowid = ta.id')
      wheres.push('tier_annotations_fts MATCH ?')
      params.push(q.text!.trim())
    }
  }
  if (q.folder) {
    joins.push('JOIN watched_folders wf ON wf.id = d.folder_id')
    wheres.push('wf.path = ?')
    params.push(q.folder)
  }
  if (q.docPath) {
    wheres.push('d.path = ?')
    params.push(q.docPath)
  }
  if (q.tierNames?.length) {
    wheres.push(`ta.tier_name IN (${q.tierNames.map(() => '?').join(',')})`)
    params.push(...q.tierNames)
  }
  if (q.speakers?.length) {
    wheres.push(`ta.participant IN (${q.speakers.map(() => '?').join(',')})`)
    params.push(...q.speakers)
  }

  const baseSql = `
    FROM tier_annotations ta
    JOIN documents d ON d.id = ta.document_id
    ${joins.join('\n')}
    ${wheres.length > 0 ? 'WHERE ' + wheres.join(' AND ') : ''}
  `

  try {
    const total = (db.prepare(`SELECT COUNT(*) as n ${baseSql}`).get(...params) as { n: number }).n
    const snippetCol = useFts ? `snippet(tier_annotations_fts, 0, '[', ']', '…', 14)` : 'NULL'
    const items = db.prepare(`
      SELECT ta.ann_id, ta.tier_name, ta.participant, ta.value, ${snippetCol} AS snip,
             ta.start_s, ta.end_s,
             (SELECT u.text FROM utterances u WHERE u.document_id = ta.document_id AND u.utterance_id = ta.utterance_pm_id) AS utt_text,
             d.path, d.title
      ${baseSql}
      ORDER BY d.mtime DESC, ta.start_s ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{
      ann_id: string; tier_name: string; participant: string | null; value: string; snip: string | null
      start_s: number | null; end_s: number | null; utt_text: string | null; path: string; title: string | null
    }>
    return {
      total,
      items: items.map(r => ({
        annId: r.ann_id, tierName: r.tier_name, participant: r.participant, value: r.value,
        snippet: r.snip, startS: r.start_s, endS: r.end_s, uttText: r.utt_text,
        docPath: r.path, docTitle: r.title,
      })),
    }
  } catch (e) {
    return { total: 0, items: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// Cross-tier temporal search (ELAN multiple-layer style)
// annotation on tier A [overlaps | is inside | within ±N s of] annotation on tier B

export type TierRelation = 'overlaps' | 'inside' | 'within' | 'neighbors'

export interface TierOverlapQuery {
  tierA:      string
  textA?:     string
  tierB:      string    // ignored for 'neighbors' (same tier as A)
  textB?:     string
  relation:   TierRelation
  windowSec?: number    // 'within': seconds; 'neighbors': max annotation distance
  useRegex?:  boolean
  folder?:    string
  docPath?:   string
  limit?:     number
  offset?:    number
}

export interface TierOverlapHit {
  a:        CollectionAnnotation
  b:        CollectionAnnotation
  docPath:  string
  docTitle: string | null
}

export interface TierOverlapSearchResult {
  total: number
  error?: string
  items: TierOverlapHit[]
}

export function searchTierOverlaps(db: Database.Database, q: TierOverlapQuery): TierOverlapSearchResult {
  const limit  = q.limit  ?? 100
  const offset = q.offset ?? 0
  const w = Math.max(0, q.windowSec ?? 0)
  const neighbors = q.relation === 'neighbors'

  const relSql =
    q.relation === 'inside'    ? 'a.start_s >= b.start_s AND a.end_s <= b.end_s'
    : q.relation === 'within'  ? `a.end_s >= b.start_s - ${w} AND a.start_s <= b.end_s + ${w}`
    : neighbors                ? `abs(a.pos - b.pos) <= ${Math.max(1, Math.floor(w || 1))}`
    : 'a.start_s < b.end_s AND a.end_s > b.start_s'   // overlaps

  // structural distance is only defined within one tier's ordering
  const tierB = neighbors ? q.tierA : q.tierB
  const params: unknown[] = [q.tierA, tierB]
  const joins: string[] = []
  const wheres: string[] = [
    'a.tier_name = ?', 'b.tier_name = ?',
    'a.id != b.id',
    relSql,
  ]
  if (!neighbors) {
    wheres.push('a.start_s IS NOT NULL AND a.end_s IS NOT NULL', 'b.start_s IS NOT NULL AND b.end_s IS NOT NULL')
  }

  const textCond = (col: string) => q.useRegex
    ? `${col}.value REGEXP ?`
    : `${col}.id IN (SELECT rowid FROM tier_annotations_fts WHERE tier_annotations_fts MATCH ?)`
  if (q.textA?.trim()) {
    wheres.push(textCond('a'))
    params.push(q.textA.trim())
  }
  if (q.textB?.trim()) {
    wheres.push(textCond('b'))
    params.push(q.textB.trim())
  }
  if (q.folder) {
    joins.push('JOIN watched_folders wf ON wf.id = d.folder_id')
    wheres.push('wf.path = ?')
    params.push(q.folder)
  }
  if (q.docPath) {
    wheres.push('d.path = ?')
    params.push(q.docPath)
  }

  const baseSql = `
    FROM tier_annotations a
    JOIN tier_annotations b ON b.document_id = a.document_id
    JOIN documents d ON d.id = a.document_id
    ${joins.join('\n')}
    WHERE ${wheres.join(' AND ')}
  `

  const annCols = (x: string) =>
    `${x}.ann_id AS ${x}_id, ${x}.tier_name AS ${x}_tier, ${x}.participant AS ${x}_part, ${x}.value AS ${x}_value, ${x}.start_s AS ${x}_start, ${x}.end_s AS ${x}_end`

  try {
    const total = (db.prepare(`SELECT COUNT(*) as n ${baseSql}`).get(...params) as { n: number }).n
    const rows = db.prepare(`
      SELECT ${annCols('a')}, ${annCols('b')}, d.path, d.title
      ${baseSql}
      ORDER BY d.mtime DESC, a.start_s ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<Record<string, unknown>>
    const toAnn = (r: Record<string, unknown>, x: string, path: string, title: string | null): CollectionAnnotation => ({
      annId: r[`${x}_id`] as string, tierName: r[`${x}_tier`] as string,
      participant: r[`${x}_part`] as string | null, value: r[`${x}_value`] as string,
      snippet: null, startS: r[`${x}_start`] as number | null, endS: r[`${x}_end`] as number | null,
      uttText: null, docPath: path, docTitle: title,
    })
    return {
      total,
      items: rows.map(r => {
        const path = r['path'] as string
        const title = r['title'] as string | null
        return { a: toAnn(r, 'a', path, title), b: toAnn(r, 'b', path, title), docPath: path, docTitle: title }
      }),
    }
  } catch (e) {
    return { total: 0, items: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// Composite annotation search
// OR-groups of AND-conditions over tier annotations.

export interface AnnCondition {
  value?:       string   // FTS expression (or regex when useRegex)
  tierName?:    string
  participant?: string
  near?: { tierName: string; relation: TierRelation; windowSec?: number; text?: string }
}

export interface CompositeAnnQuery {
  groups:    AnnCondition[][]   // outer = OR, inner = AND
  useRegex?: boolean
  folder?:   string
  docPath?:  string
  limit?:    number
  offset?:   number
}

export function searchAnnotationsComposite(db: Database.Database, q: CompositeAnnQuery): AnnotationSearchResult {
  const limit  = q.limit  ?? 100
  const offset = q.offset ?? 0
  const params: unknown[] = []
  const joins: string[] = []
  const scopeWheres: string[] = []

  if (q.folder) {
    joins.push('JOIN watched_folders wf ON wf.id = d.folder_id')
    scopeWheres.push('wf.path = ?')
    params.push(q.folder)
  }
  if (q.docPath) {
    scopeWheres.push('d.path = ?')
    params.push(q.docPath)
  }

  const textCond = (col: string) => q.useRegex
    ? `${col}.value REGEXP ?`
    : `${col}.id IN (SELECT rowid FROM tier_annotations_fts WHERE tier_annotations_fts MATCH ?)`

  const groupSqls: string[] = []
  for (const group of q.groups) {
    const condSqls: string[] = []
    for (const cond of group) {
      if (cond.value?.trim()) {
        condSqls.push(textCond('ta'))
        params.push(cond.value.trim())
      }
      if (cond.tierName) {
        condSqls.push('ta.tier_name = ?')
        params.push(cond.tierName)
      }
      if (cond.participant) {
        condSqls.push('ta.participant = ?')
        params.push(cond.participant)
      }
      if (cond.near) {
        const w = Math.max(0, cond.near.windowSec ?? 0)
        const neighbors = cond.near.relation === 'neighbors'
        const rel =
          cond.near.relation === 'inside'   ? 'ta.start_s >= nb.start_s AND ta.end_s <= nb.end_s'
          : cond.near.relation === 'within' ? `ta.end_s >= nb.start_s - ${w} AND ta.start_s <= nb.end_s + ${w}`
          : neighbors                        ? `abs(ta.pos - nb.pos) <= ${Math.max(1, Math.floor(w || 1))}`
          : 'ta.start_s < nb.end_s AND ta.end_s > nb.start_s'
        const inner: string[] = ['nb.document_id = ta.document_id', 'nb.id != ta.id', rel]
        if (neighbors) {
          // structural distance is defined within one tier's ordering
          inner.push('nb.tier_name = ta.tier_name')
        } else {
          inner.push('nb.tier_name = ?')
          params.push(cond.near.tierName)
          inner.push('ta.start_s IS NOT NULL', 'nb.start_s IS NOT NULL')
        }
        if (cond.near.text?.trim()) {
          inner.push(q.useRegex ? 'nb.value REGEXP ?' : 'nb.id IN (SELECT rowid FROM tier_annotations_fts WHERE tier_annotations_fts MATCH ?)')
          params.push(cond.near.text.trim())
        }
        condSqls.push(`EXISTS (SELECT 1 FROM tier_annotations nb WHERE ${inner.join(' AND ')})`)
      }
    }
    if (condSqls.length > 0) groupSqls.push(`(${condSqls.join(' AND ')})`)
  }

  const wheres = [...scopeWheres]
  if (groupSqls.length > 0) wheres.push(`(${groupSqls.join(' OR ')})`)

  const baseSql = `
    FROM tier_annotations ta
    JOIN documents d ON d.id = ta.document_id
    ${joins.join('\n')}
    ${wheres.length > 0 ? 'WHERE ' + wheres.join(' AND ') : ''}
  `

  try {
    const total = (db.prepare(`SELECT COUNT(*) as n ${baseSql}`).get(...params) as { n: number }).n
    const items = db.prepare(`
      SELECT ta.ann_id, ta.tier_name, ta.participant, ta.value, ta.start_s, ta.end_s,
             (SELECT u.text FROM utterances u WHERE u.document_id = ta.document_id AND u.utterance_id = ta.utterance_pm_id) AS utt_text,
             d.path, d.title
      ${baseSql}
      ORDER BY d.mtime DESC, ta.start_s ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{
      ann_id: string; tier_name: string; participant: string | null; value: string
      start_s: number | null; end_s: number | null; utt_text: string | null; path: string; title: string | null
    }>
    return {
      total,
      items: items.map(r => ({
        annId: r.ann_id, tierName: r.tier_name, participant: r.participant, value: r.value,
        snippet: null, startS: r.start_s, endS: r.end_s, uttText: r.utt_text,
        docPath: r.path, docTitle: r.title,
      })),
    }
  } catch (e) {
    return { total: 0, items: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// Curated collections (user data — survives reindex migrations)

export interface CollectionDef {
  id:        number
  name:      string
  createdAt: number
  itemCount: number
}

export interface CollectionItem {
  id:      number
  kind:    string
  docPath: string
  refId:   string | null
  startS:  number | null
  endS:    number | null
  label:   string | null
  note:    string | null
  addedAt: number
  docTitle: string | null
}

export function createCollection(db: Database.Database, name: string): number {
  const r = db.prepare('INSERT INTO collections (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(name, Date.now())
  if (r.changes > 0) return Number(r.lastInsertRowid)
  return (db.prepare('SELECT id FROM collections WHERE name = ?').get(name) as { id: number }).id
}

export function listCollections(db: Database.Database): CollectionDef[] {
  return (db.prepare(`
    SELECT c.id, c.name, c.created_at, COUNT(ci.id) AS n
    FROM collections c LEFT JOIN collection_items ci ON ci.collection_id = c.id
    GROUP BY c.id ORDER BY c.name
  `).all() as Array<{ id: number; name: string; created_at: number; n: number }>)
    .map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, itemCount: r.n }))
}

export function deleteCollection(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM collections WHERE id = ?').run(id)
}

export function addCollectionItem(
  db: Database.Database,
  collectionId: number,
  item: { kind: string; docPath: string; refId?: string | null; startS?: number | null; endS?: number | null; label?: string | null; note?: string | null },
): void {
  db.prepare(`
    INSERT INTO collection_items (collection_id, kind, doc_path, ref_id, start_s, end_s, label, note, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(collectionId, item.kind, item.docPath, item.refId ?? null, item.startS ?? null, item.endS ?? null, item.label ?? null, item.note ?? null, Date.now())
}

export function listCollectionItems(db: Database.Database, collectionId: number): CollectionItem[] {
  return (db.prepare(`
    SELECT ci.id, ci.kind, ci.doc_path, ci.ref_id, ci.start_s, ci.end_s, ci.label, ci.note, ci.added_at,
           (SELECT d.title FROM documents d WHERE d.path = ci.doc_path) AS doc_title
    FROM collection_items ci WHERE ci.collection_id = ? ORDER BY ci.doc_path, ci.start_s
  `).all(collectionId) as Array<{
    id: number; kind: string; doc_path: string; ref_id: string | null; start_s: number | null; end_s: number | null
    label: string | null; note: string | null; added_at: number; doc_title: string | null
  }>).map(r => ({
    id: r.id, kind: r.kind, docPath: r.doc_path, refId: r.ref_id, startS: r.start_s, endS: r.end_s,
    label: r.label, note: r.note, addedAt: r.added_at, docTitle: r.doc_title,
  }))
}

export function removeCollectionItem(db: Database.Database, itemId: number): void {
  db.prepare('DELETE FROM collection_items WHERE id = ?').run(itemId)
}

// Composite utterance search
// OR-groups of AND-conditions. Each condition: text (FTS5 expression over the
// utterance), speaker equality, and/or containment in a pattern slot.

export interface UttCondition {
  text?:    string
  speaker?: string
  pattern?: { schemaName?: string; slotName?: string }
  tier?:    { tierName?: string; text?: string }   // has annotation on tier (optionally matching text)
}

export interface CompositeUttQuery {
  groups:   UttCondition[][]   // outer = OR, inner = AND
  folder?:  string
  docPath?: string
  limit?:   number
  offset?:  number
}

export function searchUtterancesComposite(db: Database.Database, q: CompositeUttQuery): UtteranceSearchResult {
  const limit  = q.limit  ?? 100
  const offset = q.offset ?? 0
  const params: unknown[] = []
  const joins: string[] = []
  const scopeWheres: string[] = []

  if (q.folder) {
    joins.push('JOIN watched_folders wf ON wf.id = d.folder_id')
    scopeWheres.push('wf.path = ?')
    params.push(q.folder)
  }
  if (q.docPath) {
    scopeWheres.push('d.path = ?')
    params.push(q.docPath)
  }

  const groupSqls: string[] = []
  for (const group of q.groups) {
    const condSqls: string[] = []
    for (const cond of group) {
      if (cond.text?.trim()) {
        condSqls.push('u.id IN (SELECT rowid FROM utterances_fts WHERE utterances_fts MATCH ?)')
        params.push(cond.text.trim())
      }
      if (cond.speaker) {
        condSqls.push('u.speaker = ?')
        params.push(cond.speaker)
      }
      if (cond.pattern) {
        const inner: string[] = ['psu.document_id = u.document_id', 'psu.utterance_pm_id = u.utterance_id']
        if (cond.pattern.schemaName) { inner.push('p2.schema_name = ?'); params.push(cond.pattern.schemaName) }
        if (cond.pattern.slotName)   { inner.push('ps.slot_name = ?');   params.push(cond.pattern.slotName) }
        condSqls.push(`EXISTS (
          SELECT 1 FROM pattern_slot_utterances psu
          JOIN pattern_slots ps ON ps.id = psu.slot_id
          JOIN patterns p2 ON p2.rowid = psu.pattern_rowid
          WHERE ${inner.join(' AND ')}
        )`)
      }
      if (cond.tier) {
        const inner: string[] = ['ta.document_id = u.document_id', 'ta.utterance_pm_id = u.utterance_id']
        if (cond.tier.tierName) { inner.push('ta.tier_name = ?'); params.push(cond.tier.tierName) }
        if (cond.tier.text?.trim()) {
          inner.push('ta.id IN (SELECT rowid FROM tier_annotations_fts WHERE tier_annotations_fts MATCH ?)')
          params.push(cond.tier.text.trim())
        }
        condSqls.push(`EXISTS (SELECT 1 FROM tier_annotations ta WHERE ${inner.join(' AND ')})`)
      }
    }
    if (condSqls.length > 0) groupSqls.push(`(${condSqls.join(' AND ')})`)
  }

  const wheres = [...scopeWheres]
  if (groupSqls.length > 0) wheres.push(`(${groupSqls.join(' OR ')})`)

  const baseSql = `
    FROM utterances u
    JOIN documents d ON d.id = u.document_id
    ${joins.join('\n')}
    ${wheres.length > 0 ? 'WHERE ' + wheres.join(' AND ') : ''}
  `

  try {
    const total = (db.prepare(`SELECT COUNT(*) as n ${baseSql}`).get(...params) as { n: number }).n
    const items = db.prepare(`
      SELECT u.utterance_id, u.speaker, u.start_s, u.end_s, u.text, d.path, d.title
      ${baseSql}
      ORDER BY d.mtime DESC, u.pos ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{
      utterance_id: string; speaker: string | null; start_s: number | null; end_s: number | null
      text: string; path: string; title: string | null
    }>
    return {
      total,
      items: items.map(r => ({
        utteranceId: r.utterance_id, speaker: r.speaker, startS: r.start_s, endS: r.end_s,
        text: r.text, snippet: null, docPath: r.path, docTitle: r.title,
      })),
    }
  } catch (e) {
    return { total: 0, items: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// Facet lookups for the query builders

export interface MetricFacet { name: string; values: string[] }

export function getMetricFacets(db: Database.Database, schemaName: string): MetricFacet[] {
  const rows = db.prepare(`
    SELECT DISTINCT pm.metric_name AS name, pm.value AS value
    FROM pattern_metrics pm
    JOIN patterns p ON p.rowid = pm.pattern_rowid
    WHERE p.schema_name = ? AND pm.value IS NOT NULL
    ORDER BY pm.metric_name, pm.value
  `).all(schemaName) as Array<{ name: string; value: string }>
  const map = new Map<string, string[]>()
  for (const r of rows) {
    let arr = map.get(r.name)
    if (!arr) { arr = []; map.set(r.name, arr) }
    arr.push(r.value)
  }
  return [...map.entries()].map(([name, values]) => ({ name, values }))
}

export function getSlotNames(db: Database.Database, schemaName?: string): string[] {
  const rows = schemaName
    ? db.prepare(`
        SELECT DISTINCT ps.slot_name AS n FROM pattern_slots ps
        JOIN patterns p ON p.rowid = ps.pattern_rowid
        WHERE p.schema_name = ? ORDER BY ps.slot_name
      `).all(schemaName)
    : db.prepare('SELECT DISTINCT slot_name AS n FROM pattern_slots ORDER BY slot_name').all()
  return (rows as Array<{ n: string }>).map(r => r.n)
}

// Saved queries (user data — survives reindex migrations)

export interface SavedQuery {
  id:        number
  name:      string
  queryJson: string
  createdAt: number
}

export function upsertSavedQuery(db: Database.Database, name: string, queryJson: string): void {
  db.prepare(`
    INSERT INTO saved_queries (name, query_json, created_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET query_json = excluded.query_json, created_at = excluded.created_at
  `).run(name, queryJson, Date.now())
}

export function listSavedQueries(db: Database.Database): SavedQuery[] {
  return (db.prepare('SELECT id, name, query_json, created_at FROM saved_queries ORDER BY name').all() as
    Array<{ id: number; name: string; query_json: string; created_at: number }>)
    .map(r => ({ id: r.id, name: r.name, queryJson: r.query_json, createdAt: r.created_at }))
}

export function deleteSavedQuery(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM saved_queries WHERE id = ?').run(id)
}

// Utterance sequence search
// "utterance matching A followed by utterance matching B within N utterances"

export interface SequenceQuery {
  textA:      string
  textB:      string
  withinUtts: number       // max distance in utterance positions (1 = adjacent)
  useRegex?:  boolean
  speakersA?: string[]
  speakersB?: string[]
  folder?:    string
  docPath?:   string
  limit?:     number
  offset?:    number
}

export interface SequenceHit {
  a:        CollectionUtterance
  b:        CollectionUtterance
  gap:      number          // b.pos - a.pos (1 = adjacent)
  docPath:  string
  docTitle: string | null
}

export interface SequenceSearchResult {
  total: number
  error?: string   // FTS syntax error etc. — results empty, message for the UI
  items: SequenceHit[]
}

export function searchUtteranceSequences(db: Database.Database, q: SequenceQuery): SequenceSearchResult {
  const limit  = q.limit  ?? 100
  const offset = q.offset ?? 0
  const within = Math.max(1, Math.floor(q.withinUtts))
  const params: unknown[] = [within, q.textA.trim(), q.textB.trim()]
  const textCond = (col: string) => q.useRegex
    ? `${col}.text REGEXP ?`
    : `${col}.id IN (SELECT rowid FROM utterances_fts WHERE utterances_fts MATCH ?)`

  const wheres: string[] = []
  const joins: string[] = []

  if (q.folder) {
    joins.push('JOIN watched_folders wf ON wf.id = d.folder_id')
    wheres.push('wf.path = ?')
    params.push(q.folder)
  }
  if (q.docPath) {
    wheres.push('d.path = ?')
    params.push(q.docPath)
  }
  if (q.speakersA?.length) {
    wheres.push(`a.speaker IN (${q.speakersA.map(() => '?').join(',')})`)
    params.push(...q.speakersA)
  }
  if (q.speakersB?.length) {
    wheres.push(`b.speaker IN (${q.speakersB.map(() => '?').join(',')})`)
    params.push(...q.speakersB)
  }

  const baseSql = `
    FROM utterances a
    JOIN utterances b ON b.document_id = a.document_id
      AND b.pos > a.pos AND b.pos <= a.pos + ?
    JOIN documents d ON d.id = a.document_id
    ${joins.join('\n')}
    WHERE ${textCond('a')}
      AND ${textCond('b')}
      ${wheres.length > 0 ? 'AND ' + wheres.join(' AND ') : ''}
  `

  try {
    const total = (db.prepare(`SELECT COUNT(*) as n ${baseSql}`).get(...params) as { n: number }).n

    const rows = db.prepare(`
      SELECT
        a.utterance_id AS a_id, a.speaker AS a_speaker, a.start_s AS a_start, a.end_s AS a_end, a.text AS a_text,
        b.utterance_id AS b_id, b.speaker AS b_speaker, b.start_s AS b_start, b.end_s AS b_end, b.text AS b_text,
        b.pos - a.pos AS gap, d.path, d.title
      ${baseSql}
      ORDER BY d.mtime DESC, a.pos ASC, gap ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{
      a_id: string; a_speaker: string | null; a_start: number | null; a_end: number | null; a_text: string
      b_id: string; b_speaker: string | null; b_start: number | null; b_end: number | null; b_text: string
      gap: number; path: string; title: string | null
    }>

    return {
      total,
      items: rows.map(r => ({
        a: { utteranceId: r.a_id, speaker: r.a_speaker, startS: r.a_start, endS: r.a_end, text: r.a_text, snippet: null, docPath: r.path, docTitle: r.title },
        b: { utteranceId: r.b_id, speaker: r.b_speaker, startS: r.b_start, endS: r.b_end, text: r.b_text, snippet: null, docPath: r.path, docTitle: r.title },
        gap:      r.gap,
        docPath:  r.path,
        docTitle: r.title,
      })),
    }
  } catch (e) {
    return { total: 0, items: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// Pattern search

export interface CollectionPattern {
  patternId:  string
  schemaName: string
  startS:     number | null
  endS:       number | null
  speakers:   string | null
  summary:    string | null
  slots:      Array<{ slotName: string; valueText: string | null }>
  metrics:    Array<{ slotName: string; metricName: string; value: string | null }>
  docPath:    string
  docTitle:   string | null
}

export interface PatternSearchResult {
  total: number
  error?: string   // FTS syntax error etc. — results empty, message for the UI
  items: CollectionPattern[]
}

export function searchPatterns(db: Database.Database, q: CollectionQuery): PatternSearchResult {
  const limit  = q.limit  ?? 100
  const offset = q.offset ?? 0
  const params: unknown[] = []

  const joins: string[] = []
  const wheres: string[] = []

  if (q.text?.trim()) {
    joins.push('JOIN patterns_fts ON patterns_fts.rowid = p.rowid')
    wheres.push('patterns_fts MATCH ?')
    params.push(q.text.trim())
  }

  if (q.folder) {
    joins.push('JOIN watched_folders wf ON wf.id = d.folder_id')
    wheres.push('wf.path = ?')
    params.push(q.folder)
  }

  if (q.docPath) {
    wheres.push('d.path = ?')
    params.push(q.docPath)
  }

  if (q.schemaNames?.length) {
    wheres.push(`p.schema_name IN (${q.schemaNames.map(() => '?').join(',')})`)
    params.push(...q.schemaNames)
  }

  if (q.speakers?.length) {
    wheres.push(`EXISTS (
      SELECT 1 FROM pattern_speakers ps
      WHERE ps.pattern_rowid = p.rowid AND ps.speaker IN (${q.speakers.map(() => '?').join(',')})
    )`)
    params.push(...q.speakers)
  }

  for (const m of q.metrics ?? []) {
    if (!m.values.length) continue
    wheres.push(`EXISTS (
      SELECT 1 FROM pattern_metrics pm
      WHERE pm.pattern_rowid = p.rowid AND pm.metric_name = ? AND pm.value IN (${m.values.map(() => '?').join(',')})
    )`)
    params.push(m.name, ...m.values)
  }

  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
  const baseSql = `
    FROM patterns p
    JOIN documents d ON d.id = p.document_id
    ${joins.join('\n')}
    ${whereClause}
  `

  try {
    const total = (db.prepare(`SELECT COUNT(*) as n ${baseSql}`).get(...params) as { n: number }).n

    const rows = db.prepare(`
      SELECT p.rowid AS prow, p.pattern_id, p.schema_name, p.start_s, p.end_s, p.speakers, p.summary, d.path, d.title
      ${baseSql}
      ORDER BY d.mtime DESC, p.start_s ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{
      prow: number; pattern_id: string; schema_name: string; start_s: number | null; end_s: number | null
      speakers: string | null; summary: string | null; path: string; title: string | null
    }>

    const slotsByPattern = new Map<number, Array<{ slotName: string; valueText: string | null }>>()
    const metricsByPattern = new Map<number, Array<{ slotName: string; metricName: string; value: string | null }>>()
    if (rows.length > 0) {
      const ph = rows.map(() => '?').join(',')
      const ids = rows.map(r => r.prow)
      const slotRows = db.prepare(
        `SELECT pattern_rowid, slot_name, value_text FROM pattern_slots WHERE pattern_rowid IN (${ph}) ORDER BY id`
      ).all(...ids) as Array<{ pattern_rowid: number; slot_name: string; value_text: string | null }>
      for (const s of slotRows) {
        let arr = slotsByPattern.get(s.pattern_rowid)
        if (!arr) { arr = []; slotsByPattern.set(s.pattern_rowid, arr) }
        arr.push({ slotName: s.slot_name, valueText: s.value_text })
      }
      const metricRows = db.prepare(
        `SELECT pattern_rowid, slot_name, metric_name, value FROM pattern_metrics WHERE pattern_rowid IN (${ph}) ORDER BY id`
      ).all(...ids) as Array<{ pattern_rowid: number; slot_name: string; metric_name: string; value: string | null }>
      for (const m of metricRows) {
        let arr = metricsByPattern.get(m.pattern_rowid)
        if (!arr) { arr = []; metricsByPattern.set(m.pattern_rowid, arr) }
        arr.push({ slotName: m.slot_name, metricName: m.metric_name, value: m.value })
      }
    }

    return {
      total,
      items: rows.map(r => ({
        patternId:  r.pattern_id,
        schemaName: r.schema_name,
        startS:     r.start_s,
        endS:       r.end_s,
        speakers:   r.speakers,
        summary:    r.summary,
        slots:      slotsByPattern.get(r.prow) ?? [],
        metrics:    metricsByPattern.get(r.prow) ?? [],
        docPath:    r.path,
        docTitle:   r.title,
      })),
    }
  } catch (e) {
    return { total: 0, items: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// Permalink resolution

/** docKey (doc name) → library file path. Exact path accepted too; newest wins. */
export function resolvePermalinkDoc(db: Database.Database, docKey: string): string | null {
  const exact = db.prepare('SELECT path FROM documents WHERE path = ?').get(docKey) as { path: string } | undefined
  if (exact) return exact.path
  const row = db.prepare(`
    SELECT path FROM documents
    WHERE title = ? OR path LIKE '%/' || ? OR path LIKE '%\\' || ?
    ORDER BY mtime DESC LIMIT 1
  `).get(docKey, `${docKey}.mumo`, `${docKey}.mumo`) as { path: string } | undefined
  return row?.path ?? null
}

/** Resolve a ref (utterance/annotation/pattern/bookmark ID) to its start time in the doc. */
export function resolvePermalinkTime(
  db: Database.Database,
  docPath: string,
  ref: { type: 'utt' | 'ann' | 'pat' | 'bm'; id: string },
): number | null {
  const sqlByType: Record<string, string> = {
    utt: `SELECT u.start_s AS t FROM utterances u JOIN documents d ON d.id = u.document_id WHERE d.path = ? AND u.utterance_id = ?`,
    ann: `SELECT ta.start_s AS t FROM tier_annotations ta JOIN documents d ON d.id = ta.document_id WHERE d.path = ? AND ta.ann_id = ?`,
    pat: `SELECT p.start_s AS t FROM patterns p JOIN documents d ON d.id = p.document_id WHERE d.path = ? AND p.pattern_id = ?`,
    bm:  `SELECT b.start_s AS t FROM bookmarks b JOIN documents d ON d.id = b.document_id WHERE d.path = ? AND b.bookmark_id = ?`,
  }
  const row = db.prepare(sqlByType[ref.type]!).get(docPath, ref.id) as { t: number | null } | undefined
  return row?.t ?? null
}

// Filter value lookups

export function getAllParticipantLabels(db: Database.Database): string[] {
  return (db.prepare('SELECT DISTINCT label FROM participants ORDER BY label').all() as { label: string }[]).map(r => r.label)
}

export function getAllSpeakers(db: Database.Database): string[] {
  return (db.prepare(
    "SELECT DISTINCT speaker FROM utterances WHERE speaker IS NOT NULL AND speaker != '' ORDER BY speaker"
  ).all() as { speaker: string }[]).map(r => r.speaker)
}

export function getAllTierNames(db: Database.Database): string[] {
  return (db.prepare('SELECT DISTINCT tier_name FROM tier_annotations ORDER BY tier_name').all() as { tier_name: string }[]).map(r => r.tier_name)
}

export function getAllSchemaNames(db: Database.Database): string[] {
  return (db.prepare('SELECT DISTINCT name FROM pattern_schemas ORDER BY name').all() as { name: string }[]).map(r => r.name)
}

export function getAllCodeValues(db: Database.Database): string[] {
  return (db.prepare('SELECT DISTINCT code FROM bookmarks WHERE code IS NOT NULL ORDER BY code').all() as { code: string }[]).map(r => r.code)
}
