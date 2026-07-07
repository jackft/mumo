import type { AnnotationStore, PatternSchema, ControlledVocabulary } from '@mumo/core'

// Built-in vocabularies

const troubleTypeVocab: ControlledVocabulary = {
  id: 'builtin:vocab:trouble-type',
  name: 'Trouble type',
  entries: [
    { id: 'tt-hearability',  value: 'hearability',    description: 'Could not hear / too quiet' },
    { id: 'tt-reference',    value: 'reference',      description: 'Referent unclear or unknown' },
    { id: 'tt-grammar',      value: 'grammar/syntax', description: 'Grammatical or syntactic issue' },
    { id: 'tt-factual',      value: 'factual',        description: 'Factual accuracy questioned' },
    { id: 'tt-other',        value: 'other' },
  ],
}

const initiationTypeVocab: ControlledVocabulary = {
  id: 'builtin:vocab:initiation-type',
  name: 'Initiation type',
  entries: [
    { id: 'it-open-class',   value: 'open class',              description: 'huh?, what?, pardon?' },
    { id: 'it-partial',      value: 'partial repeat',          description: 'Repeat of trouble source fragment' },
    { id: 'it-wh',           value: 'wh-word',                 description: 'who?, which?, where? etc.' },
    { id: 'it-candidate',    value: 'candidate understanding', description: 'Proposed understanding for confirmation' },
    { id: 'it-other',        value: 'other' },
  ],
}

const solutionTypeVocab: ControlledVocabulary = {
  id: 'builtin:vocab:solution-type',
  name: 'Solution type',
  entries: [
    { id: 'st-repeat',       value: 'repeat',         description: 'Repeated with emphasis or clarification' },
    { id: 'st-correction',   value: 'correction',     description: 'Replaced trouble source with correct form' },
    { id: 'st-reformulation',value: 'reformulation',  description: 'Rephrased or restructured' },
    { id: 'st-abandoned',    value: 'abandoned',      description: 'Repair attempt abandoned' },
    { id: 'st-other',        value: 'other' },
  ],
}

const fppTypeVocab: ControlledVocabulary = {
  id: 'builtin:vocab:fpp-type',
  name: 'FPP type',
  entries: [
    { id: 'fpp-question',     value: 'question' },
    { id: 'fpp-request',      value: 'request' },
    { id: 'fpp-invitation',   value: 'invitation' },
    { id: 'fpp-offer',        value: 'offer' },
    { id: 'fpp-assessment',   value: 'assessment' },
    { id: 'fpp-greeting',     value: 'greeting' },
    { id: 'fpp-complaint',    value: 'complaint' },
    { id: 'fpp-announcement', value: 'announcement' },
    { id: 'fpp-other',        value: 'other' },
  ],
}

const sppTypeVocab: ControlledVocabulary = {
  id: 'builtin:vocab:spp-type',
  name: 'SPP type',
  entries: [
    { id: 'spp-answer',       value: 'answer' },
    { id: 'spp-acceptance',   value: 'acceptance' },
    { id: 'spp-rejection',    value: 'rejection' },
    { id: 'spp-counter',      value: 'counter-assessment' },
    { id: 'spp-grant',        value: 'grant/comply' },
    { id: 'spp-greeting',     value: 'return greeting' },
    { id: 'spp-other',        value: 'other' },
  ],
}

// Built-in pattern schemas

const repairSchema: PatternSchema = {
  id: 'builtin:repair',
  name: 'Repair',
  description: 'Other-initiated self-repair (Schegloff et al. 1977)',
  slots: [
    {
      id: 'trouble',
      name: 'trouble',
      label: 'Trouble source',
      anchorKind: 'span',
      required: true,
      metrics: [
        { id: 'trouble-type', name: 'Trouble type', type: 'categorical',
          vocabularyId: 'builtin:vocab:trouble-type' },
      ],
    },
    {
      id: 'initiation',
      name: 'initiation',
      label: 'Repair initiation',
      anchorKind: 'span',
      required: true,
      metrics: [
        { id: 'initiation-type', name: 'Initiation type', type: 'categorical',
          vocabularyId: 'builtin:vocab:initiation-type' },
      ],
    },
    {
      id: 'solution',
      name: 'solution',
      label: 'Repair proper',
      anchorKind: 'span',
      required: false,
      metrics: [
        { id: 'is-solved',     name: 'Resolved?',    type: 'boolean' },
        { id: 'solution-type', name: 'Solution type', type: 'categorical',
          vocabularyId: 'builtin:vocab:solution-type' },
      ],
    },
  ],
}

const adjPairSchema: PatternSchema = {
  id: 'builtin:adj-pair',
  name: 'Adjacency Pair',
  description: 'First and second pair parts (Schegloff & Sacks 1973)',
  slots: [
    {
      id: 'fpp',
      name: 'fpp',
      label: 'First Pair Part',
      anchorKind: 'utterance',
      required: true,
      metrics: [
        { id: 'fpp-type', name: 'FPP type', type: 'categorical',
          vocabularyId: 'builtin:vocab:fpp-type' },
      ],
    },
    {
      id: 'spp',
      name: 'spp',
      label: 'Second Pair Part',
      anchorKind: 'utterance',
      required: true,
      metrics: [
        { id: 'spp-type',   name: 'SPP type',    type: 'categorical',
          vocabularyId: 'builtin:vocab:spp-type' },
        { id: 'preferred',  name: 'Preferred?',  type: 'boolean' },
      ],
    },
  ],
}

// Seed function — loads built-ins only if no pattern schemas exist yet

const BUILTIN_FRAME_SCHEMAS = [repairSchema, adjPairSchema]

const BUILTIN_VOCABS = [
  troubleTypeVocab,
  initiationTypeVocab,
  solutionTypeVocab,
  fppTypeVocab,
  sppTypeVocab,
]

export function seedBuiltins(store: AnnotationStore): void {
  if (store.allPatternSchemas().length > 0) return
  for (const vocab of BUILTIN_VOCABS) {
    if (!store.getVocabulary(vocab.id)) {
      store.addVocabulary(vocab.name, vocab.entries, vocab.id)
    }
  }
  for (const schema of BUILTIN_FRAME_SCHEMAS) {
    store.addPatternSchema(schema, schema.id)
  }
}
