import type { ID } from '@mumo/core'

export type SlotFillMode = {
  patternId: ID
  slotSchemaId: ID
  anchorKind: 'textlet' | 'utterance' | 'tier' | 'pattern' | 'any'
  tierId?: ID
}

