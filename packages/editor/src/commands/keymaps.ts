/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, chainCommands, toggleMark } from 'prosemirror-commands'
import { undoCommand as undo, redoCommand as redo } from 'y-prosemirror'
import { schema, newId } from '@mumo/core'
import type { TokenStore } from '@mumo/core'
import { TextSelection } from 'prosemirror-state'
import type { Command } from 'prosemirror-state'

/** Focus the speaker label of the utterance containing the cursor. */
const focusSpeaker: Command = (state, _dispatch, view) => {
  if (!view) return false
  const { $head } = state.selection
  let uttPos: number | null = null
  for (let d = $head.depth; d >= 0; d--) {
    if ($head.node(d).type === schema.nodes['utterance']) {
      uttPos = $head.before(d)
      break
    }
  }
  if (uttPos === null) return false
  const uttDOM = view.nodeDOM(uttPos) as HTMLElement | null
  if (!uttDOM) return false
  const nodeView = (uttDOM as unknown as { __nodeView?: { startEdit(): void } }).__nodeView
  if (!nodeView?.startEdit) return false
  nodeView.startEdit()
  return true
}

/** Create or split an utterance at the cursor. */
function splitBlock(
  state: Parameters<Command>[0],
  dispatch: Parameters<Command>[1],
  keepSpeaker: boolean,
  tokenStore: TokenStore,
  getTokenTime?: (id: string) => { start: number; end: number } | undefined,
): boolean {
  const { $from } = state.selection
  const utt = schema.nodes['utterance']

  // Walk up to find the containing utterance.
  let uttDepth = -1
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type === utt) { uttDepth = d; break }
  }
  if (uttDepth === -1) return false

  const parentNode = $from.node(uttDepth)
  const parentType = parentNode.type
  const uttPos     = $from.before(uttDepth)

  if (dispatch) {
    const origStart: number | null = parentNode.attrs.startTimeSeconds
    const origEnd:   number | null = parentNode.attrs.endTimeSeconds

    // With text* content, cursor is always at uttDepth — no word-node sub-splits.
    const splitPos    = $from.pos
    const cursorOffset = splitPos - $from.start(uttDepth)

    const atStartOfUtt = cursorOffset === 0
    if (atStartOfUtt) {
      if (parentNode.content.size === 0) {
        const insertAt = uttPos + parentNode.nodeSize
        const p = keepSpeaker ? ((parentNode.attrs.participant as string | null) ?? '') : ''
        const newAttrs = { id: newId(), participant: p || null, tier: keepSpeaker ? (parentNode.attrs.tier ?? '') : 'utterance', startTimeSeconds: null, endTimeSeconds: null }
        let tr = state.tr.insert(insertAt, parentType.create(newAttrs))
        tr = tr.setSelection(TextSelection.create(tr.doc, insertAt + 1))
        dispatch(tr.scrollIntoView())
        return true
      }

      const newUttParticipant = keepSpeaker ? ((parentNode.attrs.participant as string | null) ?? '') : ''
      const newNode = schema.nodes['utterance'].create({
        id:               newId(),
        participant:      newUttParticipant || null,
        tier:             keepSpeaker ? (parentNode.attrs.tier ?? '') : 'utterance',
        startTimeSeconds: null,
        endTimeSeconds:   null,
      })
      let tr = state.tr.insert(uttPos, newNode)
      tr = tr.setSelection(TextSelection.create(tr.doc, uttPos + 1))
      dispatch(tr.scrollIntoView())
      return true
    }

    // Check if cursor is at or past the last word token in the utterance.
    const uttId  = parentNode.attrs.id as string
    const tokens = tokenStore.getUttTokens(uttId)
    const wordsAfterCursor = tokens.filter(t => t.kind === 'word' && t.startOffset >= cursorOffset)
    const atEndOfUtt = wordsAfterCursor.length === 0

    if (atEndOfUtt) {
      const nextSiblingPos = uttPos + parentNode.nodeSize
      let nextUttStart: number | null = null
      let siblingPos = nextSiblingPos
      while (siblingPos < state.doc.content.size) {
        const next = state.doc.nodeAt(siblingPos)
        if (!next) break
        if (next.attrs.participant === parentNode.attrs.participant) {
          if (next.attrs.startTimeSeconds != null) nextUttStart = next.attrs.startTimeSeconds
          break
        }
        siblingPos += next.nodeSize
      }

      const newStart = origEnd
      const newEnd   = newStart !== null
        ? Math.max(newStart, Math.min(newStart + 1, nextUttStart ?? newStart + 1))
        : null

      const newUttId = newId()
      const endUttParticipant = keepSpeaker ? ((parentNode.attrs.participant as string | null) ?? '') : ''
      const newNode  = schema.nodes['utterance'].create({
        id: newUttId,
        participant: endUttParticipant || null,
        tier: keepSpeaker ? (parentNode.attrs.tier ?? '') : 'utterance',
        startTimeSeconds: newStart,
        endTimeSeconds:   newEnd,
      })

      const insertAt = nextSiblingPos
      let tr = state.tr.insert(insertAt, newNode)
      tr = tr.setSelection(TextSelection.create(tr.doc, insertAt + 1))
      dispatch(tr.scrollIntoView())
      return true
    }

    // Mid-utterance split — compute split time from token store.
    let splitTime: number | null = null
    if (parentType === utt) {
      const wordsBefore = tokens.filter(t => t.kind === 'word' && t.endOffset <= cursorOffset)
      const wordsAfter  = wordsAfterCursor.filter(t => t.kind === 'word')

      let lastTimedEndBefore:   number | null = null
      let firstTimedStartAfter: number | null = null

      for (const t of wordsBefore) { const tm = getTokenTime?.(t.id); if (tm != null) lastTimedEndBefore = tm.end }
      for (const t of wordsAfter)  { const tm = getTokenTime?.(t.id); if (tm != null) { firstTimedStartAfter = tm.start; break } }

      if (lastTimedEndBefore !== null) {
        splitTime = lastTimedEndBefore
      } else if (firstTimedStartAfter !== null) {
        splitTime = firstTimedStartAfter
      } else if (origStart !== null && origEnd !== null) {
        const total = wordsBefore.length + wordsAfter.length
        if (total > 0)
          splitTime = +(origStart + (wordsBefore.length / total) * (origEnd - origStart)).toFixed(3)
      }
    }

    const newUttId = newId()
    const newAttrs = {
      ...parentNode.attrs,
      id: newUttId,
      startTimeSeconds: splitTime,
      endTimeSeconds:   splitTime !== null ? origEnd : null,
    }

    let tr = state.tr.split(splitPos, 1, [{ type: parentType, attrs: newAttrs }])

    if (splitTime !== null) {
      tr = tr.setNodeMarkup(uttPos, undefined, {
        ...parentNode.attrs,
        endTimeSeconds: +splitTime.toFixed(3),
      })
    }

    let tailPos: number | null = null
    tr.doc.forEach((node, offset) => {
      if (node.attrs.id === newUttId) tailPos = offset + 1
    })
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (tailPos !== null) tr = tr.setSelection(TextSelection.create(tr.doc, tailPos))

    dispatch(tr.scrollIntoView())
  }
  return true
}

