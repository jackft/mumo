<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import type { AnnotationStore, Annotation, Pattern, ControlledVocabulary, TextletCode, Suggestion, TokenStore, NoteEntry } from '@mumo/core'
  import { getMarkText, getWordRangeText } from '@mumo/core'
  import type { PMNode } from '@mumo/core'

  const { store, annotations, patterns, vocabs, doc, tokenStore, onDelete, onHoverMark, suggestMode = false, myAuthorId = 'Anonymous' }: {
    store: AnnotationStore
    annotations: Annotation[]
    patterns: Pattern[]
    vocabs: ControlledVocabulary[]
    doc: PMNode
    tokenStore: TokenStore
    onDelete: (annId: string, markId: string) => void
    onHoverMark: (markId: string | null) => void
    suggestMode?: boolean
    myAuthorId?: string
  } = $props()

  let _suggestions = $state<Suggestion[]>([])
  onMount(() => {
    _suggestions = store.allSuggestions()
    const update = () => { _suggestions = store.allSuggestions() }
    store.on('suggestions:changed', update)
    return () => store.off('suggestions:changed', update)
  })

  const textlets = $derived(
    annotations.filter(a => a.anchors.some(x => x.type === 'mark'))
  )

  let expandedId       = $state<string | null>(null)
  let expandedGhostId  = $state<string | null>(null)
  let codeInput        = $state('')
  let ghostCodeInputs  = $state<Map<string, string>>(new Map())
  let notePopup   = $state<{ text: string; x: number; y: number } | null>(null)
  let sugNotePopup = $state<{ text: string; author: string; x: number; y: number } | null>(null)

  function markTruncated(el: HTMLElement) {
    const update = () => el.classList.toggle('truncated', el.scrollWidth > el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return { destroy() { ro.disconnect() } }
  }

  function openNotePopup(e: MouseEvent, text: string) {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    notePopup = { text, x: rect.left, y: rect.bottom + 6 }
  }

  function openSugNotePopup(e: MouseEvent, sug: Suggestion) {
    if (!sug.note) return
    const el = e.currentTarget as HTMLElement
    if (el.scrollWidth <= el.clientWidth) return
    e.stopPropagation()
    const rect = el.getBoundingClientRect()
    sugNotePopup = { text: sug.note, author: formatAuthor(sug.authorId), x: rect.left, y: rect.bottom + 6 }
  }

  function formatAuthor(authorId: string): string {
    return authorId.replace(/^(?:ai:|user:)/, '')
  }
  function formatTimestamp(ms: number): string {
    const d = new Date(ms)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  function deleteSugs(textletId: string): Suggestion[] {
    return _suggestions.filter(s => s.change.type === 'textlet:delete' && s.change.textletId === textletId)
  }
  function addCodeSugs(textletId: string): Suggestion[] {
    return _suggestions.filter(s => s.change.type === 'textlet:add-code' && s.change.textletId === textletId)
  }
  function removeCodeSugs(textletId: string): Suggestion[] {
    return _suggestions.filter(s => s.change.type === 'textlet:remove-code' && s.change.textletId === textletId)
  }
  const addSugs = $derived(_suggestions.filter(s => s.change.type === 'textlet:add'))

  function toggle(id: string) {
    expandedId = expandedId === id ? null : id
    codeInput = ''
  }

  function referencingFrames(annId: string): Pattern[] {
    return patterns.filter(f => f.slots.some(s => s.annotationId === annId))
  }

  function deleteTextlet(t: Annotation) {
    if (suggestMode) {
      store.addSuggestion({ type: 'textlet:delete', textletId: t.id }, 'user:local')
      return
    }
    const refs = referencingFrames(t.id)
    if (refs.length > 0) {
      const names = refs.map(f => {
        const schema = store.getPatternSchema(f.schemaId)
        return schema?.name ?? f.id.slice(0, 6)
      }).join(', ')
      if (!confirm(`This textlet is referenced by: ${names}.\nDelete anyway?`)) return
    }
    const markAnchor = t.anchors.find(a => a.type === 'mark')
    if (markAnchor && markAnchor.type === 'mark') {
      onDelete(t.id, markAnchor.markId)
    }
  }

  function setFeature(t: Annotation, key: string, value: unknown) {
    store.updateAnnotation(t.id, { features: { [key]: value } })
  }

  function clearFeature(t: Annotation, key: string) {
    store.updateAnnotation(t.id, { features: { [key]: undefined } })
  }

  function editableNoteAuthors(): string[] {
    return Array.from(new Set([myAuthorId, 'Anonymous']))
  }

  function textletNotes(t: Annotation): Record<string, NoteEntry[]> {
    return (t.features.notes as Record<string, NoteEntry[]> | undefined) ?? {}
  }

  function hasAnyNotes(t: Annotation): boolean {
    return Object.values(textletNotes(t)).some(a => a.length > 0)
  }

  function notesSummaryText(t: Annotation): string {
    const notes = textletNotes(t)
    const editable = editableNoteAuthors()
    for (const a of editable) {
      const entries = notes[a]
      if (entries?.length) return entries[entries.length - 1]!.text
    }
    const first = Object.values(notes)[0]
    return first?.[0]?.text ?? ''
  }

  function addTextletNote(t: Annotation) {
    const existing = textletNotes(t)
    const entries = [...(existing[myAuthorId] ?? []), { text: '', createdAt: Date.now() }]
    setFeature(t, 'notes', { ...existing, [myAuthorId]: entries })
  }

  function updateTextletNote(t: Annotation, authorId: string, index: number, text: string) {
    const existing = textletNotes(t)
    const entries: NoteEntry[] = [...(existing[authorId] ?? [])]
    if (index < 0 || index >= entries.length) return
    entries[index] = { createdAt: entries[index]!.createdAt, text }
    setFeature(t, 'notes', { ...existing, [authorId]: entries })
  }

  function deleteTextletNote(t: Annotation, authorId: string, index: number) {
    const existing = textletNotes(t)
    const entries = (existing[authorId] ?? []).filter((_, i) => i !== index)
    const { [authorId]: _removed, ...rest } = existing
    const updated = entries.length ? { ...rest, [authorId]: entries } : rest
    if (Object.keys(updated).length) setFeature(t, 'notes', updated)
    else clearFeature(t, 'notes')
  }

  function fmtNoteDate(ts: number): string {
    const d = new Date(ts)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  function codes(t: Annotation): TextletCode[] {
    const raw = t.features.codes as (string | TextletCode)[] | undefined
    if (!raw) return []
    return raw.map(c => typeof c === 'string' ? { value: c } : c)
  }

  function addCode(t: Annotation, value: string, vocabEntryId?: string, vocabId?: string) {
    const v = value.trim()
    if (!v) return
    const ann = store.getAnnotation(t.id)
    if (!ann) return
    const existing = codes(ann)
    const isDuplicate = vocabEntryId
      ? existing.some(c => c.vocabEntryId === vocabEntryId)
      : existing.some(c => !c.vocabEntryId && c.value === v)
    if (isDuplicate) return
    const newCode: TextletCode = vocabEntryId
      ? { value: v, vocabEntryId, ...(vocabId ? { vocabId } : {}) }
      : { value: v }
    if (suggestMode) {
      store.addSuggestion({ type: 'textlet:add-code', textletId: t.id, code: newCode }, 'user:local')
    } else {
      setFeature(t, 'codes', [...existing, newCode])
    }
    codeInput = ''
  }

  function removeCode(t: Annotation, code: TextletCode) {
    if (suggestMode) {
      store.addSuggestion({ type: 'textlet:remove-code', textletId: t.id, code }, 'user:local')
      return
    }
    const ann = store.getAnnotation(t.id)
    if (!ann) return
    const next = codes(ann).filter(c =>
      code.vocabEntryId ? c.vocabEntryId !== code.vocabEntryId : (c.vocabEntryId == null && c.value !== code.value)
    )
    if (next.length > 0) setFeature(t, 'codes', next)
    else clearFeature(t, 'codes')
  }

  // Ghost textlet helpers (editing the pending textlet:add suggestion in-place)

  function ghostCodes(sug: Suggestion): TextletCode[] {
    if (sug.change.type !== 'textlet:add') return []
    const raw = sug.change.annotation.features.codes as (string | TextletCode)[] | undefined
    if (!raw) return []
    return raw.map(c => typeof c === 'string' ? { value: c } : c)
  }

  function ghostNote(sug: Suggestion): string {
    if (sug.change.type !== 'textlet:add') return ''
    return (sug.change.annotation.features.note as string | undefined) ?? ''
  }

  function ghostUpdateAnn(sug: Suggestion, patch: Partial<{ type: string; features: Record<string, unknown> }>) {
    if (sug.change.type !== 'textlet:add') return
    const ann = sug.change.annotation
    store.updateSuggestionChange(sug.id, {
      type: 'textlet:add',
      annotation: { ...ann, ...patch, features: { ...ann.features, ...patch.features } },
    })
  }

  function ghostAddCode(sug: Suggestion, value: string, vocabEntryId?: string, vocabId?: string) {
    const v = value.trim()
    if (!v) return
    const existing = ghostCodes(sug)
    const isDup = vocabEntryId
      ? existing.some(c => c.vocabEntryId === vocabEntryId)
      : existing.some(c => !c.vocabEntryId && c.value === v)
    if (isDup) return
    const newCode: TextletCode = vocabEntryId
      ? { value: v, vocabEntryId, ...(vocabId ? { vocabId } : {}) }
      : { value: v }
    ghostUpdateAnn(sug, { features: { codes: [...existing, newCode] } })
    ghostCodeInputs.set(sug.id, '')
    ghostCodeInputs = new SvelteMap(ghostCodeInputs)
  }

  function ghostRemoveCode(sug: Suggestion, code: TextletCode) {
    const next = ghostCodes(sug).filter(c =>
      code.vocabEntryId ? c.vocabEntryId !== code.vocabEntryId : (c.vocabEntryId == null && c.value !== code.value)
    )
    ghostUpdateAnn(sug, { features: { codes: next.length ? next : undefined } })
  }

  function ghostSetNote(sug: Suggestion, note: string) {
    ghostUpdateAnn(sug, { features: { note: note || undefined } })
  }
</script>

{#if addSugs.length > 0}
  <div class="textlet-list">
    {#each addSugs as sug (sug.id)}
      {#if sug.change.type === 'textlet:add'}
        {@const a = sug.change.annotation}
        {@const anchor = a.anchors.find(x => x.type === 'word-range')}
        {@const previewText = anchor?.type === 'word-range'
          ? getWordRangeText(doc, anchor.fromWordId, anchor.toWordId, tokenStore)
          : '—'}
        {@const gcodes = ghostCodes(sug)}
        {@const gnote  = ghostNote(sug)}
        {@const gexpanded = expandedGhostId === sug.id}
        {@const gcodeInput = ghostCodeInputs.get(sug.id) ?? ''}
        <div class="textlet-item ghost-item" class:expanded={gexpanded}>
          <div class="textlet-row">
            <button class="textlet-select ghost-label"
              onclick={() => { expandedGhostId = gexpanded ? null : sug.id }}
            >
              <span class="textlet-text">{previewText}</span>
              {#if gcodes.length > 0}
                <span class="code-count" title={gcodes.map(c => c.value).join(', ')}>{gcodes.length} code{gcodes.length > 1 ? 's' : ''}</span>
              {/if}
            </button>
            <button class="sug-btn sug-check" title="Accept" onclick={() => store.acceptSuggestion(sug.id)}>✓</button>
            <button class="sug-btn sug-x"    title="Reject" onclick={() => store.rejectSuggestion(sug.id)}>✗</button>
          </div>
          {#if gexpanded}
            <div class="textlet-body">
              <div class="body-section">
                <span class="section-label">Note</span>
                <textarea
                  value={gnote}
                  placeholder="(write a note)"
                  rows="2"
                  oninput={(e) => ghostSetNote(sug, (e.currentTarget as HTMLTextAreaElement).value)}
                ></textarea>
              </div>
              <div class="body-section">
                <span class="section-label">Codes</span>
                {#if gcodes.length > 0}
                  <div class="codes-row">
                    {#each gcodes as code (code.vocabEntryId ?? code.value)}
                      <span class="code-tag" class:vocab-linked={!!code.vocabEntryId}>
                        {code.value}
                        <button class="code-remove" onclick={() => ghostRemoveCode(sug, code)} title="Remove">×</button>
                      </span>
                    {/each}
                  </div>
                {/if}
                <div class="code-add-row">
                  <input
                    class="code-input"
                    value={gcodeInput}
                    placeholder="New code…"
                    oninput={(e) => { ghostCodeInputs.set(sug.id, (e.currentTarget as HTMLInputElement).value); ghostCodeInputs = new SvelteMap(ghostCodeInputs) }}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); ghostAddCode(sug, gcodeInput) } }}
                  />
                  <button class="add-btn" onclick={() => ghostAddCode(sug, gcodeInput)} disabled={!gcodeInput.trim()}>+ Code</button>
                </div>
                {#if vocabs.length > 0}
                  <div class="vocab-row">
                    <select onchange={(e) => {
                      const sel = e.currentTarget as HTMLSelectElement
                      const entryId = sel.value
                      if (!entryId) return
                      const vocab = vocabs.find(v => v.entries.some(e => e.id === entryId))
                      const entry = vocab?.entries.find(e => e.id === entryId)
                      if (entry && vocab) ghostAddCode(sug, entry.value, entry.id, vocab.id)
                      sel.value = ''
                    }}>
                      <option value="">from vocab…</option>
                      {#each vocabs as vocab (vocab.id)}
                        <optgroup label={vocab.name}>
                          {#each vocab.entries as entry (entry.id)}
                            <option value={entry.id}>{entry.value}{entry.description ? ` — ${entry.description}` : ''}</option>
                          {/each}
                        </optgroup>
                      {/each}
                    </select>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

{#if textlets.length === 0 && addSugs.length === 0}
  <div class="empty-state">No textlets yet.<br/>Select text and use + annotate.</div>
{:else if textlets.length > 0}
  <div class="textlet-list">
    {#each textlets as t (t.id)}
      {@const markAnchor = t.anchors.find(a => a.type === 'mark')}
      {@const text = markAnchor && markAnchor.type === 'mark' ? getMarkText(doc, markAnchor.markId) : '—'}
      {@const expanded = expandedId === t.id}
      {@const comment = hasAnyNotes(t) ? notesSummaryText(t) : undefined}
      {@const tcodes = codes(t)}
      {@const dSugs = deleteSugs(t.id)}
      {@const acSugs = addCodeSugs(t.id)}
      {@const rcSugs = removeCodeSugs(t.id)}

      <div class="textlet-item" class:expanded>
        <!-- Summary row -->
        <div class="textlet-row">
          <button class="textlet-select"
            onclick={() => toggle(t.id)}
            onmouseenter={() => markAnchor && markAnchor.type === 'mark' && onHoverMark(markAnchor.markId)}
            onmouseleave={() => onHoverMark(null)}
          >
            <span class="textlet-text">{text}</span>
            {#if tcodes.length > 0}
              <span class="code-count" title={tcodes.map(c => c.value).join(', ')}>{tcodes.length} code{tcodes.length > 1 ? 's' : ''}</span>
            {/if}
          </button>
          {#if comment}
            <button class="icon-btn" aria-label="View note" onclick={(e) => openNotePopup(e, comment)}>
              <svg viewBox="0 0 8 10" width="11" height="14" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M0.5,0.5 H5 L7.5,3 V9.5 H0.5 Z"/>
                <polyline points="5,0.5 5,3 7.5,3"/>
                <line x1="1.5" y1="5" x2="6" y2="5"/>
                <line x1="1.5" y1="6.5" x2="6" y2="6.5"/>
                <line x1="1.5" y1="8.5" x2="4.5" y2="8.5"/>
              </svg>
            </button>
          {/if}
          <button class="icon-btn danger" onclick={() => deleteTextlet(t)} title="Delete">
            <svg width="11" height="12" viewBox="0 0 13 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M1 3h11M4.5 3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5.5 6.5v4M7.5 6.5v4M2 3l.7 8.1A1 1 0 0 0 3.7 12h5.6a1 1 0 0 0 1-.9L11 3"/>
            </svg>
          </button>
        </div>

        <!-- Code suggestion box -->
        {#if acSugs.length > 0 || rcSugs.length > 0}
          <div class="sug-box">
            <div class="sug-box-label">Codes</div>
            {#each acSugs as sug (sug.id)}
              {#if sug.change.type === 'textlet:add-code'}
                <div class="sug-row">
                  <div class="sug-row-author">
                    <span>{formatAuthor(sug.authorId)}</span>
                    <span class="sug-timestamp">{formatTimestamp(sug.createdAt)}</span>
                  </div>
                  <div class="sug-row-main">
                    <span class="sug-arrow">+</span>
                    <span class="sug-val">{sug.change.code.value}</span>
                    <button class="sug-btn sug-check" onclick={() => store.acceptSuggestion(sug.id)}>✓</button>
                    <button class="sug-btn sug-x" onclick={() => store.rejectSuggestion(sug.id)}>✗</button>
                  </div>
                  {#if sug.note}<button class="sug-note-btn" use:markTruncated onclick={(e) => openSugNotePopup(e, sug)}>{sug.note}</button>{/if}
                </div>
              {/if}
            {/each}
            {#each rcSugs as sug (sug.id)}
              {#if sug.change.type === 'textlet:remove-code'}
                <div class="sug-row">
                  <div class="sug-row-author">
                    <span>{formatAuthor(sug.authorId)}</span>
                    <span class="sug-timestamp">{formatTimestamp(sug.createdAt)}</span>
                  </div>
                  <div class="sug-row-main">
                    <span class="sug-arrow sug-trash" aria-label="remove">
                      <svg width="11" height="12" viewBox="0 0 13 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M1 3h11M4.5 3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5.5 6.5v4M7.5 6.5v4M2 3l.7 8.1A1 1 0 0 0 3.7 12h5.6a1 1 0 0 0 1-.9L11 3"/>
                      </svg>
                    </span>
                    <span class="sug-val">{sug.change.code.value}</span>
                    <button class="sug-btn sug-check" onclick={() => store.acceptSuggestion(sug.id)}>✓</button>
                    <button class="sug-btn sug-x" onclick={() => store.rejectSuggestion(sug.id)}>✗</button>
                  </div>
                  {#if sug.note}<button class="sug-note-btn" use:markTruncated onclick={(e) => openSugNotePopup(e, sug)}>{sug.note}</button>{/if}
                </div>
              {/if}
            {/each}
          </div>
        {/if}

        <!-- Delete suggestion box -->
        {#if dSugs.length > 0}
          <div class="sug-box sug-box-delete">
            {#each dSugs as sug (sug.id)}
              <div class="sug-row">
                <div class="sug-row-author">
                  <span>{formatAuthor(sug.authorId)}</span>
                  <span class="sug-timestamp">{formatTimestamp(sug.createdAt)}</span>
                </div>
                <div class="sug-row-main">
                  <span class="sug-arrow sug-trash" aria-label="delete">
                    <svg viewBox="0 0 10 12" width="9" height="11" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="1,3 9,3"/>
                      <path d="M2,3 L2.5,11 H7.5 L8,3"/>
                      <path d="M4,3 V1.5 H6 V3"/>
                      <line x1="4" y1="5" x2="4" y2="9"/>
                      <line x1="6" y1="5" x2="6" y2="9"/>
                    </svg>
                  </span>
                  <span class="sug-val">delete textlet</span>
                  <button class="sug-btn sug-check" onclick={() => store.acceptSuggestion(sug.id)}>✓</button>
                  <button class="sug-btn sug-x" onclick={() => store.rejectSuggestion(sug.id)}>✗</button>
                </div>
                {#if sug.note}<button class="sug-note-btn" use:markTruncated onclick={(e) => openSugNotePopup(e, sug)}>{sug.note}</button>{/if}
              </div>
            {/each}
          </div>
        {/if}

        {#if expanded}
          <div class="textlet-body">
            <!-- Notes -->
            <div class="body-section">
              <div class="note-header">
                <span class="section-label">Notes</span>
                {#if !suggestMode}
                  <button class="note-add-btn" onclick={() => addTextletNote(t)}>+ Note</button>
                {/if}
              </div>
              {#each editableNoteAuthors().filter(a => (textletNotes(t)[a] ?? []).length > 0 || a === myAuthorId) as author (author)}
                {#each (textletNotes(t)[author] ?? []) as entry, i (entry.createdAt)}
                  <div class="note-entry">
                    <div class="note-entry-meta">
                      {#if author !== myAuthorId}<span class="note-entry-author">{author}</span>{/if}
                      <span class="note-entry-date">{fmtNoteDate(entry.createdAt)}</span>
                      {#if !suggestMode}
                        <button class="note-delete-btn" onclick={() => deleteTextletNote(t, author, i)}>×</button>
                      {/if}
                    </div>
                    <textarea
                      class="note-entry-text"
                      value={entry.text}
                      placeholder="(write a note)"
                      rows="2"
                      disabled={suggestMode}
                      oninput={(e) => updateTextletNote(t, author, i, (e.currentTarget as HTMLTextAreaElement).value)}
                    ></textarea>
                  </div>
                {/each}
              {/each}
              {#if editableNoteAuthors().every(a => (textletNotes(t)[a] ?? []).length === 0) && !suggestMode}
                <p class="note-empty">No notes yet.</p>
              {/if}
              {#each Object.entries(textletNotes(t)).filter(([a]) => !editableNoteAuthors().includes(a)) as [author, entries] (author)}
                {#each entries as entry (entry.createdAt)}
                  <div class="note-other">
                    <div class="note-other-meta">
                      <span class="note-other-author">{author}</span>
                      <span class="note-other-date">{fmtNoteDate(entry.createdAt)}</span>
                    </div>
                    <span class="note-other-text">{entry.text}</span>
                  </div>
                {/each}
              {/each}
            </div>

            <!-- Codes -->
            <div class="body-section">
              <span class="section-label">Codes</span>
              {#if tcodes.length > 0}
                <div class="codes-row">
                  {#each tcodes as code (code.vocabEntryId ?? code.value)}
                    <span class="code-tag" class:vocab-linked={!!code.vocabEntryId}>
                      {code.value}
                      <button class="code-remove" onclick={() => removeCode(t, code)} title="Remove">×</button>
                    </span>
                  {/each}
                </div>
              {/if}
              <div class="code-add-row">
                <input
                  class="code-input"
                  bind:value={codeInput}
                  placeholder="New code…"
                  onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCode(t, codeInput) } }}
                />
                <button class="add-btn" onclick={() => addCode(t, codeInput)} disabled={!codeInput.trim()}>+ Code</button>
              </div>
              {#if vocabs.length > 0}
                <div class="vocab-row">
                  <select onchange={(e) => {
                    const sel = e.currentTarget as HTMLSelectElement
                    const entryId = sel.value
                    if (!entryId) return
                    const vocab = vocabs.find(v => v.entries.some(e => e.id === entryId))
                    const entry = vocab?.entries.find(e => e.id === entryId)
                    if (entry && vocab) addCode(t, entry.value, entry.id, vocab.id)
                    sel.value = ''
                  }}>
                    <option value="">from vocab…</option>
                    {#each vocabs as vocab (vocab.id)}
                      <optgroup label={vocab.name}>
                        {#each vocab.entries as entry (entry.id)}
                          <option value={entry.id}>{entry.value}{entry.description ? ` — ${entry.description}` : ''}</option>
                        {/each}
                      </optgroup>
                    {/each}
                  </select>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

{#if notePopup}
  <button class="note-popup-backdrop" onclick={() => notePopup = null} aria-label="Close note"></button>
  <div class="note-popup" style="left:{notePopup.x}px; top:{notePopup.y}px">{notePopup.text}</div>
{/if}

{#if sugNotePopup}
  <button class="note-popup-backdrop" onclick={() => sugNotePopup = null} aria-label="Close note"></button>
  <div class="note-popup sug-note-popup" style="left:{sugNotePopup.x}px; top:{sugNotePopup.y}px">
    <div class="note-popup-author">{sugNotePopup.author}</div>
    <div>{sugNotePopup.text}</div>
  </div>
{/if}

<style>
  .empty-state {
    padding: 1.5rem 1rem;
    font-size: var(--font-sm);
    color: var(--color-text-faint);
    text-align: center;
    line-height: 1.5;
  }

  .textlet-list {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--color-border);
  }

  .textlet-item {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--color-border-strong);
  }
  .textlet-item:last-child { border-bottom: none; }

  .textlet-row {
    display: flex;
    align-items: baseline;
    font-size: 0.82rem;
  }
  .textlet-row:hover { background: var(--color-bg-2); }
  .textlet-item.expanded > .textlet-row { background: var(--color-active-light); }

  .textlet-select {
    flex: 1; display: flex; align-items: baseline; gap: 0.5rem;
    padding: 0.32rem 0.75rem; background: none; border: none;
    cursor: pointer; font: inherit; color: inherit; text-align: left; min-width: 0;
  }

  .textlet-text {
    flex: 1;
    color: var(--color-text-2);
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .code-count {
    font-size: var(--font-xs);
    color: var(--color-primary-dark);
    background: var(--color-primary-light);
    border: 1px solid var(--color-primary-border);
    border-radius: var(--radius-xs);
    padding: 0 5px;
    flex-shrink: 0;
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
    background: var(--color-bg-0, #fff);
    border: 1px solid var(--color-border, #ccc);
    border-radius: 5px;
    padding: 0.5rem 0.65rem;
    box-shadow: 0 3px 10px rgba(0,0,0,0.14);
    font-size: var(--font-sm);
    max-width: 260px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--color-text-1);
    pointer-events: none;
  }

  /* ── Expanded body ───────────────────────────────────────────── */

  .textlet-body {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding: 0.55rem 0.75rem 0.7rem;
  }

  .body-section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .section-label {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }

  .note-header { display: flex; align-items: center; justify-content: space-between; }
  .note-add-btn { font-size: 0.65rem; padding: 0.1rem 0.4rem; border: 1px solid var(--color-active); border-radius: 3px; background: transparent; color: var(--color-active-dark); cursor: pointer; font-weight: 600; }
  .note-add-btn:hover { background: var(--color-active-light); }
  .note-entry { display: flex; flex-direction: column; gap: 0.15rem; }
  .note-entry-meta { display: flex; align-items: center; gap: 0.4em; }
  .note-entry-meta .note-delete-btn { margin-left: auto; }
  .note-entry-author { font-size: 0.65rem; font-weight: 600; color: var(--color-text-muted); }
  .note-entry-date { font-size: 0.65rem; color: var(--color-text-muted); }
  .note-delete-btn { background: none; border: none; cursor: pointer; font-size: 0.8rem; color: #bbb; padding: 0 0.2rem; line-height: 1; border-radius: 2px; }
  .note-delete-btn:hover { color: #c44; background: #fde; }
  .note-entry-text { resize: vertical; width: 100%; box-sizing: border-box; }
  .note-empty { font-size: 0.68rem; color: var(--color-text-muted); margin: 0; font-style: italic; }
  .note-other { font-size: 0.68rem; color: var(--color-text-muted); padding: 0.2rem 0.35rem; background: #f5f5f5; border-radius: 3px; white-space: pre-wrap; word-break: break-word; display: flex; flex-direction: column; gap: 0.1rem; }
  .note-other-meta { display: flex; align-items: baseline; gap: 0.4em; }
  .note-other-author { font-weight: 600; }
  .note-other-date { font-size: 0.62rem; color: #bbb; }
  .note-other-text { display: block; }

  .textlet-body textarea {
    resize: vertical;
    font-size: 0.8rem;
    min-height: 44px;
  }

  /* ── Codes ───────────────────────────────────────────────────── */

  .codes-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 0.15rem;
  }

  .code-tag {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: var(--color-primary-light);
    color: var(--color-primary-dark);
    border: 1px solid var(--color-primary-border);
    border-radius: var(--radius-xs);
    padding: 1px 6px 1px 8px;
    font-size: 0.76rem;
    font-weight: 500;
  }

  .code-tag.vocab-linked {
    background: var(--color-active-light);
    color: var(--color-active-dark);
    border-color: var(--color-active-border);
  }
  .code-tag.vocab-linked .code-remove { color: var(--color-active-dark); }
  .code-tag.vocab-linked .code-remove:hover { color: var(--color-danger); }

  .code-remove {
    background: none;
    border: none;
    padding: 0 1px;
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--color-primary-dark);
    line-height: 1;
    opacity: 0.6;
  }
  .code-remove:hover { opacity: 1; color: var(--color-danger); }

  .code-add-row {
    display: flex;
    gap: 0.3rem;
  }
  .code-input { flex: 1; min-width: 0; font-size: 0.8rem; }

  .vocab-row { margin-top: 0.15rem; }
  .vocab-row select { width: 100%; font-size: 0.8rem; }

  /* ── Suggestion boxes ────────────────────────────────────────── */

  .sug-box {
    border-top: 1px solid #ffc107;
    border-bottom: 1px solid #ffc107;
    background: #fffbf0;
    padding: 0.18rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .sug-box-label {
    font-size: 0.63rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #b45309;
    padding-top: 0.1rem;
  }
  .sug-row { display: flex; flex-direction: column; gap: 0.08rem; padding-top: 0.12rem; border-top: 1px solid #fde68a; }
  .sug-row:first-of-type { border-top: none; }
  .sug-row-author { display: flex; justify-content: space-between; font-size: 0.65rem; font-weight: 600; color: var(--color-text-3); }
  .sug-timestamp { font-weight: 400; color: var(--color-text-muted); }
  .sug-row-main { display: flex; align-items: center; gap: 0.3rem; font-size: 0.78rem; }
  .sug-note-btn { background: none; border: none; padding: 0; font-size: 0.65rem; font-style: italic; color: var(--color-text-muted); cursor: default; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sug-note-btn:global(.truncated) { cursor: pointer; }
  .sug-note-btn:global(.truncated):hover { color: var(--color-text-2); text-decoration: underline; }
  .sug-btn { padding: 0 0.28rem; border-radius: var(--radius-xs); border: 1px solid; background: none; cursor: pointer; font-size: 0.78rem; line-height: 1.5; }
  .sug-check { color: var(--color-active-dark); border-color: var(--color-active); }
  .sug-check:hover { background: var(--color-active-light); }
  .sug-x { color: var(--color-danger); border-color: var(--color-danger); }
  .sug-x:hover { background: var(--color-danger-light); }
  .sug-arrow { color: #b45309; font-size: 0.72rem; flex-shrink: 0; }
  .sug-trash { display: flex; align-items: center; }
  .sug-val { font-size: 0.77rem; color: var(--color-text-1); flex: 1; min-width: 0; }

  .note-popup-author { font-size: 0.72rem; font-weight: 600; color: var(--color-text-3); margin-bottom: 0.2rem; }

  .ghost-item { opacity: 0.85; }
  .ghost-label {
    flex: 1; display: flex; align-items: baseline; gap: 0.5rem;
    padding: 0.32rem 0.75rem; background: none; border: none;
    cursor: pointer; font: inherit; color: inherit; text-align: left; min-width: 0;
  }
  .ghost-label .textlet-text { font-style: italic; color: var(--color-text-muted); }
  .ghost-item.expanded > .textlet-row { background: var(--color-active-light); }

  /* compact accept/reject on the textlet row */
  .textlet-row .sug-btn { margin-right: 0.35rem; line-height: 1.4; }

</style>
