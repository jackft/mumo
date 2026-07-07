<script lang="ts">
  import { untrack } from 'svelte'
  import type { ParticipantJSON } from '@mumo/core'

  const { name, participant = '', participants = [], validateName, onconfirm, onclose }: {
    /** Base tier name (without the :participant suffix). */
    name: string
    participant?: string
    participants?: ParticipantJSON[]
    /** Returns an error message if (name, participant) can't be used, else null. */
    validateName?: (name: string, participant: string) => string | null
    onconfirm: (vals: { name: string; participant: string }) => void
    onclose: () => void
  } = $props()

  let nameVal = $state(untrack(() => name))
  let participantVal = $state(untrack(() => participant))

  const nameError = $derived(validateName?.(nameVal, participantVal) ?? null)
  const finalName = $derived(participantVal && nameVal.trim() && participantVal !== nameVal.trim() ? `${nameVal.trim()}:${participantVal}` : nameVal.trim())
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <h3 id="dlg-title">Edit tier</h3>
  <label>
    Name
    <!-- svelte-ignore a11y_autofocus -->
    <input bind:value={nameVal} placeholder="e.g. gesture" autofocus />
  </label>
  {#if nameError}
    <p class="name-error">{nameError}</p>
  {:else if finalName && finalName !== nameVal.trim()}
    <p class="name-preview">Will be renamed to <b>{finalName}</b></p>
  {/if}
  <label>
    Participant
    <select bind:value={participantVal}>
      <option value="">— none —</option>
      {#if participant && !participants.some(p => p.label === participant)}
        <option value={participant}>{participant}</option>
      {/if}
      {#each participants as p (p.id)}
        <option value={p.label}>{p.label}{p.attrs?.['name'] ? ` — ${p.attrs['name']}` : ''}</option>
      {/each}
    </select>
  </label>
  <div class="dlg-actions">
    <button onclick={onclose}>Cancel</button>
    <button class="confirm-btn"
      onclick={() => onconfirm({ name: nameVal.trim(), participant: participantVal })}
      disabled={!nameVal.trim() || !!nameError}>Apply</button>
  </div>
</div>

<style>
  .dlg { min-width: 380px; }
  .name-error {
    margin: 2px 0 0;
    font-size: 0.78rem;
    color: var(--color-danger, #c0392b);
  }
  .name-preview {
    margin: 2px 0 0;
    font-size: 0.78rem;
    color: var(--color-text-2, #777);
  }
</style>
