<script lang="ts">
  import { untrack } from 'svelte'

  const { tierName, participant, onconfirm, onclose }: {
    tierName: string
    participant: string
    onconfirm: (vals: { tierName: string; participant: string }) => void
    onclose: () => void
  } = $props()

  let newTierName   = $state(untrack(() => tierName))
  let newParticipant = $state(untrack(() => participant))
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <h3 id="dlg-title">Edit utterance tier</h3>

  <label>
    Tier name <span class="req">*</span>
    <!-- svelte-ignore a11y_autofocus -->
    <input bind:value={newTierName} placeholder="e.g. Speaker A" autofocus />
    <span class="hint">Display name for this tier in the timeline. Must be unique across all tiers.</span>
  </label>

  <label>
    Participant
    <input bind:value={newParticipant} placeholder="e.g. Ann" />
    <span class="hint">Who is speaking on this tier. Can differ from the tier name.</span>
  </label>

  <div class="dlg-actions">
    <button onclick={onclose}>Cancel</button>
    <button class="confirm-btn"
      onclick={() => onconfirm({ tierName: newTierName.trim(), participant: newParticipant.trim() })}
      disabled={!newTierName.trim()}>Apply</button>
  </div>
</div>

<style>
  .dlg { min-width: 380px; }
</style>
