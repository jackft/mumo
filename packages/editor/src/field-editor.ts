import type { EditorView } from 'prosemirror-view'

/**
 * Shared boilerplate for inline field editing inside a NodeView.
 * Handles contentEditable toggle, view-disable, done guard, blur/keydown.
 * onCommit gets (trimmedText, returnFocus); onCancel should restore el.textContent.
 */
export function startFieldEdit(
  el: HTMLSpanElement,
  view: EditorView,
  onCommit: (text: string, returnFocus: boolean) => void,
  onCancel: () => void,
): void {
  el.contentEditable = 'true'
  view.dom.contentEditable = 'false'
  el.focus()

  let done = false

  const commit = (returnFocus = false) => {
    if (done) return
    done = true
    el.contentEditable = 'false'
    view.dom.contentEditable = 'true'
    onCommit(el.textContent.trim(), returnFocus)
    if (returnFocus) view.focus()
  }

  const cancel = () => {
    if (done) return
    done = true
    el.contentEditable = 'false'
    view.dom.contentEditable = 'true'
    onCancel()
    view.focus()
  }

  el.addEventListener('blur', () => { commit() }, { once: true })
  el.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit(true) }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() }
  }, { once: true })
}
