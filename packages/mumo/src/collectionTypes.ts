export interface CollectionQuery {
  text?:          string
  folder?:        string
  docPath?:       string
  participants?:  string[]   // document-level: docs containing these participants
  speakers?:      string[]   // utterance-level: rows spoken by these speakers
  schemaNames?:   string[]   // pattern-level: instances of these schemas
  metrics?:       Array<{ name: string; values: string[] }>   // pattern-level: metric equals one of values (AND across entries)
  tierNames?:     string[]   // annotation-level: annotations on these tiers
  useRegex?:      boolean    // text fields are regexes (table scan) instead of FTS expressions
  codes?:         string[]
  limit?:         number
  offset?:        number
}

export interface FolderDocument {
  folderPath: string
  docPath:    string
  docTitle:   string | null
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

export interface CollectionUtterance {
  utteranceId: string
  speaker:     string | null
  startS:      number | null
  endS:        number | null
  text:        string
  snippet:     string | null   // FTS highlight ([…] around hits), null without a text query
  docPath:     string
  docTitle:    string | null
}

export interface UtteranceSearchResult {
  total: number
  error?: string   // FTS syntax error etc. — results empty, message for the UI
  items: CollectionUtterance[]
}

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

export interface MetricFacet { name: string; values: string[] }

export interface SavedQuery {
  id:        number
  name:      string
  queryJson: string
  createdAt: number
}

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

export interface AnnCondition {
  value?:       string
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

export interface SequenceSearchResult {
  total: number
  error?: string   // FTS syntax error etc. — results empty, message for the UI
  items: SequenceHit[]
}
