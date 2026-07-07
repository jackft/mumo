<script lang="ts">
  import { onMount } from 'svelte'
  import { TabulatorFull as Tabulator } from 'tabulator-tables'
  import type { CellComponent } from 'tabulator-tables'
  import 'tabulator-tables/dist/css/tabulator_simple.min.css'
  import type { AnnotationStore, LinguisticType, ControlledVocabulary, TierConstraint } from '@mumo/core'

  const { store, lingTypes, vocabs, onclose }: {
    store: AnnotationStore
    lingTypes: LinguisticType[]
    vocabs: ControlledVocabulary[]
    onclose: () => void
  } = $props()

  type Row = { _id: string; name: string; constraint: string; vocabularyId: string }

  function toRow(lt: LinguisticType): Row {
    return { _id: lt.id, name: lt.name, constraint: lt.constraint ?? '', vocabularyId: lt.vocabularyId ?? '' }
  }

  const CONSTRAINT_LABELS: Record<string, string> = {
    '':                     '(no constraint)',
    time_subdivision:       'Time subdivision',
    included_in:            'Included in',
    symbolic_association:   'Symbolic association',
    symbolic_subdivision:   'Symbolic subdivision',
  }

  function constraintFormatter(cell: CellComponent) {
    const v = String(cell.getValue() ?? '')
    if (!v) {
      const span = document.createElement('span')
      span.className = 'cell-placeholder'
      span.textContent = '(no constraint)'
      return span
    }
    return CONSTRAINT_LABELS[v] ?? v
  }

  function vocabFormatter(cell: CellComponent) {
    const v = String(cell.getValue() ?? '')
    if (!v) {
      const span = document.createElement('span')
      span.className = 'cell-placeholder'
      span.textContent = '(no vocabulary)'
      return span
    }
    return vocabs.find(voc => voc.id === v)?.name ?? v
  }

  // Tabulator init

  let tableEl: HTMLDivElement | null = $state(null)
  let tab: InstanceType<typeof Tabulator> | null = null

  onMount(() => {
    if (!tableEl) return

    const onCellEdited = (cell: CellComponent) => {
      const id    = (cell.getRow().getData() as Row)['_id'] as string
      const field = cell.getField()
      const value = String(cell.getValue() ?? '')
      if (field === 'name') {
        if (value.trim()) store.updateLinguisticType(id, { name: value.trim() })
      } else if (field === 'constraint') {
        if (value) { store.updateLinguisticType(id, { constraint: value as TierConstraint }) }
        else       { store.updateLinguisticType(id, {}) }
      } else if (field === 'vocabularyId') {
        if (value) { store.updateLinguisticType(id, { vocabularyId: value }) }
        else       { store.updateLinguisticType(id, { vocabularyId: undefined }) }
      }
    }

    tab = new Tabulator(tableEl, {
      index: '_id',
      data: lingTypes.map(toRow),
      layout: 'fitColumns',
      maxHeight: '40vh',
      headerSort: false,
      rowFormatter: (row) => {
        row.getElement().classList.toggle('tabulator-row-even', (row.getPosition() as number) % 2 === 0)
      },
      columns: [
        {
          title: 'Name', field: 'name', editor: 'input', headerSort: false,
          cellEdited: onCellEdited,
        },
        {
          title: 'Constraint', field: 'constraint', headerSort: false,
          formatter: constraintFormatter,
          editor: 'list',
          editorParams: {
            values: [
              { label: '(no constraint)',      value: '' },
              { label: 'Time subdivision',     value: 'time_subdivision' },
              { label: 'Included in',          value: 'included_in' },
              { label: 'Symbolic assoc.',      value: 'symbolic_association' },
              { label: 'Symbolic subdivision', value: 'symbolic_subdivision' },
            ],
          },
          cellEdited: onCellEdited,
        },
        {
          title: 'Vocabulary', field: 'vocabularyId', headerSort: false,
          formatter: vocabFormatter,
          editor: 'list',
          editorParams: (_cell: CellComponent) => ({
            values: [
              { label: '(no vocabulary)', value: '' },
              ...vocabs.map(v => ({ label: v.name, value: v.id })),
            ],
          }),
          cellEdited: onCellEdited,
        },
        {
          title: '', field: '_del', headerSort: false, width: 42, hozAlign: 'center', frozen: true,
          formatter: (cell: CellComponent) => {
            const btn = document.createElement('button')
            btn.className = 'tab-del-btn'
            btn.title = 'Delete'
            btn.innerHTML = '<svg width="13" height="14" viewBox="0 0 13 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 3h11M4.5 3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5.5 6.5v4M7.5 6.5v4M2 3l.7 8.1A1 1 0 0 0 3.7 12h5.6a1 1 0 0 0 1-.9L11 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            btn.onclick = () => {
              const id = (cell.getRow().getData() as Row)['_id'] as string
              cell.getRow().delete()
              store.removeLinguisticType(id)
            }
            return btn
          },
        },
      ],
    })

    return () => { tab?.destroy(); tab = null }
  })

  // Add form

  let showAddForm   = $state(false)
  let newName       = $state('')
  let newConstraint = $state('')
  let newVocabId    = $state('')

  function confirmAdd() {
    const name = newName.trim()
    if (!name) return
    const lt = store.addLinguisticType(name, {
      ...(newConstraint ? { constraint: newConstraint as TierConstraint } : {}),
      ...(newVocabId    ? { vocabularyId: newVocabId }                   : {}),
    })
    tab?.addRow(toRow(lt))
    newName = ''; newConstraint = ''; newVocabId = ''
    showAddForm = false
  }
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <div class="dlg-header">
    <h3 id="dlg-title">Linguistic Types</h3>
    <button class="icon-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>

  <div class="dlg-body">
    <div class="table-wrap">
      <div class="table-border" bind:this={tableEl}></div>
    </div>

    {#if showAddForm}
      <div class="add-form-panel">
        <h4 class="add-form-title">Add linguistic type</h4>

        <label class="field-label">
          Name <span class="req">*</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="field-input" bind:value={newName} placeholder="e.g. utterance" autofocus
                 onkeydown={(e) => e.key === 'Enter' && confirmAdd()} />
        </label>

        <label class="field-label">
          Constraint
          <select class="field-select" bind:value={newConstraint}>
            <option value="">(no constraint)</option>
            <option value="time_subdivision">Time subdivision</option>
            <option value="included_in">Included in</option>
            <option value="symbolic_association">Symbolic association</option>
            <option value="symbolic_subdivision">Symbolic subdivision</option>
          </select>
        </label>

        <label class="field-label">
          Vocabulary
          <select class="field-select" bind:value={newVocabId}>
            <option value="">(no vocabulary)</option>
            {#each vocabs as v (v.id)}
              <option value={v.id}>{v.name}</option>
            {/each}
          </select>
        </label>

        <div class="dlg-actions">
          <button onclick={() => { showAddForm = false; newName = ''; newConstraint = ''; newVocabId = '' }}>Cancel</button>
          <button class="add-btn" onclick={confirmAdd} disabled={!newName.trim()}>Add</button>
        </div>
      </div>
    {:else}
      <div class="add-trigger-row">
        <button class="add-btn" onclick={() => showAddForm = true}>+ Add linguistic type</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .dlg {
    width: min(90vw, 680px);
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
  .field-input { width: 18rem; }
  .field-select { max-width: 22rem; }
</style>
