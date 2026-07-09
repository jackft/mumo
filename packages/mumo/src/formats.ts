import type { AnnotationStore, TokenStore, TokenRecord, AnnotationJSON, TierDefJSON, VocabularyJSON, LinguisticTypeJSON, PatternSchemaJSON, PatternJSON, ParticipantJSON, SymbolDef, Suggestion } from '@mumo/core'

// Common data types

export type StoreData = {
  annotations: AnnotationJSON[]
  tiers?: TierDefJSON[]
  vocabularies?: VocabularyJSON[]
  linguisticTypes?: LinguisticTypeJSON[]
  patternSchemas?: PatternSchemaJSON[]
  patterns?: PatternJSON[]
  participants?: ParticipantJSON[]
  symbolDefs?: SymbolDef[]
  transcriptFont?: string
}

export type ImportResult = {
  docJSON: object
  storeData: StoreData
  tokens?: TokenRecord[]
  tokenTimes?: Record<string, { start: number | null; end: number | null }>
  transcriptFont?: string
  language?: string
  suggestions?: Suggestion[]
}

export type ExportOpts = {
  language?: string
  mediaUrl?: string
  mimeType?: string
  mediaHash?: string
  timeOriginMs?: number
  /** Additional media descriptors beyond the primary. */
  additionalMedia?: Array<{ mediaUrl: string; mimeType?: string; mediaHash?: string; timeOriginMs?: number }>
  /** Passthrough PROPERTY elements from an original EAF header (mumo:mediaHash:* excluded — regenerated). */
  headerProperties?: Array<{ name: string; value: string }>
  /** Emit word-level token tiers (tokens:<participant>) in EAF export. */
  includeTokenTiers?: boolean
}

export type ExportContext = {
  docJSON: object
  store: AnnotationStore
  tokenStore?: TokenStore
  opts?: ExportOpts
}

// Plugin interfaces

export interface FormatImporter {
  id: string
  label: string
  extensions: string[]
  isTemplate?: boolean
  import(text: string): ImportResult
}

export interface FormatExporter {
  id: string
  label: string
  extension: string
  mimeType?: string
  isTemplate?: boolean
  export(ctx: ExportContext): string
}
