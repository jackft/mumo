<script lang="ts">
  import type { ControlledVocabulary } from '@mumo/core'

  const { tierId, tierName, vocabs, onconfirm, onclose }: {
    tierId: string
    tierName: string
    vocabs: ControlledVocabulary[]
    onconfirm: (vals: { tierId: string; vocabularyId: string }) => void
    onclose: () => void
  } = $props()

  let vocabularyId = $state('')
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <h3 id="dlg-title">Assign vocabulary — {tierName}</h3>
  <label>
    Vocabulary
    <select bind:value={vocabularyId}>
      <option value="">— none —</option>
      {#each vocabs as v (v.id)}
        <option value={v.id}>{v.name} ({v.entries.length} entries)</option>
      {/each}
    </select>
  </label>
  <div class="dlg-actions">
    <button onclick={onclose}>Cancel</button>
    <button class="primary" onclick={() => onconfirm({ tierId, vocabularyId })}>Save</button>
  </div>
</div>

<style>
  .dlg { min-width: 380px; }
</style>
