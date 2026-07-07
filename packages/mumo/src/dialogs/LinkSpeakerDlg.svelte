<script lang="ts">
  import { untrack } from 'svelte'

  const { tierName, speakers, onconfirm, onclose }: {
    tierName: string
    speakers: string[]
    onconfirm: (participant: string) => void
    onclose: () => void
  } = $props()

  let selected = $state(untrack(() => speakers[0] ?? ''))
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="lsd-title">
  <div class="dlg-header">
    <h3 id="lsd-title">Link to participant</h3>
    <button class="close-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>
  <p class="dlg-hint">
    Nest <strong>{tierName}</strong> under a participant lane. Existing annotations will be matched
    to utterances by time overlap and linked as translations.
  </p>
  <label>
    Participant
    <select bind:value={selected}>
      {#each speakers as sp (sp)}
        <option value={sp}>{sp}</option>
      {/each}
    </select>
  </label>
  <div class="dlg-footer">
    <button onclick={onclose}>Cancel</button>
    <button class="primary" onclick={() => onconfirm(selected)} disabled={!selected}>Link</button>
  </div>
</div>

<style>
  .dlg { padding: 1.25rem 1.5rem; min-width: 320px; max-width: 420px; gap: 0.9rem; }
</style>
