<script lang="ts">
  import { onMount } from 'svelte'
  import type { AnnotationStore, PatternSchema, Pattern, SlotInstance, ControlledVocabulary, TokenStore, ParticipantJSON, Suggestion } from '@mumo/core'
  import { newId } from '@mumo/core'
  import type { ID } from '@mumo/core'
  import type { SlotFillMode } from '../patternTypes.js'
  import { patternLabel, patternLineNums, getMarkText, getTokenText, getUttLabel } from '@mumo/core'
  import type { PMNode } from '@mumo/core'

  const {
    store,
    tokenStore,
    patternSchemas,
    patterns,
    vocabs,
    participants,
    doc,
    slotFillMode,
    selectedPatternId = null,
    myAuthorId = 'Anonymous',
    onSelectPattern,
    onRequestSlotFill,
    onCancelSlotFill,
    onFillWithPattern,
    onHoverSlot,
    onHoverPattern,
    editorMode = 'annotate',
    suggestMode = false,
  }: {
    store: AnnotationStore
    tokenStore: TokenStore
    patternSchemas: PatternSchema[]
    patterns: Pattern[]
    vocabs: ControlledVocabulary[]
    participants: ParticipantJSON[]
    doc: PMNode
    slotFillMode: SlotFillMode | null
    selectedPatternId?: ID | null
    myAuthorId?: string
    onSelectPattern?: (id: ID | null) => void
    onRequestSlotFill: (patternId: ID, slotSchemaId: ID, anchorKind: 'textlet' | 'utterance' | 'tier' | 'pattern' | 'any', tierId?: ID) => void
    onCancelSlotFill: () => void
    onFillWithPattern?: (patternId: ID) => void
    onHoverSlot?: (slotSchemaId: ID | null) => void
    onHoverPattern?: (patternId: ID | null) => void
    editorMode?: 'edit' | 'annotate'
    suggestMode?: boolean
  } = $props()

  let filterSchemaId  = $state('')
  let addMode         = $state(false)
  let pickerIndex     = $state(0)
  let _suggestions    = $state<Suggestion[]>([])
  let hoverSugId      = $state<string | null>(null)
  let sugNotePopup    = $state<{ text: string; author: string; x: number; y: number } | null>(null)

  function formatAuthor(authorId: string): string {
    return authorId.replace(/^(?:ai:|user:)/, '')
  }

  function formatTimestamp(ms: number): string {
    const d = new Date(ms)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  function openSugNotePopup(e: MouseEvent, sug: Suggestion) {
    if (!sug.note) return
    const el = e.currentTarget as HTMLElement
    if (el.scrollWidth <= el.clientWidth) return
    e.stopPropagation()
    const rect = el.getBoundingClientRect()
    sugNotePopup = { text: sug.note, author: formatAuthor(sug.authorId), x: rect.left, y: rect.bottom + 6 }
  }

  function markTruncated(el: HTMLElement) {
    const update = () => el.classList.toggle('truncated', el.scrollWidth > el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return { destroy() { ro.disconnect() } }
  }

  function closeSugNotePopup() {
    sugNotePopup = null
  }

  onMount(() => {
    _suggestions = store.allSuggestions()
    const update = () => { _suggestions = store.allSuggestions() }
    store.on('suggestions:changed', update)
    return () => store.off('suggestions:changed', update)
  })

  const patternSuggestions = $derived(
    !selectedPatternId ? [] :
    _suggestions.filter(s => {
      const c = s.change
      return (
        (c.type === 'pattern:fill-slot'   && c.patternId === selectedPatternId) ||
        (c.type === 'pattern:fill-metric' && c.patternId === selectedPatternId)
      )
    })
  )

  const addPatternSugs = $derived(_suggestions.filter(s => s.change.type === 'pattern:add'))

  function patternDeleteSug(patternId: ID): Suggestion | undefined {
    return _suggestions.find(s => s.change.type === 'pattern:delete' && s.change.patternId === patternId)
  }

  function slotSuggestions(slotSchemaId: ID): Suggestion[] {
    return patternSuggestions.filter(s =>
      s.change.type === 'pattern:fill-slot' && s.change.slot.schemaSlotId === slotSchemaId
    )
  }

  function metricSuggestions(slotSchemaId: ID, metricSchemaId: ID): Suggestion[] {
    return patternSuggestions.filter(s =>
      s.change.type === 'pattern:fill-metric' &&
      s.change.slotSchemaId === slotSchemaId &&
      s.change.metricId === metricSchemaId
    )
  }

  const selectedPattern  = $derived(patterns.find(f => f.id === selectedPatternId) ?? null)
  const selectedSchema = $derived(
    selectedPattern ? (patternSchemas.find(s => s.id === selectedPattern.schemaId) ?? null) : null
  )

  // Sort patterns by first anchor line, then filter by schema type
  const sortedPatterns = $derived.by(() => {
    const withNums = patterns.map(f => ({
      pattern: f,
      lines: patternLineNums(f, doc, store, tokenStore),
    }))
    withNums.sort((a, b) => {
      const af = a.lines?.first ?? Number.MAX_SAFE_INTEGER
      const bf = b.lines?.first ?? Number.MAX_SAFE_INTEGER
      return af - bf
    })
    if (!filterSchemaId) return withNums
    return withNums.filter(x => x.pattern.schemaId === filterSchemaId)
  })

  function enterAddMode() {
    if (!patternSchemas.length) return
    if (patternSchemas.length === 1) {
      _addFrame(patternSchemas[0]!.id)
      return
    }
    addMode     = true
    pickerIndex = 0
  }

  function exitAddMode() {
    addMode = false
  }

  function _addFrame(schemaId: ID) {
    if (suggestMode) {
      const patternId = newId()
      store.addSuggestion({ type: 'pattern:add', patternId, schemaId }, 'user:local')
    } else {
      const pattern = store.addPattern(schemaId)
      onSelectPattern?.(pattern.id)
    }
    addMode = false
  }

  function confirmPick(index: number = pickerIndex) {
    const schema = patternSchemas[index]
    if (!schema) return
    _addFrame(schema.id)
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    const target   = e.target as HTMLElement
    const tag      = target.tagName
    // Bare keys must not fire inside form inputs or the editor in edit mode
    const isFormInput   = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    const isEditorTyping = target.isContentEditable && editorMode === 'edit'
    const isTyping       = isFormInput || isEditorTyping

    if (addMode) {
      if (e.key === 'Escape') { exitAddMode(); e.preventDefault(); return }
      if (!isTyping) {
        if (e.key === 'ArrowDown') { pickerIndex = (pickerIndex + 1) % patternSchemas.length; e.preventDefault(); return }
        if (e.key === 'ArrowUp')   { pickerIndex = (pickerIndex - 1 + patternSchemas.length) % patternSchemas.length; e.preventDefault(); return }
        if (e.key === 'Enter')     { confirmPick(); e.preventDefault(); return }
        const n = parseInt(e.key)
        if (!isNaN(n) && n >= 1 && n <= patternSchemas.length) { confirmPick(n - 1); e.preventDefault(); return }
        // Schema hotkey letter (bare, not in editor)
        const hi = patternSchemas.findIndex(s => s.hotkey && s.hotkey === e.key)
        if (hi !== -1) { confirmPick(hi); e.preventDefault(); return }
      }
      return
    }

    // Alt+key combos work from anywhere, including the transcript editor
    if (e.altKey && !e.ctrlKey && !e.metaKey && !isFormInput) {
      if (e.key.toLowerCase() === 'f') { enterAddMode(); e.preventDefault(); return }
      // alt+<schema hotkey> creates that pattern type directly
      const hi = patternSchemas.findIndex(s => s.hotkey && s.hotkey === e.key)
      if (hi !== -1) { confirmPick(hi); e.preventDefault(); return }
    }

    if (isTyping) return

    if (!e.altKey && !e.ctrlKey && !e.metaKey && selectedPatternId && selectedSchema) {
      const n = parseInt(e.key)
      if (!isNaN(n) && n >= 1 && n <= selectedSchema.slots.length) {
        const slot = selectedSchema.slots[n - 1]!
        onRequestSlotFill(selectedPatternId, slot.id, slot.anchorKind, slot.tierId)
        e.preventDefault()
      }
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleGlobalKeydown)
    return () => document.removeEventListener('keydown', handleGlobalKeydown)
  })

  function deleteFrame() {
    if (!selectedPatternId) return
    if (suggestMode) {
      store.addSuggestion({ type: 'pattern:delete', patternId: selectedPatternId }, 'user:local')
    } else {
      store.removePattern(selectedPatternId)
      onSelectPattern?.(null)
    }
  }

  function getSlotInstance(slotSchemaId: ID): SlotInstance | null {
    return selectedPattern?.slots.find(s => s.schemaSlotId === slotSchemaId) ?? null
  }

  function getSlotInstances(slotSchemaId: ID): SlotInstance[] {
    return selectedPattern?.slots.filter(s => s.schemaSlotId === slotSchemaId) ?? []
  }

  function resolveAnnotation(annotationId: ID) {
    const fromStore = store.getAnnotation(annotationId)
    if (fromStore) return fromStore
    for (const s of _suggestions) {
      if (s.change.type === 'pattern:fill-slot' &&
          s.change.slot.annotationId === annotationId &&
          s.change.pendingAnnotation) {
        return s.change.pendingAnnotation
      }
    }
    return undefined
  }

  function annDisplayText(annotationId: ID): string {
    const ann = resolveAnnotation(annotationId)
    if (!ann) return ''
    const markAnchor = ann.anchors.find(a => a.type === 'mark')
    if (markAnchor && markAnchor.type === 'mark') return getMarkText(doc, markAnchor.markId)
    const uttId = ann.features.utteranceId as ID | undefined
    if (uttId) return getUttLabel(doc, uttId)
    const tokenId = ann.features.tokenId as ID | undefined
    if (tokenId) return getTokenText(tokenId, tokenStore, doc, ann.features)
    if (ann.type) return ann.type
    return '—'
  }

  function refPatternFor(annotationId: ID): { patternId: ID; label: string; filled: number; total: number } | null {
    const ann = store.getAnnotation(annotationId)
    if (!ann) return null
    const refPatternId = ann.features.patternId as ID | undefined
    if (!refPatternId) return null
    const f = patterns.find(x => x.id === refPatternId)
    if (!f) return null
    const schema = patternSchemas.find(s => s.id === f.schemaId)
    const total  = schema?.slots.length ?? 0
    const filled = f.slots.length
    return { patternId: refPatternId, label: patternLabel(f, patterns, patternSchemas), filled, total }
  }

  function removeSlotInstance(instanceId: ID) {
    if (!selectedPattern || suggestMode) return
    store.updatePattern(selectedPattern.id, {
      slots: selectedPattern.slots.filter(s => s.id !== instanceId),
    })
  }

  function getMetricValue(slotSchemaId: ID, metricSchemaId: ID): string | boolean | number | null {
    const inst = getSlotInstance(slotSchemaId)
    if (!inst) return null
    return inst.metrics.find(m => m.schemaId === metricSchemaId)?.value ?? null
  }

  function setMetricValue(slotSchemaId: ID, metricSchemaId: ID, value: string | boolean | null) {
    if (!selectedPattern) return
    const inst = getSlotInstance(slotSchemaId)
    if (!inst) return
    if (suggestMode) {
      store.addSuggestion({
        type: 'pattern:fill-metric',
        patternId: selectedPattern.id,
        slotSchemaId,
        metricId: metricSchemaId,
        value,
      }, 'user:local')
      return
    }
    const newMetrics = [
      ...inst.metrics.filter(m => m.schemaId !== metricSchemaId),
      ...(value !== null ? [{ schemaId: metricSchemaId, value }] : []),
    ]
    const newSlots = selectedPattern.slots.map(s =>
      s.schemaSlotId === slotSchemaId ? { ...s, metrics: newMetrics } : s
    )
    store.updatePattern(selectedPattern.id, { slots: newSlots })
  }

  /** Authors whose notes the current user can edit/delete. */
  function editableAuthors(): string[] {
    const authors = new Set([myAuthorId, 'Anonymous'])
    return Array.from(authors)
  }

  function addNote() {
    if (!selectedPattern || suggestMode) return
    store.addPatternNote(selectedPattern.id, myAuthorId, '')
  }

  function updateNote(authorId: string, index: number, text: string) {
    if (!selectedPattern || suggestMode) return
    store.updatePatternNote(selectedPattern.id, authorId, index, text)
  }

  function deleteNote(authorId: string, index: number) {
    if (!selectedPattern || suggestMode) return
    store.deletePatternNote(selectedPattern.id, authorId, index)
  }


  function fmtNoteDate(ts: number): string {
    const d = new Date(ts)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  function isFillingSlot(slotSchemaId: ID): boolean {
    return slotFillMode?.patternId === selectedPatternId && slotFillMode?.slotSchemaId === slotSchemaId
  }

  function ghostSetMetricValue(patternId: ID, slotSchemaId: ID, metricSchemaId: ID, value: string | boolean | null) {
    store.addSuggestion({ type: 'pattern:fill-metric', patternId, slotSchemaId, metricId: metricSchemaId, value }, 'user:local')
  }

  function ghostMetricSugValue(slotSchemaId: ID, metricSchemaId: ID): string | boolean | null {
    const s = patternSuggestions.findLast(x =>
      x.change.type === 'pattern:fill-metric' &&
      x.change.slotSchemaId === slotSchemaId &&
      x.change.metricId === metricSchemaId
    )
    return s?.change.type === 'pattern:fill-metric' ? (s.change.value as string | boolean | null) : null
  }

  function acceptAllForGhostPattern(patternId: ID, addSugId: ID) {
    // Accept in dependency order: pattern first, then slots, then metrics.
    store.acceptSuggestion(addSugId)
    for (const s of _suggestions) {
      if (s.change.type === 'pattern:fill-slot' && s.change.patternId === patternId)
        store.acceptSuggestion(s.id)
    }
    for (const s of _suggestions) {
      if (s.change.type === 'pattern:fill-metric' && s.change.patternId === patternId)
        store.acceptSuggestion(s.id)
    }
    onSelectPattern?.(patternId)
  }

  const label = (f: Pattern) => patternLabel(f, patterns, patternSchemas)

  function isIncomplete(pattern: Pattern): boolean {
    const schema = patternSchemas.find(s => s.id === pattern.schemaId)
    if (!schema) return false
    return schema.slots.some(slotSchema =>
      slotSchema.required && !pattern.slots.find(s => s.schemaSlotId === slotSchema.id)
    )
  }
</script>

<div class="inspector-header">
  <div class="new-pattern-row">
    <button
      onclick={addMode ? exitAddMode : enterAddMode}
      disabled={!patternSchemas.length}
      class="add-btn"
      class:add-btn-active={addMode}
    >+ Pattern</button>
    {#if !addMode}<span class="add-hint">alt+f</span>{/if}
  </div>

  {#if addMode}
    <div class="picker-list">
      {#each patternSchemas as schema, i (schema.id)}
        <button
          class="picker-item"
          class:picker-active={pickerIndex === i}
          onclick={() => confirmPick(i)}
          onpointermove={() => pickerIndex = i}
        >
          <span class="picker-num">{i + 1}</span>
          <span class="picker-name">{schema.name}</span>
          {#if schema.hotkey}<span class="picker-hotkey">alt+{schema.hotkey}</span>{/if}
        </button>
      {/each}
    </div>
  {:else if patternSchemas.length > 1 && patterns.length > 0}
    <div class="filter-row">
      <select bind:value={filterSchemaId}>
        <option value="">all types</option>
        {#each patternSchemas as s (s.id)}
          <option value={s.id}>{s.name}</option>
        {/each}
      </select>
    </div>
  {/if}
</div>

{#if sortedPatterns.length > 0 || addPatternSugs.length > 0}
  <div class="pattern-list">
    {#each sortedPatterns as { pattern, lines } (pattern.id)}
      {@const isSelected = selectedPatternId === pattern.id}
      {@const schema = patternSchemas.find(s => s.id === pattern.schemaId)}
      {@const incomplete = isIncomplete(pattern)}
      {@const deleteSug = patternDeleteSug(pattern.id)}
      <div class="pattern-item" class:selected={isSelected} class:pattern-pending-delete={!!deleteSug}>
        <button
          class="pattern-row"
          class:pattern-fill-target={!!slotFillMode && pattern.id !== slotFillMode?.patternId}
          onclick={() => {
            if (slotFillMode && pattern.id !== slotFillMode.patternId) {
              onFillWithPattern?.(pattern.id)
            } else {
              onSelectPattern?.(isSelected ? null : pattern.id)
            }
          }}
          onmouseenter={() => onHoverPattern?.(pattern.id)}
          onmouseleave={() => onHoverPattern?.(null)}
        >
          {#if incomplete}<span class="warn-icon" title="Required slots unfilled">⚠</span>{/if}
          <span class="pattern-row-label">{label(pattern)}</span>
          {#if lines}
            <span class="pattern-row-lines">
              {lines.first === lines.last ? `L${lines.first}` : `L${lines.first}–${lines.last}`}
            </span>
          {/if}
        </button>

        {#if deleteSug}
          <div class="sug-box sug-box-delete">
            <div class="sug-row">
              <div class="sug-row-author">
                <span>{formatAuthor(deleteSug.authorId)}</span>
                <span class="sug-timestamp">{formatTimestamp(deleteSug.createdAt)}</span>
              </div>
              <div class="sug-row-main">
                <span class="sug-arrow">→ delete</span>
                <button class="sug-btn sug-check" title="Accept: delete pattern"
                  onclick={() => { store.acceptSuggestion(deleteSug.id); onSelectPattern?.(null) }}>✓</button>
                <button class="sug-btn sug-x" title="Reject: keep pattern"
                  onclick={() => store.rejectSuggestion(deleteSug.id)}>✗</button>
              </div>
              {#if deleteSug.note}
                <button class="sug-note-btn" use:markTruncated onclick={(e) => openSugNotePopup(e, deleteSug)}>{deleteSug.note}</button>
              {/if}
            </div>
          </div>
        {/if}

        {#if isSelected && schema}
          <div class="pattern-body">
            {#each schema.slots as slotSchema, i (slotSchema.id)}
              {@const filling = isFillingSlot(slotSchema.id)}
              {#if i > 0}<hr class="slot-sep" />{/if}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="slot-block" class:filling
                onmouseenter={() => onHoverSlot?.(slotSchema.id)}
                onmouseleave={() => onHoverSlot?.(null)}
              >
                <div class="slot-header">
                  <div class="slot-btns">
                    {#if filling}
                      <button class="slot-btn active" onclick={() => onCancelSlotFill()}>cancel</button>
                    {:else if slotSchema.variadic}
                      <button class="slot-btn fill" onclick={() => onRequestSlotFill(pattern.id, slotSchema.id, slotSchema.anchorKind, slotSchema.tierId)}>+ add</button>
                    {:else}
                      {@const inst = getSlotInstance(slotSchema.id)}
                      <button class="slot-btn fill" title="Click to fill ({slotSchema.anchorKind})" onclick={() => onRequestSlotFill(pattern.id, slotSchema.id, slotSchema.anchorKind, slotSchema.tierId)}>fill</button>
                      {#if inst}
                        <button class="slot-btn unfill" onclick={() => removeSlotInstance(inst.id)}>unfill</button>
                      {/if}
                    {/if}
                  </div>
                  <span class="slot-label">{slotSchema.label ?? slotSchema.name}</span>
                  <span class="slot-kind">{slotSchema.anchorKind}</span>
                  {#if slotSchema.tierId}
                    {@const tierDef_ = store.getTier(slotSchema.tierId)}
                    <span class="slot-tier-badge" title={slotSchema.tierId}>{tierDef_?.name ?? slotSchema.tierId}</span>
                  {/if}
                  {#if i < 9}<span class="slot-shortcut">{i + 1}</span>{/if}
                  {#if !slotSchema.required}<span class="slot-optional">opt</span>{/if}
                </div>

                {#if slotSchema.variadic}
                  {@const instances = getSlotInstances(slotSchema.id)}
                  {#if instances.length === 0}
                    <div class="slot-value">
                      <span class="slot-empty">{slotSchema.required ? '— required —' : '— empty —'}</span>
                    </div>
                  {:else}
                    <div class="variadic-list">
                      {#each instances as vInst (vInst.id)}
                        <div class="variadic-row">
                          <span class="slot-text">{annDisplayText(vInst.annotationId)}</span>
                          <button class="icon-btn danger" onclick={() => removeSlotInstance(vInst.id)} title="Remove">×</button>
                        </div>
                      {/each}
                    </div>
                  {/if}
                {:else}
                  {@const inst     = getSlotInstance(slotSchema.id)}
                  {@const slotSugs = slotSuggestions(slotSchema.id)}
                  {#if slotSugs.length > 0}
                    {@const hoverSlotSug = slotSugs.find(s => s.id === hoverSugId)}
                    <div class="sug-box">
                      <div class="slot-value" class:sug-preview={!!hoverSlotSug}>
                        {#if hoverSlotSug && hoverSlotSug.change.type === 'pattern:fill-slot'}
                          <span class="slot-text">{annDisplayText(hoverSlotSug.change.slot.annotationId) || '(pending)'}</span>
                        {:else if inst}
                          {@const nested = refPatternFor(inst.annotationId)}
                          {#if nested}
                            <span class="slot-text pattern-ref">{nested.label}</span>
                            <span class="pattern-ref-detail">{nested.filled}/{nested.total} slots</span>
                            <button class="goto-btn" aria-label="Go to pattern" onclick={() => onSelectPattern?.(nested.patternId)}>→</button>
                          {:else}
                            <span class="slot-text">{annDisplayText(inst.annotationId)}</span>
                          {/if}
                        {:else}
                          <span class="slot-empty">{slotSchema.required ? '— required —' : '— empty —'}</span>
                        {/if}
                      </div>
                      {#each slotSugs as sug (sug.id)}
                        {#if sug.change.type === 'pattern:fill-slot'}
                          <div class="sug-row">
                            <div class="sug-row-author"><span>{formatAuthor(sug.authorId)}</span><span class="sug-timestamp">{formatTimestamp(sug.createdAt)}</span></div>
                            <div class="sug-row-main">
                              <span class="sug-arrow">→</span>
                              <span class="slot-text">{annDisplayText(sug.change.slot.annotationId) || '(pending)'}</span>
                              <button class="sug-btn sug-check" title="Accept suggestion"
                                onmouseenter={() => hoverSugId = sug.id}
                                onmouseleave={() => hoverSugId = null}
                                onclick={() => store.acceptSuggestion(sug.id)}>✓</button>
                              <button class="sug-btn sug-x" title="Reject suggestion" onclick={() => store.rejectSuggestion(sug.id)}>✗</button>
                            </div>
                            {#if sug.note}
                              <button class="sug-note-btn" use:markTruncated onclick={(e) => openSugNotePopup(e, sug)}>{sug.note}</button>
                            {/if}
                          </div>
                        {/if}
                      {/each}
                    </div>
                  {:else}
                    <div class="slot-value">
                      {#if inst}
                        {@const nested = refPatternFor(inst.annotationId)}
                        {#if nested}
                          <span class="slot-text pattern-ref">{nested.label}</span>
                          <span class="pattern-ref-detail">{nested.filled}/{nested.total} slots</span>
                          <button class="goto-btn" aria-label="Go to pattern" onclick={() => onSelectPattern?.(nested.patternId)}>→</button>
                        {:else}
                          <span class="slot-text">{annDisplayText(inst.annotationId)}</span>
                        {/if}
                      {:else}
                        <span class="slot-empty">{slotSchema.required ? '— required —' : '— empty —'}</span>
                      {/if}
                    </div>
                  {/if}
                  {#if inst && slotSchema.metrics.length > 0}
                    <div class="slot-metrics">
                      {#each slotSchema.metrics as metricSchema (metricSchema.id)}
                        {@const metSugs   = metricSuggestions(slotSchema.id, metricSchema.id)}
                        {@const previewSug = metSugs.find(s => s.id === hoverSugId)}
                        {#if metSugs.length > 0}
                          <div class="sug-box">
                            <div class="metric-row">
                              <span class="metric-label">{metricSchema.name}</span>
                              {#if metricSchema.type === 'boolean'}
                                <input type="checkbox"
                                  class:sug-preview={!!previewSug}
                                  checked={previewSug?.change.type === 'pattern:fill-metric'
                                    ? Boolean(previewSug.change.value)
                                    : getMetricValue(slotSchema.id, metricSchema.id) === true}
                                  onchange={(e) => setMetricValue(slotSchema.id, metricSchema.id,
                                    (e.currentTarget as HTMLInputElement).checked)}
                                />
                              {:else if metricSchema.type === 'categorical' && metricSchema.vocabularyId}
                                {@const vocab = vocabs.find(v => v.id === metricSchema.vocabularyId)}
                                <select
                                  class:sug-preview={!!previewSug}
                                  value={previewSug?.change.type === 'pattern:fill-metric'
                                    ? String(previewSug.change.value)
                                    : (getMetricValue(slotSchema.id, metricSchema.id) as string ?? '')}
                                  onchange={(e) => setMetricValue(slotSchema.id, metricSchema.id,
                                    (e.currentTarget as HTMLSelectElement).value || null)}
                                >
                                  <option value="">—</option>
                                  {#each vocab?.entries ?? [] as entry (entry.id)}
                                    <option value={entry.value}>
                                      {entry.value}{entry.description ? ` — ${entry.description}` : ''}
                                    </option>
                                  {/each}
                                </select>
                              {:else if metricSchema.type === 'participant'}
                                <select
                                  class:sug-preview={!!previewSug}
                                  value={previewSug?.change.type === 'pattern:fill-metric'
                                    ? String(previewSug.change.value)
                                    : (getMetricValue(slotSchema.id, metricSchema.id) as string ?? '')}
                                  onchange={(e) => setMetricValue(slotSchema.id, metricSchema.id,
                                    (e.currentTarget as HTMLSelectElement).value || null)}
                                >
                                  <option value="">—</option>
                                  {#each participants as p (p.id)}
                                    <option value={p.id}>{p.label}</option>
                                  {/each}
                                </select>
                              {:else}
                                <input type="text"
                                  class:sug-preview={!!previewSug}
                                  value={previewSug?.change.type === 'pattern:fill-metric'
                                    ? String(previewSug.change.value)
                                    : (getMetricValue(slotSchema.id, metricSchema.id) as string ?? '')}
                                  oninput={(e) => setMetricValue(slotSchema.id, metricSchema.id,
                                    (e.currentTarget as HTMLInputElement).value || null)}
                                />
                              {/if}
                            </div>
                            {#each metSugs as sug (sug.id)}
                              {#if sug.change.type === 'pattern:fill-metric'}
                                <div class="sug-row">
                                  <div class="sug-row-author"><span>{formatAuthor(sug.authorId)}</span><span class="sug-timestamp">{formatTimestamp(sug.createdAt)}</span></div>
                                  <div class="sug-row-main">
                                    <span class="sug-arrow">→</span>
                                    <span class="sug-val">{String(sug.change.value)}</span>
                                    <button class="sug-btn sug-check" title="Accept suggestion"
                                      onmouseenter={() => hoverSugId = sug.id}
                                      onmouseleave={() => hoverSugId = null}
                                      onclick={() => store.acceptSuggestion(sug.id)}>✓</button>
                                    <button class="sug-btn sug-x" title="Reject suggestion" onclick={() => store.rejectSuggestion(sug.id)}>✗</button>
                                  </div>
                                  {#if sug.note}
                                    <button class="sug-note-btn" use:markTruncated onclick={(e) => openSugNotePopup(e, sug)}>{sug.note}</button>
                                  {/if}
                                </div>
                              {/if}
                            {/each}
                          </div>
                        {:else}
                          <div class="metric-row">
                            <span class="metric-label">{metricSchema.name}</span>
                            {#if metricSchema.type === 'boolean'}
                              <input type="checkbox"
                                checked={getMetricValue(slotSchema.id, metricSchema.id) === true}
                                onchange={(e) => setMetricValue(slotSchema.id, metricSchema.id,
                                  (e.currentTarget as HTMLInputElement).checked)}
                              />
                            {:else if metricSchema.type === 'categorical' && metricSchema.vocabularyId}
                              {@const vocab = vocabs.find(v => v.id === metricSchema.vocabularyId)}
                              <select
                                value={getMetricValue(slotSchema.id, metricSchema.id) as string ?? ''}
                                onchange={(e) => setMetricValue(slotSchema.id, metricSchema.id,
                                  (e.currentTarget as HTMLSelectElement).value || null)}
                              >
                                <option value="">—</option>
                                {#each vocab?.entries ?? [] as entry (entry.id)}
                                  <option value={entry.value}>
                                    {entry.value}{entry.description ? ` — ${entry.description}` : ''}
                                  </option>
                                {/each}
                              </select>
                            {:else if metricSchema.type === 'participant'}
                              <select
                                value={getMetricValue(slotSchema.id, metricSchema.id) as string ?? ''}
                                onchange={(e) => setMetricValue(slotSchema.id, metricSchema.id,
                                  (e.currentTarget as HTMLSelectElement).value || null)}
                              >
                                <option value="">—</option>
                                {#each participants as p (p.id)}
                                  <option value={p.id}>{p.label}</option>
                                {/each}
                              </select>
                            {:else}
                              <input type="text"
                                value={getMetricValue(slotSchema.id, metricSchema.id) as string ?? ''}
                                oninput={(e) => setMetricValue(slotSchema.id, metricSchema.id,
                                  (e.currentTarget as HTMLInputElement).value || null)}
                              />
                            {/if}
                          </div>
                        {/if}
                      {/each}
                    </div>
                  {/if}
                {/if}
              </div>
            {/each}

            <hr class="slot-sep" />
            <div class="note-block">
              <div class="note-header">
                <span class="note-label">Notes</span>
                {#if !suggestMode}
                  <button class="note-add-btn" onclick={addNote} title="Add note">+ Note</button>
                {/if}
              </div>
              {#each editableAuthors().filter(a => (pattern.notes?.[a] ?? []).length > 0 || a === myAuthorId) as author (author)}
                {#each (pattern.notes?.[author] ?? []) as entry, i (entry.createdAt)}
                  <div class="note-entry note-entry-own">
                    <div class="note-entry-meta">
                      {#if author !== myAuthorId}<span class="note-entry-author">{author}</span>{/if}
                      <span class="note-entry-date">{fmtNoteDate(entry.createdAt)}</span>
                      {#if !suggestMode}
                        <button class="note-delete-btn" onclick={() => deleteNote(author, i)} title="Delete note">×</button>
                      {/if}
                    </div>
                    <textarea
                      class="note-entry-text"
                      value={entry.text}
                      oninput={(e) => updateNote(author, i, (e.currentTarget as HTMLTextAreaElement).value)}
                      placeholder="(write a note)"
                      rows="2"
                      disabled={suggestMode}
                    ></textarea>
                  </div>
                {/each}
              {/each}
              {#if editableAuthors().every(a => (pattern.notes?.[a] ?? []).length === 0) && !suggestMode}
                <p class="note-empty">No notes yet.</p>
              {/if}
              {#each Object.entries(pattern.notes ?? {}).filter(([a]) => !editableAuthors().includes(a)) as [author, entries] (author)}
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
            <div class="pattern-actions">
              <button class="danger" onclick={deleteFrame}>Delete pattern</button>
            </div>
          </div>
        {/if}
      </div>
    {/each}

    {#each addPatternSugs as sug (sug.id)}
      {@const change = sug.change as { type: 'pattern:add'; patternId: ID; schemaId: ID }}
      {@const schema = patternSchemas.find(s => s.id === change.schemaId)}
      {@const isSelected = selectedPatternId === change.patternId}
      <div class="pattern-item pattern-ghost" class:selected={isSelected}>
        <button
          class="pattern-row"
          onclick={() => onSelectPattern?.(isSelected ? null : change.patternId)}
          onmouseenter={() => onHoverPattern?.(change.patternId)}
          onmouseleave={() => onHoverPattern?.(null)}
        >
          <span class="pattern-row-label pattern-ghost-label">{schema?.name ?? '(pattern)'}</span>
        </button>
        <div class="sug-box sug-box-add">
          <div class="sug-row">
            <div class="sug-row-author">
              <span>{formatAuthor(sug.authorId)}</span>
              <span class="sug-timestamp">{formatTimestamp(sug.createdAt)}</span>
            </div>
            <div class="sug-row-main">
              <span class="sug-arrow">+ proposed</span>
              <button class="sug-btn sug-check" title="Accept: create pattern"
                onclick={() => { store.acceptSuggestion(sug.id); onSelectPattern?.(change.patternId) }}>✓</button>
              <button class="sug-btn sug-x" title="Reject: discard"
                onclick={() => store.rejectSuggestion(sug.id)}>✗</button>
            </div>
            {#if sug.note}
              <button class="sug-note-btn" use:markTruncated onclick={(e) => openSugNotePopup(e, sug)}>{sug.note}</button>
            {/if}
          </div>
        </div>
        {#if isSelected && schema}
          <div class="pattern-body">
            {#each schema.slots as slotSchema, i (slotSchema.id)}
              {@const filling = isFillingSlot(slotSchema.id)}
              {@const slotSugs = slotSuggestions(slotSchema.id)}
              {#if i > 0}<hr class="slot-sep" />{/if}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="slot-block" class:filling
                onmouseenter={() => onHoverSlot?.(slotSchema.id)}
                onmouseleave={() => onHoverSlot?.(null)}
              >
                <div class="slot-header">
                  <div class="slot-btns">
                    {#if filling}
                      <button class="slot-btn active" onclick={() => onCancelSlotFill()}>cancel</button>
                    {:else}
                      <button class="slot-btn fill" onclick={() => onRequestSlotFill(change.patternId, slotSchema.id, slotSchema.anchorKind, slotSchema.tierId)}>{slotSchema.variadic ? '+ add' : 'fill'}</button>
                    {/if}
                  </div>
                  <span class="slot-label">{slotSchema.label ?? slotSchema.name}</span>
                  <span class="slot-kind">{slotSchema.anchorKind}</span>
                  {#if slotSchema.tierId}
                    {@const tierDef__ = store.getTier(slotSchema.tierId)}
                    <span class="slot-tier-badge" title={slotSchema.tierId}>{tierDef__?.name ?? slotSchema.tierId}</span>
                  {/if}
                  {#if i < 9}<span class="slot-shortcut">{i + 1}</span>{/if}
                  {#if !slotSchema.required}<span class="slot-optional">opt</span>{/if}
                </div>
                {#if slotSugs.length > 0}
                  {@const hoverSlotSug = slotSugs.find(s => s.id === hoverSugId)}
                  <div class="sug-box">
                    <div class="slot-value" class:sug-preview={!!hoverSlotSug}>
                      {#if hoverSlotSug && hoverSlotSug.change.type === 'pattern:fill-slot'}
                        <span class="slot-text">{annDisplayText(hoverSlotSug.change.slot.annotationId) || '(pending)'}</span>
                      {:else}
                        <span class="slot-empty">{slotSchema.required ? '— required —' : '— empty —'}</span>
                      {/if}
                    </div>
                    {#each slotSugs as slotSug (slotSug.id)}
                      {#if slotSug.change.type === 'pattern:fill-slot'}
                        <div class="sug-row">
                          <div class="sug-row-author"><span>{formatAuthor(slotSug.authorId)}</span><span class="sug-timestamp">{formatTimestamp(slotSug.createdAt)}</span></div>
                          <div class="sug-row-main">
                            <span class="sug-arrow">→</span>
                            <span class="slot-text">{annDisplayText(slotSug.change.slot.annotationId) || '(pending)'}</span>
                            <button class="sug-btn sug-check" title="Accept suggestion"
                              onmouseenter={() => hoverSugId = slotSug.id}
                              onmouseleave={() => hoverSugId = null}
                              onclick={() => store.acceptSuggestion(slotSug.id)}>✓</button>
                            <button class="sug-btn sug-x" title="Reject suggestion"
                              onclick={() => store.rejectSuggestion(slotSug.id)}>✗</button>
                          </div>
                        </div>
                      {/if}
                    {/each}
                  </div>
                {:else}
                  <div class="slot-value">
                    <span class="slot-empty">{slotSchema.required ? '— required —' : '— empty —'}</span>
                  </div>
                {/if}
                {#if slotSugs.length > 0 && slotSchema.metrics.length > 0}
                  <div class="slot-metrics">
                    {#each slotSchema.metrics as metricSchema (metricSchema.id)}
                      {@const metSugs   = metricSuggestions(slotSchema.id, metricSchema.id)}
                      {@const previewSug = metSugs.find(s => s.id === hoverSugId)}
                      {@const curVal    = ghostMetricSugValue(slotSchema.id, metricSchema.id)}
                      {#if metSugs.length > 0}
                        <div class="sug-box">
                          <div class="metric-row">
                            <span class="metric-label">{metricSchema.name}</span>
                            {#if metricSchema.type === 'boolean'}
                              <input type="checkbox"
                                class:sug-preview={!!previewSug}
                                checked={previewSug?.change.type === 'pattern:fill-metric' ? Boolean(previewSug.change.value) : curVal === true}
                                onchange={(e) => ghostSetMetricValue(change.patternId, slotSchema.id, metricSchema.id, (e.currentTarget as HTMLInputElement).checked)}
                              />
                            {:else if metricSchema.type === 'categorical' && metricSchema.vocabularyId}
                              {@const vocab = vocabs.find(v => v.id === metricSchema.vocabularyId)}
                              <select
                                class:sug-preview={!!previewSug}
                                value={previewSug?.change.type === 'pattern:fill-metric' ? String(previewSug.change.value) : (curVal as string ?? '')}
                                onchange={(e) => ghostSetMetricValue(change.patternId, slotSchema.id, metricSchema.id, (e.currentTarget as HTMLSelectElement).value || null)}
                              >
                                <option value="">—</option>
                                {#each vocab?.entries ?? [] as entry (entry.id)}
                                  <option value={entry.value}>{entry.value}{entry.description ? ` — ${entry.description}` : ''}</option>
                                {/each}
                              </select>
                            {:else if metricSchema.type === 'participant'}
                              <select
                                class:sug-preview={!!previewSug}
                                value={previewSug?.change.type === 'pattern:fill-metric' ? String(previewSug.change.value) : (curVal as string ?? '')}
                                onchange={(e) => ghostSetMetricValue(change.patternId, slotSchema.id, metricSchema.id, (e.currentTarget as HTMLSelectElement).value || null)}
                              >
                                <option value="">—</option>
                                {#each participants as p (p.id)}
                                  <option value={p.id}>{p.label}</option>
                                {/each}
                              </select>
                            {:else}
                              <input type="text"
                                class:sug-preview={!!previewSug}
                                value={previewSug?.change.type === 'pattern:fill-metric' ? String(previewSug.change.value) : (curVal as string ?? '')}
                                oninput={(e) => ghostSetMetricValue(change.patternId, slotSchema.id, metricSchema.id, (e.currentTarget as HTMLInputElement).value || null)}
                              />
                            {/if}
                          </div>
                          {#each metSugs as metSug (metSug.id)}
                            {#if metSug.change.type === 'pattern:fill-metric'}
                              <div class="sug-row">
                                <div class="sug-row-author"><span>{formatAuthor(metSug.authorId)}</span><span class="sug-timestamp">{formatTimestamp(metSug.createdAt)}</span></div>
                                <div class="sug-row-main">
                                  <span class="sug-arrow">→</span>
                                  <span class="sug-val">{String(metSug.change.value)}</span>
                                  <button class="sug-btn sug-check" title="Accept suggestion"
                                    onmouseenter={() => hoverSugId = metSug.id}
                                    onmouseleave={() => hoverSugId = null}
                                    onclick={() => store.acceptSuggestion(metSug.id)}>✓</button>
                                  <button class="sug-btn sug-x" title="Reject suggestion"
                                    onclick={() => store.rejectSuggestion(metSug.id)}>✗</button>
                                </div>
                              </div>
                            {/if}
                          {/each}
                        </div>
                      {:else}
                        <div class="metric-row">
                          <span class="metric-label">{metricSchema.name}</span>
                          {#if metricSchema.type === 'boolean'}
                            <input type="checkbox" checked={curVal === true}
                              onchange={(e) => ghostSetMetricValue(change.patternId, slotSchema.id, metricSchema.id, (e.currentTarget as HTMLInputElement).checked)}
                            />
                          {:else if metricSchema.type === 'categorical' && metricSchema.vocabularyId}
                            {@const vocab = vocabs.find(v => v.id === metricSchema.vocabularyId)}
                            <select value={curVal as string ?? ''}
                              onchange={(e) => ghostSetMetricValue(change.patternId, slotSchema.id, metricSchema.id, (e.currentTarget as HTMLSelectElement).value || null)}
                            >
                              <option value="">—</option>
                              {#each vocab?.entries ?? [] as entry (entry.id)}
                                <option value={entry.value}>{entry.value}{entry.description ? ` — ${entry.description}` : ''}</option>
                              {/each}
                            </select>
                          {:else if metricSchema.type === 'participant'}
                            <select value={curVal as string ?? ''}
                              onchange={(e) => ghostSetMetricValue(change.patternId, slotSchema.id, metricSchema.id, (e.currentTarget as HTMLSelectElement).value || null)}
                            >
                              <option value="">—</option>
                              {#each participants as p (p.id)}
                                <option value={p.id}>{p.label}</option>
                              {/each}
                            </select>
                          {:else}
                            <input type="text" value={curVal as string ?? ''}
                              oninput={(e) => ghostSetMetricValue(change.patternId, slotSchema.id, metricSchema.id, (e.currentTarget as HTMLInputElement).value || null)}
                            />
                          {/if}
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
            <hr class="slot-sep" />
            <div class="pattern-actions">
              <button class="accept-all-btn" onclick={() => acceptAllForGhostPattern(change.patternId, sug.id)}>Accept all</button>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{:else}
  <div class="empty-state">No patterns yet.<br/>Create one above.</div>
{/if}

{#if sugNotePopup}
  <button class="note-popup-backdrop" onclick={closeSugNotePopup} aria-label="Close note"></button>
  <div class="note-popup" style="left:{sugNotePopup.x}px; top:{sugNotePopup.y}px">
    <div class="note-popup-header">
      <span class="note-popup-title">{sugNotePopup.author}</span>
      <button class="note-popup-close" onclick={closeSugNotePopup} aria-label="Close">×</button>
    </div>
    <div class="note-popup-single">
      <p class="note-popup-text">{sugNotePopup.text}</p>
    </div>
  </div>
{/if}

<style>
  .inspector-header {
    padding: 0.6rem 0.75rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    flex-shrink: 0;
    background: var(--color-bg-0);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .new-pattern-row { display: flex; align-items: center; gap: 0.5rem; }
  .add-hint { font-size: 0.7rem; color: var(--color-text-placeholder); }
  .filter-row { display: flex; }
  .filter-row select { flex: 1; min-width: 0; }

  .add-btn-active {
    background: var(--color-active-dark);
    border-color: var(--color-active-dark);
  }
  .add-btn-active:hover { background: var(--color-active); border-color: var(--color-active); }

  /* ── Pattern type picker ─────────────────────────────────────────────────── */

  .picker-list { display: flex; flex-direction: column; gap: 1px; }

  .picker-item {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.3rem 0.4rem; border-radius: var(--radius-xs);
    border: none; background: none; cursor: pointer; width: 100%;
    text-align: left; font: inherit; color: var(--color-text-1);
  }
  .picker-item:hover, .picker-item.picker-active {
    background: var(--color-active-light); color: var(--color-active-dark);
  }
  .picker-num {
    font-size: 0.68rem; font-weight: 700; color: var(--color-text-muted);
    width: 1rem; text-align: right; flex-shrink: 0;
  }
  .picker-item.picker-active .picker-num { color: var(--color-active); }
  .picker-name { flex: 1; font-size: 0.82rem; }
  .picker-hotkey { font-size: 0.68rem; color: var(--color-text-placeholder); flex-shrink: 0; }

  /* ── Pattern list ─────────────────────────────────────────────────────────── */

  .pattern-list {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    border-bottom: 1px solid var(--color-border);
  }

  .pattern-item { display: flex; flex-direction: column; border-bottom: 1px solid var(--color-border-strong); }
  .pattern-item:last-child { border-bottom: none; }
  .pattern-item.pattern-pending-delete > .pattern-row { opacity: 0.55; text-decoration: line-through; }
  .pattern-ghost { opacity: 0.85; }
  .pattern-ghost-label { color: var(--color-text-muted); font-style: italic; }

  .pattern-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.32rem 0.75rem;
    cursor: pointer;
    font-size: 0.82rem;
    background: none; border: none; width: 100%; text-align: left; font: inherit; color: inherit;
  }
  .pattern-row:hover { background: var(--color-bg-2); }
  .pattern-item.selected > .pattern-row { background: var(--color-active-light); }
  .pattern-row.pattern-fill-target { cursor: crosshair; }
  .pattern-row.pattern-fill-target:hover { background: #dff0d8; }

  .warn-icon { font-size: 0.75rem; color: var(--color-status-warn); flex-shrink: 0; }

  .pattern-row-label { flex: 1; font-weight: 500; }
  .pattern-row-lines {
    font-variant-numeric: tabular-nums;
    font-size: var(--font-xs);
    color: var(--color-text-placeholder);
    flex-shrink: 0;
  }

  /* ── Pattern body ─────────────────────────────────────────────────────────── */

  .pattern-body {
    padding: 0.6rem 0.75rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .slot-sep {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 0.45rem 0;
  }

  .slot-block {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .slot-block.filling { background: #fffdf4; border-radius: var(--radius-xs); padding: 0.2rem 0.3rem; margin: 0 -0.3rem; }

  .slot-header { display: flex; align-items: center; gap: 0.35rem; flex-wrap: nowrap; }
  .slot-btns { display: flex; gap: 0.2rem; flex-shrink: 0; }
  .slot-label { font-weight: 500; font-size: var(--font-sm); flex: 1; text-align: right; }
  .slot-kind {
    font-size: 0.6rem; color: var(--color-text-muted);
    border: 1px solid var(--color-border); border-radius: 2px;
    padding: 0 0.22rem; line-height: 1.5; flex-shrink: 0;
    font-style: italic;
  }
  .slot-tier-badge {
    font-size: 0.6rem; color: var(--color-active-dark);
    background: var(--color-active-light); border: 1px solid var(--color-active);
    border-radius: 2px; padding: 0 0.22rem; line-height: 1.5; flex-shrink: 0;
    max-width: 6rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .slot-shortcut {
    font-size: 0.62rem; color: var(--color-text-placeholder);
    border: 1px solid var(--color-border); border-radius: 2px;
    padding: 0 0.25rem; line-height: 1.4; flex-shrink: 0;
  }
  .slot-optional { font-size: 0.68rem; color: var(--color-text-light, #888); font-style: italic; }

  .slot-btn {
    padding: 0.1rem 0.45rem;
    font-size: var(--font-xs);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-xs);
    background: var(--color-bg-0);
    cursor: pointer;
    font-family: inherit;
    line-height: 1.5;
    color: var(--color-text-2);
  }
  .slot-btn:hover { background: var(--color-bg-menu-hover); border-color: var(--color-primary-border); }
  .slot-btn.fill { color: var(--color-active-dark); border-color: var(--color-active); }
  .slot-btn.fill:hover { background: var(--color-active-light); border-color: var(--color-active); }
  .slot-btn.active { background: var(--color-active-light); border-color: var(--color-active); color: var(--color-active-dark); }
  .slot-btn.unfill { color: var(--color-text-light, #888); }
  .slot-btn.unfill:hover { background: var(--color-danger-light); border-color: var(--color-danger); color: var(--color-danger); }

  .slot-value { font-size: 0.78rem; padding-left: 1px; display: flex; align-items: baseline; gap: 0.3rem; flex-wrap: wrap; }
  .slot-text { color: #2c5f8a; font-family: 'CMU Serif', 'Computer Modern', Georgia, serif; font-style: italic; flex: 1; }
  .slot-text.pattern-ref { font-style: normal; font-weight: 500; }
  .slot-empty { color: var(--color-text-light, #888); }
  .pattern-ref-detail { font-size: 0.7rem; color: var(--color-text-muted, #aaa); flex-shrink: 0; }
  .goto-btn {
    padding: 0 0.3rem;
    font-size: 0.78rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xs);
    background: var(--color-bg-2);
    cursor: pointer;
    color: var(--color-primary-dark);
    flex-shrink: 0;
    line-height: 1.4;
  }
  .goto-btn:hover { background: var(--color-primary-light); border-color: var(--color-primary-border); }

  .variadic-list { display: flex; flex-direction: column; gap: 1px; font-size: 0.78rem; }
  .variadic-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.1rem 0.2rem;
    border-radius: var(--radius-xs);
  }
  .variadic-row:hover { background: var(--color-bg-3); }
  .variadic-row .slot-text { flex: 1; }
  .variadic-row .icon-btn { padding: 0 0.2rem; font-size: 0.75rem; }

  .slot-metrics {
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
    margin-top: 0.15rem;
  }

  .metric-row { display: flex; align-items: center; gap: 0.4rem; font-size: 0.77rem; }
  .metric-label { color: var(--color-text-3); min-width: 76px; flex-shrink: 0; }

  .metric-row select,
  .metric-row input[type="text"] {
    flex: 1;
    min-width: 0;
  }

  .metric-row input[type="checkbox"] { cursor: pointer; }

  /* ── Suggestion box ─────────────────────────────────────────────────────── */

  .sug-box {
    border-top: 1px solid #ffc107;
    border-bottom: 1px solid #ffc107;
    background: #fffbf0;
    padding: 0.22rem 0.75rem;
    margin: 0 -0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.12rem;
  }
  .sug-box-delete {
    border-color: #f87171;
    background: #fff5f5;
    margin: 0;
    padding: 0.18rem 0.75rem;
  }
  .sug-box-add {
    border-color: #86efac;
    background: #f0fdf4;
    margin: 0;
    padding: 0.18rem 0.75rem;
  }
  .sug-row {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding-top: 0.15rem;
    border-top: 1px solid #fde68a;
  }
  .sug-row-author {
    display: flex;
    justify-content: space-between;
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--color-text-3);
  }
  .sug-timestamp {
    font-weight: 400;
    color: var(--color-text-muted);
  }
  .sug-row-main {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.78rem;
  }
  .sug-note-btn {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 0.65rem;
    font-style: italic;
    color: var(--color-text-muted);
    cursor: default;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sug-note-btn:global(.truncated) { cursor: pointer; }
  .sug-note-btn:global(.truncated):hover { color: var(--color-text-2); text-decoration: underline; }

  /* ── Suggestion note popup (same pattern as GutterOverlay) ──────────────── */

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
  .note-popup-single { padding: 0.1rem 0; }
  .note-popup-text {
    margin: 0;
    line-height: 1.45;
    white-space: pre-wrap;
    padding: 0.3rem 0.65rem 0.5rem;
  }

  .sug-arrow {
    color: #b45309;
    font-size: 0.72rem;
    flex-shrink: 0;
  }
  .sug-box .slot-value.sug-preview {
    background: #fef3c7;
    border-radius: var(--radius-xs);
  }
  .sug-box .metric-row select.sug-preview,
  .sug-box .metric-row input[type="text"].sug-preview {
    background: #fef3c7;
    border-color: #ffc107;
  }
  .sug-box .metric-row input[type="checkbox"].sug-preview {
    outline: 2px solid #ffc107;
    outline-offset: 1px;
  }

  .sug-val {
    font-size: 0.77rem;
    color: var(--color-text-1);
    flex: 1;
    min-width: 0;
  }
  .sug-btn {
    padding: 0 0.28rem;
    border-radius: var(--radius-xs);
    border: 1px solid;
    background: none;
    cursor: pointer;
    font-size: 0.78rem;
    line-height: 1.5;
    flex-shrink: 0;
    font-family: inherit;
  }
  .sug-check { color: var(--color-active-dark); border-color: var(--color-active); }
  .sug-check:hover { background: var(--color-active-light); }
  .sug-x { color: var(--color-danger); border-color: var(--color-danger); }
  .sug-x:hover { background: var(--color-danger-light); }

  .note-block { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.1rem; }
  .note-header { display: flex; align-items: center; justify-content: space-between; }
  .note-label { font-size: var(--font-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-muted); }
  .note-add-btn { font-size: var(--font-xs); padding: 0.1rem 0.4rem; border: 1px solid var(--color-active); border-radius: 3px; background: transparent; color: var(--color-active-dark); cursor: pointer; font-weight: 600; }
  .note-add-btn:hover { background: var(--color-active-light); }
  .note-entry { display: flex; flex-direction: column; gap: 0.15rem; }
  .note-entry-meta { display: flex; align-items: center; gap: 0.4em; }
  .note-entry-meta .note-delete-btn { margin-left: auto; }
  .note-entry-author { font-size: 0.68rem; font-weight: 600; color: var(--color-text-muted); }
  .note-entry-date { font-size: 0.68rem; color: var(--color-text-muted); }
  .note-delete-btn { background: none; border: none; cursor: pointer; font-size: 0.8rem; color: #bbb; padding: 0 0.2rem; line-height: 1; border-radius: 2px; }
  .note-delete-btn:hover { color: #c44; background: #fde; }
  .note-entry-text { resize: vertical; width: 100%; box-sizing: border-box; }
  .note-empty { font-size: var(--font-xs); color: var(--color-text-muted); margin: 0; font-style: italic; }
  .note-other { font-size: var(--font-xs); color: var(--color-text-muted); padding: 0.25rem 0.35rem; background: #f5f5f5; border-radius: 3px; white-space: pre-wrap; word-break: break-word; display: flex; flex-direction: column; gap: 0.1rem; }
  .note-other-meta { display: flex; align-items: baseline; gap: 0.4em; }
  .note-other-author { font-weight: 600; }
  .note-other-date { font-size: 0.65rem; color: #bbb; }
  .note-other-text { display: block; }

  .pattern-actions { display: flex; justify-content: flex-end; margin-top: 0.5rem; gap: 0.4rem; }
  .accept-all-btn {
    padding: 0.2rem 0.6rem;
    font-size: var(--font-xs);
    border: 1px solid var(--color-active);
    border-radius: var(--radius-xs);
    background: var(--color-active-light);
    color: var(--color-active-dark);
    cursor: pointer;
    font-family: inherit;
    line-height: 1.5;
  }
  .accept-all-btn:hover { background: var(--color-active); color: #fff; }

  .empty-state {
    padding: 1.5rem 1rem;
    font-size: var(--font-sm);
    color: var(--color-text-faint);
    text-align: center;
    line-height: 1.5;
  }
</style>
