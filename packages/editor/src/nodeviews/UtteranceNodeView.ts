/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import type { Node } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { formatTime, getCurrentDecimals, registerTimeView, unregisterTimeView } from '../format.js'
import { startTimeEdit } from '../time-edit.js'
import { startFieldEdit } from '../field-editor.js'
import { registerGlossView, unregisterGlossView, getGlossEntryFor, isGlossesVisible } from '../gloss.js'
import type { GlossEntry } from '../gloss.js'
import { registerUttTierView, unregisterUttTierView, isUttTiersVisible } from '../utt-tier.js'

// Module-level singleton so at most one context menu is open at a time.
let _activeContextMenu: HTMLElement | null = null
function _closeActiveContextMenu() {
  _activeContextMenu?.remove()
  _activeContextMenu = null
}

export class UtteranceNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private lineNumEl: HTMLSpanElement
  private lineNumRightEl: HTMLSpanElement
  startTimeEl: HTMLSpanElement
  endTimeEl: HTMLSpanElement
  private participantEl: HTMLSpanElement
  private tierEl: HTMLSpanElement
  private glossEl: HTMLElement
  view: EditorView
  node: Node
  getPos: () => number | undefined

  private onSeek: ((t: number) => void) | undefined

  _decimals: number
  _editingWhichTime: 'start' | 'end' | null = null
  private _participantEditing = false
  private _sepEl: HTMLSpanElement

  private _glossOnSave: ((text: string) => void) | null = null
  private _hasGlossAnnotation = false
  private _glossEditing = false
  private _glossOriginalText = ''

  constructor(node: Node, view: EditorView, getPos: () => number | undefined, onSeek?: ((t: number) => void)  ) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.onSeek = onSeek
    this._decimals = getCurrentDecimals()
    registerTimeView(this)

    this.dom = document.createElement('div')
    this.dom.className = 'utt-row'
    this.dom.setAttribute('data-id', node.attrs.id)
    ;(this.dom as unknown as { __nodeView: UtteranceNodeView }).__nodeView = this

    this.lineNumEl = document.createElement('span')
    this.lineNumEl.className = 'utt-linenum'
    this.lineNumEl.contentEditable = 'false'

    if (node.attrs.continuationOfId) this.dom.setAttribute('data-continuation', 'true')

    this.lineNumRightEl = document.createElement('span')
    this.lineNumRightEl.className = 'utt-linenum utt-linenum-right'
    this.lineNumRightEl.contentEditable = 'false'

    this.startTimeEl = document.createElement('span')
    this.startTimeEl.className = 'utt-time utt-time-start'
    this.startTimeEl.contentEditable = 'false'
    this.startTimeEl.textContent = formatTime(this._displayTime(node, 'start'))

    this.endTimeEl = document.createElement('span')
    this.endTimeEl.className = 'utt-time utt-time-end'
    this.endTimeEl.contentEditable = 'false'
    this.endTimeEl.textContent = formatTime(this._displayTime(node, 'end'))

    this.participantEl = document.createElement('span')
    this.participantEl.className = 'utt-participant'
    this.participantEl.contentEditable = 'false'
    this.participantEl.textContent = node.attrs.participant || '—'
    this.participantEl.title = 'Click to edit participant (Shift+Tab)'

    this._sepEl = document.createElement('span')
    this._sepEl.className = 'utt-participant-sep'
    this._sepEl.contentEditable = 'false'
    this._refreshSepEl(node.attrs.continuationOfId as string | null)
    this.participantEl.appendChild(this._sepEl)

    this.tierEl = document.createElement('span')
    this.tierEl.className = 'utt-tier'
    this.tierEl.contentEditable = 'false'
    this.tierEl.textContent = node.attrs.tier || ''
    this.tierEl.title = 'Click to edit utterance tier name'
    this.tierEl.style.display = isUttTiersVisible() ? '' : 'none'

    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'utt-content'

    this.glossEl = document.createElement('div')
    this.glossEl.className = 'utt-gloss'
    this.glossEl.contentEditable = 'false'
    this.glossEl.style.display = 'none'

    this.dom.appendChild(this.lineNumEl)
    this.dom.appendChild(this.startTimeEl)
    this.dom.appendChild(this.endTimeEl)
    this.dom.appendChild(this.tierEl)
    this.dom.appendChild(this.participantEl)
    this.dom.appendChild(this.contentDOM)
    this.dom.appendChild(this.lineNumRightEl)
    this.dom.appendChild(this.glossEl)

    registerGlossView(node.attrs.id as string, this)
    this.applyGloss(getGlossEntryFor(node.attrs.id as string))
    registerUttTierView(node.attrs.id as string, this)

    this.startTimeEl.addEventListener('click', () => {
      const t = this._displayTime(this.node, 'start')
      if (t !== null) this.onSeek?.(t)
      else this._startTimeEdit('start')
    })

    this.endTimeEl.addEventListener('click', () => {
      const t = this._displayTime(this.node, 'end')
      if (t !== null) this.onSeek?.(t)
      else this._startTimeEdit('end')
    })

    this.participantEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      this.startEdit()
    })

    this.dom.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this._showMoveMenu(e.clientX, e.clientY)
    })

    this.tierEl.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      this._startTierEdit()
    })

    this.glossEl.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      if (this._hasGlossAnnotation) this._startGlossEdit()
    })

    this.glossEl.addEventListener('blur', () => { this._commitGlossEdit(); })

    this.glossEl.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        this._commitGlossEdit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this._cancelGlossEdit()
      }
    })
  }

  private _refreshSepEl(continuationOfId: string | null): void {
    if (continuationOfId) {
      this._sepEl.className = 'utt-participant-sep utt-continuation-mark'
      this._sepEl.textContent = '↪'
    } else {
      this._sepEl.className = 'utt-participant-sep'
      this._sepEl.textContent = ':'
    }
  }

  // Gloss editing

  applyGloss(entry: GlossEntry): void {
    this._glossOnSave = entry.onSave
    if (this._glossEditing) return  // don't disrupt in-progress edit
    this._hasGlossAnnotation = entry.text !== null
    this.glossEl.textContent = entry.text ?? ''
    this._refreshGlossDisplay()
  }

  setGlossVisible(_v: boolean): void {
    this._refreshGlossDisplay()
  }

  setTierVisible(visible: boolean): void {
    this.tierEl.style.display = visible ? '' : 'none'
  }

  private _refreshGlossDisplay(): void {
    this.glossEl.style.display = (isGlossesVisible() && this._hasGlossAnnotation) ? '' : 'none'
  }

  private _startGlossEdit(): void {
    if (this._glossEditing) return
    this._glossEditing = true
    this._glossOriginalText = this.glossEl.textContent
    this.glossEl.contentEditable = 'true'
    this.view.dom.contentEditable = 'false'
    this.glossEl.focus()
  }

  private _commitGlossEdit(): void {
    if (!this._glossEditing) return
    this._glossEditing = false
    this.glossEl.contentEditable = 'false'
    this.view.dom.contentEditable = 'true'
    const newText = this.glossEl.textContent.trim()
    this.glossEl.textContent = newText
    this._glossOnSave?.(newText)
    this.view.focus()
  }

  private _cancelGlossEdit(): void {
    if (!this._glossEditing) return
    this._glossEditing = false
    this.glossEl.contentEditable = 'false'
    this.view.dom.contentEditable = 'true'
    this.glossEl.textContent = this._glossOriginalText
    this.view.focus()
  }

  // Tier editing (per-utterance)

  private _startTierEdit(): void {
    const original = this.node.attrs.tier as string
    startFieldEdit(this.tierEl, this.view,
      (text, returnFocus) => {
        const pos = this.getPos()
        if (pos !== undefined && text !== original) {
          let tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, tier: text })
          if (returnFocus) tr = tr.setSelection(TextSelection.create(tr.doc, pos + 1))
          this.view.dispatch(tr)
        }
      },
      () => { this.tierEl.textContent = original || '' },
    )
  }

  // Participant editing

  startEdit(): void {
    if (this._participantEditing) return
    this._participantEditing = true
    const original = this.node.attrs.participant as string
    this._sepEl.remove()
    startFieldEdit(this.participantEl, this.view,
      (rawText, returnFocus) => {
        this._participantEditing = false
        const newParticipant = rawText === '—' ? '' : rawText
        this.participantEl.textContent = newParticipant || '—'
        this.participantEl.appendChild(this._sepEl)
        const pos = this.getPos()
        if (pos === undefined) return
        if (newParticipant !== original) {
          if (this.participantConflicts(newParticipant, pos)) {
            this.participantEl.textContent = original || '—'
            this.participantEl.appendChild(this._sepEl)
            this.participantEl.classList.add('utt-participant--conflict')
            setTimeout(() => { this.participantEl.classList.remove('utt-participant--conflict') }, 700)
            return
          }
          const currentTier = (this.node.attrs.tier as string | null) ?? ''
          const tierIsAuto = currentTier === '' || currentTier === 'utterance'
          const newTier = tierIsAuto ? 'utterance' : currentTier
          let tr = this.view.state.tr
            .setNodeMarkup(pos, undefined, { ...this.node.attrs, participant: newParticipant, tier: newTier })
            .setMeta('participantChange', { uttId: this.node.attrs.id as string, participant: newParticipant, originalParticipant: original, tier: newTier })
          if (returnFocus) tr = tr.setSelection(TextSelection.create(tr.doc, pos + 1))
          this.view.dispatch(tr)
        } else if (returnFocus) {
          // No change — just place cursor at start of utterance content
          const tr = this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + 1))
          this.view.dispatch(tr)
        }
      },
      () => {
        this._participantEditing = false
        this.participantEl.textContent = original || '—'
        this.participantEl.appendChild(this._sepEl)
      },
    )
    // Select all for easy replacement
    const range = document.createRange()
    range.selectNodeContents(this.participantEl)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  private participantConflicts(newParticipant: string, selfPos: number): boolean {
    if (!newParticipant) return false
    const s1: number | null = this.node.attrs.startTimeSeconds
    if (s1 === null) return false
    const e1: number = this.node.attrs.endTimeSeconds ?? s1 + 1

    let conflict = false
    this.view.state.doc.forEach((node, offset) => {
      if (conflict || offset === selfPos) return
      if (node.type.name !== 'utterance') return
      if (node.attrs.participant !== newParticipant) return
      const s2: number | null = node.attrs.startTimeSeconds
      if (s2 === null) return
      const e2: number = node.attrs.endTimeSeconds ?? s2 + 1
      if (s1 < e2 && e1 > s2) conflict = true
    })
    return conflict
  }

  // Move-to-tier context menu

  private _showMoveMenu(x: number, y: number): void {
    _closeActiveContextMenu()

    const currentParticipant = this.node.attrs.participant as string | null

    // Collect unique participants from the document, preserving document order.
    const seen = new Set<string>()
    const others: string[] = []
    this.view.state.doc.forEach(n => {
      if (n.type.name !== 'utterance') return
      const p = n.attrs.participant as string | null
      if (p && p !== currentParticipant && !seen.has(p)) {
        seen.add(p)
        others.push(p)
      }
    })

    const menu = document.createElement('div')
    menu.className = 'utt-ctx-menu'
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999`

    const header = document.createElement('div')
    header.className = 'utt-ctx-header'
    header.textContent = 'Move to tier'
    menu.appendChild(header)

    if (others.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'utt-ctx-empty'
      empty.textContent = 'No other tiers'
      menu.appendChild(empty)
    } else {
      for (const p of others) {
        const btn = document.createElement('button')
        btn.className = 'utt-ctx-item'
        btn.textContent = p
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault()
          _closeActiveContextMenu()
          this._moveToParticipant(p)
        })
        menu.appendChild(btn)
      }
    }

    const sep = document.createElement('div')
    sep.className = 'utt-ctx-sep'
    menu.appendChild(sep)

    const newBtn = document.createElement('button')
    newBtn.className = 'utt-ctx-item utt-ctx-new'
    newBtn.textContent = 'New tier…'
    newBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      _closeActiveContextMenu()
      this.startEdit()
    })
    menu.appendChild(newBtn)

    document.body.appendChild(menu)
    _activeContextMenu = menu

    // Clamp to viewport after render
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect()
      if (rect.right > window.innerWidth)  menu.style.left = `${x - rect.width}px`
      if (rect.bottom > window.innerHeight) menu.style.top  = `${y - rect.height}px`
    })

    const onMousedown = (e: MouseEvent) => {
      if (!menu.contains(e.target as Element)) {
        _closeActiveContextMenu()
        document.removeEventListener('mousedown', onMousedown, true)
      }
    }
    document.addEventListener('mousedown', onMousedown, true)
  }

  private _moveToParticipant(newParticipant: string): void {
    const pos = this.getPos()
    if (pos === undefined) return
    const original = this.node.attrs.participant as string

    if (this.participantConflicts(newParticipant, pos)) {
      this.participantEl.classList.add('utt-participant--conflict')
      setTimeout(() => { this.participantEl.classList.remove('utt-participant--conflict') }, 700)
      return
    }

    const currentTier = (this.node.attrs.tier as string | null) ?? ''
    const tierIsAuto = currentTier === '' || currentTier === 'utterance'
    const newTier = tierIsAuto ? 'utterance' : currentTier

    const tr = this.view.state.tr
      .setNodeMarkup(pos, undefined, { ...this.node.attrs, participant: newParticipant, tier: newTier })
      .setMeta('participantChange', { uttId: this.node.attrs.id as string, participant: newParticipant, originalParticipant: original, tier: newTier })
    this.view.dispatch(tr)
  }

  // PM NodeView interface

  stopEvent(event: Event): boolean {
    return (
      event.target === this.participantEl ||
      event.target === this._sepEl ||
      event.target === this.tierEl ||
      event.target === this.startTimeEl ||
      event.target === this.endTimeEl ||
      event.target === this.glossEl
    )
  }

  ignoreMutation(): boolean {
    return (
      this._participantEditing ||
      this.tierEl.contentEditable === 'true' ||
      this._editingWhichTime !== null ||
      this._glossEditing
    )
  }

  refresh(decimals: number): void {
    this._decimals = decimals
    if (this._editingWhichTime !== 'start')
      this.startTimeEl.textContent = formatTime(this.node.attrs.startTimeSeconds, decimals)
    if (this._editingWhichTime !== 'end')
      this.endTimeEl.textContent   = formatTime(this.node.attrs.endTimeSeconds,   decimals)
  }

  destroy(): void {
    unregisterTimeView(this)
    unregisterGlossView(this.node.attrs.id as string, this)
    unregisterUttTierView(this.node.attrs.id as string, this)
    if (_activeContextMenu) _closeActiveContextMenu()
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false
    const prevId = this.node.attrs.id as string
    this.node = node
    const newId = node.attrs.id as string
    if (newId !== prevId) {
      unregisterGlossView(prevId, this)
      registerGlossView(newId, this)
      unregisterUttTierView(prevId, this)
      registerUttTierView(newId, this)
    }
    if (this.participantEl.contentEditable !== 'true') {
      this.participantEl.textContent = node.attrs.participant || '—'
      this.participantEl.appendChild(this._sepEl)
    }
    this._refreshSepEl(node.attrs.continuationOfId as string | null)
    if (this.tierEl.contentEditable !== 'true') {
      this.tierEl.textContent = node.attrs.tier || ''
    }
    if (this._editingWhichTime !== 'start')
      this.startTimeEl.textContent = formatTime(this._displayTime(node, 'start'), this._decimals)
    if (this._editingWhichTime !== 'end')
      this.endTimeEl.textContent   = formatTime(this._displayTime(node, 'end'),   this._decimals)
    this.dom.setAttribute('data-id', node.attrs.id)
    if (node.attrs.continuationOfId) {
      this.dom.setAttribute('data-continuation', 'true')
    } else {
      this.dom.removeAttribute('data-continuation')
    }
    return true
  }

  private _displayTime(node: Node, which: 'start' | 'end'): number | null {
    const headId = node.attrs.continuationOfId as string | null
    if (!headId) return which === 'start' ? (node.attrs.startTimeSeconds as number | null) : (node.attrs.endTimeSeconds as number | null)
    let result: number | null = null
    this.view.state.doc.forEach(block => {
      if (block.attrs.id === headId)
        result = which === 'start' ? block.attrs.startTimeSeconds : block.attrs.endTimeSeconds
    })
    return result
  }

  private _startTimeEdit(which: 'start' | 'end'): void {
    startTimeEdit(this, which)
  }
}
