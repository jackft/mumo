/**
 * Internal types representing the EAF/ETF XML data model after parsing.
 * These are intermediate representations — not the mumo store types.
 */

export interface EAFTimeSlot {
  id: string           // e.g. "ts1"
  value: number | null // milliseconds; null when TIME_VALUE attribute is absent
}

export interface EAFAlignableAnnotation {
  kind: 'alignable'
  id: string
  ts1: string     // TIME_SLOT_REF1
  ts2: string     // TIME_SLOT_REF2
  value: string
  cveRef?: string // CVE_REF (controlled vocabulary entry ID)
}

export interface EAFRefAnnotation {
  kind: 'ref'
  id: string
  ref: string     // ANNOTATION_REF (parent annotation EAF ID)
  prev?: string   // PREVIOUS_ANNOTATION
  value: string
  cveRef?: string // CVE_REF (controlled vocabulary entry ID)
}

export type EAFAnnotation = EAFAlignableAnnotation | EAFRefAnnotation

export interface EAFTier {
  id: string
  linguisticTypeRef: string
  parentRef?: string
  participant?: string
  annotator?: string
  defaultLocale?: string
  annotations: EAFAnnotation[]
}

export type EAFConstraint =
  | 'Time_Subdivision'
  | 'Included_In'
  | 'Symbolic_Subdivision'
  | 'Symbolic_Association'

export interface EAFLinguisticType {
  id: string
  timeAlignable: boolean
  constraint?: EAFConstraint
  cvRef?: string
}

export interface EAFCVEntry {
  id: string
  value: string
  description?: string
}

export interface EAFCV {
  id: string
  entries: EAFCVEntry[]
  extRef?: string  // EXT_REF_ID — references an EAFExternalRef
}

export interface EAFMediaDescriptor {
  mediaUrl: string
  mimeType?: string
  relativeUrl?: string
  timeOrigin?: number  // TIME_ORIGIN in milliseconds
}

export interface EAFExternalRef {
  id: string    // EXT_REF_ID
  type: string  // e.g. 'ecv'
  value: string // URL
}

export interface EAFLanguage {
  langId: string      // LANG_ID (BCP47 tag)
  langLabel?: string  // LANG_LABEL
  langDef?: string    // LANG_DEF (URI)
}

export interface EAFDocument {
  timeSlots: EAFTimeSlot[]
  tiers: EAFTier[]
  linguisticTypes: EAFLinguisticType[]
  vocabularies: EAFCV[]
  media: EAFMediaDescriptor[]
  externalRefs: EAFExternalRef[]
  languages: EAFLanguage[]
  properties: Array<{ name: string; value: string }>
  author?: string
}

// Serialised PM doc types (mirrors ProseMirror's JSON shape)

export interface PMNodeJSON {
  type: string
  attrs?: Record<string, unknown>
  content?: PMNodeJSON[]
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
  text?: string
}
