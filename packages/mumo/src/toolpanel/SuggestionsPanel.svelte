<script lang="ts">
  import type { AnnotationStore, Suggestion, SuggestedChange, PatternSchema, Pattern, TokenStore } from '@mumo/core'
  import { getMarkText, getWordRangeText } from '@mumo/core'
  import type { PMNode } from '@mumo/core'

  const {
    store,
    doc,
    patternSchemas = [],
    patterns = [],
    tokenStore,
    onSelectPattern,
  }: {
    store: AnnotationStore
    doc: PMNode
    patternSchemas?: PatternSchema[]
    patterns?: Pattern[]
    tokenStore?: TokenStore
    onSelectPattern?: (id: string) => void
  } = $props()

  let suggestions = $state<Suggestion[]>([])

  $effect(() => {
    const s = store
    const update = () => { suggestions = s.allSuggestions() }
    update()
    s.on('suggestions:changed', update)
    return () => s.off('suggestions:changed', update)
  })

  // Author grouping

  type AuthorGroup = { authorId: string; label: string; suggestions: Suggestion[] }

  const authorGroups = $derived.by((): AuthorGroup[] => {
    const order: string[] = []
    const map: Record<string, Suggestion[]> = {}
    for (const sug of suggestions) {
      if (!map[sug.authorId]) { order.push(sug.authorId); map[sug.authorId] = [] }
      map[sug.authorId]!.push(sug)
    }
    return order.map(authorId => ({
      authorId,
      label: formatAuthor(authorId),
      suggestions: map[authorId]!,
    }))
  })

  // Helpers

  function formatAuthor(authorId: string): string {
    return authorId.replace(/^(?:ai:|user:)/, '')
  }

  function isAI(authorId: string): boolean {
    return authorId.startsWith('ai:')
  }

  function formatTimestamp(ms: number): string {
    const d = new Date(ms)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  function truncate(s: string, n = 40): string {
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }

  // Rich description builders

  function getPatternLabel(patternId: string): string {
    const p = patterns.find(x => x.id === patternId)
    if (!p) return '(pattern)'
    const schema = patternSchemas.find(s => s.id === p.schemaId)
    return schema?.name ?? '(pattern)'
  }

  function getSlotLabel(patternId: string, slotSchemaId: string): string {
    const p = patterns.find(x => x.id === patternId)
    if (!p) return slotSchemaId
    const schema = patternSchemas.find(s => s.id === p.schemaId)
    const slot = schema?.slots.find(sl => sl.id === slotSchemaId)
    return slot?.label ?? slot?.name ?? slotSchemaId
  }

  function getTextletText(textletId: string): string {
    const ann = store.getAnnotation(textletId)
    if (!ann) return '(textlet)'
    const markAnchor = ann.anchors.find(a => a.type === 'mark')
    if (markAnchor && markAnchor.type === 'mark') {
      const t = getMarkText(doc, markAnchor.markId)
      return t ? truncate(`"${t}"`) : '(textlet)'
    }
    const wordRange = ann.anchors.find(a => a.type === 'word-range')
    if (wordRange && wordRange.type === 'word-range' && tokenStore) {
      const t = getWordRangeText(doc, wordRange.fromWordId, wordRange.toWordId, tokenStore)
      return t ? truncate(`"${t}"`) : '(textlet)'
    }
    return '(textlet)'
  }

  function getUttParticipant(uttId: string): string {
    let participant = ''
    doc.forEach(node => {
      if (node.attrs['id'] === uttId) {
        participant = String(node.attrs['participant'] ?? '')
      }
    })
    return participant || uttId.slice(0, 6)
  }

  function uttTextAround(uttId: string, from: number, to: number): string {
    let result = ''
    doc.forEach(node => {
      if (node.attrs['id'] === uttId) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result = (node as any).textBetween(from, to, ' ')
        } catch { /* out of range */ }
      }
    })
    return result
  }

  type RichLabel = { primary: string; detail?: string; kind: 'add' | 'remove' | 'update' | 'neutral' }
  function rl(primary: string, kind: RichLabel['kind'], detail?: string): RichLabel {
    return detail ? { primary, kind, detail } : { primary, kind }
  }

  function richLabel(c: SuggestedChange): RichLabel {
    switch (c.type) {
      case 'pm:replace': {
        const old = uttTextAround(c.uttId, c.fromOffset, c.toOffset)
        const participant = getUttParticipant(c.uttId)
        if (c.fromOffset === c.toOffset) return rl(`insert: "${c.replacement}"`, 'add', participant)
        if (c.replacement === '')        return rl(old ? `delete: "${truncate(old, 30)}"` : 'delete text', 'remove', participant)
        return rl(old ? `"${truncate(old, 25)}" → "${c.replacement}"` : `→ "${c.replacement}"`, 'update', participant)
      }
      case 'utt:set-participant': {
        const participant = getUttParticipant(c.uttId)
        return rl(`participant → ${c.participant}`, 'update', participant ? `was: ${participant}` : undefined)
      }
      case 'utt:set-time': {
        const participant = getUttParticipant(c.uttId)
        return rl(`time → ${c.startTime.toFixed(2)}–${c.endTime.toFixed(2)}s`, 'update', participant)
      }
      case 'textlet:add': {
        const a = c.annotation
        const wr = a.anchors.find(x => x.type === 'word-range')
        const txt = wr && wr.type === 'word-range' && tokenStore
          ? getWordRangeText(doc, wr.fromWordId, wr.toWordId, tokenStore)
          : ''
        return { primary: txt ? `+ textlet: "${truncate(txt, 35)}"` : '+ textlet', kind: 'add' }
      }
      case 'textlet:delete':
        return { primary: `delete textlet`, detail: getTextletText(c.textletId), kind: 'remove' }
      case 'textlet:add-code':
        return { primary: `+ code: ${c.code.value}`, detail: getTextletText(c.textletId), kind: 'add' }
      case 'textlet:remove-code':
        return { primary: `- code: ${c.code.value}`, detail: getTextletText(c.textletId), kind: 'remove' }
      case 'pattern:add': {
        const schema = patternSchemas.find(s => s.id === c.schemaId)
        return { primary: `+ ${schema?.name ?? 'pattern'}`, kind: 'add' }
      }
      case 'pattern:delete':
        return { primary: `delete ${getPatternLabel(c.patternId)}`, kind: 'remove' }
      case 'pattern:fill-slot': {
        const pLabel = getPatternLabel(c.patternId)
        const sLabel = getSlotLabel(c.patternId, c.slot.schemaSlotId)
        return { primary: `fill: ${sLabel}`, detail: pLabel, kind: 'update' }
      }
      case 'pattern:fill-metric': {
        const pLabel = getPatternLabel(c.patternId)
        const sLabel = getSlotLabel(c.patternId, c.slotSchemaId)
        const p = patterns.find(x => x.id === c.patternId)
        const schema = patternSchemas.find(s => s.id === p?.schemaId)
        const metric = schema?.slots.flatMap(sl => sl.metrics).find(m => m.id === c.metricId)
        const mLabel = metric?.name ?? c.metricId
        return { primary: `${mLabel} → ${String(c.value) || '(clear)'}`, detail: `${pLabel}: ${sLabel}`, kind: 'update' }
      }
      case 'annotation:add': {
        const tierId = c.annotation.features['tierId'] as string | undefined
        const tier = tierId ? store.getTier(tierId) : undefined
        const ta = c.annotation.anchors.find(a => a.type === 'time')
        const timeStr = ta && ta.type === 'time' ? ` ${ta.start.toFixed(2)}–${ta.end.toFixed(2)}s` : ''
        return { primary: `+ ${tier?.name ?? 'annotation'}${timeStr}`, kind: 'add' }
      }
      case 'annotation:delete': {
        const ann = store.getAnnotation(c.annotationId)
        const tierId = ann?.features['tierId'] as string | undefined
        const tier = tierId ? store.getTier(tierId) : undefined
        return { primary: `delete ${tier?.name ?? 'annotation'}`, kind: 'remove' }
      }
      case 'annotation:update': {
        const ann = store.getAnnotation(c.annotationId)
        const tierId = ann?.features['tierId'] as string | undefined
        const tier = tierId ? store.getTier(tierId) : undefined
        const ta = c.patch.anchors?.find(a => a.type === 'time')
        const timeStr = ta && ta.type === 'time' ? ` → ${ta.start.toFixed(2)}–${ta.end.toFixed(2)}s` : ''
        return { primary: `update ${tier?.name ?? 'annotation'}${timeStr}`, kind: 'update' }
      }
      default:
        return { primary: (c as { type: string }).type, kind: 'neutral' }
    }
  }

  // Navigate to context when clicking suggestion label
  function navigate(sug: Suggestion): void {
    const c = sug.change
    if ((c.type === 'pattern:fill-slot' || c.type === 'pattern:fill-metric' || c.type === 'pattern:delete') && onSelectPattern) {
      const patternId = 'patternId' in c ? c.patternId : undefined
      if (patternId) onSelectPattern(patternId)
    }
    if (c.type === 'pattern:add' && onSelectPattern) {
      onSelectPattern(c.patternId)
    }
  }

  function accept(id: string): void { store.acceptSuggestion(id) }
  function reject(id: string): void { store.rejectSuggestion(id) }
  function acceptGroup(sugs: Suggestion[]): void { for (const s of [...sugs]) store.acceptSuggestion(s.id) }
  function rejectGroup(sugs: Suggestion[]): void { for (const s of [...sugs]) store.rejectSuggestion(s.id) }
  function acceptAll(): void { for (const s of [...suggestions]) store.acceptSuggestion(s.id) }
  function rejectAll(): void { for (const s of [...suggestions]) store.rejectSuggestion(s.id) }
