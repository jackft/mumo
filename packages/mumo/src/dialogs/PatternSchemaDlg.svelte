<script lang="ts">
  import type { AnnotationStore, PatternSchema, SlotSchema, MetricSchema, ControlledVocabulary, SlotTextStyle } from '@mumo/core'
  import type { MetricType } from '@mumo/core'
  import { newId } from '@mumo/core'

  const { store, patternSchemas, vocabs, onClose }: {
    store: AnnotationStore
    patternSchemas: PatternSchema[]
    vocabs: ControlledVocabulary[]
    onClose: () => void
  } = $props()

  let selectedId = $state<string | null>(null)
  let newName    = $state('')

  const selected = $derived(patternSchemas.find(s => s.id === selectedId) ?? null)

  function create() {
    if (!newName.trim()) return
    const s = store.addPatternSchema({ name: newName.trim(), slots: [] })
    selectedId = s.id
    newName = ''
  }

  function deleteSchema(id: string) {
    if (selectedId === id) selectedId = null
    store.removePatternSchema(id)
  }

  function patch(p: Partial<Omit<PatternSchema, 'id'>>) {
    if (!selectedId) return
    store.updatePatternSchema(selectedId, p)
  }

  function patchSlots(slots: SlotSchema[]) { patch({ slots }) }

  function addSlot() {
    if (!selected) return
    patchSlots([...selected.slots, {
      id: newId(), name: 'slot', anchorKind: 'textlet', required: true, metrics: [],
    }])
  }

  function removeSlot(slotId: string) {
    if (!selected) return
    patchSlots(selected.slots.filter(s => s.id !== slotId))
  }

  function patchSlot(slotId: string, p: Partial<SlotSchema>) {
    if (!selected) return
    patchSlots(selected.slots.map(s => s.id === slotId ? { ...s, ...p } : s))
  }

  function addMetric(slotId: string) {
    if (!selected) return
    const slot = selected.slots.find(s => s.id === slotId)
    if (!slot) return
    patchSlot(slotId, { metrics: [...slot.metrics, { id: newId(), name: 'metric', type: 'text' as MetricType }] })
  }

  function removeMetric(slotId: string, metricId: string) {
    if (!selected) return
    const slot = selected.slots.find(s => s.id === slotId)
    if (!slot) return
    patchSlot(slotId, { metrics: slot.metrics.filter(m => m.id !== metricId) })
  }

  function patchMetric(slotId: string, metricId: string, p: Partial<MetricSchema>) {
    if (!selected) return
    const slot = selected.slots.find(s => s.id === slotId)
    if (!slot) return
    patchSlot(slotId, { metrics: slot.metrics.map(m => m.id === metricId ? { ...m, ...p } : m) })
  }

  function patchSlotStyleKey<K extends keyof SlotTextStyle>(slotId: string, key: K, value: SlotTextStyle[K] | undefined | false | '') {
    if (!selected) return
    const slot = selected.slots.find(s => s.id === slotId)
    if (!slot) return
    const next: Record<string, unknown> = { ...slot.style }
    if (value === undefined || value === false || value === '') {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete next[key]
    } else {
      next[key] = value
    }
    if (Object.keys(next).length === 0) {
      patchSlots(selected.slots.map(s => {
        if (s.id !== slotId) return s
        const { style: _, ...rest } = s
        return rest as SlotSchema
      }))
    } else {
      patchSlot(slotId, { style: next as SlotTextStyle })
    }
  }

  function normalizeKey(e: KeyboardEvent): string {
    const parts: string[] = []
    if (e.ctrlKey)  parts.push('ctrl')
    if (e.altKey)   parts.push('alt')
    if (e.shiftKey) parts.push('shift')
    if (e.metaKey)  parts.push('meta')
    const key = e.key.toLowerCase()
    // Ignore bare modifier presses
    if (['control','alt','shift','meta'].includes(key)) return ''
    parts.push(key)
    return parts.join('+')
  }

</script>

