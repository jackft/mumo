/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import type { Node } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { formatTime, getCurrentDecimals, registerTimeView, unregisterTimeView } from '../format.js'
import { startTimeEdit } from '../time-edit.js'
import { startFieldEdit } from '../field-editor.js'

export type VizContextMenuCallback = (
  vizId: string,
  vizType: string,
  startSeconds: number | null,
  endSeconds: number | null,
  x: number,
  y: number,
) => void

export class VisualizationNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement

  private lineNumEl: HTMLSpanElement
  private lineNumRightEl: HTMLSpanElement
  startTimeEl: HTMLSpanElement
  endTimeEl: HTMLSpanElement
  private typeEl: HTMLSpanElement
  private participantEl: HTMLSpanElement
  private _placeholderEl: HTMLSpanElement

  node: Node
  view: EditorView
  getPos: () => number | undefined

  private onSeek: ((t: number) => void) | undefined
  private onContextMenu: VizContextMenuCallback | undefined
  _decimals: number
  _editingWhichTime: 'start' | 'end' | null = null

  constructor(
    node: Node,
    view: EditorView,
    getPos: () => number | undefined,
    onSeek?: (t: number) => void,
    onContextMenu?: VizContextMenuCallback,
  ) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.onSeek = onSeek
    this.onContextMenu = onContextMenu
    this._decimals = getCurrentDecimals()
    registerTimeView(this)

    this.dom = document.createElement('div')
    this.dom.className = 'viz-row'
    this.dom.setAttribute('data-id', node.attrs.id as string)

    this.lineNumEl = document.createElement('span')
    this.lineNumEl.className = 'utt-linenum'
    this.lineNumEl.contentEditable = 'false'

    this.lineNumRightEl = document.createElement('span')
    this.lineNumRightEl.className = 'utt-linenum utt-linenum-right'
    this.lineNumRightEl.contentEditable = 'false'

    this.startTimeEl = document.createElement('span')
    this.startTimeEl.className = 'utt-time utt-time-start'
    this.startTimeEl.contentEditable = 'false'
    this.startTimeEl.textContent = formatTime(node.attrs.startTimeSeconds)

    this.endTimeEl = document.createElement('span')
    this.endTimeEl.className = 'utt-time utt-time-end'
    this.endTimeEl.contentEditable = 'false'
    this.endTimeEl.textContent = formatTime(node.attrs.endTimeSeconds)

    // Meta column: participant on top, viz type below — matches evt-meta-col convention
    const metaColEl = document.createElement('span')
    metaColEl.className = 'evt-meta-col'
    metaColEl.contentEditable = 'false'

    this.participantEl = document.createElement('span')
    this.participantEl.className = 'evt-actors'
    this.participantEl.contentEditable = 'false'
    this.participantEl.textContent = (node.attrs.participant as string) || '—'
    this.participantEl.title = 'Click to edit participant'

    this.typeEl = document.createElement('span')
    this.typeEl.className = 'viz-type-tag'
    this.typeEl.contentEditable = 'false'
    this.typeEl.textContent = (node.attrs.type as string) || 'visualization'
    this.typeEl.title = 'Click to edit type'

    metaColEl.appendChild(this.participantEl)
    metaColEl.appendChild(this.typeEl)

    this.contentDOM = document.createElement('span')
    this.contentDOM.className = 'utt-content'

    this._placeholderEl = document.createElement('span')
    this._placeholderEl.className = 'viz-empty-hint'
    this._placeholderEl.contentEditable = 'false'
    this._placeholderEl.textContent = 'right-click to configure'
    this._syncPlaceholder(node)

    this.dom.appendChild(this.lineNumEl)
    this.dom.appendChild(this.startTimeEl)
    this.dom.appendChild(this.endTimeEl)
    this.dom.appendChild(metaColEl)
    this.dom.appendChild(this._placeholderEl)
    this.dom.appendChild(this.contentDOM)
    this.dom.appendChild(this.lineNumRightEl)

    this.dom.addEventListener('contextmenu', (e) => {
      if (!this.onContextMenu) return
      e.preventDefault()
      e.stopPropagation()
      this.onContextMenu(
        this.node.attrs.id as string,
        this.node.attrs.type as string,
        this.node.attrs.startTimeSeconds as number | null,
        this.node.attrs.endTimeSeconds as number | null,
        e.clientX,
        e.clientY,
      )
    })

    this.startTimeEl.addEventListener('click', () => {
      const t = this.node.attrs.startTimeSeconds
      if (t !== null) this.onSeek?.(t)
      else this._startTimeEdit('start')
    })

    this.endTimeEl.addEventListener('click', () => {
      const t = this.node.attrs.endTimeSeconds
      if (t !== null) this.onSeek?.(t)
      else this._startTimeEdit('end')
    })

    this.typeEl.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      this._startFieldEdit(this.typeEl, 'type')
    })

    this.participantEl.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      this._startFieldEdit(this.participantEl, 'participant')
    })

  }

  private _syncPlaceholder(node: Node): void {
    const type = node.attrs.type as string
    const needsConfig = type === 'spectrogram-clip'
    this._placeholderEl.style.display = (node.childCount === 0 && needsConfig) ? '' : 'none'
  }

  private _startFieldEdit(el: HTMLSpanElement, field: 'type' | 'participant'): void {
    const original = this.node.attrs[field] as string
    startFieldEdit(el, this.view,
      (rawText, returnFocus) => {
        const newVal = rawText === '—' ? '' : rawText
        el.textContent = newVal || '—'
        const pos = this.getPos()
        if (pos !== undefined && newVal !== original) {
          const extraAttrs = field === 'participant' && newVal === ''
            ? { dependent: false, parentNodeId: null }
            : {}
          let tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, [field]: newVal, ...extraAttrs })
          if (returnFocus) tr = tr.setSelection(TextSelection.create(tr.doc, pos + 1))
          this.view.dispatch(tr)
        }
      },
      () => { el.textContent = original || '—' },
    )
  }

  private _startTimeEdit(which: 'start' | 'end'): void {
    startTimeEdit(this, which)
  }

  stopEvent(event: Event): boolean {
    return (
      event.target === this.typeEl ||
      event.target === this.participantEl ||
      event.target === this.startTimeEl ||
      event.target === this.endTimeEl
    )
  }

  ignoreMutation(): boolean {
    return (
      this.typeEl.contentEditable === 'true' ||
      this.participantEl.contentEditable === 'true' ||
      this._editingWhichTime !== null
    )
  }

  refresh(decimals: number): void {
    this._decimals = decimals
    if (this._editingWhichTime !== 'start')
      this.startTimeEl.textContent = formatTime(this.node.attrs.startTimeSeconds, decimals)
    if (this._editingWhichTime !== 'end')
      this.endTimeEl.textContent   = formatTime(this.node.attrs.endTimeSeconds,   decimals)
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.dom.setAttribute('data-id', node.attrs.id as string)
    if (this.typeEl.contentEditable !== 'true')
      this.typeEl.textContent = (node.attrs.type as string) || 'visualization'
    if (this.participantEl.contentEditable !== 'true')
      this.participantEl.textContent = (node.attrs.participant as string) || '—'
    if (this._editingWhichTime !== 'start')
      this.startTimeEl.textContent = formatTime(node.attrs.startTimeSeconds, this._decimals)
    if (this._editingWhichTime !== 'end')
      this.endTimeEl.textContent   = formatTime(node.attrs.endTimeSeconds,   this._decimals)
    this._syncPlaceholder(node)
    return true
  }

  destroy(): void {
    unregisterTimeView(this)
  }
}