/** Insert a comment block after the current block. */
const insertCommentBlock: Command = (state, dispatch) => {
  const { $from } = state.selection
  let topDepth = -1
  for (let d = $from.depth; d >= 1; d--) {
    if ($from.node(d - 1).type === state.schema.nodes['doc']) { topDepth = d; break }
  }
  if (topDepth === -1) return false
  const blockEnd = $from.after(topDepth)
  if (dispatch) {
    const comment = schema.nodes['comment'].create({ id: newId() })
    const insertPos = Math.min(blockEnd, state.doc.content.size)
    const tr = state.tr.insert(insertPos, comment)
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
    dispatch(tr.scrollIntoView())
  }
  return true
}

/**
 * When Enter is pressed inside a comment block, insert a new empty utterance
 * after it (rather than letting PM's default splitBlock copy the comment's id).
 */
/** Enter in a comment → new utterance after it. */
const exitComment: Command = (state, dispatch) => {
  const { $from } = state.selection
  let commentDepth = -1
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type === schema.nodes['comment']) { commentDepth = d; break }
  }
  if (commentDepth === -1) return false

  const blockEnd = $from.after(commentDepth)
  if (dispatch) {
    const utt = schema.nodes['utterance'].create({ id: newId(), participant: null, tier: 'utterance', startTimeSeconds: null, endTimeSeconds: null })
    const insertPos = Math.min(blockEnd, state.doc.content.size)
    const tr = state.tr.insert(insertPos, utt)
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
    dispatch(tr.scrollIntoView())
  }
  return true
}

