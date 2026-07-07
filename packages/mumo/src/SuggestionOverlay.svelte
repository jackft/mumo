<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import type { AnnotationStore, Suggestion } from '@mumo/core'

  interface Props {
    store: AnnotationStore
    editorContainer: HTMLElement | undefined
  }

  let { store, editorContainer }: Props = $props()

  // Card state

  type Card =
    | { kind: 'replace'; suggestionId: string; note: string; x: number; y: number; flip: boolean }
    | { kind: 'participant'; uttId: string; suggestions: Suggestion[]; x: number; y: number; flip: boolean }

  let activeCard: Card | null = $state(null)
  let hideCardTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleHideCard(): void {
    if (hideCardTimer) { clearTimeout(hideCardTimer) }
    hideCardTimer = setTimeout(() => { activeCard = null }, 400)
  }
  function cancelHideCard(): void {
    if (hideCardTimer) { clearTimeout(hideCardTimer); hideCardTimer = null }
  }

  // Horizontal positioning: align ✗ button above the cursor.
  // Y stays anchored to the hovered element's bottom edge (like a tooltip).
  const BUTTON_OFFSET = 16   // px from card leading edge to ✓ button centre
  const CARD_MAX_W   = 290   // conservative width estimate for flip detection
  const VIEWPORT_PAD = 8

  function _needsFlip(mouseX: number): boolean {
    return mouseX - BUTTON_OFFSET + CARD_MAX_W > window.innerWidth - VIEWPORT_PAD
  }

  function _cardStyle(card: Card): string {
    if (card.flip) {
      const right = window.innerWidth - card.x - BUTTON_OFFSET
      return `right:${right}px; top:${card.y}px`
    }
    return `left:${card.x - BUTTON_OFFSET}px; top:${card.y}px`
  }

  // Preview CSS injection

  let _previewStyleEl: HTMLStyleElement | null = null

  function _getPreviewStyleEl(): HTMLStyleElement {
    if (!_previewStyleEl) {
      _previewStyleEl = document.createElement('style')
      _previewStyleEl.id = 'mumo-sug-preview'
      document.head.appendChild(_previewStyleEl)
    }
    return _previewStyleEl
  }

  function _clearPreview(): void {
    if (_previewStyleEl) _previewStyleEl.textContent = ''
  }

  function _previewReplace(suggestionId: string, action: 'accept' | 'reject'): void {
    const id = CSS.escape(suggestionId)
    const css = action === 'accept' ? [
      `.suggestion-delete[data-suggestion-id="${id}"] { display: none; }`,
      `.suggestion-insert[data-suggestion-id="${id}"] { background: transparent !important; text-decoration: none !important; }`,
    ] : [
      `.suggestion-insert[data-suggestion-id="${id}"] { display: none; }`,
      `.suggestion-delete[data-suggestion-id="${id}"] { background: transparent !important; text-decoration: none !important; }`,
    ]
    _getPreviewStyleEl().textContent = css.join('\n')
  }

  function _previewParticipant(uttId: string, participant: string, action: 'accept' | 'reject'): void {
    const id  = CSS.escape(uttId)
    // Escape participant for use as a CSS string literal
    const p   = participant.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const css = action === 'accept' ? [
      // Hide current text (including ::after colon) and overlay replacement via ::before.
      // ::before uses inset:0 + text-align:right to match the original right-aligned layout.
      `[data-id="${id}"] .utt-speaker { color: transparent !important; position: relative !important; background: #dcfce7 !important; outline-color: #16a34a !important; }`,
      `[data-id="${id}"] .utt-speaker::after { color: transparent !important; }`,
      `[data-id="${id}"] .utt-speaker::before { content: "${p}:"; position: absolute; inset: 0; text-align: right; color: #15803d; }`,
    ] : [
      // Reject preview: suggestion goes away — remove yellow highlight
      `[data-id="${id}"] .utt-speaker { background: transparent !important; outline: none !important; }`,
    ]
    _getPreviewStyleEl().textContent = css.join('\n')
  }

  // utt:set-participant yellow highlight injection

  let _participantSugs = new Map<string, Suggestion[]>()
  let _highlightStyleEl: HTMLStyleElement | null = null

  function _getHighlightStyleEl(): HTMLStyleElement {
    if (!_highlightStyleEl) {
      _highlightStyleEl = document.createElement('style')
      _highlightStyleEl.id = 'mumo-participant-sug-highlights'
      document.head.appendChild(_highlightStyleEl)
    }
    return _highlightStyleEl
  }

  function _refreshParticipantSugs(): void {
    const next = new SvelteMap<string, Suggestion[]>()
    for (const sug of store.allSuggestions()) {
      if (sug.change.type === 'utt:set-participant') {
        const list = next.get(sug.change.uttId) ?? []
        list.push(sug)
        next.set(sug.change.uttId, list)
      }
    }
    _participantSugs = next
    const rules: string[] = []
    for (const uttId of next.keys()) {
      const esc = CSS.escape(uttId)
      rules.push(`[data-id="${esc}"] .utt-speaker { background: #fef9c3; outline: 1.5px solid #ca8a04; border-radius: 2px; cursor: pointer; }`)
    }
    _getHighlightStyleEl().textContent = rules.join('\n')
  }

  // Mouse event handling

  function handleEditorMouseOver(e: MouseEvent): void {
    const target = e.target as HTMLElement | null
    const mx = e.clientX

    // pm:replace — hovered a suggestion-marked span
    const span = target?.closest('[data-suggestion-id]') as HTMLElement | null
    if (span) {
      const suggestionId = span.getAttribute('data-suggestion-id')
      if (suggestionId) {
        const sug = store.getSuggestion(suggestionId)
        if (sug?.change.type === 'pm:replace') {
          cancelHideCard()
          if (activeCard?.kind !== 'replace' || activeCard.suggestionId !== suggestionId) {
            const rect = span.getBoundingClientRect()
            activeCard = { kind: 'replace', suggestionId, note: sug.note ?? '', x: mx, y: rect.bottom + 2, flip: _needsFlip(mx) }
          }
          return
        }
      }
    }

    // utt:set-participant — hovered the speaker label
    const speakerEl = target?.closest('.utt-speaker') as HTMLElement | null
    if (speakerEl) {
      const rowEl = speakerEl.closest('[data-id]') as HTMLElement | null
      const uttId = rowEl?.getAttribute('data-id')
      if (uttId) {
        const sugs = _participantSugs.get(uttId)
        if (sugs?.length) {
          cancelHideCard()
          if (activeCard?.kind !== 'participant' || activeCard.uttId !== uttId) {
            const rect = speakerEl.getBoundingClientRect()
            activeCard = { kind: 'participant', uttId, suggestions: sugs, x: mx, y: rect.bottom + 2, flip: _needsFlip(mx) }
          }
          return
        }
      }
    }

    scheduleHideCard()
  }

  // Accept / reject

  function accept(id: string): void { _clearPreview(); activeCard = null; store.acceptSuggestion(id) }
  function reject(id: string): void { _clearPreview(); activeCard = null; store.rejectSuggestion(id) }

  // Lifecycle

  onMount(() => {
    store.on('suggestions:changed', _refreshParticipantSugs)
    _refreshParticipantSugs()
    editorContainer?.addEventListener('mouseover', handleEditorMouseOver)
    editorContainer?.addEventListener('mouseleave', scheduleHideCard)
    return () => {
      store.off('suggestions:changed', _refreshParticipantSugs)
      editorContainer?.removeEventListener('mouseover', handleEditorMouseOver)
      editorContainer?.removeEventListener('mouseleave', scheduleHideCard)
    }
  })

  onDestroy(() => {
    _highlightStyleEl?.remove(); _highlightStyleEl = null
    _previewStyleEl?.remove();  _previewStyleEl  = null
  })
