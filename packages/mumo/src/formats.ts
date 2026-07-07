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
  timeOriginMs?: number
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