/** Shift+Enter in a comment → new comment block after it. */
const splitComment: Command = (state, dispatch) => {
  const { $from } = state.selection
  let commentDepth = -1
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type === schema.nodes['comment']) { commentDepth = d; break }
  }
  if (commentDepth === -1) return false

  const blockEnd = $from.after(commentDepth)
  if (dispatch) {
    const comment = schema.nodes['comment'].create({ id: newId() })
    const insertPos = Math.min(blockEnd, state.doc.content.size)
    const tr = state.tr.insert(insertPos, comment)
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
    dispatch(tr.scrollIntoView())
  }
  return true
}

/** Insert a visualization block after the current top-level block, tied to the preceding block. */
const insertVisualization: Command = (state, dispatch) => {
  const { $from } = state.selection
  // Walk up to find the current top-level block position
  let topDepth = -1
  for (let d = $from.depth; d >= 1; d--) {
    if ($from.node(d - 1).type === state.schema.nodes['doc']) {
      topDepth = d
      break
    }
  }
  if (topDepth === -1) return false
  const blockEnd = $from.after(topDepth)

  // Inherit attrs from the block the cursor is currently inside
  const currentNode = $from.node(topDepth)
  let prevParticipant = ''
  const prevTier = ''
  let prevStart: number | null = null
  let prevEnd: number | null = null
  if (currentNode.type === schema.nodes['utterance']) {
    prevParticipant = currentNode.attrs.participant as string
    prevStart       = currentNode.attrs.startTimeSeconds as number | null
    prevEnd         = currentNode.attrs.endTimeSeconds   as number | null
  }

  if (dispatch) {
    const parentId = (currentNode.attrs.id as string | null) ?? null
    const viz = schema.nodes['visualization'].create({
      id: newId(),
      type: 'screenshot',
      participant: prevParticipant,
      tier: prevTier,
      startTimeSeconds: prevStart,
      endTimeSeconds: prevEnd,
      dependent: parentId !== null,
      parentNodeId: parentId,
    })
    const insertPos = Math.min(blockEnd, state.doc.content.size)
    const tr = state.tr.insert(insertPos, viz)
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
    dispatch(tr.scrollIntoView())
  }
  return true
}

/**
 * Backspace at the very start of an utterance:
 * - If the previous sibling is empty, delete it (keeps the current utterance intact).
 * - If the previous sibling has the same speaker, join and merge time attrs
 *   (start time from prev, end time from current).
 * - Otherwise fall through to baseKeymap's joinBackward.
 */
const backspaceBlockStart: Command = (state, dispatch) => {
  const { $head, empty } = state.selection
  if (!empty || $head.parentOffset !== 0) return false

  let uttDepth = -1
  for (let d = $head.depth; d >= 0; d--) {
    if ($head.node(d).type === schema.nodes['utterance']) { uttDepth = d; break }
  }
  if (uttDepth === -1) return false

  const uttPos = $head.before(uttDepth)
  if (uttPos === 0) return false

  const currUtt = $head.node(uttDepth)
  const prevSibling = state.doc.resolve(uttPos).nodeBefore
  if (!prevSibling || prevSibling.type !== schema.nodes['utterance']) return false

  // Empty prev sibling: delete it, keep current intact.
  if (prevSibling.content.size === 0) {
    if (dispatch) {
      const prevStart = uttPos - prevSibling.nodeSize
      dispatch(state.tr.delete(prevStart, uttPos))
    }
    return true
  }

  // Same-speaker join: merge and pick start time from prev, end time from current.
  const prevParticipant = (prevSibling.attrs.participant as string) || ''
  const currParticipant = (currUtt.attrs.participant as string) || ''
  if (prevParticipant !== currParticipant) return false

  if (dispatch) {
    const prevStart = uttPos - prevSibling.nodeSize
    const startTime = (prevSibling.attrs.startTimeSeconds as number | null)
      ?? (currUtt.attrs.startTimeSeconds as number | null)
    const endTime = (currUtt.attrs.endTimeSeconds as number | null)
      ?? (prevSibling.attrs.endTimeSeconds as number | null)
    let tr = state.tr.join(uttPos)
    tr = tr.setNodeMarkup(prevStart, undefined, {
      ...prevSibling.attrs,
      startTimeSeconds: startTime,
      endTimeSeconds: endTime,
    })
    dispatch(tr)
  }
  return true
}

