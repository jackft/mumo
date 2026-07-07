import type { EditorView } from 'prosemirror-view'
import { NodeSelection, TextSelection } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import { schema, newId } from '@mumo/core'
import { insertOverlapBracketAtCursor } from '../plugins/overlap.js'

export function runToggleBold(view: EditorView): void {
  toggleMark(schema.marks['bold'])(view.state, view.dispatch, view)
  view.focus()
}

export function runToggleItalic(view: EditorView): void {
  toggleMark(schema.marks['italic'])(view.state, view.dispatch, view)
  view.focus()
}

export function runToggleStrike(view: EditorView): void {
  toggleMark(schema.marks['strike'])(view.state, view.dispatch, view)
  view.focus()
}

export function runToggleUnderline(view: EditorView): void {
  toggleMark(schema.marks['underline'])(view.state, view.dispatch, view)
  view.focus()
}

export function runInsertChar(view: EditorView, char: string): void {
  const { selection } = view.state
  if (selection.empty) {
    view.dispatch(view.state.tr.insertText(char))
  } else {
    // Wrap selection: insert symbol before and after, keeping selected text.
    const tr = view.state.tr
      .insertText(char, selection.to, selection.to)
      .insertText(char, selection.from, selection.from)
    view.dispatch(tr)
  }
  view.focus()
}

export function runInsertOverlapBracket(view: EditorView, kind: 'start' | 'end'): void {
  insertOverlapBracketAtCursor(view, kind)
}

export function runSelectParentBlock(view: EditorView): void {
  const { $from } = view.state.selection
  if ($from.depth < 1) return
  const pos = $from.before(1)
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
  view.focus()
}

/** Insert a comment block after the current top-level block. */
export function runInsertComment(view: EditorView): void {
  const { $from } = view.state.selection
  let topDepth = -1
  for (let d = $from.depth; d >= 1; d--) {
    if ($from.node(d - 1).type === view.state.schema.nodes['doc']) { topDepth = d; break }
  }
  if (topDepth === -1) return
  const blockEnd = $from.after(topDepth)
  const comment = schema.nodes['comment'].create({ id: newId() })
  const insertPos = Math.min(blockEnd, view.state.doc.content.size)
  const tr = view.state.tr.insert(insertPos, comment)
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** Apply a font-family mark to the current selection, or remove font marks if family is empty. */
export function runApplyFont(view: EditorView, family: string): void {
  const { selection } = view.state
  if (selection.empty) return
  const markType = schema.marks['font']
  const tr = family
    ? view.state.tr.addMark(selection.from, selection.to, markType.create({ family }))
    : view.state.tr.removeMark(selection.from, selection.to, markType)
  view.dispatch(tr)
  view.focus()
}