<button class="dlg-backdrop" onclick={onClose} aria-label="Close dialog"></button>
<div class="dlg pattern-schema-dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <h3 id="dlg-title">Pattern Schemas</h3>

  <div class="panels">

    <!-- Left: schema list -->
    <div class="list-panel">
      {#each patternSchemas as s (s.id)}
        <div class="schema-row" class:selected={selectedId === s.id}>
          <button class="schema-select" onclick={() => selectedId = s.id}>
            <span class="schema-name">{s.name}</span>
          </button>
          <button class="icon-btn danger" title="Delete" onclick={() => deleteSchema(s.id)}>×</button>
        </div>
      {/each}
      <div class="new-row">
        <input bind:value={newName} placeholder="New schema…"
               onkeydown={(e) => e.key === 'Enter' && create()} />
        <button onclick={create} disabled={!newName.trim()}>Add</button>
      </div>
    </div>

    <!-- Right: detail -->
    <div class="detail-panel">
      {#if selected}

        <!-- Header fields -->
        <div class="field-row">
          <label for="fs-name">Name</label>
          <input id="fs-name" value={selected.name}
                 oninput={(e) => patch({ name: (e.currentTarget as HTMLInputElement).value })} />
        </div>
        <div class="field-row">
          <label for="fs-desc">Description</label>
          <input id="fs-desc" value={selected.description ?? ''}
                 placeholder="optional…"
                 oninput={(e) => {
                   const v = (e.currentTarget as HTMLInputElement).value
                   if (v) patch({ description: v }); else { const { description: _, ...rest } = selected; patch(rest) }
                 }} />
        </div>
        <div class="field-row">
          <label for="fs-color">Color</label>
          <input id="fs-color" type="color"
            value={selected.color !== undefined ? '#' + selected.color.toString(16).padStart(6, '0') : '#888888'}
            onchange={(e) => patch({ color: parseInt((e.currentTarget as HTMLInputElement).value.slice(1), 16) })}
          />
          {#if selected.color !== undefined}
            <button class="icon-btn" title="Clear color"
              onclick={() => { const { color: _, ...rest } = selected; patch(rest) }}>×</button>
          {/if}
        </div>
        <div class="field-row">
          <label for="fs-hotkey">Hotkey</label>
          <input id="fs-hotkey" class="hotkey-input"
                 value={selected.hotkey ?? ''}
                 placeholder="e.g. alt+r"
                 readonly
                 onkeydown={(e) => {
                   e.preventDefault()
                   const combo = normalizeKey(e)
                   if (combo === 'escape' || combo === 'backspace' || combo === 'delete') {
                     const { hotkey: _, ...rest } = selected; patch(rest)
                   } else if (combo) {
                     patch({ hotkey: combo })
                   }
                 }}
                 onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
          />
        </div>

        <!-- Slots -->
        <div class="slots-header">
          <span class="section-label">Slots</span>
          <button class="add-btn" onclick={addSlot}>+ slot</button>
        </div>

        {#if selected.slots.length === 0}
          <div class="empty-hint">No slots yet.</div>
        {/if}

        {#each selected.slots as slot (slot.id)}
          <div class="slot-block">
            <div class="slot-header-row">
              <input class="slot-name" value={slot.name}
                     placeholder="name"
                     oninput={(e) => patchSlot(slot.id, { name: (e.currentTarget as HTMLInputElement).value })} />
              <input class="slot-label" value={slot.label ?? ''}
                     placeholder="label (optional)"
                     oninput={(e) => {
                       const v = (e.currentTarget as HTMLInputElement).value
                       if (v) patchSlot(slot.id, { label: v }); else { const { label: _, ...rest } = slot; patchSlot(slot.id, rest) }
                     }} />
              <select value={slot.anchorKind}
                      onchange={(e) => patchSlot(slot.id, { anchorKind: (e.currentTarget as HTMLSelectElement).value as 'textlet' | 'utterance' | 'tier' | 'pattern' | 'any' })}>
                <option value="any">any</option>
                <option value="textlet">textlet</option>
                <option value="utterance">utterance</option>
                <option value="tier">tier annotation</option>
                <option value="pattern">pattern</option>
              </select>
              <label class="req-label" title="Required">
                <input type="checkbox" checked={!!slot.required}
                       onchange={(e) => patchSlot(slot.id, { required: (e.currentTarget as HTMLInputElement).checked })} />
                req
              </label>
              <label class="req-label" title="Variadic (multiple values)">
                <input type="checkbox" checked={!!slot.variadic}
                       onchange={(e) => patchSlot(slot.id, { variadic: (e.currentTarget as HTMLInputElement).checked })} />
                variadic
              </label>
              <button class="icon-btn danger" onclick={() => removeSlot(slot.id)} title="Remove slot">×</button>
            </div>

            <!-- Text Style -->
            <div class="style-row">
              <label class="style-toggle">
                <input type="checkbox" checked={!!slot.style?.textColor}
                       onchange={(e) => patchSlotStyleKey(slot.id, 'textColor', (e.currentTarget as HTMLInputElement).checked ? '#000000' : '')} />
                color
              </label>
              {#if slot.style?.textColor}
                <input type="color" class="style-color" value={slot.style.textColor}
                       onchange={(e) => patchSlotStyleKey(slot.id, 'textColor', (e.currentTarget as HTMLInputElement).value)} />
              {/if}
              <label class="style-toggle">
                <input type="checkbox" checked={!!slot.style?.backgroundColor}
                       onchange={(e) => patchSlotStyleKey(slot.id, 'backgroundColor', (e.currentTarget as HTMLInputElement).checked ? '#ffff00' : '')} />
                bg
              </label>
              {#if slot.style?.backgroundColor}
                <input type="color" class="style-color" value={slot.style.backgroundColor}
                       onchange={(e) => patchSlotStyleKey(slot.id, 'backgroundColor', (e.currentTarget as HTMLInputElement).value)} />
              {/if}
              <label class="style-toggle">
                <input type="checkbox" checked={!!slot.style?.borderColor}
                       onchange={(e) => patchSlotStyleKey(slot.id, 'borderColor', (e.currentTarget as HTMLInputElement).checked ? '#888888' : '')} />
                border
              </label>
              {#if slot.style?.borderColor}
                <input type="color" class="style-color" value={slot.style.borderColor}
                       onchange={(e) => patchSlotStyleKey(slot.id, 'borderColor', (e.currentTarget as HTMLInputElement).value)} />
              {/if}
              <div class="style-divider"></div>
              <label class="style-toggle style-fmt" title="Bold">
                <input type="checkbox" checked={!!slot.style?.bold}
                       onchange={(e) => patchSlotStyleKey(slot.id, 'bold', (e.currentTarget as HTMLInputElement).checked)} />
                <strong>B</strong>
              </label>
              <label class="style-toggle style-fmt" title="Italic">
                <input type="checkbox" checked={!!slot.style?.italic}
                       onchange={(e) => patchSlotStyleKey(slot.id, 'italic', (e.currentTarget as HTMLInputElement).checked)} />
                <em>I</em>
              </label>
              <label class="style-toggle style-fmt" title="Underline">
                <input type="checkbox" checked={!!slot.style?.underline}
                       onchange={(e) => patchSlotStyleKey(slot.id, 'underline', (e.currentTarget as HTMLInputElement).checked)} />
                <u>U</u>
              </label>
              <label class="style-toggle style-fmt" title="Strikethrough">
                <input type="checkbox" checked={!!slot.style?.strikethrough}
                       onchange={(e) => patchSlotStyleKey(slot.id, 'strikethrough', (e.currentTarget as HTMLInputElement).checked)} />
                <s>S</s>
              </label>
            </div>

            <!-- Metrics -->
            <div class="metrics-area">
              {#each slot.metrics as metric (metric.id)}
                <div class="metric-row">
                  <input class="metric-name" value={metric.name}
                         placeholder="metric name"
                         oninput={(e) => patchMetric(slot.id, metric.id, { name: (e.currentTarget as HTMLInputElement).value })} />
                  <select value={metric.type}
                          onchange={(e) => {
                            const t = (e.currentTarget as HTMLSelectElement).value as MetricType
                            if (t === 'categorical') {
                              patchMetric(slot.id, metric.id, { type: t })
                            } else {
                              const { vocabularyId: _, ...rest } = metric
                              patchMetric(slot.id, metric.id, { ...rest, type: t })
                            }
                          }}>
                    <option value="text">text</option>
                    <option value="boolean">boolean</option>
                    <option value="categorical">categorical</option>
                    <option value="participant">participant</option>
                  </select>
                  {#if metric.type === 'categorical'}
                    <select value={metric.vocabularyId ?? ''}
                            onchange={(e) => {
                              const v = (e.currentTarget as HTMLSelectElement).value
                              if (v) {
                                patchMetric(slot.id, metric.id, { vocabularyId: v })
                              } else {
                                const { vocabularyId: _, ...rest } = metric
                                patchMetric(slot.id, metric.id, rest)
                              }
                            }}>
                      <option value="">— vocab —</option>
                      {#each vocabs as v (v.id)}
                        <option value={v.id}>{v.name}</option>
                      {/each}
                    </select>
                  {/if}
                  <button class="icon-btn danger" onclick={() => removeMetric(slot.id, metric.id)} title="Remove metric">×</button>
                </div>
              {/each}
              <button class="add-metric-btn" onclick={() => addMetric(slot.id)}>+ metric</button>
            </div>
          </div>
        {/each}

      {:else}
        <div class="empty-hint tall">Select a schema to edit, or create one.</div>
      {/if}
    </div>
  </div>

  <div class="dlg-actions">
    <button class="primary" onclick={onClose}>Done</button>
  </div>
</div>

<style>
  .panels {
    display: flex;
    gap: 0;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .list-panel {
    width: 170px;
    flex-shrink: 0;
    border-right: 1px solid var(--color-border-strong);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 0.4rem 0;
  }

  .schema-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.82rem;
  }
  .schema-row:hover { background: var(--color-bg-2); }
  .schema-row.selected { background: var(--color-primary-light); }

  .schema-select {
    flex: 1; display: flex; align-items: center;
    background: none; border: none; padding: 0.28rem 0.6rem; cursor: pointer;
    font: inherit; color: inherit; text-align: left; min-width: 0; overflow: hidden;
  }
  .schema-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .new-row {
    display: flex;
    gap: 0.3rem;
    padding: 0.4rem 0.5rem 0.2rem;
    margin-top: auto;
    border-top: 1px solid #eee;
  }
  .new-row input { flex: 1; min-width: 0; }

  .detail-panel {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .field-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.82rem;
  }
  .field-row label { width: 76px; flex-shrink: 0; color: var(--color-text-3); font-size: 0.78rem; }
  .field-row input:not([type]) { flex: 1; }
  .field-row input[type="color"] { width: 36px; height: 24px; padding: 1px 2px; cursor: pointer; border: 1px solid var(--color-border); border-radius: var(--radius-xs); }

  .slots-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .section-label { flex: 1; }

  .slot-block {
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    padding: 0.45rem 0.5rem;
    background: var(--color-bg-0);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .slot-header-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .slot-name  { width: 90px; flex-shrink: 0; }
  .slot-label { flex: 1; min-width: 80px; }

  .req-label {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    font-size: var(--font-xs);
    color: var(--color-text-3);
    cursor: pointer;
    flex-shrink: 0;
  }

  .style-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-wrap: wrap;
    padding: 0.2rem 0;
    border-top: 1px solid var(--color-bg-3);
  }

  .style-toggle {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    font-size: var(--font-xs);
    color: var(--color-text-3);
    cursor: pointer;
    flex-shrink: 0;
  }

  .style-color {
    width: 28px;
    height: 20px;
    padding: 1px 2px;
    cursor: pointer;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xs);
  }

  .style-divider {
    width: 1px;
    height: 16px;
    background: var(--color-border);
    margin: 0 0.15rem;
    flex-shrink: 0;
  }

  .style-fmt {
    font-size: 0.8rem;
    min-width: 28px;
    justify-content: center;
  }

  .metrics-area {
    display: flex;
    flex-direction: column;
    gap: 0.22rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--color-bg-3);
  }

  .metric-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  .metric-name { width: 110px; flex-shrink: 0; }

  .add-metric-btn {
    align-self: flex-start;
    margin-top: 2px;
  }

  .empty-hint { font-size: var(--font-sm); color: var(--color-text-faint); }
  .empty-hint.tall { padding: 2rem 0; text-align: center; }

  .dlg { width: 700px; max-width: 95vw; max-height: 80vh; }
</style>
