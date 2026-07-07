<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import type { AnnotationStore, Pattern, PatternSchema, TokenStore, Annotation } from '@mumo/core'
  import type { ID } from '@mumo/core'
  import type { SlotFillMode } from './patternTypes.js'
  import type { PMNode } from '@mumo/core'

  const {
    store,
    patterns,
    patternSchemas,
    annotations = [],
    doc,
    editorPane,
    tokenStore,
    selectedPatternId,
    slotFillMode = null,
    peerPatternSelections = [],
    onSelectPattern,
    onFillWithPattern,
    onWidthChange,
    onHoverPattern,
    onHoverNoteItem,
  }: {
    store: AnnotationStore
    patterns: Pattern[]
    patternSchemas: PatternSchema[]
    annotations?: Annotation[]
    doc: PMNode
    editorPane: HTMLElement | null
    tokenStore: TokenStore
    selectedPatternId: ID | null
    slotFillMode?: SlotFillMode | null
    peerPatternSelections?: { patternId: string; color: string }[]
    onSelectPattern: (id: ID) => void
    onFillWithPattern?: (id: ID) => void
    onWidthChange?: (w: number) => void
    onHoverPattern?: (patternId: ID | null) => void
    onHoverNoteItem?: (type: 'pattern' | 'textlet', sourceId: string | null) => void
  } = $props()

  const COLUMN_WIDTH = 16
  const COLUMN_GAP   = 4
  const GUTTER_PAD   = 10
  const MIN_GUTTER   = 80

  // Internal type during column assignment (before right is computed)
  type RawItem = {
    patternId: ID
    label: string
    top: number
    height: number
    complete: boolean
    color: number | undefined
    col: number
  }

  interface Stripe {
    patternId: ID
    label: string
    top: number
    height: number
    complete: boolean
    right: number  // pre-computed CSS right value (px from container right edge)
    color: number | undefined
  }

  interface NoteItem {
    text: string
    label: string     // pattern schema name, or 'Textlet'
    type: 'pattern' | 'textlet'
    sourceId: string  // patternId or markId
  }

  interface LineNote {
    top: number
    notes: NoteItem[]
  }

  const NOTE_ICON_W  = 8
  const NOTE_COL_W   = 16  // reserved column width (icon + badge overflow)
  const NOTE_COL_GAP = 6   // gap between bracket columns and note column

  let stripes   = $state<Stripe[]>([])
  let lineNotes = $state<LineNote[]>([])

  // Position helpers

  function relTop(el: HTMLElement): number {
    if (!editorPane) return 0
    return el.getBoundingClientRect().top
      - editorPane.getBoundingClientRect().top
      + editorPane.scrollTop
  }

  function relBottom(el: HTMLElement): number {
    if (!editorPane) return 0
    return el.getBoundingClientRect().bottom
      - editorPane.getBoundingClientRect().top
      + editorPane.scrollTop
  }

  // Utterance lookup

  function uttIdForMark(markId: string): string | null {
    let found: string | null = null
    ;(_liveDoc ?? doc).forEach((node: PMNode) => {
      if (found || node.type?.name !== 'utterance') return
      let hit = false
      node.forEach((inline: PMNode) => {
        if (hit) return
        if (inline.isText) {
          if (inline.marks?.some(m => m.type.name === 'annotation' && m.attrs.id === markId)) hit = true
          return
        }
        inline.forEach?.((t: PMNode) => {
          if (t.marks?.some(m => m.type.name === 'annotation' && m.attrs.id === markId)) hit = true
        })
      })
      if (hit) found = node.attrs.id as string
    })
    return found
  }

  function uttIdForToken(tokenId: string, features?: Record<string, unknown>): string | null {
    return tokenStore.getToken(tokenId)?.uttId ?? (features?.uttId as string | undefined) ?? null
  }

  function uttIdsForPattern(pattern: Pattern): Set<string> {
    const ids = new SvelteSet<string>()
    for (const slot of pattern.slots) {
      const ann = store.getAnnotation(slot.annotationId)
      if (!ann) continue
      const uttId = ann.features.utteranceId as string | undefined
      if (uttId) { ids.add(uttId); continue }
      const markAnchor = ann.anchors.find(a => a.type === 'mark')
      if (markAnchor?.type === 'mark') {
        const id = uttIdForMark(markAnchor.markId)
        if (id) ids.add(id)
        continue
      }
      const tokenId = ann.features.tokenId as string | undefined
      if (tokenId) {
        const id = uttIdForToken(tokenId, ann.features)
        if (id) ids.add(id)
        continue
      }
      const refPatternId = ann.features.patternId as string | undefined
      if (refPatternId) {
        const refFrame = patterns.find(f => f.id === refPatternId)
        if (refFrame) for (const id of uttIdsForPattern(refFrame)) ids.add(id)
      }
    }
    return ids
  }

  // Column assignment (greedy interval scheduling)

  function assignColumns(items: Omit<RawItem, 'col'>[]): RawItem[] {
    const getBottom = (item: Omit<RawItem, 'col'>) => item.top + item.height
    // Containment depth: how many other items geometrically contain this item.
    // More contained → lower col → closer to text (left in gutter).
    const depths = items.map((item, _, arr) =>
      arr.filter(other => other !== item &&
        other.top <= item.top && getBottom(other) >= getBottom(item)
      ).length
    )
    const indexed = items.map((item, i) => ({ item, depth: depths[i]! }))
    indexed.sort((a, b) => b.depth - a.depth || a.item.top - b.item.top)
    const colEnds: number[] = []
    return indexed.map(({ item }) => {
      let col = colEnds.findIndex(end => end + 4 <= item.top)
      if (col === -1) { col = colEnds.length; colEnds.push(0) }
      colEnds[col] = item.top + item.height
      return { ...item, col }
    })
  }

  // Stripe computation

  function computeStripes() {
    if (!editorPane) { stripes = []; lineNotes = []; return }
    const raw: Omit<RawItem, 'col'>[] = []

    for (const pattern of patterns) {
      const schema = patternSchemas.find(s => s.id === pattern.schemaId)
      if (!schema) continue

      const uttIds = uttIdsForPattern(pattern)
      if (uttIds.size === 0) continue

      const mids: number[] = []
      for (const uttId of uttIds) {
        const el = editorPane.querySelector(`[data-id="${CSS.escape(uttId)}"]`) as HTMLElement | null
        if (!el) continue
        mids.push((relTop(el) + relBottom(el)) / 2)
      }
      if (mids.length === 0) continue

      const top    = Math.min(...mids)
      const bottom = Math.max(...mids)
      const height = Math.max(bottom - top, 2)

      const complete = schema.slots
        .filter(s => s.required)
        .every(s => pattern.slots.some(fi => fi.schemaSlotId === s.id))

      raw.push({ patternId: pattern.id, label: schema.name, top, height, complete, color: schema.color })
    }

    const withCols = assignColumns(raw)
    const maxCol   = withCols.reduce((m, s) => Math.max(m, s.col), -1)

    // Gutter width: bracket columns + dedicated note column when notes exist.
    const hasNotes = patterns.some(f => Object.values(f.notes ?? {}).some(a => a.length > 0)) ||
                     annotations.some(a => Object.values((a.features.notes as Record<string, {text:string}[]> | undefined) ?? {}).some(e => e.length > 0))
    const bracketWidth = maxCol >= 0
      ? (maxCol + 1) * COLUMN_WIDTH + maxCol * COLUMN_GAP
      : 0
    const noteExtra = hasNotes ? NOTE_COL_GAP + NOTE_COL_W : 0
    const gw = Math.max(MIN_GUTTER, 2 * GUTTER_PAD + bracketWidth + noteExtra)

    // Left-aligned: col 0 is closest to the text, higher cols toward the scrollbar.
    const rightBase = gw - GUTTER_PAD - COLUMN_WIDTH

    const computed: Stripe[] = withCols.map(item => ({
      patternId:  item.patternId,
      label:    item.label,
      top:      item.top,
      height:   item.height,
      complete: item.complete,
      right:    rightBase - item.col * (COLUMN_WIDTH + COLUMN_GAP),
      color:    item.color,
    }))

    stripes = computed

    // Aggregate notes by utterance line
    const byUtt = new SvelteMap<string, { top: number; notes: NoteItem[] }>()

    function addNote(uttId: string, mid: number, item: NoteItem) {
      const entry = byUtt.get(uttId)
      if (entry) { entry.notes.push(item) }
      else        { byUtt.set(uttId, { top: mid, notes: [item] }) }
    }

    // Pattern notes: tied to the topmost utterance of the pattern
    for (const pattern of patterns) {
      const patternNotes = pattern.notes ?? {}
      if (!Object.values(patternNotes).some(a => a.length > 0)) continue
      const noteText = Object.entries(patternNotes)
        .flatMap(([a, entries]) => entries.map(e => `${a}: ${e.text}`))
        .join('\n')
      const schema = patternSchemas.find(s => s.id === pattern.schemaId)
      const uttIds = uttIdsForPattern(pattern)
      let topUttId = ''
      let minMid = Infinity
      for (const uttId of uttIds) {
        const el = editorPane.querySelector(`[data-id="${CSS.escape(uttId)}"]`) as HTMLElement | null
        if (!el) continue
        const mid = (relTop(el) + relBottom(el)) / 2
        if (mid < minMid) { minMid = mid; topUttId = uttId }
      }
      if (topUttId) addNote(topUttId, minMid, { text: noteText, label: schema?.name ?? 'Pattern', type: 'pattern', sourceId: pattern.id })
    }

    // Textlet notes: tied to the utterance containing the mark
    for (const ann of annotations) {
      const annNotes = (ann.features.notes as Record<string, { text: string; createdAt: number }[]> | undefined) ?? {}
      const noteText = Object.entries(annNotes)
        .flatMap(([a, entries]) => entries.map(e => `${a}: ${e.text}`))
        .join('\n')
      if (!noteText) continue
      const markAnchor = ann.anchors.find(a => a.type === 'mark')
      if (!markAnchor || markAnchor.type !== 'mark') continue
      const uttId = uttIdForMark(markAnchor.markId)
      if (!uttId) continue
      const el = editorPane.querySelector(`[data-id="${CSS.escape(uttId)}"]`) as HTMLElement | null
      if (!el) continue
      addNote(uttId, (relTop(el) + relBottom(el)) / 2, { text: noteText, label: 'Textlet', type: 'textlet', sourceId: markAnchor.markId })
    }

    lineNotes = Array.from(byUtt.values())
    onWidthChange?.(gw)
  }

  // Setup

  let _ro: ResizeObserver | null = null
  // Holds the doc passed to the most recent refresh() call, so computeStripes
  // always uses the live document rather than the potentially-stale doc prop
  // (currentDoc in App.svelte is non-reactive and may lag behind in collab).
  let _liveDoc: PMNode | null = null

  export function refresh(liveDoc?: PMNode) {
    if (liveDoc) _liveDoc = liveDoc
    requestAnimationFrame(computeStripes)
  }

  onMount(() => {
    if (editorPane) {
      _ro = new ResizeObserver(() => requestAnimationFrame(computeStripes))
      _ro.observe(editorPane)
      editorPane.addEventListener('scroll', computeStripes)
    }
    requestAnimationFrame(computeStripes)
  })

  onDestroy(() => {
    _ro?.disconnect()
    editorPane?.removeEventListener('scroll', computeStripes)
  })

  const patternFillMode = $derived(slotFillMode != null)

  let notePopup            = $state<{ notes: NoteItem[]; x: number; y: number } | null>(null)
  let expandedNoteIndices  = $state<Set<number>>(new Set())

  function openNotePopup(e: MouseEvent, notes: NoteItem[]) {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    notePopup = { notes, x: rect.left, y: rect.bottom + 6 }
    expandedNoteIndices = new Set()
  }

  function closeNotePopup() {
    notePopup = null
    onHoverNoteItem?.('pattern', null)
  }

  function toggleExpanded(i: number) {
    const next = new SvelteSet(expandedNoteIndices)
    if (next.has(i)) next.delete(i); else next.add(i)
    expandedNoteIndices = next
  }
