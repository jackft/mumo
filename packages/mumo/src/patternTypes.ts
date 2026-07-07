import type { ID } from '@mumo/core'

export type SlotFillMode = {
  patternId: ID
  slotSchemaId: ID
  anchorKind: 'span' | 'utterance' | 'pattern' | 'any'
}

