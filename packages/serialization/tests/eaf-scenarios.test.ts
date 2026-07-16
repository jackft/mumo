/**
 * Scenario tests for specific EAF features:
 * controlled vocabularies, symbolic association, event tiers, ETF templates.
 */
import { describe, it, expect } from 'vitest'
import { parseEAF } from '../src/eaf-parse.js'
import { emitEAF, emitETF } from '../src/eaf-emit.js'
import { AnnotationStore } from '@mumo/core'
import { newId } from '@mumo/core'
import type { PMNodeJSON } from '../src/types.js'

// helpers

function emptyDoc(): PMNodeJSON {
  return { type: 'doc', content: [] }
}

// Controlled vocabularies

describe('controlled vocabularies', () => {
  it('round-trips a vocabulary with entries', () => {
    const store = new AnnotationStore()
    const vocabId = newId()
    store.addVocabulary('POS', [
      { id: newId(), value: 'NOUN' },
      { id: newId(), value: 'VERB' },
    ], vocabId)

    const xml = emitEAF(emptyDoc(), store)
    expect(xml).toContain('CV_ID=')
    expect(xml).toContain('NOUN')
    expect(xml).toContain('VERB')

    const result = parseEAF(xml)
    expect(result.vocabularies).toHaveLength(1)
    expect(result.vocabularies[0]!.entries.map(e => e.value)).toContain('NOUN')
    expect(result.vocabularies[0]!.entries.map(e => e.value)).toContain('VERB')
  })

  it('round-trips entry descriptions', () => {
    const store = new AnnotationStore()
    store.addVocabulary('Gesture types', [
      { id: newId(), value: 'stroke', description: 'The main movement phase' },
    ])

    const xml = emitEAF(emptyDoc(), store)
    const result = parseEAF(xml)
    expect(result.vocabularies[0]!.entries[0]!.description).toBe('The main movement phase')
  })

  it('round-trips vocabulary count', () => {
    const store = new AnnotationStore()
    store.addVocabulary('V1', [{ id: newId(), value: 'a' }])
    store.addVocabulary('V2', [{ id: newId(), value: 'b' }])

    const result = parseEAF(emitEAF(emptyDoc(), store))
    expect(result.vocabularies).toHaveLength(2)
  })
})

// Symbolic association (REF annotations)

describe('symbolic association', () => {
  it('emits REF_ANNOTATION for symbolic_association tiers', () => {
    const store = new AnnotationStore()
    const tierId = newId()
    const parentId = newId()
    store.addTier('POS', { constraint: 'symbolic_association' }, tierId)
    store.addAnnotation('NOUN', [], { tierId, parentAnnId: parentId }, newId())

    const xml = emitEAF(emptyDoc(), store)
    expect(xml).toContain('<REF_ANNOTATION')
    expect(xml).not.toContain('<ALIGNABLE_ANNOTATION ANNOTATION_ID="a1"')
  })

  it('round-trips symbolic_association constraint via linguistic type', () => {
    const store = new AnnotationStore()
    const tierId = newId()
    store.addTier('POS', { constraint: 'symbolic_association' }, tierId)

    const result = parseEAF(emitEAF(emptyDoc(), store))
    const tier = result.tiers[0]!
    const lt = result.linguisticTypes.find(l => l.id === tier.linguisticTypeId)
    expect(lt?.constraint).toBe('symbolic_association')
  })

  it('round-trips symbolic_subdivision constraint via linguistic type', () => {
    const store = new AnnotationStore()
    const tierId = newId()
    store.addTier('Morphemes', { constraint: 'symbolic_subdivision' }, tierId)

    const result = parseEAF(emitEAF(emptyDoc(), store))
    const tier = result.tiers[0]!
    const lt = result.linguisticTypes.find(l => l.id === tier.linguisticTypeId)
    expect(lt?.constraint).toBe('symbolic_subdivision')
  })
})

// ETF (template) output