</script>

{#each stripes as stripe (stripe.patternId)}
  {@const selected = selectedPatternId === stripe.patternId}
  {@const peerSels = (peerPatternSelections ?? []).filter(p => p.patternId === stripe.patternId)}
  {@const borderColor = stripe.color !== undefined ? '#' + stripe.color.toString(16).padStart(6, '0') : 'black'}
  <button
    class="bracket"
    class:selected
    class:complete={stripe.complete}
    class:pattern-fill-target={patternFillMode && stripe.patternId !== slotFillMode?.patternId}
    style="top:{stripe.top}px; height:{stripe.height}px; right:{stripe.right}px; width:{COLUMN_WIDTH}px; border-color:{borderColor}"
    title="{stripe.label}{stripe.complete ? '' : ' (incomplete)'}"
    onmouseenter={() => onHoverPattern?.(stripe.patternId)}
    onmouseleave={() => onHoverPattern?.(null)}
    onclick={() => {
      if (slotFillMode != null && stripe.patternId !== slotFillMode.patternId) {
        onFillWithPattern?.(stripe.patternId)
      } else {
        onSelectPattern(stripe.patternId)
      }
    }}
  >
    <span class="label">{stripe.label}</span>

    {#each peerSels as ps, i (ps.color)}
      <span class="peer-dot" style="background:{ps.color}; top:{4 + i * 9}px"></span>
    {/each}
  </button>
{/each}

{#each lineNotes as ln (ln.top)}
  <button
    class="line-note"
    style="top:{ln.top - 5}px; right:{GUTTER_PAD}px"
    aria-label="View note{ln.notes.length > 1 ? 's' : ''}"
    onclick={(e) => openNotePopup(e, ln.notes)}
  >
    <svg viewBox="0 0 8 10" width="{NOTE_ICON_W}" height="10" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M0.5,0.5 H5 L7.5,3 V9.5 H0.5 Z"/>
      <polyline points="5,0.5 5,3 7.5,3"/>
      <line x1="1.5" y1="5" x2="6" y2="5"/>
      <line x1="1.5" y1="6.5" x2="6" y2="6.5"/>
      <line x1="1.5" y1="8.5" x2="4.5" y2="8.5"/>
    </svg>
    {#if ln.notes.length > 1}
      <span class="note-count">{ln.notes.length}</span>
    {/if}
  </button>
{/each}

{#if notePopup}
  <button class="note-popup-backdrop" onclick={closeNotePopup} aria-label="Close note"></button>
  <div class="note-popup" style="left:{notePopup.x}px; top:{notePopup.y}px">
    <div class="note-popup-header">
      <span class="note-popup-title">Note{notePopup.notes.length > 1 ? 's' : ''}</span>
      <button class="note-popup-close" onclick={closeNotePopup} aria-label="Close">×</button>
    </div>
    {#each notePopup.notes as item, i (item.sourceId)}
      {#if notePopup.notes.length === 1}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="note-popup-single"
          onmouseenter={() => onHoverNoteItem?.(item.type, item.sourceId)}
          onmouseleave={() => onHoverNoteItem?.(item.type, null)}
        >
          <div class="note-popup-label">{item.label}</div>
          <p class="note-popup-text">{item.text}</p>
        </div>
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="note-popup-item"
          class:note-popup-item--sep={i > 0}
          onmouseenter={() => onHoverNoteItem?.(item.type, item.sourceId)}
          onmouseleave={() => onHoverNoteItem?.(item.type, null)}
        >
          <button class="note-popup-toggle" onclick={() => toggleExpanded(i)}>
            <span class="note-popup-arrow">{expandedNoteIndices.has(i) ? '▾' : '▸'}</span>
            <span class="note-popup-label">{item.label}</span>
          </button>
          {#if expandedNoteIndices.has(i)}
            <p class="note-popup-text">{item.text}</p>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* ] bracket: right bar + top/bottom caps, rounded right corners */
  .bracket {
    position: absolute;
    border-left: none;
    border-right: 1.5px solid black;
    border-top: 1.5px solid black;
    border-bottom: 1.5px solid black;
    border-radius: 0 4px 4px 0;
    opacity: 0.18;
    cursor: pointer;
    transition: opacity 0.12s;
    z-index: 4;
    overflow: visible;
    display: flex;
    align-items: center;
    background: none; padding: 0; font: inherit; color: inherit;
    justify-content: center;
  }

  .bracket.complete { opacity: 0.45; }
  .bracket.selected { opacity: 1 !important; }
  .bracket:hover    { opacity: 1 !important; }

  .bracket.pattern-fill-target { opacity: 0.35; border-color: #2e7d32 !important; }
  .bracket.pattern-fill-target:hover { opacity: 1 !important; background: #e8f5e9; }

  /* Vertical label, bottom of text faces left (reads upward) */
  .label {
    writing-mode: vertical-rl;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: black;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-height: calc(100% - 8px);
    pointer-events: none;
  }

  .line-note {
    position: absolute;
    color: #aaa;
    cursor: pointer;
    z-index: 6;
    display: flex;
    align-items: center;
    background: none;
    border: none;
    padding: 0;
    transition: color 0.1s;
  }
  .line-note:hover { color: #333; }

  .note-count {
    position: absolute;
    top: -4px;
    right: -5px;
    font-size: 8px;
    font-weight: 700;
    line-height: 1;
    background: #888;
    color: #fff;
    border-radius: 6px;
    padding: 0 2px;
    min-width: 10px;
    text-align: center;
  }

  .peer-dot {
    position: absolute;
    left: 2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    pointer-events: none;
    opacity: 0.85;
  }

  .note-popup-backdrop {
    position: fixed;
    inset: 0;
    z-index: 999;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
  }

  .note-popup {
    position: fixed;
    z-index: 1000;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 5px;
    box-shadow: 0 3px 10px rgba(0,0,0,0.14);
    font-size: 0.8rem;
    max-width: 280px;
    min-width: 180px;
    word-break: break-word;
    color: #222;
    overflow: hidden;
  }

  .note-popup-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.3rem 0.5rem 0.3rem 0.65rem;
    border-bottom: 1px solid #eee;
    background: #f8f8f8;
  }

  .note-popup-title {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #888;
  }

  .note-popup-close {
    background: none;
    border: none;
    padding: 0 2px;
    font-size: 1rem;
    line-height: 1;
    color: #aaa;
    cursor: pointer;
    border-radius: 3px;
  }
  .note-popup-close:hover { color: #333; background: #eee; }

  .note-popup-single {
    padding: 0.1rem 0;
  }
  .note-popup-single:hover { background: #f5f5f5; }

  .note-popup-item {
    padding: 0.3rem 0.65rem 0.3rem 0;
  }
  .note-popup-item--sep {
    border-top: 1px solid #eee;
  }

  .note-popup-toggle {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    background: none;
    border: none;
    padding: 0.1rem 0.65rem;
    cursor: pointer;
    font: inherit;
    text-align: left;
    border-radius: 3px;
  }
  .note-popup-toggle:hover { background: #f5f5f5; }

  .note-popup-arrow {
    font-size: 0.65rem;
    color: #888;
    flex-shrink: 0;
  }

  .note-popup-label {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #666;
    padding: 0.3rem 0.65rem 0.1rem;
    display: block;
  }

  .note-popup-text {
    margin: 0;
    line-height: 1.45;
    white-space: pre-wrap;
    padding: 0.1rem 0.65rem 0.4rem;
  }
</style>
