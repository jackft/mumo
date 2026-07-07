/**
 * Typed mm:feature values: numbers, booleans, and structured (JSON) feature
 * values must survive an MMEAF round-trip instead of flattening to strings
 * (or, for objects, being dropped entirely).
 */

import { describe, it, expect } from 'vitest'
import { emitMMEAF, parseMMEAF } from '../src/index.js'
import { AnnotationStore } from '@mumo/core'
import type { PMNodeJSON } from '../src/types.js'

function emptyDoc(): PMNodeJSON {
  return { type: 'doc', content: [] }
}

describe('typed mm:feature round-trip', () => {
  it('preserves number, boolean, and object feature values on textlets', () => {
    const store = new AnnotationStore()
    store.addAnnotation('textlet', [{ type: 'mark', markId: 'm1' }], {
      confidence: 0.87,
      reviewed: true,
      spanInfo: { fromToken: 3, toToken: 5 },
      plainNote: 'a string',
    }, 'tl1')

    const xml = emitMMEAF(emptyDoc(), store)
    const parsed = parseMMEAF(xml)

    const tl = parsed.annotations.find(a => a.id === 'tl1')!
    expect(tl.features['confidence']).toBe(0.87)
    expect(tl.features['reviewed']).toBe(true)
    expect(tl.features['spanInfo']).toEqual({ fromToken: 3, toToken: 5 })
    expect(tl.features['plainNote']).toBe('a string')
  })

  it('preserves typed features on utterance-anchored annotations', () => {
    const store = new AnnotationStore()
    store.addAnnotation('gesture', [{ type: 'utterance', uttId: 'u1' }], {
      startOffset: 42,
      auto: false,
    }, 'ann1')

    const xml = emitMMEAF(emptyDoc(), store)
    const parsed = parseMMEAF(xml)

    const ann = parsed.annotations.find(a => a.id === 'ann1')!
    expect(ann.features['startOffset']).toBe(42)
    expect(ann.features['auto']).toBe(false)
  })

  it('parses features without value_type as strings (older files)', () => {
    // Hand-built legacy-style feature element: no value_type attribute.
    const store = new AnnotationStore()
    store.addAnnotation('textlet', [{ type: 'mark', markId: 'm1' }], { note: 'legacy' }, 'tl1')
    const xml = emitMMEAF(emptyDoc(), store)
    expect(xml).toContain('name="note"')
    expect(xml).not.toContain('value_type="string"')
    const parsed = parseMMEAF(xml)
    expect(parsed.annotations.find(a => a.id === 'tl1')!.features['note']).toBe('legacy')
  })

  it('falls back to the raw string when json decoding fails', () => {
    const store = new AnnotationStore()
    store.addAnnotation('textlet', [{ type: 'mark', markId: 'm1' }], { good: { a: 1 } }, 'tl1')
    const xml = emitMMEAF(emptyDoc(), store)
    // The XML builder may escape quotes in text content — replace either form.
    const broken = xml.replace('{&quot;a&quot;:1}', '{not json').replace('{"a":1}', '{not json')
    expect(broken).toContain('{not json')
    const parsed = parseMMEAF(broken)
    expect(parsed.annotations.find(a => a.id === 'tl1')!.features['good']).toBe('{not json')
  })
})
