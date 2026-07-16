import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'

// Loop plugin

const loopKey = new PluginKey<Set<string>>('loop')

export function buildLoopPlugin(): Plugin {
  return new Plugin({
    key: loopKey,
    state: {
      init: () => new Set<string>(),
      apply(tr, prev) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const meta = tr.getMeta(loopKey)
        if (meta !== undefined) return meta as Set<string>
        return prev
      },
    },
    props: {
      decorations(state) {
        const loopIds = loopKey.getState(state)!
        if (!loopIds.size) return DecorationSet.empty
        const decos: Decoration[] = []
        state.doc.forEach((node, offset) => {
          const id = node.attrs.id as string | undefined
          if (id && loopIds.has(id)) {
            decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'is-looping' }))
          }
        })
        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

export function updateLoopIds(view: EditorView, ids: string[]): void {
  const prev = loopKey.getState(view.state) ?? new Set<string>()
  const next = new Set(ids)
  if (next.size === prev.size && [...next].every(id => prev.has(id))) return
  view.dispatch(view.state.tr.setMeta(loopKey, next).setMeta('addToHistory', false))
}

// Playing plugin

const playingKey = new PluginKey<Set<string>>('playing')

export function buildPlayingPlugin(): Plugin {
  return new Plugin({
    key: playingKey,
    state: {
      init: () => new Set<string>(),
      apply(tr, prev) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const meta = tr.getMeta(playingKey)
        if (meta !== undefined) return meta as Set<string>
        return prev
      },
    },
    props: {
      decorations(state) {
        const activeIds = playingKey.getState(state)!
        if (!activeIds.size) return DecorationSet.empty
        const decos: Decoration[] = []
        state.doc.forEach((node, offset) => {
          const id = node.attrs.id as string | undefined
          if (id && activeIds.has(id)) {
            decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'is-playing' }))
          }
        })
        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

export function updatePlaying(view: EditorView, added: string[], removed: string[]): void {
  const prev = playingKey.getState(view.state) ?? new Set<string>()
  if (!added.length && !removed.length) return
  const next = new Set(prev)
  for (const id of removed) next.delete(id)
  for (const id of added) next.add(id)
  view.dispatch(view.state.tr.setMeta(playingKey, next).setMeta('addToHistory', false))
}

// Continuation head plugin — decorates head blocks with data-has-continuation

const continuationHeadKey = new PluginKey<DecorationSet>('continuationHead')

export function buildContinuationHeadPlugin(): Plugin {
  return new Plugin({
    key: continuationHeadKey,
    state: {
      init(_, state) { return _buildContinuationHeadDecos(state.doc) },
      apply(tr, prev) {
        if (!tr.docChanged) return prev
        return _buildContinuationHeadDecos(tr.doc)
      },
    },
    props: {
      decorations(state) { return continuationHeadKey.getState(state)! },
    },
  })
}

function _buildContinuationHeadDecos(doc: Parameters<typeof DecorationSet.create>[0]): DecorationSet {
  // Collect continuations per head, in doc order (forEach is doc order)
  const contsByHead = new Map<string, Array<{ id: string; offset: number; size: number }>>()
  const headOffsets = new Map<string, { offset: number; size: number }>()

  doc.forEach((node, offset) => {
    const id = node.attrs.id as string | undefined
    if (!id) return
    const headId = node.attrs.continuationOfId as string | null
    if (headId) {
      const arr = contsByHead.get(headId) ?? []
      arr.push({ id, offset, size: node.nodeSize })
      contsByHead.set(headId, arr)
    } else {
      headOffsets.set(id, { offset, size: node.nodeSize })
    }
  })

  if (!contsByHead.size) return DecorationSet.empty
  const decos: Decoration[] = []

  for (const [headId, conts] of contsByHead) {
    // Head block always gets the marker
    const head = headOffsets.get(headId)
    if (head) decos.push(Decoration.node(head.offset, head.offset + head.size, { 'data-has-continuation': 'true' }))
    // All continuations except the last also get the marker
    for (let i = 0; i < conts.length - 1; i++) {
      const c = conts[i]!
      decos.push(Decoration.node(c.offset, c.offset + c.size, { 'data-has-continuation': 'true' }))
    }
  }

  return DecorationSet.create(doc, decos)
}

// Continuation chain hover plugin — adds .continuation-chain-hover to all chain members on mouseover

export function buildContinuationHoverPlugin(): Plugin {
  return new Plugin({
    view(editorView) {
      let _hoveredChain: string[] = []

      // Tooltip element
      const tooltip = document.createElement('div')
      tooltip.className = 'continuation-tooltip'
      tooltip.textContent = 'continuation'
      tooltip.style.cssText = 'position:fixed;display:none;pointer-events:none;'
      document.body.appendChild(tooltip)

      function _chainFor(id: string, doc: EditorView['state']['doc']): string[] {
        let headId = id
        doc.forEach((node) => {
          if (node.attrs.id === id) {
            const contOf = node.attrs.continuationOfId as string | null
            if (contOf) headId = contOf
          }
        })
        const chain: string[] = []
        doc.forEach((node) => {
          const nid = node.attrs.id as string | undefined
          if (!nid) return
          const contOf = node.attrs.continuationOfId as string | null
          if (nid === headId || contOf === headId) chain.push(nid)
        })
        return chain
      }

      function _setChain(ids: string[], pane: HTMLElement) {
        for (const id of _hoveredChain) {
          pane.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.classList.remove('continuation-chain-hover')
        }
        _hoveredChain = ids
        for (const id of ids) {
          pane.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.classList.add('continuation-chain-hover')
        }
      }

      function _isOverMark(target: HTMLElement): boolean {
        return !!target.closest('.utt-continuation-mark')
      }

      function _positionTooltipAbove(mark: HTMLElement) {
        const rect = mark.getBoundingClientRect()
        tooltip.style.left = `${rect.left + rect.width / 2}px`
        tooltip.style.top = `${rect.top - 4}px`
        tooltip.style.transform = 'translate(-50%, -100%)'
      }

      function onMouseOver(e: MouseEvent) {
        const target = e.target as HTMLElement
        const row = target.closest<HTMLElement>('.utt-row[data-continuation], .utt-row[data-has-continuation]')
        if (!row) {
          _setChain([], editorView.dom)
          tooltip.style.display = 'none'
          return
        }
        const id = row.getAttribute('data-id')
        if (id) _setChain(_chainFor(id, editorView.state.doc), editorView.dom)
        const mark = target.closest<HTMLElement>('.utt-continuation-mark')
        if (mark) {
          _positionTooltipAbove(mark)
          tooltip.style.display = 'block'
        } else {
          tooltip.style.display = 'none'
        }
      }

      function onMouseOut(e: MouseEvent) {
        const to = e.relatedTarget as HTMLElement | null
        if (to?.closest('.ProseMirror')) return
        _setChain([], editorView.dom)
        tooltip.style.display = 'none'
      }

      editorView.dom.addEventListener('mouseover', onMouseOver)
      editorView.dom.addEventListener('mouseout', onMouseOut)

      return {
        destroy() {
          editorView.dom.removeEventListener('mouseover', onMouseOver)
          editorView.dom.removeEventListener('mouseout', onMouseOut)
          tooltip.remove()
        },
      }
    },
  })
}