describe('emitETF', () => {
  it('omits TIME_ORDER', () => {
    const store = new AnnotationStore()
    store.addTier('Gesture', {})
    const xml = emitETF(store)
    expect(xml).not.toContain('<TIME_ORDER>')
  })

  it('omits ANNOTATION elements', () => {
    const store = new AnnotationStore()
    const tierId = newId()
    store.addTier('POS', {}, tierId)
    store.addAnnotation('NOUN', [{ type: 'time', start: 0.0, end: 1.0 }], { tierId })
    const xml = emitETF(store)
    expect(xml).not.toContain('<ANNOTATION>')
  })

  it('retains TIER and LINGUISTIC_TYPE elements', () => {
    const store = new AnnotationStore()
    store.addTier('POS', {})
    const xml = emitETF(store)
    expect(xml).toContain('<TIER')
    expect(xml).toContain('<LINGUISTIC_TYPE')
  })

  it('retains CONTROLLED_VOCABULARY elements', () => {
    const store = new AnnotationStore()
    store.addVocabulary('Tags', [{ id: newId(), value: 'NOUN' }])
    const xml = emitETF(store)
    expect(xml).toContain('<CONTROLLED_VOCABULARY')
    expect(xml).toContain('NOUN')
  })

  it('produces valid XML declaration', () => {
    const xml = emitETF(new AnnotationStore())
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true)
    expect(xml).toContain('</ANNOTATION_DOCUMENT>')
  })
})

// Linguistic types

describe('linguistic types round-trip', () => {
  it('round-trips a linguistic type with constraint', () => {
    const store = new AnnotationStore()
    store.addLinguisticType('Gesture phase', { constraint: 'included_in' })

    const result = parseEAF(emitEAF(emptyDoc(), store))
    const lt = result.linguisticTypes.find(l => l.name === 'Gesture phase')
    expect(lt).toBeDefined()
    expect(lt!.constraint).toBe('included_in')
  })

  it('round-trips a linguistic type with vocabulary reference', () => {
    const store = new AnnotationStore()
    store.addVocabulary('POS', [{ id: newId(), value: 'NOUN' }])
    store.addLinguisticType('POS type', { vocabularyId: store.allVocabularies()[0]!.id })

    const result = parseEAF(emitEAF(emptyDoc(), store))
    const lt = result.linguisticTypes.find(l => l.name === 'POS type')
    expect(lt).toBeDefined()
    expect(lt!.vocabularyId).toBeDefined()
    // The vocabularyId reference must point to an actual vocabulary in the result
    const referencedVocab = result.vocabularies.find(v => v.id === lt!.vocabularyId)
    expect(referencedVocab).toBeDefined()
    expect(referencedVocab!.name).toBe('POS')
  })
})

// Unanchored utterances

describe('unanchored utterances', () => {
  it('skips utterances with null start time', () => {
    const doc: PMNodeJSON = {
      type: 'doc',
      content: [{
        type: 'utterance',
        attrs: { id: newId(), participant: 'A', startTimeSeconds: null, endTimeSeconds: null },
        content: [{ type: 'word', attrs: { id: newId(), startTimeSeconds: null, endTimeSeconds: null }, content: [{ type: 'text', text: 'hi' }] }],
      }],
    }
    const store = new AnnotationStore()
    const xml = emitEAF(doc, store)
    expect(xml).not.toContain('<ANNOTATION>')
  })
})

// Skipped-tier child annotations
//
// When a non-gloss, non-token tier is a child of a transcript tier, it is
// intentionally skipped (neither its tier def nor its annotations are collected).
// If that skipped tier has its own symbolic children, those children's REF
// annotations must NOT create dangling parentAnnId references.

