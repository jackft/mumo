import { describe, it, expect } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { schema, docFromBlocks, newId } from '@mumo/core'

function stateWithText(text: string): EditorState {
  const doc = docFromBlocks([{ type: 'utterance', participant: 'A', text }])
  return EditorState.create({ doc, schema })
}

function annMark(id: string) {
  return schema.marks['annotation'].create({ id })
}

function marksAt(state: EditorState, pos: number) {
  return state.doc.resolve(pos).marks()
}

// annotation mark schema

describe('annotation mark schema', () => {
  it('allows multiple overlapping annotation marks on the same range', () => {
    // "hello world" — positions inside the utterance block:
    //   pos 1 = start of block content, text starts at 2
    //   "hello" = pos 2–6, "world" = pos 8–12 (space at 7)
    // We use from/to relative to what PM gives us after applying addMark.
    let state = stateWithText('hello world')

    // Resolve exact character positions: doc > utterance(1) > text
    // doc pos 0 = before utterance, 1 = inside utterance, 2 = 'h', ...
    const uttStart = 1  // opening token of the utterance node
    const helloFrom = uttStart + 1   // 'h'
    const _helloTo   = uttStart + 6   // after 'o'
    const _worldFrom = uttStart + 7   // 'w'
    const worldTo   = uttStart + 12  // after 'd'
    // Overlap region: "o w" — last char of hello, space, first char of world
    const overlapFrom = uttStart + 5
    const overlapTo   = uttStart + 8

    const id1 = newId()
    const id2 = newId()

    // Apply first mark: "hello wo"
    state = state.apply(state.tr.addMark(helloFrom, overlapTo, annMark(id1)))
    // Apply second mark: "o world"
    state = state.apply(state.tr.addMark(overlapFrom, worldTo, annMark(id2)))

    // In the overlap region both marks should coexist
    const midPos = uttStart + 6  // inside overlap
    const marks = marksAt(state, midPos)
    const ids = marks.filter(m => m.type.name === 'annotation').map(m => m.attrs['id'] as string)
    expect(ids).toContain(id1)
    expect(ids).toContain(id2)
  })

  it('two non-overlapping annotation marks are both present in the doc', () => {
    let state = stateWithText('hello world')
    const uttStart = 1
    const id1 = newId()
    const id2 = newId()
    state = state.apply(state.tr.addMark(uttStart + 1, uttStart + 6, annMark(id1)))
    state = state.apply(state.tr.addMark(uttStart + 7, uttStart + 12, annMark(id2)))

    const helloMidmarks = marksAt(state, uttStart + 3)
    const worldMidmarks = marksAt(state, uttStart + 9)
    expect(helloMidmarks.map(m => m.attrs['id'])).toContain(id1)
    expect(worldMidmarks.map(m => m.attrs['id'])).toContain(id2)
    // Marks don't bleed across
    expect(helloMidmarks.map(m => m.attrs['id'])).not.toContain(id2)
    expect(worldMidmarks.map(m => m.attrs['id'])).not.toContain(id1)
  })
})

// allowWhenReadonly gate

describe('allowWhenReadonly dispatch gate', () => {
  it('drops addMark transactions that lack allowWhenReadonly when editable=false', () => {
    const state = stateWithText('hello world')
    const uttStart = 1
    let applied: EditorState | null = null

    // Simulate the TranscriptEditor dispatchTransaction guard
    const editable = false
    function dispatch(tr: ReturnType<typeof state.tr>) {
      if (!editable && tr.docChanged && !tr.getMeta('allowWhenReadonly')) return
      applied = state.apply(tr)
    }

    const id = newId()
    dispatch(state.tr.addMark(uttStart + 1, uttStart + 6, annMark(id)))
    expect(applied).toBeNull()  // dropped — no allowWhenReadonly
  })

  it('applies addMark transactions that carry allowWhenReadonly when editable=false', () => {
    const state = stateWithText('hello world')
    const uttStart = 1
    let applied: EditorState | null = null

    const editable = false
    function dispatch(tr: ReturnType<typeof state.tr>) {
      if (!editable && tr.docChanged && !tr.getMeta('allowWhenReadonly')) return
      applied = state.apply(tr)
    }

    const id = newId()
    dispatch(
      state.tr
        .addMark(uttStart + 1, uttStart + 6, annMark(id))
        .setMeta('allowWhenReadonly', true),
    )
    expect(applied).not.toBeNull()
    const marks = marksAt(applied!, uttStart + 3)
    expect(marks.map(m => m.attrs['id'])).toContain(id)
  })
})
