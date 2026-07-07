<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { TabulatorFull as Tabulator } from 'tabulator-tables'
  import type { CellComponent, ColumnComponent, ColumnDefinition } from 'tabulator-tables'
  import 'tabulator-tables/dist/css/tabulator_simple.min.css'
  import type { ParticipantJSON, TierDef } from '@mumo/core'

  type Row = Record<string, string>

  const {
    participants,
    inUseLabels,
    tiers,
    onadd,
    onupdate,
    onremove,
    onclose,
    oncopystructure,
  }: {
    participants: ParticipantJSON[]
    inUseLabels: Set<string>
    tiers: TierDef[]
    onadd:    (vals: Omit<ParticipantJSON, 'id'>) => ParticipantJSON
    onupdate: (id: string, patch: Partial<Omit<ParticipantJSON, 'id'>>) => void
    onremove: (id: string) => void
    onclose:  () => void
    oncopystructure?: (newLabel: string, source: { type: 'participant' | 'tier'; id: string }) => void
  } = $props()

  // Data helpers

  function toRow(p: ParticipantJSON): Row {
    const row: Row = { _id: p.id, label: p.label }
    for (const [k, v] of Object.entries(p.attrs ?? {})) row[`attr_${k}`] = v
    return row
  }

  function rowToVals(row: Row): Omit<ParticipantJSON, 'id'> {
    const attrs: Record<string, string> = {}
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('attr_') && v.trim()) attrs[k.slice(5)] = v.trim()
    }
    return {
      label: (row['label'] ?? '').trim(),
      ...(Object.keys(attrs).length ? { attrs } : {}),
    }
  }

  // Column management

  let attrKeys = $state<string[]>(
    untrack(() => [...new Set(participants.flatMap(p => Object.keys(p.attrs ?? {})))])
  )

  function placeholderFormatter(text: string) {
    return (cell: CellComponent) => {
      const v = String(cell.getValue() ?? '').trim()
      if (v) return v
      const span = document.createElement('span')
      span.className = 'cell-placeholder'
      span.textContent = text
      return span
    }
  }

  function makeAttrCol(key: string): ColumnDefinition {
    return {
      title: key,
      field: `attr_${key}`,
      editor: 'input',
      formatter: placeholderFormatter('(no value)'),
      headerSort: false,
      headerClick: (_e: unknown, col: ColumnComponent) => col.getElement().querySelector('input')?.focus(),
    }
  }

  function buildColumns(): ColumnDefinition[] {
    const onCellEdited = (cell: CellComponent) => {
      const data = cell.getRow().getData() as Row
      onupdate(data['_id'] as string, rowToVals(data))
    }

    return [
      { title: 'ID', field: 'label', editor: 'input', headerSort: false, width: 80, cssClass: 'col-required', cellEdited: onCellEdited },
      ...attrKeys.map(k => ({ ...makeAttrCol(k), cellEdited: onCellEdited })),
      {
        title: '',
        field: '_del',
        headerSort: false,
        width: 42,
        hozAlign: 'center',
        frozen: true,
        formatter: (cell: CellComponent) => {
          const btn = document.createElement('button')
          btn.className = 'tab-del-btn'
          btn.innerHTML = '<svg width="13" height="14" viewBox="0 0 13 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 3h11M4.5 3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5.5 6.5v4M7.5 6.5v4M2 3l.7 8.1A1 1 0 0 0 3.7 12h5.6a1 1 0 0 0 1-.9L11 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          btn.onclick = () => {
            const data = cell.getRow().getData() as Row
            const label = data['label'] as string
            const id    = data['_id']   as string
            if (inUseLabels.has(label)) {
              alert('Cannot delete — this participant is referenced in the transcript or tiers.')
              return
            }
            cell.getRow().delete()
            onremove(id)
          }
          return btn
        },
      },
    ]
  }

  // Tabulator init

  let tableEl: HTMLDivElement | null = $state(null)
  let tab: InstanceType<typeof Tabulator> | null = null

  onMount(() => {
    if (!tableEl) return

    tab = new Tabulator(tableEl, {
      index: '_id',
      data: participants.map(toRow),
      columns: buildColumns(),
      layout: 'fitColumns',
      maxHeight: '40vh',
      headerSort: false,
      rowFormatter: (row) => {
        row.getElement().classList.toggle(
          'tabulator-row-even',
          (row.getPosition() as number) % 2 === 0,
        )
      },
    })

    return () => { tab?.destroy(); tab = null }
  })

  function deleteAttrColumn(key: string) {
    tab?.deleteColumn(`attr_${key}`)
    attrKeys = attrKeys.filter(k => k !== key)
    for (const p of participants) {
      if (p.attrs && key in p.attrs) {
        const next = { ...p.attrs }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete next[key]
        onupdate(p.id, Object.keys(next).length ? { attrs: next } : {})
      }
    }
  }

  // Add attr column

  let showAttrInput = $state(false)
  let newAttrKey    = $state('')

  function confirmAddAttr() {
    const key = newAttrKey.trim()
    if (!key || attrKeys.includes(key)) return
    const onCellEdited = (cell: CellComponent) => {
      const data = cell.getRow().getData() as Row
      onupdate(data['_id'] as string, rowToVals(data))
    }
    tab?.addColumn({ ...makeAttrCol(key), cellEdited: onCellEdited }, true, '_del')
    attrKeys = [...attrKeys, key]
    newAttrKey = ''
    showAttrInput = false
  }

  // Add participant form

  let showAddForm = $state(false)
  let addLabel    = $state('')
  let copyMode    = $state<'none' | 'participant' | 'tier'>('none')
  let copySource  = $state('')

  // Tiers that are linked to a participant (valid "copy from tier" sources)
  const linkedTiers = $derived(
    tiers.filter(t => t.participant)
  )

  function confirmAdd() {
    const label = addLabel.trim()
    if (!label) return
    const newP = onadd({ label })
    tab?.addRow(toRow(newP))
    if (copyMode !== 'none' && copySource) {
      oncopystructure?.(label, { type: copyMode as 'participant' | 'tier', id: copySource })
    }
    addLabel   = ''
    copyMode   = 'none'
    copySource = ''
    showAddForm = false
  }
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <div class="dlg-header">
    <h3 id="dlg-title">Participants</h3>
    <button class="icon-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>

  <div class="dlg-body">
    <!-- Tabulator table -->
    <div class="table-wrap">
      <div class="table-border" bind:this={tableEl}></div>
    </div>

    <!-- Attribute column chips -->
    <div class="attr-bar">
      <span class="attr-bar-label">Attribute columns</span>
      {#each attrKeys as key (key)}
        <span class="attr-chip">
          {key}
          <button class="icon-btn danger" onclick={() => deleteAttrColumn(key)} title="Remove column from all participants">×</button>
        </span>
      {/each}
      {#if showAttrInput}
        <input
          class="attr-key-input"
          bind:value={newAttrKey}
          placeholder="Column name"
          onkeydown={(e) => { if (e.key === 'Enter') confirmAddAttr(); if (e.key === 'Escape') { showAttrInput = false; newAttrKey = '' } }}
        />
        <button onclick={confirmAddAttr} disabled={!newAttrKey.trim()}>Add</button>
        <button onclick={() => { showAttrInput = false; newAttrKey = '' }}>Cancel</button>
      {:else}
        <button class="add-btn" onclick={() => showAttrInput = true}>+ Add column</button>
      {/if}
    </div>

    <!-- Add participant section -->
    {#if showAddForm}
      <div class="add-form-panel">
        <h4 class="add-form-title">Add participant</h4>

        <label class="field-label">
          ID <span class="req">*</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="field-input" bind:value={addLabel} placeholder="e.g. C" autofocus />
        </label>

        <label class="field-label">
          Copy tier structure
          <div class="copy-row">
            <label class="radio-label">
              <input type="radio" bind:group={copyMode} value="none" /> None
            </label>
            <label class="radio-label">
              <input type="radio" bind:group={copyMode} value="participant" /> From participant
            </label>
            <label class="radio-label">
              <input type="radio" bind:group={copyMode} value="tier" /> From tier
            </label>
          </div>
        </label>

        {#if copyMode === 'participant'}
          <label class="field-label">
            Participant to copy
            <select class="field-select" bind:value={copySource}>
              <option value="">— select —</option>
              {#each participants as p (p.id)}
                <option value={p.label}>{p.label}{p.attrs?.['name'] ? ` — ${p.attrs['name']}` : ''}</option>
              {/each}
            </select>
          </label>
        {:else if copyMode === 'tier'}
          <label class="field-label">
            Tier to copy structure from
            <select class="field-select" bind:value={copySource}>
              <option value="">— select —</option>
              {#each linkedTiers as t (t.id)}
                <option value={t.id}>{t.name}{t.participant ? ` (${t.participant})` : ''}</option>
              {/each}
            </select>
          </label>
        {/if}

        <div class="dlg-actions">
          <button onclick={() => { showAddForm = false; addLabel = ''; copyMode = 'none'; copySource = '' }}>Cancel</button>
          <button class="add-btn" onclick={confirmAdd} disabled={!addLabel.trim()}>Add</button>
        </div>
      </div>
    {:else}
      <div class="add-trigger-row">
        <button class="add-btn" onclick={() => showAddForm = true}>+ Add participant</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .dlg {
    width: min(90vw, 820px);
    max-height: 85vh;
    padding: 0;
    overflow: hidden;
  }

  .dlg-header {
    justify-content: space-between;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .table-wrap { flex-shrink: 0; border-bottom: 1px solid var(--color-border); }
  .table-border { margin: 0.75rem 1rem; border: 1px solid #bbb; }

  /* ── Attr bar ───────────────────────────────────────────────────────── */
  .attr-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--color-border, #ccc);
    background: var(--color-bg-1, #f8f8f8);
    flex-shrink: 0;
  }

  .attr-bar-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted, #999);
    margin-right: 0.25rem;
    white-space: nowrap;
  }

  .attr-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0.15rem 0.4rem 0.15rem 0.55rem;
    background: var(--color-bg-3, #e8e8e8);
    border: 1px solid var(--color-border, #ccc);
    border-radius: var(--radius-xs);
    font-size: 0.8rem;
    color: var(--color-text-2, #444);
  }

  .attr-key-input {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--color-border, #ccc);
    border-radius: 4px;
    font-size: 0.82rem;
    font-family: inherit;
    width: 9rem;
  }

  /* ── Add participant section ─────────────────────────────────────────── */
  .add-trigger-row { padding: 0.75rem 1rem; }

  .add-form-panel {
    padding: 1rem 1.25rem 1.25rem;
    border-top: 1px solid var(--color-border);
    display: flex; flex-direction: column; gap: 0.9rem;
  }
  .add-form-title { font-size: 0.88rem; font-weight: 600; color: var(--color-text-1); margin: 0 0 0.1rem; }

  .field-label {
    display: flex; flex-direction: column; gap: 0.3rem;
    font-size: 0.78rem; color: var(--color-text-3); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .field-input { width: 10rem; }
  .field-select { max-width: 22rem; }

  .copy-row { display: flex; gap: 1.1rem; align-items: center; flex-wrap: wrap; }

  .radio-label {
    display: inline-flex; align-items: center; gap: 0.3rem;
    font-size: 0.83rem; font-weight: 400; text-transform: none; letter-spacing: normal;
    color: var(--color-text-2); cursor: pointer;
  }
</style>
