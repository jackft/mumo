<script lang="ts">
  import type { AnnotationStore, ControlledVocabulary } from '@mumo/core'
  import { newId } from '@mumo/core'

  const { store, vocabs, onclose }: {
    store: AnnotationStore
    vocabs: ControlledVocabulary[]
    onclose: () => void
  } = $props()

  let selectedId = $state('')
  let newName = $state('')
  let newEntryValue = $state('')
  let newEntryDesc = $state('')

  function create() {
    if (!newName.trim()) return
    const v = store.addVocabulary(newName.trim())
    newName = ''
    selectedId = v.id
  }

  function del(id: string) {
    store.removeVocabulary(id)
    if (selectedId === id) selectedId = ''
  }

  function addEntry() {
    const v = store.getVocabulary(selectedId)
    if (!v || !newEntryValue.trim()) return
    const entry = {
      id: newId(),
      value: newEntryValue.trim(),
      ...(newEntryDesc.trim() ? { description: newEntryDesc.trim() } : {}),
    }
    store.updateVocabulary(v.id, { entries: [...v.entries, entry] })
    newEntryValue = ''
    newEntryDesc = ''
  }

  function removeEntry(vocabId: string, entryId: string) {
    const v = store.getVocabulary(vocabId)
    if (!v) return
    store.updateVocabulary(v.id, { entries: v.entries.filter(e => e.id !== entryId) })
  }
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg vocab-dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <h3 id="dlg-title">Vocabularies</h3>
  <div class="vocab-panels">
    <div class="vocab-list-panel">
      {#each vocabs as v (v.id)}
        <div class="vocab-row" class:selected={selectedId === v.id}>
          <button class="vocab-select" onclick={() => selectedId = v.id}>
            <span class="vocab-name">{v.name}</span>
            <span class="vocab-count">{v.entries.length}</span>
          </button>
          <button class="icon-btn danger" title="Delete vocabulary" onclick={() => del(v.id)}>×</button>
        </div>
      {/each}
      <div class="vocab-new-row">
        <input bind:value={newName} placeholder="New vocabulary…"
               onkeydown={(e) => e.key === 'Enter' && create()} />
        <button class="add-btn" onclick={create} disabled={!newName.trim()}>Add</button>
      </div>
    </div>
    <div class="vocab-entries-panel">
      {#if selectedId}
        {@const vocab = vocabs.find(v => v.id === selectedId)}
        {#if vocab}
          <div class="entries-header">{vocab.name}</div>
          {#each vocab.entries as entry (entry.id)}
            <div class="entry-row">
              <span class="entry-value">{entry.value}</span>
              {#if entry.description}<span class="entry-desc">{entry.description}</span>{/if}
              <button class="icon-btn danger" title="Remove entry" onclick={() => removeEntry(vocab.id, entry.id)}>×</button>
            </div>
          {/each}
          <div class="entry-new-row">
            <input bind:value={newEntryValue} placeholder="Value"
                   onkeydown={(e) => e.key === 'Enter' && addEntry()} />
            <input bind:value={newEntryDesc} placeholder="Description (optional)"
                   onkeydown={(e) => e.key === 'Enter' && addEntry()} />
            <button class="add-btn" onclick={addEntry} disabled={!newEntryValue.trim()}>Add</button>
          </div>
        {/if}
      {:else}
        <span class="entries-placeholder">Select a vocabulary to edit its entries.</span>
      {/if}
    </div>
  </div>
  <div class="dlg-actions">
    <button class="primary" onclick={onclose}>Done</button>
  </div>
</div>

<style>
  .dlg { min-width: 380px; }
  .vocab-dlg { min-width: 580px; }

  .vocab-panels {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 0.25rem;
    min-height: 240px;
  }

  .vocab-list-panel {
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .vocab-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
  }
  .vocab-row:hover { background: #f5f5f5; }
  .vocab-row.selected { background: var(--color-primary-light); }
  .vocab-select {
    flex: 1; display: flex; align-items: center; gap: 0.4rem;
    background: none; border: none; padding: 0.35rem 0.6rem; cursor: pointer;
    font: inherit; color: inherit; text-align: left; min-width: 0;
  }
  .vocab-name { flex: 1; }
  .vocab-count { font-size: 0.25rem; color: #aaa; }

  .vocab-new-row {
    display: flex;
    gap: 0.3rem;
    padding: 0.4rem 0.5rem;
    border-top: 1px solid #eee;
    margin-top: auto;
  }
  .vocab-new-row input { flex: 1; min-width: 0; padding: 0.3rem 0.4rem; border: 1px solid #ccc; border-radius: 3px; font-size: 0.8rem; font-family: inherit; }
  .vocab-new-row button { padding: 0.3rem 0.6rem; font-size: 0.8rem; }

  .vocab-entries-panel {
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    overflow-y: auto;
  }

  .entries-header { font-weight: 600; font-size: 0.85rem; margin-bottom: 0.25rem; }
  .entries-placeholder { font-size: 0.8rem; color: #aaa; margin: auto; text-align: center; }

  .entry-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.3rem;
    font-size: 0.85rem;
    border-radius: 3px;
  }
  .entry-row:hover { background: #f5f5f5; }
  .entry-value { font-weight: 500; min-width: 80px; }
  .entry-desc  { flex: 1; color: #888; font-size: 0.8rem; }

  .entry-new-row {
    display: flex;
    gap: 0.3rem;
    padding: 0.3rem 0;
    margin-top: auto;
    border-top: 1px solid #eee;
    padding-top: 0.5rem;
  }
  .entry-new-row input { flex: 1; min-width: 0; padding: 0.3rem 0.4rem; border: 1px solid #ccc; border-radius: 3px; font-size: 0.8rem; font-family: inherit; }
  .entry-new-row button { padding: 0.3rem 0.6rem; font-size: 0.8rem; }

</style>
