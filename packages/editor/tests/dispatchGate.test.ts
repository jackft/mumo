/**
 * Tests for the dispatchTransaction read-only gate in TranscriptEditor.
 *
 * The guard is:
 *   const isYjsSync = tr.getMeta(ySyncPluginKey)?.isChangeOrigin
 *   if (!editable && tr.docChanged && !tr.getMeta('allowWhenReadonly') && !isYjsSync) return
 *
 * Critical cases:
 *   - user edits in annotate mode (editable=false) → blocked
 *   - textlet creation (allowWhenReadonly=true) → allowed
 *   - Yjs undo sync-back (isChangeOrigin=true) → allowed, so the mark is removed on undo
 */
import { describe, it, expect } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { ySyncPluginKey } from 'y-prosemirror'
import { schema, docFromBlocks, newId } from '@mumo/core'

function stateWithText(text: string): EditorState {
  return EditorState.create({
    doc: docFromBlocks([{ type: 'utterance', participant: 'A', text }]),
    schema,
  })
}

function annMark(id: string) {
  return schema.marks['annotation'].create({ id })
}

/** Mirrors the dispatchTransaction guard verbatim. */
function gate(editable: boolean, tr: ReturnType<EditorState['tr']>): 'drop' | 'apply' {
  const isYjsSync = tr.getMeta(ySyncPluginKey)?.isChangeOrigin
  if (!editable && tr.docChanged && !tr.getMeta('allowWhenReadonly') && !isYjsSync) return 'drop'
  return 'apply'
}

describe('dispatchTransaction gate', () => {
  const uttStart = 1

  it('allows doc-changing transactions when editable=true', () => {
    const state = stateWithText('hello world')
    const tr = state.tr.addMark(uttStart + 1, uttStart + 6, annMark(newId()))
    expect(gate(true, tr)).toBe('apply')
  })

  it('blocks doc-changing transactions when editable=false (user edit in annotate mode)', () => {
    const state = stateWithText('hello world')
    const tr = state.tr.addMark(uttStart + 1, uttStart + 6, annMark(newId()))
    expect(gate(false, tr)).toBe('drop')
  })

  it('allows transactions with allowWhenReadonly=true when editable=false (textlet creation)', () => {
    const state = stateWithText('hello world')
    const tr = state.tr
      .addMark(uttStart + 1, uttStart + 6, annMark(newId()))
      .setMeta('allowWhenReadonly', true)
    expect(gate(false, tr)).toBe('apply')
  })

  it('allows isChangeOrigin transactions when editable=false (Yjs undo/redo sync-back)', () => {
    // This is the critical case: when undo reverses the XML fragment, y-prosemirror
    // dispatches a PM transaction with ySyncPluginKey meta { isChangeOrigin: true }.
    // Without this exemption the mark removal is dropped and the highlight persists.
    const state = stateWithText('hello world')
    const id = newId()
    const withMark = state.apply(
      state.tr.addMark(uttStart + 1, uttStart + 6, annMark(id)).setMeta('allowWhenReadonly', true),
    )
    const removeTr = withMark.tr
      .removeMark(uttStart + 1, uttStart + 6, schema.marks['annotation'])
      .setMeta(ySyncPluginKey, { isChangeOrigin: true })
    expect(gate(false, removeTr)).toBe('apply')

    // Verify the mark actually gets removed when the transaction is applied
    const after = withMark.apply(removeTr)
    const marks = after.doc.resolve(uttStart + 3).marks()
    expect(marks.filter(m => m.type.name === 'annotation' && m.attrs['id'] === id)).toHaveLength(0)
  })

  it('allows non-doc-changing transactions when editable=false (selection, decorations)', () => {
    const state = stateWithText('hello world')
    const tr = state.tr  // no doc change
    expect(gate(false, tr)).toBe('apply')
  })
})