/** When the cursor is in an empty utterance, clear its participant and timing attrs. */
const clearBlock: Command = (state, dispatch) => {
  const { $head, empty } = state.selection
  if (!empty) return false

  let uttDepth = -1
  for (let d = $head.depth; d >= 0; d--) {
    if ($head.node(d).type === schema.nodes['utterance']) { uttDepth = d; break }
  }
  if (uttDepth === -1) return false

  const utt = $head.node(uttDepth)
  if (utt.content.size !== 0) return false

  const hasParticipant = !!utt.attrs.participant
  const hasTiming = utt.attrs.startTimeSeconds !== null || utt.attrs.endTimeSeconds !== null
  if (!hasParticipant && !hasTiming) return false

  if (dispatch) {
    const uttPos = $head.before(uttDepth)
    const tr = state.tr.setNodeMarkup(uttPos, undefined, {
      ...utt.attrs,
      participant: '',
      tier: '',
      startTimeSeconds: null,
      endTimeSeconds: null,
    })
    dispatch(tr)
  }
  return true
}

/** Move the cursor to the end of the previous block when at position 0. */
const arrowLeftBlock: Command = (state, dispatch) => {
  const { $head, empty } = state.selection
  if (!empty || !$head.parent.isTextblock || $head.parentOffset !== 0) return false
  const before = $head.before($head.depth)
  if (before === 0) return false
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, before - 1)).scrollIntoView())
  return true
}

/** Move the cursor to the start of the next block when at the end of content. */
const arrowRightBlock: Command = (state, dispatch) => {
  const { $head, empty } = state.selection
  if (!empty || !$head.parent.isTextblock || $head.parentOffset !== $head.parent.content.size) return false
  const after = $head.after($head.depth)
  if (after >= state.doc.content.size) return false
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, after + 1)).scrollIntoView())
  return true
}

/** Move to end of previous block when cursor is at the very start (Firefox up-arrow fix). */
const arrowUpBlock: Command = (state, dispatch) => {
  const { $head, empty } = state.selection
  if (!empty || !$head.parent.isTextblock || $head.parentOffset !== 0) return false
  const before = $head.before($head.depth)
  if (before === 0) return false
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, before - 1)).scrollIntoView())
  return true
}

/** Move to start of next block when cursor is at the very end (Firefox down-arrow fix). */
const arrowDownBlock: Command = (state, dispatch) => {
  const { $head, empty } = state.selection
  if (!empty || !$head.parent.isTextblock || $head.parentOffset !== $head.parent.content.size) return false
  const after = $head.after($head.depth)
  if (after >= state.doc.content.size) return false
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, after + 1)).scrollIntoView())
  return true
}

export function buildKeymapPlugin(
  tokenStore: TokenStore,
  getTokenTime?: (id: string) => { start: number; end: number } | undefined,
  onEscapeKey?: () => void,
) {
  const splitUtterance:            Command = (state, dispatch) => splitBlock(state, dispatch, false, tokenStore, getTokenTime)
  const splitUtteranceSameSpeaker: Command = (state, dispatch) => splitBlock(state, dispatch, true,  tokenStore, getTokenTime)

  return [
    keymap({
      'Mod-z': undo,
      'Mod-y': redo,
      'Mod-Shift-z': redo,
      'Mod-b': toggleMark(schema.marks['bold']),
      'Mod-i': toggleMark(schema.marks['italic']),
      'Mod-Shift-s': toggleMark(schema.marks['strike']),
      'Mod-u': toggleMark(schema.marks['underline']),
      'Enter': chainCommands(exitComment, splitUtterance),
      'Shift-Enter': chainCommands(splitComment, splitUtteranceSameSpeaker),
      'Alt-/': insertCommentBlock,
      'Alt-Shift-Enter': insertVisualization,
      'Shift-Tab': focusSpeaker,
      'Backspace':  backspaceBlockStart,
      'Delete':     clearBlock,
      'ArrowLeft':  arrowLeftBlock,
      'ArrowRight': arrowRightBlock,
      'ArrowUp':    arrowUpBlock,
      'ArrowDown':  arrowDownBlock,
      ...(onEscapeKey ? { 'Escape': () => { onEscapeKey(); return false } } : {}),
    }),
    keymap(baseKeymap),
  ]
}
