import type { Node } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { formatTime, parseTimeInput } from './format.js'

export interface TimeEditHost {
  startTimeEl: HTMLSpanElement
  endTimeEl: HTMLSpanElement
  view: EditorView
  node: Node
  getPos: () => number | undefined
  _editingWhichTime: 'start' | 'end' | null
  _decimals: number
}

export function startTimeEdit(host: TimeEditHost, which: 'start' | 'end'): void {
  host._editingWhichTime = which
  const el     = which === 'start' ? host.startTimeEl : host.endTimeEl
  const attrKey = which === 'start' ? 'startTimeSeconds' : 'endTimeSeconds'

  el.contentEditable = 'true'
  el.textContent = ''
  host.view.dom.contentEditable = 'false'
  el.focus()

  let done = false
  const commit = (returnFocus = false) => {
    if (done) return
    done = true
    el.removeEventListener('keydown', onKeydown)
    host._editingWhichTime = null
    el.contentEditable = 'false'
    host.view.dom.contentEditable = 'true'
    const seconds = parseTimeInput(el.textContent)
    el.textContent = formatTime(host.node.attrs[attrKey] as number | null, host._decimals)
    if (seconds !== null) {
      const pos = host.getPos()
      if (pos !== undefined) {
        let start = host.node.attrs.startTimeSeconds as number | null
        let end   = host.node.attrs.endTimeSeconds   as number | null
        if (which === 'start') {
          start = +seconds.toFixed(3)
          if (end !== null && start >= end) end = +(start + 1).toFixed(3)
        } else {
          end = +seconds.toFixed(3)
          if (start !== null && end <= start) start = +Math.max(0, end - 1).toFixed(3)
        }
        host.view.dispatch(
          host.view.state.tr.setNodeMarkup(pos, undefined, { ...host.node.attrs, startTimeSeconds: start, endTimeSeconds: end })
        )
      }
    }
    if (returnFocus) host.view.focus()
  }
  const cancel = () => {
    if (done) return
    done = true
    el.removeEventListener('keydown', onKeydown)
    host._editingWhichTime = null
    el.contentEditable = 'false'
    host.view.dom.contentEditable = 'true'
    el.textContent = formatTime(host.node.attrs[attrKey] as number | null, host._decimals)
    host.view.focus()
  }

  const onKeydown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter') { e.preventDefault(); commit(true) }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() }
  }
  el.addEventListener('blur', () => { commit() }, { once: true })
  el.addEventListener('keydown', onKeydown)
}
