import { describe, it, expect } from 'vitest'
import { parseMMETF, parseMMEAF } from '../src/index.js'
import { AnnotationStore } from '@mumo/core'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { buildTemplateMerge } from '../../mumo/src/template-merge.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../')

function makeStore() { return new AnnotationStore() }

describe('template apply end-to-end', () => {
  it('applies vocab, LT, and pattern schema from template.mmetf onto a transcript-loaded store', () => {
    const store = makeStore()

    // Simulate loading transcript.mmeaf (goes through mmeaf importer → loadJSON with full storeData)
    const transcriptXml = readFileSync(join(root, 'tmp/transcript.mmeaf'), 'utf8')
    const transcriptResult = parseMMEAF(transcriptXml)
    store.loadJSON({
      annotations: transcriptResult.annotations,
      tiers: transcriptResult.tiers,
      vocabularies: transcriptResult.vocabularies,
      linguisticTypes: transcriptResult.linguisticTypes,
      patternSchemas: transcriptResult.patternSchemas,
      patterns: transcriptResult.patterns,
      participants: transcriptResult.participants,
    })

    console.log('store after EAF load:')
    console.log('  vocabs:', store.allVocabularies().map(v => v.name))
    console.log('  LTs:', store.allLinguisticTypes().map(lt => lt.name))
    console.log('  patterns:', store.allPatternSchemas().map(s => s.name))

    // Parse template and build merge
    const templateXml = readFileSync(join(root, 'tmp/template.mmetf'), 'utf8')
    const tmpl = parseMMETF(templateXml)
    const merge = buildTemplateMerge(tmpl, store)

    console.log('conflicts:', merge.conflicts)
    console.log('preview:', JSON.stringify(merge.preview, null, 2))
    console.log('hasChanges:', merge.preview.some(s => s.items.some(i => i.action !== 'skip')))

    // Apply
    merge.applyFn(store)

    console.log('store after apply:')
    console.log('  vocabs:', store.allVocabularies().map(v => v.name))
    console.log('  LTs:', store.allLinguisticTypes().map(lt => lt.name))
    console.log('  patterns:', store.allPatternSchemas().map(s => s.name))

    expect(store.allVocabularies().map(v => v.name)).toContain('test')
    expect(store.allLinguisticTypes().map(lt => lt.name)).toContain('blah')
    expect(store.allPatternSchemas().map(s => s.name)).toContain('howdy')
  })
})