</script>

<!-- Floating card — shared for pm:replace and utt:set-participant -->
{#if activeCard !== null}
  <div
    class="sug-menu"
    class:flip={activeCard.flip}
    style={_cardStyle(activeCard)}
    onmouseenter={cancelHideCard}
    onmouseleave={() => { scheduleHideCard(); _clearPreview() }}
    onmouseover={(e) => e.stopPropagation()}
    onfocus={() => {}}
    role="menu"
    tabindex="-1"
  >
    {#if activeCard.kind === 'replace'}
      {@const id   = activeCard.suggestionId}
      {@const note = activeCard.note}
      <div class="sug-row">
        <button class="sug-btn sug-x" title="Reject"
          onmouseenter={() => _previewReplace(id, 'reject')}
          onmouseleave={_clearPreview}
          onclick={() => reject(id)}>✗</button>
        <button class="sug-btn sug-check" title="Accept"
          onmouseenter={() => _previewReplace(id, 'accept')}
          onmouseleave={_clearPreview}
          onclick={() => accept(id)}>✓</button>
        {#if note}<span class="sug-comment">{note}</span>{/if}
      </div>
    {:else}
      {@const sugs = activeCard.suggestions}
      {#each sugs as sug (sug.id)}
        {@const participant = (sug.change as { participant: string }).participant}
        {@const uttId = (sug.change as { uttId: string }).uttId}
        <div class="sug-row">
          <button class="sug-btn sug-x" title="Reject"
            onmouseenter={() => _previewParticipant(uttId, participant, 'reject')}
            onmouseleave={_clearPreview}
            onclick={() => reject(sug.id)}>✗</button>
          <button class="sug-btn sug-check" title="Accept"
            onmouseenter={() => _previewParticipant(uttId, participant, 'accept')}
            onmouseleave={_clearPreview}
            onclick={() => accept(sug.id)}>✓</button>
          <span class="sug-comment">→ {participant}:{sug.note ? ` · ${sug.note}` : ''}</span>
        </div>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .sug-menu {
    position: fixed;
    z-index: 500;
    background: var(--color-bg-0, #fff);
    border: 1px solid var(--color-border, #ddd);
    border-radius: var(--radius-md, 4px);
    box-shadow: var(--shadow-menu-sm, 0 2px 8px rgba(0,0,0,0.15));
    padding: 3px 0;
    pointer-events: all;
    white-space: nowrap;
  }

  .sug-row {
    display: flex;
    align-items: center;
    padding: 0.2rem 0.25rem;
    gap: 0.18rem;
  }

  /* Flip: reverse row so buttons sit on the right edge above the cursor */
  .flip .sug-row { flex-direction: row-reverse; }

  .sug-btn {
    padding: 0 0.28rem;
    border-radius: var(--radius-xs, 3px);
    border: 1px solid;
    background: none;
    cursor: pointer;
    font-size: 0.78rem;
    line-height: 1.5;
    flex-shrink: 0;
  }
  .sug-check { color: var(--color-active-dark, #15803d); border-color: var(--color-active, #16a34a); }
  .sug-check:hover { background: var(--color-active-light, #dcfce7); }
  .sug-x { color: var(--color-danger, #b91c1c); border-color: var(--color-danger, #b91c1c); }
  .sug-x:hover { background: var(--color-danger-light, #fee2e2); }

  .sug-comment {
    font-size: 0.82rem;
    color: var(--color-text-1, #555);
    padding: 0 0.25rem;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
