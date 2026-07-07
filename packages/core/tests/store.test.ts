import { describe, it, expect, beforeEach } from 'vitest'
import { AnnotationStore } from '../src/store.js'
import { newId } from '../src/id.js'

describe('AnnotationStore', () => {
  let store: AnnotationStore

  beforeEach(() => { store = new AnnotationStore() })

  describe('annotations', () => {
    it('adds and retrieves an annotation', () => {
      const id = newId()
      store.addAnnotation('noun', [], {}, id)
      expect(store.getAnnotation(id)).toMatchObject({ id, type: 'noun' })
    })

    it('removes an annotation', () => {
      const id = newId()
      store.addAnnotation('verb', [], {}, id)
      store.removeAnnotation(id)
      expect(store.getAnnotation(id)).toBeUndefined()
    })

    it('updates annotation type', () => {
      const id = newId()
      store.addAnnotation('noun', [], {}, id)
      store.updateAnnotation(id, { type: 'verb' })
      expect(store.getAnnotation(id)?.type).toBe('verb')
    })

    it('lists all annotations', () => {
      store.addAnnotation('a', [], {})
      store.addAnnotation('b', [], {})
      expect(store.allAnnotations()).toHaveLength(2)
    })

    it('stores anchors', () => {
      const id = newId()
      store.addAnnotation('label', [{ type: 'time', start: 1.0, end: 2.0 }], {}, id)
      const ann = store.getAnnotation(id)!
      expect(ann.anchors[0]).toMatchObject({ type: 'time', start: 1.0, end: 2.0 })
    })
  })

  describe('tiers', () => {
    it('adds and retrieves a tier', () => {
      const id = newId()
      store.addTier('POS', {}, id)
      expect(store.getTier(id)).toMatchObject({ id, name: 'POS' })
    })

    it('removes a tier', () => {
      const id = newId()
      store.addTier('POS', {}, id)
      store.removeTier(id)
      expect(store.getTier(id)).toBeUndefined()
    })

    it('auto-creates a linguistic type when constraint is given', () => {
      const tierId = newId()
      store.addTier('Gesture', { constraint: 'time_subdivision' }, tierId)
      const tier = store.getTier(tierId)!
      const lt = store.getLinguisticType(tier.linguisticTypeId)
      expect(lt?.constraint).toBe('time_subdivision')
    })

    it('defaults to default-lt when no linguisticTypeId given', () => {
      const tierId = newId()
      store.addTier('Notes', {}, tierId)
      const tier = store.getTier(tierId)!
      expect(tier.linguisticTypeId).toBe('default-lt')
    })
  })

  describe('controlled vocabularies', () => {
    it('adds a vocabulary', () => {
      const id = newId()
      store.addVocabulary('POS tags', [{ id: newId(), value: 'NOUN' }], id)
      expect(store.getVocabulary(id)?.name).toBe('POS tags')
    })

    it('stores entries', () => {
      const id = newId()
      const entryId = newId()
      store.addVocabulary('Tags', [{ id: entryId, value: 'VERB' }], id)
      expect(store.getVocabulary(id)?.entries[0]?.value).toBe('VERB')
    })
  })

  describe('validateAnnotationTimes — token-subtier (tokenNodeId)', () => {
    let tierId: string
    let tokenId: string

    beforeEach(() => {
      tierId  = newId()
      tokenId = newId()
      store.addTier('Phoneme', { constraint: 'time_subdivision' }, tierId)
      store.setTokenTime(tokenId, 1.0, 2.0)
    })

    it('accepts annotation within token bounds', () => {
      const annId = newId()
      store.addAnnotation('p', [{ type: 'time', start: 1.0, end: 1.5 }], { tierId, tokenNodeId: tokenId }, annId)
      const result = store.validateAnnotationTimes(annId, 1.2, 1.8)
      expect(result).toBeNull()
    })

    it('rejects annotation that starts before token', () => {
      const annId = newId()
      store.addAnnotation('p', [{ type: 'time', start: 1.0, end: 1.5 }], { tierId, tokenNodeId: tokenId }, annId)
      const result = store.validateAnnotationTimes(annId, 0.5, 1.5)
      expect(result?.kind).toBe('out_of_parent')
    })

    it('rejects annotation that ends after token', () => {
      const annId = newId()
      store.addAnnotation('p', [{ type: 'time', start: 1.0, end: 1.5 }], { tierId, tokenNodeId: tokenId }, annId)
      const result = store.validateAnnotationTimes(annId, 1.2, 2.5)
      expect(result?.kind).toBe('out_of_parent')
    })

    it('rejects time_subdivision sibling overlap', () => {
      const sib = newId()
      const ann = newId()
      store.addAnnotation('p', [{ type: 'time', start: 1.0, end: 1.5 }], { tierId, tokenNodeId: tokenId }, sib)
      store.addAnnotation('b', [{ type: 'time', start: 1.5, end: 2.0 }], { tierId, tokenNodeId: tokenId }, ann)
      // moving sib so it overlaps ann
      const result = store.validateAnnotationTimes(sib, 1.0, 1.6)
      expect(result?.kind).toBe('sibling_overlap')
    })

    it('allows update when token time is unknown (no bounds to enforce)', () => {
      const unknownToken = newId()
      const annId = newId()
      store.addAnnotation('x', [{ type: 'time', start: 0.0, end: 5.0 }], { tierId, tokenNodeId: unknownToken }, annId)
      const result = store.validateAnnotationTimes(annId, 0.0, 5.0)
      expect(result).toBeNull()
    })

    it('updateAnnotation clips out_of_parent to token bounds', () => {
      const annId = newId()
      store.addAnnotation('p', [{ type: 'time', start: 1.0, end: 1.5 }], { tierId, tokenNodeId: tokenId }, annId)
      store.updateAnnotation(annId, { anchors: [{ type: 'time', start: 0.5, end: 2.5 }] })
      const ta = store.getAnnotation(annId)?.anchors.find(a => a.type === 'time')
      expect(ta).toMatchObject({ start: 1.0, end: 2.0 })
    })
  })

  describe('JSON round-trip', () => {
    it('serialises and deserialises annotations and tiers', () => {
      const tierId = newId()
      const annId = newId()
      store.addTier('Gesture', {}, tierId)
      store.addAnnotation('stroke', [{ type: 'time', start: 1.0, end: 2.0 }], { tierId }, annId)

      const json = store.toJSON()
      const store2 = new AnnotationStore()
      store2.loadJSON(json)

      expect(store2.getAnnotation(annId)?.type).toBe('stroke')
      expect(store2.getTier(tierId)?.name).toBe('Gesture')
    })

    it('round-trips time anchors', () => {
      const id = newId()
      store.addAnnotation('x', [{ type: 'time', start: 0.5, end: 1.5 }], {}, id)
      const store2 = new AnnotationStore()
      store2.loadJSON(store.toJSON())
      const anchor = store2.getAnnotation(id)?.anchors[0]
      expect(anchor).toMatchObject({ type: 'time', start: 0.5, end: 1.5 })
    })
  })
})
