import { describe, it, expect } from 'vitest'
import { emitMMEAF } from '../src/index.js'
import { AnnotationStore } from '@mumo/core'

describe('xml validity', () => {
  it('slot label does not produce invalid <@_label> element', () => {
    const store = new AnnotationStore()
    store.addPatternSchema({
      id: 'fs1', name: 'Repair',
      slots: [{ id: 'sl1', name: 'trouble', anchorKind: 'span', required: true, label: 'Trouble source', metrics: [] }]
    })
    const xml = emitMMEAF({ type: 'doc', content: [] }, store)
    expect(xml).not.toContain('<@_')
    // label should be an attribute, not an element
    expect(xml).toContain('label="Trouble source"')
  })
})