</script>

<div class="prov-panel">
  {#if suggestions.length === 0}
    <p class="empty">No pending suggestions.</p>
  {:else}
    <div class="bulk-row">
      <button class="bulk-btn reject" onclick={rejectAll}>✗ reject all</button>
      <button class="bulk-btn accept" onclick={acceptAll}>✓ accept all</button>
    </div>

    {#each authorGroups as group (group.authorId)}
      <div class="author-group">
        <div class="author-header">
          <span class="author-name" class:ai-badge={isAI(group.authorId)}>{group.label}</span>
          <span class="author-count">{group.suggestions.length}</span>
          <div class="group-actions">
            <button class="group-btn reject" title="Reject all from {group.label}"
              onclick={() => rejectGroup(group.suggestions)}>✗ all</button>
            <button class="group-btn accept" title="Accept all from {group.label}"
              onclick={() => acceptGroup(group.suggestions)}>✓ all</button>
          </div>
        </div>

        <ul class="sug-list">
          {#each group.suggestions as sug (sug.id)}
            {@const { primary, detail, kind } = richLabel(sug.change)}
            <li class="sug-item" class:kind-add={kind === 'add'} class:kind-remove={kind === 'remove'}>
              <div class="sug-main">
                <div class="sug-text" role="button" tabindex="0"
                  onclick={() => navigate(sug)}
                  onkeydown={(e) => e.key === 'Enter' && navigate(sug)}
                >
                  <span class="sug-primary">{primary}</span>
                  {#if detail}<span class="sug-detail">{detail}</span>{/if}
                </div>
                <div class="sug-actions">
                  <button class="act-btn act-x" title="Reject" onclick={() => reject(sug.id)}>✗</button>
                  <button class="act-btn act-check" title="Accept" onclick={() => accept(sug.id)}>✓</button>
                </div>
              </div>
              {#if sug.note}
                <p class="sug-note">{sug.note}</p>
              {/if}
              <p class="sug-meta">{formatTimestamp(sug.createdAt)}</p>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}
</div>

<style>
  .prov-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 0.4rem 0;
  }

  .empty {
    color: #999;
    font-size: 0.78rem;
    text-align: center;
    padding: 1.5rem 0.5rem;
    margin: 0;
  }

  .bulk-row {
    display: flex;
    gap: 0.4rem;
    padding: 0.3rem 0.5rem 0.4rem;
    border-bottom: 1px solid var(--color-border, #ddd);
    flex-shrink: 0;
  }
  .bulk-btn {
    flex: 1;
    padding: 0.2rem 0.4rem;
    font-size: 0.72rem;
    border-radius: 3px;
    border: 1px solid;
    background: none;
    cursor: pointer;
    font-family: inherit;
  }
  .bulk-btn.reject { color: #b91c1c; border-color: #b91c1c; }
  .bulk-btn.reject:hover { background: #fee2e2; }
  .bulk-btn.accept { color: #15803d; border-color: #16a34a; }
  .bulk-btn.accept:hover { background: #dcfce7; }

  /* ── Author group ────────────────────────────────────────────────────────── */

  .author-group {
    border-bottom: 1px solid var(--color-border, #ddd);
  }

  .author-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.5rem 0.25rem;
    background: var(--color-bg-2, #f5f5f5);
    border-bottom: 1px solid var(--color-border, #ddd);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .author-name {
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--color-text-2, #444);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-badge {
    color: var(--color-primary-dark, #1a5c8a);
  }
  .ai-badge::before {
    content: '✦ ';
    font-size: 0.65rem;
    opacity: 0.7;
  }

  .author-count {
    font-size: 0.65rem;
    color: var(--color-text-muted, #aaa);
    background: var(--color-bg-3, #eee);
    border-radius: 8px;
    padding: 0 5px;
    line-height: 1.5;
    flex-shrink: 0;
  }

  .group-actions {
    display: flex;
    gap: 0.15rem;
    flex-shrink: 0;
  }

  .group-btn {
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    border: 1px solid;
    background: none;
    cursor: pointer;
    font-size: 0.65rem;
    line-height: 1.5;
    font-family: inherit;
  }
  .group-btn.reject { color: #b91c1c; border-color: #b91c1c; }
  .group-btn.reject:hover { background: #fee2e2; }
  .group-btn.accept { color: #15803d; border-color: #16a34a; }
  .group-btn.accept:hover { background: #dcfce7; }

  /* ── Suggestion list ─────────────────────────────────────────────────────── */

  .sug-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .sug-item {
    padding: 0.3rem 0.5rem 0.22rem;
    border-bottom: 1px solid var(--color-border, #e8e8e8);
    border-left: 3px solid transparent;
  }
  .sug-item.kind-add    { border-left-color: #86efac; }
  .sug-item.kind-remove { border-left-color: #fca5a5; }

  .sug-main {
    display: flex;
    align-items: flex-start;
    gap: 0.3rem;
  }

  .sug-text {
    flex: 1;
    min-width: 0;
    cursor: default;
    display: flex;
    flex-direction: column;
    gap: 0.08rem;
  }

  .sug-primary {
    font-size: 0.78rem;
    color: var(--color-text-1, #333);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sug-detail {
    font-size: 0.65rem;
    color: var(--color-text-muted, #999);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sug-actions {
    display: flex;
    gap: 0.18rem;
    flex-shrink: 0;
    align-self: center;
  }

  .act-btn {
    padding: 0 0.28rem;
    border-radius: 3px;
    border: 1px solid;
    background: none;
    cursor: pointer;
    font-size: 0.72rem;
    line-height: 1.5;
  }
  .act-x     { color: #b91c1c; border-color: #b91c1c; }
  .act-x:hover { background: #fee2e2; }
  .act-check { color: #15803d; border-color: #16a34a; }
  .act-check:hover { background: #dcfce7; }

  .sug-note {
    margin: 0.12rem 0 0;
    font-size: 0.72rem;
    color: var(--color-text-2, #555);
    font-style: italic;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.35;
  }

  .sug-meta {
    margin: 0.08rem 0 0;
    font-size: 0.65rem;
    color: var(--color-text-muted, #aaa);
  }
</style>
