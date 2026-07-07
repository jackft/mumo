<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { EditorState, TextSelection } from 'prosemirror-state'
  import type { Selection, Transaction } from 'prosemirror-state'
  import { EditorView } from 'prosemirror-view'
  import {
    ySyncPlugin,
    ySyncPluginKey,
    yCursorPlugin,
    yUndoPlugin,
    undo as yUndo,
    redo as yRedo,
  } from 'y-prosemirror'
  import type { XmlFragment as YXmlFragment, UndoManager } from 'yjs'
  import { replaceYXmlFragment } from './yInit.js'
  import {
    schema,
    createControllerPlugin,
    createUttSyncPlugin,
    TokenStore,
    TimeKeeper,
    newId,
  } from '@mumo/core'
  import type { AnnotationStore, ImageProvenance } from '@mumo/core'
  import { Fragment, Slice } from 'prosemirror-model'
  import type { Node, Mark } from 'prosemirror-model'
  import { buildKeymapPlugin } from './commands/keymaps.js'
  import { runInsertComment } from './commands/toolbar-commands.js'
  import { buildTokenHoverPlugin } from './plugins/token-hover.js'
  import { buildTokenKindDecoratorPlugin } from './plugins/token-kind-decorator.js'
  import { buildTokenSlotHighlightPlugin, setTokenSlotHighlight, setHoverTokenRanges as _setHoverTokenRanges } from './plugins/token-slot-highlight.js'
  import type { TokenRef } from './plugins/token-slot-highlight.js'
  import { buildSlotStylePlugin, setStyledSlotTokens as _setStyledSlotTokens } from './plugins/slot-style-decorator.js'
  import type { StyledTokenRef } from './plugins/slot-style-decorator.js'
  import { refreshAllTimeViews, getCurrentDecimals } from './format.js'
  import { buildOverlapPlugin, buildOverlapAlignmentPlugin } from './plugins/overlap.js'
  import { buildSelectionSpacerPlugin, setSelectionMarkSpacers as _setSelectionMarkSpacers } from './plugins/selection-spacer.js'
  import { UtteranceNodeView } from './nodeviews/UtteranceNodeView.js'
  import { ImageNodeView } from './nodeviews/ImageNodeView.js'
  import { VisualizationNodeView } from './nodeviews/VisualizationNodeView.js'
  import { buildImageInputRulePlugin } from './plugins/image-command.js'
  import { buildSpectInputRulePlugin } from './commands/viz-commands.js'
  import { buildSymbolInputRulePlugin } from './plugins/symbol-input.js'
  import type { SymbolDef } from '@mumo/core'
  import type { VizContextMenuCallback } from './nodeviews/VisualizationNodeView.js'
  import { buildVizSyncPlugin } from './plugins/viz-sync-plugin.js'
  import { gapCursor } from 'prosemirror-gapcursor'
  import type { TokenRecord } from '@mumo/core'
  import { buildPlayingPlugin, updatePlaying, buildLoopPlugin, updateLoopIds } from './plugins/playback-plugins.js'
  import type { FormattingState } from './format.js'

  interface Props {
    yXmlFragment: YXmlFragment
    undoManager: UndoManager
    store: AnnotationStore
    tokenStore?: TokenStore
    timeKeeper?: TimeKeeper
    onDocChange?: (doc: Node, state: EditorState) => void
    onSeek?: (t: number) => void
    showTimes?: boolean
    showStart?: boolean
    showEnd?: boolean
    onEscapeKey?: () => void
    getTokenTime?: (id: string) => { start: number; end: number } | undefined
    editable?: boolean
    tokenClickMode?: boolean
    ontokenclick?: (token: TokenRecord) => void
    ontokenhover?: (token: TokenRecord | null, x: number, y: number) => void
    awareness?: unknown
    onOverlapChange?: () => void
    invalidGapIds?: () => ReadonlySet<string>
    imageRegistry?: Map<string, string>
    onImageActivate?: (id: string, x: number, y: number) => void
    onImageLoad?: () => void
    onVizContextMenu?: VizContextMenuCallback
    onUpdate?: (fmt: FormattingState) => void
    getSymbolDefs?: () => SymbolDef[]
    transcriptFont?: string
    onActiveUtteranceChange?: (id: string | null) => void
    onUndoRedo?: () => void
    suggestMode?: boolean
    onSuggestEdit?: (id: string, uttId: string, fromOffset: number, toOffset: number, replacement: string) => void
    onSuggestRemove?: (id: string) => void
    onSuggestParticipant?: (uttId: string, participant: string) => void
    showGuides?: boolean
    showLeftGuide?: boolean
    showSepGuide?: boolean
    showRightGuide?: boolean
  }

  const {
    yXmlFragment,
    undoManager,
    store,
    tokenStore = new TokenStore(),
    timeKeeper,
    onDocChange,
    onSeek,
    showTimes = true,
    showStart = true,
    showEnd = false,
    onEscapeKey,
    getTokenTime,
    editable = true,
    tokenClickMode = false,
    ontokenclick,
    ontokenhover,
    awareness,
    onOverlapChange,
    invalidGapIds,
    imageRegistry = new Map<string, string>(),
    onImageActivate,
    onImageLoad,
    onVizContextMenu,
    onUpdate,
    getSymbolDefs,
    transcriptFont = '',
    onActiveUtteranceChange,
    onUndoRedo,
    suggestMode = false,
    onSuggestEdit,
    onSuggestRemove,
    onSuggestParticipant,
    showGuides = true,
    showLeftGuide = true,
    showSepGuide = true,
    showRightGuide = true,
  }: Props = $props()

  let container: HTMLDivElement
  let view: EditorView
  let _lastActiveUtteranceId: string | null = null
  let _unsubscribeTimeKeeper: (() => void) | undefined
  let _resetting = false

  // Active accumulator for suggest mode.
  // fromOffset/toOffset: utterance-relative, fixed for the life of this suggestion.
  // insertEnd: absolute PM position where the next typed char should go (grows as user types).
  let _suggestAccum: {
    id: string; uttId: string; uttPos: number
    fromOffset: number; toOffset: number
    insertEnd: number; replacement: string
  } | null = null

  // Apply a suggest-mode transaction to the view and sync with Yjs in one atomic step.
  function _applySuggestCommit(v: EditorView, next: EditorState): void {
    const ydoc = yXmlFragment.doc
    if (ydoc) ydoc.transact(() => { v.updateState(next); onDocChange?.(next.doc, next) }, ySyncPluginKey)
    else { v.updateState(next); onDocChange?.(next.doc, next) }
    _updateColumnWidths(next.doc)
  }

  // True if [from, to] in doc contains a text node carrying our suggestion_insert mark.
  function _rangeHasInsertMark(doc: Node, from: number, to: number, sugId: string): boolean {
    const insM = schema.marks['suggestion_insert']!
    let found = false
    doc.nodesBetween(from, to, node => {
      if (!found && node.isText && node.marks.some(m => m.type === insM && m.attrs.suggestionId === sugId))
        found = true
      return !found
    })
    return found
  }

  // Fire onSuggestEdit or onSuggestRemove based on current accum state (call after mutating accum).
  function _notifyAccumChanged(uttId: string): void {
    const accum = _suggestAccum
    if (!accum) return
    if (accum.replacement === '' && accum.fromOffset === accum.toOffset) {
      const remId = accum.id; _suggestAccum = null; queueMicrotask(() => onSuggestRemove?.(remId))
    } else {
      const { id, fromOffset, toOffset, replacement } = accum
      queueMicrotask(() => onSuggestEdit!(id, uttId, fromOffset, toOffset, replacement))
    }
  }

  // Core suggest-mode transaction handler. Returns true if the tr was consumed.
  // Called from dispatchTransaction for any doc-changing transaction that enters suggest mode.
  function _handleSuggestTr(view: EditorView, tr: Transaction): boolean {
    type Step0 = { from?: number; to?: number; slice?: Slice; structure?: boolean }
    const step0 = tr.steps[0] as Step0 | undefined
    if (tr.steps.length !== 1 || !step0 || typeof step0.from !== 'number' || typeof step0.to !== 'number'
        || step0.slice == null || step0.structure === true) {
      _suggestAccum = null
      return false
    }

    const from = step0.from
    const to   = step0.to
    const doc  = view.state.doc
    const fromRes = doc.resolve(from)
    const toRes   = doc.resolve(Math.min(to, doc.content.size))
    if (fromRes.node(1)?.type.name !== 'utterance' || fromRes.before(1) !== toRes.before(1)) {
      _suggestAccum = null
      return false
    }

    const uttPos = fromRes.before(1)
    const uttId  = fromRes.node(1).attrs.id as string
    let incoming = ''
    step0.slice.content.forEach((n: Node) => { if (n.isText) incoming += n.text ?? '' })
    incoming = incoming.replace(/\u00a0/g, ' ')

    const insMarkType = schema.marks['suggestion_insert']!
    const delMarkType = schema.marks['suggestion_delete']!
    const accum = _suggestAccum

    // Delete key on our own suggestion_insert text → remove it directly
    if (incoming === '' && from < to && accum && _rangeHasInsertMark(doc, from, to, accum.id)) {
      accum.insertEnd  -= (to - from)
      accum.replacement = accum.replacement.slice(0, -(to - from))
      _applySuggestCommit(view, view.state.apply(view.state.tr.delete(from, to).setMeta('isSuggestModeEdit', true).setMeta('allowWhenReadonly', true)))
      _notifyAccumChanged(uttId)
      return true
    }

    // Normalize Chrome span-boundary quirk: when cursor sits at the end of a suggestion_insert
    // span, Chrome re-emits our last inserted char(s) as a replace step instead of a pure insert.
    // Strip the already-handled prefix so this always looks like a continuation.
    let normFrom = from, normTo = to, normIncoming = incoming
    if (accum && from < to && to === accum.insertEnd && from >= accum.insertEnd - accum.replacement.length) {
      const prefix = doc.textBetween(from, to)
      normFrom = accum.insertEnd; normTo = accum.insertEnd
      normIncoming = prefix === incoming.slice(0, prefix.length) ? incoming.slice(prefix.length) : incoming
    }

    // Noop: browser re-asserted our text with no new chars — just reposition the cursor
    if (accum && normFrom === accum.insertEnd && normTo === accum.insertEnd && normIncoming === '') {
      const target = Math.min(accum.insertEnd, view.state.doc.content.size)
      const noopNext = view.state.apply(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)).setMeta('isSuggestModeEdit', true).setMeta('allowWhenReadonly', true))
      view.updateState(noopNext)
      onUpdate?.(_computeFormattingState(noopNext))
      return true
    }

    // Continuing an existing suggestion vs. starting a new one.
    // (normIncoming is guaranteed non-empty here since noop returned above.)
    const isContinuation = !!accum && normFrom === accum.insertEnd && normTo === accum.insertEnd
    if (!isContinuation) _suggestAccum = null
    const sugId      = isContinuation ? accum!.id         : newId()
    const fromOffset = isContinuation ? accum!.fromOffset : normFrom - (uttPos + 1)
    const toOffset   = isContinuation ? accum!.toOffset   : normTo   - (uttPos + 1)
    const insertPos  = isContinuation ? accum!.insertEnd  : normTo

    const transformedTr = view.state.tr.setMeta('isSuggestModeEdit', true).setMeta('allowWhenReadonly', true)
    if (normFrom < normTo)
      transformedTr.addMark(normFrom, normTo, delMarkType.create({ suggestionId: sugId, authorId: 'user:local' }))
    if (normIncoming.length > 0) {
      const contentMarks = doc.resolve(Math.min(insertPos, doc.content.size - 1)).marks().filter(m => m.type !== insMarkType && m.type !== delMarkType)
      transformedTr.insert(insertPos, schema.text(normIncoming, [...contentMarks, insMarkType.create({ suggestionId: sugId, authorId: 'user:local' })]))
    } else if (normFrom < normTo) {
      transformedTr.setSelection(TextSelection.create(transformedTr.doc, normFrom))
    }

    const newReplacement = isContinuation ? accum!.replacement + normIncoming : normIncoming
    _suggestAccum = { id: sugId, uttId, uttPos, fromOffset, toOffset, insertEnd: normIncoming.length > 0 ? insertPos + normIncoming.length : normFrom, replacement: newReplacement }
    _applySuggestCommit(view, view.state.apply(transformedTr))
    queueMicrotask(() => onSuggestEdit!(sugId, uttId, fromOffset, toOffset, newReplacement))
    return true
  }

  function _computeFormattingState(s: EditorState): FormattingState {
    const sel = s.selection
    const marks = s.storedMarks || sel.$from.marks()
    const hasMark = (name: string) => sel.empty
      ? !!schema.marks[name]!.isInSet(marks)
      : s.doc.rangeHasMark(sel.from, sel.to, schema.marks[name]!)
    const fontMark = schema.marks['font']!.isInSet(marks)
    return {
      bold:       hasMark('bold'),
      italic:     hasMark('italic'),
      strike:     hasMark('strike'),
      underline:  hasMark('underline'),
      fontFamily: fontMark ? (fontMark.attrs['family'] as string) : '',
    }
  }

  function _applyPlayingClasses(added: string[], removed: string[]) {
    if (!view) return
    updatePlaying(view, added, removed)
  }

  export function setLoopIds(ids: string[]): void {
    if (!view) return
    updateLoopIds(view, ids)
  }

  function _measureW(text: string, css: string, parent: HTMLElement): number {
    const el = document.createElement('span')
    el.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;${css}`
    el.textContent = text
    parent.appendChild(el)
    const w = el.getBoundingClientRect().width
    parent.removeChild(el)
    return w
  }

  function _updateColumnWidths(doc: Node, decimals = getCurrentDecimals()) {
    const el = container?.parentElement as HTMLElement | null
    if (!el) return
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)

    let lineCount = 0
    let longestParticipant = 'XX'
    doc.forEach(n => {
      if (n.type.name !== 'utterance') return
      lineCount++
      const p = (n.attrs.participant as string) || ''
      if (p.length > longestParticipant.length) longestParticipant = p
    })

    // Line number width
    const digits = String(Math.max(lineCount, 1)).length
    const lnW = digits <= 2 ? '2rem' : digits === 3 ? '2.5rem' : digits === 4 ? '3rem' : '3.5rem'
    el.style.setProperty('--ln-w', lnW)

    // Time width — measure a sample formatted time at the element's actual font
    const timeSample = `00:00:00${decimals > 0 ? '.' + '0'.repeat(decimals) : ''}`
    const timePx = _measureW(timeSample, 'font-size:0.72em;font-variant-numeric:tabular-nums', el)
    el.style.setProperty('--time-w', ((timePx / rem) + 0.6).toFixed(2) + 'rem')

    // Participant width — measure the longest participant name at the element's actual font
    const participantPx = _measureW(longestParticipant + ':', 'font-size:0.85em;font-weight:600', el)
    const participantRem = Math.min(Math.max(participantPx / rem + 0.6, 2), 12)
    el.style.setProperty('--participant-w', participantRem.toFixed(2) + 'rem')
  }

  function _activeUtteranceId(sel: Selection): string | null {
    const anchor = sel.$anchor
    if (anchor.depth < 1) return null
    const node = anchor.node(1)
    if (node?.type.name === 'utterance') {
      return (node.attrs.id as string) ?? null
    }
    return null
  }

  onMount(() => {
    const state = EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(yXmlFragment),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(awareness ? [yCursorPlugin(awareness as any, {
          selectionBuilder: (user: { color: string }) => ({
            style: `background-color: ${user.color}cc`,
            class: 'ProseMirror-yjs-selection',
          }),
        })] : []),
        yUndoPlugin({ undoManager }),
        createControllerPlugin(tokenStore, ySyncPluginKey),
        createUttSyncPlugin(store, ySyncPluginKey),
        ...buildKeymapPlugin(tokenStore, getTokenTime, onEscapeKey),
        buildTokenHoverPlugin(tokenStore, () => tokenClickMode, tok => ontokenclick?.(tok), (tok, x, y) => ontokenhover?.(tok, x, y)),
        buildTokenKindDecoratorPlugin(tokenStore, { gap: 'tok-gap' }, invalidGapIds),
        buildTokenSlotHighlightPlugin(),
        buildSlotStylePlugin(),
        buildPlayingPlugin(),
        buildLoopPlugin(),
        buildOverlapPlugin(),
        buildOverlapAlignmentPlugin(onOverlapChange),
        buildSelectionSpacerPlugin(),
        buildImageInputRulePlugin(),
        buildSpectInputRulePlugin(),
        buildSymbolInputRulePlugin(getSymbolDefs),
        buildVizSyncPlugin(),
        gapCursor(),
      ],
    })

    view = new EditorView(container, {
      state,
      transformPasted(slice) {
        // Reassign IDs and clear time anchors on pasted utterance nodes so that
        // a paste never overwrites the destination utterance's identity or timing.
        function sanitizeFragment(frag: Fragment): Fragment {
          const nodes: Node[] = []
          frag.forEach(node => {
            if (node.type.name === 'utterance') {
              nodes.push(node.type.create(
                { ...node.attrs, id: newId(), startTimeSeconds: null, endTimeSeconds: null, participant: null, tier: null },
                sanitizeFragment(node.content),
                node.marks,
              ))
            } else {
              nodes.push(node)
            }
          })
          return Fragment.fromArray(nodes)
        }
        return new Slice(sanitizeFragment(slice.content), slice.openStart, slice.openEnd)
      },
      handlePaste(view, _event, slice) {
        // When the cursor is inside an utterance and the clipboard holds complete
        // utterance blocks (openStart=0), pasting would replace the destination
        // utterance node and wipe its participant/timing attrs.  Re-open the slice
        // at depth 1 so PM merges the pasted content *into* the destination
        // utterance instead of inserting a new block.
        const from = view.state.selection.$from
        if (from.depth < 1 || from.node(1)?.type.name !== 'utterance') return false
        if (slice.openStart !== 0) return false
        let allUtt = slice.content.childCount > 0
        slice.content.forEach(n => { if (n.type.name !== 'utterance') allUtt = false })
        if (!allUtt) return false
        view.dispatch(view.state.tr.replaceSelection(new Slice(slice.content, 1, slice.openEnd)))
        return true
      },
      nodeViews: {
        utterance: (node, editorView, getPos) =>
          new UtteranceNodeView(node, editorView, getPos, onSeek),
        visualization: (node, editorView, getPos) =>
          new VisualizationNodeView(node, editorView, getPos, onSeek, onVizContextMenu),
        image: (node, editorView, getPos) =>
          new ImageNodeView(node, editorView, getPos, () => imageRegistry, onImageActivate, onImageLoad),
      },
      handleKeyDown(_view, event) {
        // Handle Backspace in suggest mode directly at keydown time so Chrome's
        // beforeinput never fires. Chrome fires weird multi-char replaceWith steps
        // for backspace at span boundaries (e.g. replaceWith(" t","  ")) which our
        // normalization logic misreads as insertions.
        if (event.key !== 'Backspace' || !suggestMode || !onSuggestEdit) return false
        const { state } = _view
        if (!state.selection.empty) return false
        const pos  = state.selection.$head.pos
        const rpos = state.doc.resolve(pos)
        if (rpos.depth < 1 || rpos.node(1)?.type.name !== 'utterance') return false
        const uttNode = rpos.node(1)
        const uttPos  = rpos.before(1)
        const uttId   = uttNode.attrs.id as string
        const from = pos - 1
        const to   = pos
        if (from < uttPos + 1) return false  // at start of utterance; let joinBackward fire

        const accum = _suggestAccum

        // Case 1: char before cursor is our own suggestion_insert — delete it directly
        if (accum && _rangeHasInsertMark(state.doc, from, to, accum.id)) {
          accum.insertEnd -= 1
          accum.replacement = accum.replacement.slice(0, -1)
          const next = state.apply(state.tr.delete(from, to).setMeta('isSuggestModeEdit', true).setMeta('allowWhenReadonly', true))
          _applySuggestCommit(_view, next)
          _notifyAccumChanged(uttId)
          return true
        }

        // Case 2: backspace into existing text → mark it deleted, move cursor left
        const sugId      = newId()
        const fromOffset = from - (uttPos + 1)
        const toOffset   = to   - (uttPos + 1)
        const delM = schema.marks['suggestion_delete']!
        const next = state.apply(
          state.tr
            .setMeta('isSuggestModeEdit', true).setMeta('allowWhenReadonly', true)
            .addMark(from, to, delM.create({ suggestionId: sugId, authorId: 'user:local' }))
            .setSelection(TextSelection.create(state.doc, from))
        )
        _suggestAccum = { id: sugId, uttId, uttPos, fromOffset, toOffset, insertEnd: from, replacement: '' }
        _applySuggestCommit(_view, next)
        queueMicrotask(() => onSuggestEdit!(sugId, uttId, fromOffset, toOffset, ''))
        return true
      },
      dispatchTransaction(this: EditorView, tr) {
        const yjsMeta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean; isUndoRedoOperation?: boolean } | undefined
        const isYjsSync = yjsMeta?.isChangeOrigin
        if (!editable && tr.docChanged && !tr.getMeta('allowWhenReadonly') && !isYjsSync) return
        if (yjsMeta?.isUndoRedoOperation) {
          _suggestAccum = null
          queueMicrotask(() => onUndoRedo?.())
        }
        // Suggest mode: transform text edits into mark-based suggestions.
        if (suggestMode && onSuggestEdit && tr.docChanged && !tr.getMeta('allowWhenReadonly') && !isYjsSync && !tr.getMeta('isSuggestModeEdit')) {
          if (_handleSuggestTr(this, tr)) return
        }
        // Participant changes in suggest mode → create utt:set-participant suggestion
        // instead of applying the setNodeMarkup directly.
        if (suggestMode && !isYjsSync && !tr.getMeta('allowWhenReadonly')) {
          const pm = tr.getMeta('participantChange') as { uttId: string; participant: string } | undefined
          if (pm) {
            onSuggestParticipant?.(pm.uttId, pm.participant)
            return
          }
        }
        // Yjs fires an isChangeOrigin replace(0, contentSize) after every local edit.
        // In suggest mode we already synced content via ydocInner.transact(), so the
        // replace is a no-op content-wise. Applying it would run PM history position
        // maps through a degenerate replace(0,N,...) mapping, breaking time-based
        // keystroke grouping (each char becomes its own undo step). Instead: skip the
        // Yjs tr and only apply a selection-only transaction that restores the cursor.
        // Identity position maps on the selection tr leave history grouping intact.
        //
        // NOTE: Do NOT set addToHistory:false here. The ySyncPlugin's view update checks
        // pluginState.addToHistory === false and calls undoManager.stopCapturing() when it
        // sees that, which closes the undo stack item after every keystroke and makes each
        // character a separate undo step. Without addToHistory:false the cursor-only tr is
        // simply invisible to the Yjs UndoManager (no doc change → no Yjs transaction).
        //
        // Undo/redo operations must bypass this block — they carry real doc changes that
        // must be applied; intercepting them here would swallow the undo and only move
        // the cursor. _suggestAccum is already cleared above for isUndoRedoOperation.
        if (isYjsSync && _suggestAccum && !yjsMeta?.isUndoRedoOperation) {
          const target = Math.min(_suggestAccum.insertEnd, this.state.doc.content.size)
          const next = this.state.apply(
            this.state.tr
              .setSelection(TextSelection.create(this.state.doc, target)),
          )
          this.updateState(next)
          onUpdate?.(_computeFormattingState(next))
          return
        }
        // Apply the PM transaction inside the Yjs transaction so that
        // appendTransaction side effects (e.g. store.addAnnotation in
        // createUttSyncPlugin) are bundled into the same Yjs transaction as
        // the yXmlFragment write, giving a single atomic undo entry.
        let next!: EditorState
        if (tr.docChanged && !_resetting) {
          const ydoc = yXmlFragment.doc
          if (ydoc && !isYjsSync) {
            // Local change: bundle PM apply with Yjs write atomically so that
            // appendTransaction side effects land in the same Yjs transaction.
            let _next!: EditorState
            ydoc.transact(() => {
              _next = this.state.apply(tr)
              this.updateState(_next)
              onDocChange?.(_next.doc, _next)
            }, ySyncPluginKey)
            next = _next
          } else {
            // Remote (isChangeOrigin) or no ydoc: apply directly — wrapping a
            // remote _typeChanged dispatch in another ydoc.transact() creates
            // empty nested Yjs transactions and interferes with cursor restore.
            next = this.state.apply(tr)
            this.updateState(next)
            onDocChange?.(next.doc, next)
          }
          _updateColumnWidths(next.doc)
        } else {
          next = this.state.apply(tr)
          this.updateState(next)
        }
        onUpdate?.(_computeFormattingState(next))
        if (onActiveUtteranceChange) {
          const newId = _activeUtteranceId(next.selection)
          if (newId !== _lastActiveUtteranceId) {
            _lastActiveUtteranceId = newId
            onActiveUtteranceChange(newId)
          }
        }
      },
    })

    _updateColumnWidths(view.state.doc)

    if (timeKeeper) {
      _unsubscribeTimeKeeper = timeKeeper.onActiveChange((added, removed) => {
        _applyPlayingClasses(added, removed)
      })
    }
  })

  onDestroy(() => {
    _unsubscribeTimeKeeper?.()
    view?.destroy()
  })

  // Clear the accumulator whenever suggest mode is turned off so state doesn't leak.
  $effect(() => { if (!suggestMode) _suggestAccum = null })

  export function getView(): EditorView | undefined {
    return view
  }

  export function liveDoc(): Node | undefined {
    return view?.state.doc
  }

  export function focus(): void {
    view?.focus()
  }

  export function getSelectionRange(): { from: number; to: number } | null {
    if (!view) return null
    const { from, to } = view.state.selection
    if (from === to) return null
    return { from, to }
  }

  export function getBlockIds(): ReadonlySet<string> {
    const ids = new SvelteSet<string>()
    view?.state.doc.forEach(node => { if (node.attrs.id) ids.add(node.attrs.id as string) })
    return ids
  }

  /** Returns the start/end times of the utterance containing the cursor, or null. */
  export function getUttAtCursor(): { start: number; end: number } | null {
    if (!view) return null
    const { from } = view.state.selection
    const rPos = view.state.doc.resolve(from)
    for (let d = rPos.depth; d >= 0; d--) {
      const node = rPos.node(d)
      if (node.type.name === 'utterance') {
        const s: number | null = node.attrs.startTimeSeconds
        const e: number | null = node.attrs.endTimeSeconds
        if (s !== null && e !== null) return { start: s, end: e }
        return null
      }
    }
    return null
  }

  export function getAdjacentUtt(dir: 'next' | 'prev'): { start: number; end: number } | null {
    if (!view) return null
    const blocks: { start: number; end: number; pos: number }[] = []
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === 'utterance') {
        const s: number | null = node.attrs.startTimeSeconds
        const e: number | null = node.attrs.endTimeSeconds
        if (s !== null && e !== null) blocks.push({ start: s, end: e, pos: offset })
      }
    })
    if (blocks.length === 0) return null
    const { from } = view.state.selection
    const rPos = view.state.doc.resolve(from)
    let curPos = -1
    for (let d = rPos.depth; d >= 0; d--) {
      if (rPos.node(d).type.name === 'utterance') {
        curPos = rPos.start(d) - 1
        break
      }
    }
    const idx = curPos >= 0 ? blocks.findIndex(b => b.pos === curPos) : -1
    if (dir === 'next') {
      const next = idx >= 0 ? blocks[idx + 1] : blocks[0]
      return next ? { start: next.start, end: next.end } : null
    } else {
      const prev = idx > 0 ? blocks[idx - 1] : null
      return prev ? { start: prev.start, end: prev.end } : null
    }
  }

  export function blockTypeAtCoords(x: number, y: number): { pos: number; type: 'utterance' } | null {
    if (!view) return null
    const res = view.posAtCoords({ left: x, top: y })
    if (!res) return null
    const safePos = Math.max(0, Math.min(res.pos, view.state.doc.content.size))
    const rPos = view.state.doc.resolve(safePos)
    for (let d = rPos.depth; d >= 0; d--) {
      if (rPos.node(d).type.name === 'utterance') {
        return { pos: rPos.before(d), type: 'utterance' }
      }
    }
    return null
  }

  export function focusBlock(blockId: string): boolean {
    if (!view) return false
    let found = false
    view.state.doc.forEach((node, offset) => {
      if (found) return
      if (node.attrs.id === blockId) {
        found = true
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(offset + 1))))
        view.focus()
      }
    })
    return found
  }

  /** Insert a new utterance at the time position t, set cursor inside it, and focus. */
  export function insertBlockAtTime(
    type: 'utterance',
    attrs: Record<string, unknown>,
    t: number,
  ): void {
    if (!view) return
    let insertAt = 0
    view.state.doc.forEach((node, offset) => {
      if ((node.attrs.startTimeSeconds ?? 0) <= t) insertAt = offset + node.nodeSize
    })
    const newNode = schema.nodes[type]!.create({ id: newId(), ...attrs })
    const tr = view.state.tr.insert(insertAt, newNode)
    tr.setMeta('allowWhenReadonly', true)
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, insertAt + 1)))
    view.focus()
  }

  /** Insert a new utterance after the block containing the current cursor, and focus. */
  export function insertBlockAfterCursor(
    type: 'utterance',
    attrs: Record<string, unknown>,
  ): void {
    if (!view) return
    const insertAt = view.state.selection.$from.after(1)
    const newNode = schema.nodes[type]!.create({ id: newId(), ...attrs })
    const tr = view.state.tr.insert(insertAt, newNode)
    tr.setSelection(TextSelection.create(tr.doc, insertAt + 1))
    view.dispatch(tr)
    view.focus()
  }

  export function renameParticipant(oldLabel: string, newLabel: string): void {
    if (!view) return
    const tr = view.state.tr
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === 'utterance' && (node.attrs.participant ?? '') === oldLabel)
        tr.setNodeMarkup(offset, undefined, { ...node.attrs, participant: newLabel })
    })
    view.dispatch(tr)
  }


  /** Re-tier the utterances of one lane, matched by (participant, base tier attr).
   *  Bases are the bare tier attr with '' meaning the default utterance:<participant> lane
   *  (the reserved 'utterance' attr set on new utterances is normalized to '').
   *  Optionally moves the matched utterances to a new participant. */
  export function updateUttTier(oldParticipant: string, oldBase: string, newBase: string, newParticipant?: string): void {
    if (!view) return
    const tr = view.state.tr
    view.state.doc.forEach((node, offset) => {
      if (node.type.name !== 'utterance') return
      if (((node.attrs.participant as string | undefined) ?? '') !== oldParticipant) return
      const nodeTier = (node.attrs.tier as string | undefined) ?? ''
      const base = nodeTier === 'utterance' ? '' : nodeTier
      if (base !== oldBase) return
      tr.setNodeMarkup(offset, undefined, {
        ...node.attrs,
        tier: newBase,
        ...(newParticipant !== undefined ? { participant: newParticipant } : {}),
      })
    })
    if (tr.docChanged) view.dispatch(tr)
  }

  export function addAnnotationMarkForWordIds(fromWordId: string, toWordId: string): string | null {
    if (!view) return null
    const fromTok = tokenStore.getToken(fromWordId)
    const toTok   = tokenStore.getToken(toWordId)
    if (!fromTok || !toTok || fromTok.uttId !== toTok.uttId) return null
    let uttPos: number | null = null
    view.state.doc.forEach((node, pos) => {
      if (node.attrs.id === fromTok.uttId) uttPos = pos
    })
    if (uttPos === null) return null
    const from = uttPos + 1 + fromTok.startOffset
    const to   = uttPos + 1 + toTok.endOffset
    const markId = newId()
    addAnnotationMarkToRange(markId, from, to)
    return markId
  }

  export function addAnnotationMarkToRange(markId: string, from: number, to: number, allowWhenReadonly = false): void {
    if (!view) return
    const tr = view.state.tr.addMark(from, to, schema.marks['annotation']!.create({ id: markId }))
    if (allowWhenReadonly) tr.setMeta('allowWhenReadonly', true)
    view.dispatch(tr)
  }

  export function removeAnnotationMark(markId: string): void {
    if (!view) return
    const markType = schema.marks['annotation']!
    const { doc, tr } = view.state
    doc.descendants((node, pos) => {
      if (!node.isText) return true
      const m = node.marks.find((mk: Mark) => mk.type === markType && mk.attrs.id === markId)
      if (m) tr.removeMark(pos, pos + node.nodeSize, markType)
      return true
    })
    view.dispatch(tr.setMeta('allowWhenReadonly', true))
  }

  // pm:replace suggestion mark helpers

  function _suggestionMarkRanges(markTypeName: 'suggestion_insert' | 'suggestion_delete', suggestionId: string): { from: number; to: number }[] {
    if (!view) return []
    const markType = schema.marks[markTypeName]!
    const raw: { from: number; to: number }[] = []
    view.state.doc.descendants((node, pos) => {
      if (!node.isText) return true
      if (node.marks.some(m => m.type === markType && m.attrs.suggestionId === suggestionId))
        raw.push({ from: pos, to: pos + node.nodeSize })
      return true
    })
    // merge adjacent text-node ranges that belong to the same mark span
    const merged: { from: number; to: number }[] = []
    for (const r of raw.sort((a, b) => a.from - b.from)) {
      const last = merged[merged.length - 1]
      if (last && r.from <= last.to) last.to = Math.max(last.to, r.to)
      else merged.push({ ...r })
    }
    return merged
  }

  /** Apply marks to the doc for a pm:replace suggestion (idempotent). */
  export function applyReplaceSuggestion(suggestionId: string, authorId: string, uttId: string, fromOffset: number, toOffset: number, replacement: string): void {
    if (!view) return
    if (_suggestionMarkRanges('suggestion_insert', suggestionId).length > 0 ||
        _suggestionMarkRanges('suggestion_delete', suggestionId).length > 0) return
    let uttPos: number | null = null
    view.state.doc.forEach((node, pos) => { if (node.attrs.id === uttId) uttPos = pos })
    if (uttPos === null) return
    const insM = schema.marks['suggestion_insert']!.create({ suggestionId, authorId })
    const delM = schema.marks['suggestion_delete']!.create({ suggestionId, authorId })
    const from = uttPos + 1 + fromOffset
    const to   = uttPos + 1 + toOffset
    const tr = view.state.tr
    if (from < to) tr.addMark(from, to, delM)
    if (replacement.length > 0) tr.insert(to, schema.text(replacement, [insM]))
    view.dispatch(tr.setMeta('allowWhenReadonly', true))
  }

  /** Accept a pm:replace suggestion — keep insert text (strip mark), delete marked original. */
  export function acceptReplaceSuggestion(suggestionId: string): void {
    if (!view) return
    const insRanges = _suggestionMarkRanges('suggestion_insert', suggestionId)
    const delRanges = _suggestionMarkRanges('suggestion_delete', suggestionId)
    const tr = view.state.tr
    const insM = schema.marks['suggestion_insert']!
    for (const r of insRanges) tr.removeMark(r.from, r.to, insM)
    for (const r of [...delRanges].sort((a, b) => b.from - a.from)) tr.delete(r.from, r.to)
    view.dispatch(tr.setMeta('allowWhenReadonly', true))
  }

  /** Reject a pm:replace suggestion — delete insert text, keep original (strip mark). */
  export function rejectReplaceSuggestion(suggestionId: string): void {
    if (!view) return
    const insRanges = _suggestionMarkRanges('suggestion_insert', suggestionId)
    const delRanges = _suggestionMarkRanges('suggestion_delete', suggestionId)
    const tr = view.state.tr
    const delM = schema.marks['suggestion_delete']!
    for (const r of delRanges) tr.removeMark(r.from, r.to, delM)
    for (const r of [...insRanges].sort((a, b) => b.from - a.from)) tr.delete(r.from, r.to)
    view.dispatch(tr.setMeta('allowWhenReadonly', true))
  }

  export function applyParticipantChange(uttId: string, participant: string): void {
    if (!view) return
    view.state.doc.forEach((node, pos) => {
      if (node.attrs.id !== uttId) return
      const currentTier = (node.attrs.tier as string) ?? ''
      const tierIsAuto = currentTier === '' || currentTier === 'utterance'
      const newTier = tierIsAuto ? 'utterance' : currentTier
      view.dispatch(
        view.state.tr
          .setNodeMarkup(pos, undefined, { ...node.attrs, participant, tier: newTier })
          .setMeta('allowWhenReadonly', true)
      )
    })
  }

  export function updateImageNode(imageId: string, width: number, provenance: ImageProvenance): void {
    if (!view) return
    view.state.doc.descendants((node, pos) => {
      if (node.type === schema.nodes['image'] && node.attrs.id === imageId) {
        view.dispatch(
          view.state.tr
            .setNodeAttribute(pos, 'width', width)
            .setNodeAttribute(pos, 'provenance', provenance)
            .setMeta('allowWhenReadonly', true)
        )
        return false
      }
    })
  }

  export function insertImageIntoViz(vizId: string): string | null {
    if (!view) return null
    let imageId: string | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.type !== schema.nodes['visualization'] || node.attrs.id !== vizId) return
      imageId = newId()
      const img = schema.nodes['image']!.create({ id: imageId })
      view.dispatch(view.state.tr.insert(pos + 1, img).setMeta('allowWhenReadonly', true))
      return false
    })
    return imageId
  }

  export function reorderByTime(addToHistory = true): void {
    if (!view) return
    const nodes: Node[] = []
    view.state.doc.forEach((node: Node) => nodes.push(node))

    // Only sort timed nodes amongst themselves; untimed nodes stay at their current positions.
    const timedIndices: number[] = []
    const timedNodes: Node[] = []
    nodes.forEach((node, i) => {
      if (node.attrs.startTimeSeconds !== null) {
        timedIndices.push(i)
        timedNodes.push(node)
      }
    })
    const sortedTimed = [...timedNodes].sort((a, b) =>
      (a.attrs.startTimeSeconds as number) - (b.attrs.startTimeSeconds as number),
    )
    if (sortedTimed.every((node, i) => node === timedNodes[i])) return

    const sorted = [...nodes]
    timedIndices.forEach((idx, i) => { sorted[idx] = sortedTimed[i]! })

    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, Fragment.fromArray(sorted))
    if (!addToHistory) tr.setMeta('addToHistory', false)
    view.dispatch(tr)
  }

  export function insertVisualizationBlock(type = 'screenshot'): void {
    if (!view) return
    const selFrom = view.state.selection.$from
    const parentBlock = selFrom.node(1)
    const img = schema.nodes['image']!.create({ id: newId() })

    if (parentBlock?.type === schema.nodes['visualization']) {
      view.dispatch(view.state.tr.insert(selFrom.pos, img))
      view.focus()
      return
    }

    const insertPos = Math.min(selFrom.end(1) + 1, view.state.doc.content.size)
    const viz = schema.nodes['visualization']!.create(
      {
        id: newId(),
        type,
        startTimeSeconds: parentBlock?.attrs.startTimeSeconds ?? null,
        endTimeSeconds:   parentBlock?.attrs.endTimeSeconds   ?? null,
      },
      img,
    )
    view.dispatch(view.state.tr.insert(insertPos, viz))
    view.focus()
  }

  export function insertCommentBlock(): void {
    if (!view) return
    runInsertComment(view)
  }

  export function insertText(text: string): void {
    if (!view) return
    const { state } = view
    const { from, to } = state.selection
    view.dispatch(state.tr.insertText(text, from, to))
    view.focus()
  }

  export function refreshDecorations(): void {
    if (!view) return
    view.dispatch(view.state.tr)
  }

  export function updateGapText(tok: TokenRecord, newText: string): void {
    if (!view) return
    const { doc } = view.state
    doc.forEach((block: Node, blockOffset: number) => {
      if (block.attrs.id !== tok.uttId) return
      const nodeStart = blockOffset + 1
      let charPos = 0
      let fromPos: number | null = null
      let toPos: number | null = null
      block.forEach((child: Node, childRelOffset: number) => {
        if (fromPos !== null && toPos !== null) return
        if (child.isText) {
          const textLen = child.text!.length
          if (fromPos === null && charPos + textLen > tok.startOffset)
            fromPos = nodeStart + childRelOffset + (tok.startOffset - charPos)
          if (toPos === null && charPos + textLen >= tok.endOffset)
            toPos = nodeStart + childRelOffset + (tok.endOffset - charPos)
          charPos += textLen
        }
      })
      if (fromPos !== null && toPos !== null) {
        undoManager.trackedOrigins.delete(ySyncPluginKey)
        view.dispatch(view.state.tr.insertText(newText, fromPos, toPos).setMeta('addToHistory', false))
        undoManager.trackedOrigins.add(ySyncPluginKey)
      }
    })
  }

  export function setAwareness(aw: unknown): void {
    if (!view || !aw) return
    // No-op if cursor plugin is already present (e.g. awareness was set at mount time).
    // yCursorPlugin registers itself under a well-known key; check for it by name.
    const alreadyHas = view.state.plugins.some(p => (p as { key?: string }).key?.startsWith('yCursorPlugin'))
    if (alreadyHas) return
    const cursorPlugin = yCursorPlugin(aw as Parameters<typeof yCursorPlugin>[0], {
      selectionBuilder: (user: { color: string }) => ({
        style: `background-color: ${user.color}cc`,
        class: 'ProseMirror-yjs-selection',
      }),
    })
    view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, cursorPlugin] }))
  }

  export function undo(): void {
    if (view) yUndo(view.state)
  }

  export function redo(): void {
    if (view) yRedo(view.state)
  }

  export function setSlotHighlightToken(token: TokenRef | null): void {
    if (!view) return
    setTokenSlotHighlight(view, token, tokenStore)
  }

  export function setHoverTokenRefs(refs: TokenRef[]): void {
    if (!view) return
    _setHoverTokenRanges(view, refs, tokenStore ?? new TokenStore())
  }

  export function setSelectionMarkSpacers(markIds: string[]): void {
    if (!view) return
    _setSelectionMarkSpacers(view, markIds)
  }

  export function setStyledSlotTokens(refs: StyledTokenRef[]): void {
    if (!view) return
    _setStyledSlotTokens(view, refs, tokenStore)
  }

  export function setTimeDecimals(decimals: number): void {
    refreshAllTimeViews(decimals)
    if (view) _updateColumnWidths(view.state.doc, decimals)
  }

  export function resetDoc(newDoc: Node, tokens?: TokenRecord[]): void {
    if (!view) return
    _resetting = true
    try {
      replaceYXmlFragment(yXmlFragment.doc!, yXmlFragment, newDoc)
    } finally {
      _resetting = false
    }
    // replaceYXmlFragment triggers two intermediate buildFromDoc calls (delete + apply)
    // that generate new token IDs because the pool is cleared by the delete transaction.
    // Restore the correct pool here so the final buildFromDoc produces the original IDs.
    if (tokens) tokenStore.loadTokens(tokens)
    tokenStore.buildFromDoc(view.state.doc)
    onDocChange?.(view.state.doc, view.state)
    _updateColumnWidths(view.state.doc)
  }
</script>

<div class="transcript-editor"
  class:hide-times={!showTimes}
  class:hide-start={!showStart}
  class:hide-end={!showEnd}
  class:hide-guides={!showGuides}
  class:hide-left-guide={!showLeftGuide}
  class:hide-sep-guide={!showSepGuide}
  class:hide-right-guide={!showRightGuide}
  style={transcriptFont ? `--transcript-font: ${transcriptFont}` : ''}>
  <div bind:this={container}></div>
</div>

<style>
  .transcript-editor {
    outline: none;
    counter-reset: utt-line;
    --ln-w: 2rem;
    --ln-margin: 0.25rem;
    --ln-gutter: calc(var(--ln-w) + var(--ln-margin) * 2);
    --utt-meta-w: calc(var(--ln-w) + var(--time-w, 6.5rem) + var(--time-w, 6.5rem) + var(--participant-w, 4rem) + 4 * 0.5rem);
    /* Both times visible: gutter + gap + time + gap + time + half-gap */
    --sep-x: calc(var(--ln-gutter) + var(--time-w, 6.5rem) * 2 + 1.25rem);
    /* Per-guide positions — set to -1px to hide an individual line */
    --g-l-outer: 0px;
    --g-l-inner: var(--ln-gutter);
    --g-sep:     var(--sep-x);
    --g-r-inner: calc(100% - var(--ln-gutter));
    --g-r-outer: 100%;
    background:
      linear-gradient(var(--color-border, #ddd), var(--color-border, #ddd)) var(--g-l-outer) / 1px 100% no-repeat,
      linear-gradient(var(--color-border, #ddd), var(--color-border, #ddd)) var(--g-l-inner) / 1px 100% no-repeat,
      linear-gradient(var(--color-border, #ddd), var(--color-border, #ddd)) var(--g-sep)     / 1px 100% no-repeat,
      linear-gradient(var(--color-border, #ddd), var(--color-border, #ddd)) var(--g-r-inner) / 1px 100% no-repeat,
      linear-gradient(var(--color-border, #ddd), var(--color-border, #ddd)) var(--g-r-outer) / 1px 100% no-repeat;
  }
  /* One time column visible: gutter + gap + time + half-gap */
  .hide-start { --sep-x: calc(var(--ln-gutter) + var(--time-w, 6.5rem) + 0.75rem); }
  .hide-end   { --sep-x: calc(var(--ln-gutter) + var(--time-w, 6.5rem) + 0.75rem); }
  /* No times: push separator off-screen */
  .hide-times { --sep-x: -1px; }

  /* Master guide toggle */
  .hide-guides { background: none; }
  /* Individual guide toggles */
  .hide-left-guide  { --g-l-outer: -1px; --g-l-inner: -1px; }
  .hide-sep-guide   { --g-sep: -1px; }
  .hide-right-guide { --g-r-inner: -1px; --g-r-outer: -1px; }

  :global(.ProseMirror) {
    outline: none;
    min-height: 100%;
  }

  /* !important required: .viz-row defines its own background and comes later in
     the stylesheet, so it would win at equal specificity without it. */
  :global(.is-playing) { background: rgba(242, 173, 0, 0.35) !important; }
  :global(.is-looping) {
    background: rgba(255, 120, 30, 0.15) !important;
    border-top: 1.5px solid #ff7a1e !important;
    border-bottom: 1.5px solid #ff7a1e !important;
  }

  :global(.comment-row) {
    font-style: italic;
    font-family: var(--transcript-font, 'CMU Serif', 'Computer Modern', Georgia, serif);
    color: #4a7c59;
    padding: 0.05rem 0.5rem 0.05rem var(--utt-meta-w, 21rem);
    line-height: 1.5;
    counter-increment: utt-line;
    min-height: 1.5em;
  }
  .hide-times :global(.comment-row) { padding-left: calc(var(--ln-w, 2rem) + var(--participant-w, 4rem) + 2 * 0.5rem); }
  .hide-start :global(.comment-row) { padding-left: calc(var(--ln-w, 2rem) + var(--time-w, 6.5rem) + var(--participant-w, 4rem) + 3 * 0.5rem); }
  .hide-end   :global(.comment-row) { padding-left: calc(var(--ln-w, 2rem) + var(--time-w, 6.5rem) + var(--participant-w, 4rem) + 3 * 0.5rem); }

  :global(.utt-row) {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 0.5rem;
    row-gap: 0.05em;
    padding: 0.05rem 0;
    line-height: 1.5;
    counter-increment: utt-line;
  }

  :global(.utt-linenum) {
    flex-shrink: 0;
    width: var(--ln-w, 2rem);
    margin: 0 var(--ln-margin, 0.25rem);
    text-align: right;
    font-size: 0.75em;
    color: var(--color-text-muted, #999);
    user-select: none;
    font-variant-numeric: tabular-nums;
  }

  :global(.utt-linenum::before) {
    content: counter(utt-line);
  }

  :global(.utt-linenum-right) {
    text-align: left;
    margin-left: auto;
  }

  :global(.utt-linenum-right::before) {
    content: counter(utt-line);
  }

  .hide-times :global(.utt-time) {
    display: none;
  }

  .hide-start :global(.utt-time-start) { display: none; }
  .hide-end   :global(.utt-time-end)   { display: none; }

  :global(.token-hover) {
    background: color-mix(in srgb, var(--color-accent, #7c5cbf) 20%, transparent);
    border-radius: 2px;
    cursor: pointer;
  }

  :global(.token-slot-highlight) {
    text-decoration: underline wavy 2px #555;
    text-underline-offset: 3px;
    text-decoration-skip-ink: none;
  }


  :global(.utt-time) {
    flex-shrink: 0;
    width: var(--time-w, 6.5rem);
    font-size: 0.72em;
    color: var(--color-text-light, #888);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
  }

  :global(.utt-time:hover) {
    color: var(--color-primary, #4a9eff);
  }

  :global(.utt-participant) {
    flex-shrink: 0;
    width: var(--participant-w, 4rem);
    font-weight: 400;
    color: var(--color-text-3, #555);
    cursor: text;
    user-select: none;
    text-align: right;
    font-size: 0.85em;
  }

  :global(.utt-participant::after) {
    content: ':';
    color: var(--color-text-light, #888);
    font-weight: 400;
  }

  :global(.utt-participant[contenteditable="true"]) {
    background: #fffbe6;
    outline: 1px solid #f0c040;
    border-radius: 2px;
    cursor: text;
    user-select: text;
  }

  :global(.utt-participant--conflict) {
    background: var(--color-danger-light, #fde8e8) !important;
    outline: 2px solid var(--color-danger, #e74c3c) !important;
    border-radius: 2px;
    transition: background 0.7s, outline 0.7s;
  }

  :global(.utt-ctx-menu) {
    background: var(--color-bg-0, #fff);
    border: 1px solid var(--color-border, #ddd);
    border-radius: 5px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    min-width: 140px;
    padding: 3px 0;
    font-size: 0.82rem;
    user-select: none;
  }

  :global(.utt-ctx-header) {
    padding: 5px 12px 4px;
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted, #aaa);
  }

  :global(.utt-ctx-sep) {
    height: 1px;
    background: var(--color-border, #eee);
    margin: 3px 0;
  }

  :global(.utt-ctx-empty) {
    padding: 4px 12px;
    color: var(--color-text-muted, #aaa);
    font-style: italic;
    font-size: 0.78rem;
  }

  :global(.utt-ctx-item) {
    display: block;
    width: 100%;
    text-align: left;
    padding: 5px 12px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-1, #222);
    font-size: 0.82rem;
    font-family: inherit;
  }

  :global(.utt-ctx-item:hover) {
    background: var(--color-bg-2, #f0f0f0);
    color: var(--color-primary, #4a90d9);
  }

  :global(.utt-ctx-new) {
    color: var(--color-text-muted, #888);
    font-style: italic;
  }

  :global(.utt-ctx-new:hover) {
    color: var(--color-primary, #4a90d9);
  }

  :global(.utt-tier) {
    flex-shrink: 0;
    max-width: var(--tier-w, 7rem);
    font-size: 0.7em;
    color: var(--color-text-muted, #aaa);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: text;
    user-select: none;
    border: 1px solid transparent;
    border-radius: 2px;
    padding: 0 0.2em;
  }

  :global(.utt-tier:not(:empty):hover) {
    border-color: var(--color-border, #ddd);
    color: var(--color-text-2, #666);
  }

  :global(.utt-tier[contenteditable="true"]) {
    background: #fffbe6;
    outline: 1px solid #f0c040;
    border-color: transparent;
    border-radius: 2px;
    cursor: text;
    user-select: text;
    overflow: visible;
    max-width: none;
    color: var(--color-text-1, #222);
  }

  :global(.utt-content) {
    flex: 1;
    font-family: var(--transcript-font, 'CMU Serif', 'Computer Modern', Georgia, serif);
  }

  /* --utt-meta-w is defined on .transcript-editor using --ln-w */

  :global(.utt-gloss) {
    /* Force onto second flex line; padding-left aligns text with utt-content */
    flex: 0 0 100%;
    box-sizing: border-box;
    padding-left: var(--utt-meta-w, 21rem);
    padding-bottom: 0.15em;
    font-family: var(--transcript-font, 'CMU Serif', 'Computer Modern', Georgia, serif);
    color: var(--color-text-muted, #999);
    font-style: italic;
    line-height: 1.4;
    min-height: 1.2em;
    cursor: text;
    outline: none;
  }

  :global(.utt-gloss:empty::before) {
    content: '(empty gloss)';
    color: var(--color-text-muted, #999);
    opacity: 0.45;
    font-style: italic;
  }


  :global(.utt-gloss[contenteditable="true"]) {
    color: var(--color-text-1, #222);
    font-style: normal;
    background: var(--color-bg-1, #f5f5f5);
    border-radius: 2px;
  }

  /* Adjust gloss indent when time columns are hidden */
  .hide-times :global(.utt-gloss) { padding-left: calc(var(--ln-w, 2rem) + var(--participant-w, 4rem) + 2 * 0.5rem); }
  .hide-start :global(.utt-gloss),
  .hide-end   :global(.utt-gloss) { padding-left: calc(var(--ln-w, 2rem) + var(--time-w, 6.5rem) + var(--participant-w, 4rem) + 3 * 0.5rem); }

  :global(.tok-ws) {
    white-space: pre-wrap;
  }

  :global(.tok-punct) {
    color: var(--color-text-3, #777);
  }

  :global(.tok-gap) {
    color: var(--color-text-light, #888);
    font-style: italic;
  }

  :global(.tok-gap-invalid) {
    color: var(--color-error, #dc2626);
    font-style: italic;
  }


  :global(.viz-row) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.05rem 0;
    line-height: 1.5;
    background: var(--color-viz-light, #e8f5e9);
    counter-increment: utt-line;
  }

  :global(.viz-type-tag) {
    font-size: 0.68em;
    color: var(--color-viz, #388e3c);
    cursor: text;
    line-height: 1.3;
    font-style: italic;
  }

  :global(.viz-type-tag[contenteditable="true"]) {
    background: #f1f8e9;
    outline: 1px solid #81c784;
    border-radius: 2px;
    cursor: text;
    user-select: text;
  }

  :global(.viz-empty-hint) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 150px;
    height: 52px;
    border: 1px dashed #ccc;
    border-radius: 3px;
    font-size: 0.7em;
    color: var(--color-text-faint, #bbb);
    font-style: italic;
    pointer-events: none;
    user-select: none;
    vertical-align: middle;
  }

  :global(.ann-span) {
    background: rgba(255, 220, 50, 0.35);
    border-radius: 2px;
  }

  /* gap cursor before/after atom nodes (images) */
  :global(.ProseMirror-gapcursor) {
    display: none;
    pointer-events: none;
    position: absolute;
  }
  :global(.ProseMirror-gapcursor:after) {
    content: '';
    display: block;
    position: absolute;
    top: -2px;
    width: 20px;
    border-top: 1px solid #555;
    animation: ProseMirror-cursor-blink 1.1s steps(2, start) infinite;
  }
  @keyframes ProseMirror-cursor-blink {
    to { visibility: hidden; }
  }
  :global(.ProseMirror-focused .ProseMirror-gapcursor) {
    display: block;
  }

  /* y-prosemirror collaborative cursors */
  :global(.ProseMirror-yjs-cursor) {
    position: relative;
    margin-left: -1px;
    margin-right: -1px;
    border-left: 2px solid black;
    word-break: normal;
    pointer-events: none;
  }

  :global(.ProseMirror-yjs-cursor > div) {
    position: absolute;
    top: -1.4em;
    left: -2px;
    font-size: 11px;
    font-family: system-ui, sans-serif;
    font-style: normal;
    font-weight: 600;
    line-height: 1.4;
    user-select: none;
    white-space: nowrap;
    padding: 1px 4px;
    color: white;
    border-radius: 3px;
    border-bottom-left-radius: 0;
    z-index: 10;
  }

  :global(.ProseMirror-yjs-selection) {
    mix-blend-mode: multiply;
  }

  :global(.overlap-bracket) {
    user-select: none;
    cursor: default;
    pointer-events: none;
  }

  :global(.img-node) {
    position: relative;
    display: inline-block;
    vertical-align: middle;
    user-select: none;
    padding: 2px 4px;
  }

  :global(.img-node__img) {
    display: block;
    object-fit: contain;
  }

  :global(.img-node__placeholder) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 150px;
    height: 100px;
    border: 2px dashed #888;
    border-radius: 4px;
    color: #888;
    font-size: 0.75rem;
    cursor: pointer;
    background: rgba(128,128,128,0.06);
  }

  :global(.img-node__placeholder:hover) {
    border-color: #aaa;
    color: #aaa;
    background: rgba(128,128,128,0.12);
  }

  :global(.img-node__handle) {
    position: absolute;
    width: 8px;
    height: 8px;
    background: #fff;
    border: 1px solid #666;
    border-radius: 2px;
    opacity: 0;
  }

  :global(.img-node:hover .img-node__handle) { opacity: 1; }

  :global(.img-node__handle--nw) { top: -4px;    left: -4px;    cursor: nw-resize; }
  :global(.img-node__handle--ne) { top: -4px;    right: -4px;   cursor: ne-resize; }
  :global(.img-node__handle--sw) { bottom: -4px; left: -4px;    cursor: sw-resize; }
  :global(.img-node__handle--se) { bottom: -4px; right: -4px;   cursor: se-resize; }

  :global(.suggestion-insert) {
    font-family: inherit;
    font-size: inherit;
    color: #15803d;
    white-space: pre-wrap;
    text-decoration-line: underline;
    text-decoration-color: #16a34a;
    text-decoration-style: solid;
    text-decoration-thickness: 1.5px;
  }
  :global(.suggestion-delete) {
    font-family: inherit;
    font-size: inherit;
    color: #b91c1c;
    white-space: pre-wrap;
    text-decoration-line: line-through;
    text-decoration-color: #dc2626;
    text-decoration-style: solid;
    text-decoration-thickness: 1.5px;
  }
</style>
