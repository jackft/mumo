<script lang="ts">
  import { onMount } from 'svelte'
  import { TabulatorFull as Tabulator } from 'tabulator-tables'
  import type { CellComponent, ColumnDefinition } from 'tabulator-tables'
  import 'tabulator-tables/dist/css/tabulator_simple.min.css'

  type TierRow = { _originalTierName: string; tierName: string; count: number }

  const { uttTiers, onupdate, onclose }: {
    uttTiers: { tierName: string; count: number }[]
    onupdate: (oldTierName: string, newTierName: string) => void
    onclose:  () => void
  } = $props()

  function toRow(t: { tierName: string; count: number }): TierRow {
    return { _originalTierName: t.tierName, tierName: t.tierName, count: t.count }
  }

  function buildColumns(): ColumnDefinition[] {
    const onCellEdited = (cell: CellComponent) => {
      const row = cell.getRow()
      const data = row.getData() as TierRow
      const oldName = data._originalTierName
      const newName = (data.tierName ?? '').trim()
      if (!newName) {
        cell.restoreOldValue()
        return
      }
      onupdate(oldName, newName)
      void row.update({ _originalTierName: newName, tierName: newName })
    }

    return [
      {
        title: 'Tier name',
        field: 'tierName',
        editor: 'input',
        headerSort: true,
        widthGrow: 3,
        cssClass: 'col-required',
        cellEdited: onCellEdited,
      },
      {
        title: 'Count',
        field: 'count',
        headerSort: true,
        width: 70,
        hozAlign: 'right' as const,
      },
    ]
  }

  let tableEl: HTMLDivElement | null = $state(null)

  onMount(() => {
    if (!tableEl) return
    const tab = new Tabulator(tableEl, {
      data: uttTiers.map(toRow),
      columns: buildColumns(),
      layout: 'fitColumns',
      maxHeight: '55vh',
      headerSort: true,
      initialSort: [{ column: 'tierName', dir: 'asc' }],
      rowFormatter: (row) => {
        row.getElement().classList.toggle('tabulator-row-even', (row.getPosition() as number) % 2 === 0)
      },
    })
    return () => { tab.destroy() }
  })
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <div class="dlg-header">
    <h3 id="dlg-title">Utterance tiers</h3>
    <button class="icon-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>
  <div class="dlg-body">
    <p class="dlg-hint">Click a cell to edit. Changes apply immediately.</p>
    <div class="table-wrap">
      <div class="table-border" bind:this={tableEl}></div>
    </div>
  </div>
</div>

<style>
  .dlg {
    width: min(90vw, 640px);
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

  .dlg-hint { padding: 0.5rem 1rem 0; font-size: 0.78rem; flex-shrink: 0; }

  .table-wrap { flex-shrink: 0; }
  .table-border { margin: 0.5rem 1rem 1rem; border: 1px solid #bbb; }
</style>
