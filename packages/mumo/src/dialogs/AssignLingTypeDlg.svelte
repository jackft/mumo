<script lang="ts">
  import type { LinguisticType } from '@mumo/core'

  const { tierId, tierName, lingTypes, onconfirm, onclose }: {
    tierId: string
    tierName: string
    lingTypes: LinguisticType[]
    onconfirm: (vals: { tierId: string; linguisticTypeId: string }) => void
    onclose: () => void
  } = $props()

  let linguisticTypeId = $state('')
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <h3 id="dlg-title">Assign linguistic type — {tierName}</h3>
  <label>
    Linguistic type
    <select bind:value={linguisticTypeId}>
      <option value="">— none —</option>
      {#each lingTypes as lt (lt.id)}
        <option value={lt.id}>{lt.name}{lt.constraint ? ` · ${lt.constraint}` : ''}</option>
      {/each}
    </select>
  </label>
  <div class="dlg-actions">
    <button onclick={onclose}>Cancel</button>
    <button class="primary" onclick={() => onconfirm({ tierId, linguisticTypeId })}>Save</button>
  </div>
</div>

<style>
  .dlg { min-width: 380px; }
</style>
