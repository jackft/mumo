import { describe, it, expect } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { createControllerPlugin, docFromUtterances, controllerKey } from '../src/controller.js'
import { TokenStore } from '../src/token-store.js'
import { schema } from '../src/schema.js'

function setup(utts: Array<{ id: string; participant: string; text: string }>) {
  const tokenStore = new TokenStore()
  const doc = docFromUtterances(utts)
  tokenStore.buildFromDoc(doc)
  const state = EditorState.create({ doc, schema, plugins: [createControllerPlugin(tokenStore)] })
  return { tokenStore, state }
}

/** Document position of the end of the text in the given top-level block. */
function endOfBlock(state: EditorState, blockIndex: number): number {
  let pos = 0
  for (let i = 0; i < blockIndex; i++) pos += state.doc.child(i).nodeSize
  return pos + 1 + state.doc.child(blockIndex).content.size
}

describe('controller plugin', () => {
  it('rebuilds the edited block on typing at the selection', () => {
    const { tokenStore, state } = setup([{ id: 'u1', participant: 'A', text: 'hello' }])
    const end = endOfBlock(state, 0)
    let tr = state.tr.setSelection(TextSelection.create(state.doc, end))
    tr = tr.insertText(' world')
    const next = state.apply(tr)
    expect(next.doc.child(0).textContent).toBe('hello world')
    expect(tokenStore.getUttTokens('u1').map(t => t.text)).toEqual(['hello', ' ', 'world'])
  })

  it('rebuilds a block edited away from the selection (programmatic edit)', () => {
    // Regression: the old fast path keyed off the selection block; an edit
    // dispatched at another block left that block's tokens stale.
    const { tokenStore, state } = setup([
      { id: 'u1', participant: 'A', text: 'first line' },
      { id: 'u2', participant: 'B', text: 'second line' },
    ])
    // Selection sits in block 0 (document start); edit block 1.
    const tr = state.tr.insertText(' extra', endOfBlock(state, 1))
    expect(tr.selection.$from.node(1).attrs.id).toBe('u1')
    const next = state.apply(tr)
    expect(next.doc.child(1).textContent).toBe('second line extra')
    expect(tokenStore.getUttTokens('u2').map(t => t.text))
      .toEqual(['second', ' ', 'line', ' ', 'extra'])
    // The untouched block keeps its tokens
    expect(tokenStore.getUttTokens('u1').map(t => t.text)).toEqual(['first', ' ', 'line'])
  })

  it('keeps token IDs in an untouched block when another block is edited', () => {
    const { tokenStore, state } = setup([
      { id: 'u1', participant: 'A', text: 'first line' },
      { id: 'u2', participant: 'B', text: 'second line' },
    ])
    const u1Ids = tokenStore.getUttTokens('u1').map(t => t.id)
    const tr = state.tr.insertText(' extra', endOfBlock(state, 1))
    state.apply(tr)
    expect(tokenStore.getUttTokens('u1').map(t => t.id)).toEqual(u1Ids)
  })

  it('sets controller meta with new token IDs on the appended transaction', () => {
    const { state } = setup([{ id: 'u1', participant: 'A', text: 'hello' }])
    const tr = state.tr.insertText(' world', endOfBlock(state, 0))
    const next = state.apply(tr)
    const meta = controllerKey.getState(next)!
    expect(meta.newIds.size).toBeGreaterThan(0)
  })

  it('falls back to a full rebuild when the block count changes', () => {
    const { tokenStore, state } = setup([
      { id: 'u1', participant: 'A', text: 'first line' },
      { id: 'u2', participant: 'B', text: 'second line' },
    ])
    const u2Ids = tokenStore.getUttTokens('u2').map(t => t.id)
    // Delete the whole second utterance
    const blockStart = state.doc.child(0).nodeSize
    const tr = state.tr.delete(blockStart, state.doc.content.size)
    const next = state.apply(tr)
    expect(next.doc.childCount).toBe(1)
    const meta = controllerKey.getState(next)!
    expect(tokenStore.getUttTokens('u2')).toEqual([])
    for (const id of u2Ids) expect(meta.removedIds.has(id)).toBe(true)
    expect(tokenStore.getUttTokens('u1').map(t => t.text)).toEqual(['first', ' ', 'line'])
  })
})