describe('REF annotations whose parent tier was skipped', () => {
  it('drops symbolic children of a non-gloss non-token transcript child, no dangling parentAnnId', () => {
    // participant:A is the transcript tier (matches heuristic).
    // phonemes@A is Time_Subdivision of participant:A → skipped (non-gloss, non-token).
    // features@A is Symbolic_Association of phonemes@A → collected but parent annotations skipped.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT AUTHOR="" DATE="2025-01-01" FORMAT="3.0" VERSION="3.0"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/EAFv3.0.xsd">
  <HEADER MEDIA_FILE="" TIME_UNITS="milliseconds"/>
  <TIME_ORDER>
    <TIME_SLOT TIME_SLOT_ID="ts1" TIME_VALUE="0"/>
    <TIME_SLOT TIME_SLOT_ID="ts2" TIME_VALUE="1000"/>
    <TIME_SLOT TIME_SLOT_ID="ts3" TIME_VALUE="400"/>
    <TIME_SLOT TIME_SLOT_ID="ts4" TIME_VALUE="700"/>
  </TIME_ORDER>
  <TIER LINGUISTIC_TYPE_REF="lt-utterance" TIER_ID="participant:A">
    <ANNOTATION>
      <ALIGNABLE_ANNOTATION ANNOTATION_ID="a1" TIME_SLOT_REF1="ts1" TIME_SLOT_REF2="ts2">
        <ANNOTATION_VALUE>hello world</ANNOTATION_VALUE>
      </ALIGNABLE_ANNOTATION>
    </ANNOTATION>
  </TIER>
  <TIER LINGUISTIC_TYPE_REF="lt-phon" TIER_ID="phonemes@A" PARENT_REF="participant:A">
    <ANNOTATION>
      <ALIGNABLE_ANNOTATION ANNOTATION_ID="a2" TIME_SLOT_REF1="ts3" TIME_SLOT_REF2="ts4">
        <ANNOTATION_VALUE>h</ANNOTATION_VALUE>
      </ALIGNABLE_ANNOTATION>
    </ANNOTATION>
  </TIER>
  <TIER LINGUISTIC_TYPE_REF="lt-feat" TIER_ID="features@A" PARENT_REF="phonemes@A">
    <ANNOTATION>
      <REF_ANNOTATION ANNOTATION_ID="a3" ANNOTATION_REF="a2">
        <ANNOTATION_VALUE>+voice</ANNOTATION_VALUE>
      </REF_ANNOTATION>
    </ANNOTATION>
  </TIER>
  <LINGUISTIC_TYPE CONSTRAINTS="Time_Subdivision" LINGUISTIC_TYPE_ID="lt-phon" TIME_ALIGNABLE="true"/>
  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Association" LINGUISTIC_TYPE_ID="lt-feat" TIME_ALIGNABLE="false"/>
  <LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="lt-utterance" TIME_ALIGNABLE="true"/>
</ANNOTATION_DOCUMENT>`

    const result = parseEAF(xml)

    // features@A annotation (a3) must not exist because its parent (a2 from phonemes@A) was skipped.
    const danglingAnns = result.annotations.filter(a => {
      const pid = a.features['parentAnnId'] as string | undefined
      if (!pid) return false
      return !result.annotations.some(p => p.id === pid)
    })
    expect(danglingAnns).toHaveLength(0)
  })
})

// Media descriptor

describe('media descriptor', () => {
  it('includes MEDIA_DESCRIPTOR when mediaUrl is set', () => {
    const xml = emitEAF(emptyDoc(), new AnnotationStore(), {
      mediaUrl: 'file:///path/to/video.mp4',
      mimeType: 'video/mp4',
    })
    expect(xml).toContain('MEDIA_URL="file:///path/to/video.mp4"')
    expect(xml).toContain('MIME_TYPE="video/mp4"')
  })

  it('omits MEDIA_DESCRIPTOR when mediaUrl is empty', () => {
    const xml = emitEAF(emptyDoc(), new AnnotationStore())
    expect(xml).not.toContain('<MEDIA_DESCRIPTOR')
  })

  it('includes additionalMedia descriptors', () => {
    const xml = emitEAF(emptyDoc(), new AnnotationStore(), {
      mediaUrl: 'file:///primary.mp4',
      additionalMedia: [
        { mediaUrl: 'file:///secondary.wav', mimeType: 'audio/x-wav', timeOrigin: 500 },
      ],
    })
    expect(xml).toContain('MEDIA_URL="file:///primary.mp4"')
    expect(xml).toContain('MEDIA_URL="file:///secondary.wav"')
    expect(xml).toContain('MIME_TYPE="audio/x-wav"')
    expect(xml).toContain('TIME_ORIGIN="500"')
  })

  it('omits TIME_ORIGIN when timeOrigin is zero', () => {
    const xml = emitEAF(emptyDoc(), new AnnotationStore(), {
      mediaUrl: 'file:///video.mp4',
      timeOrigin: 0,
    })
    expect(xml).not.toContain('TIME_ORIGIN')
  })

  it('parses MIME_TYPE="unknown" as absent (ELAN sentinel for unresolvable)', () => {
    const xml = emitEAF(emptyDoc(), new AnnotationStore(), {
      mediaUrl: 'file:///video.mp4',
    })
    expect(xml).toContain('MIME_TYPE="unknown"')
    const result = parseEAF(xml)
    expect(result.media[0]!.mimeType).toBeUndefined()
  })
})
