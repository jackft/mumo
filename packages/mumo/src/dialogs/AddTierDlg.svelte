<script lang="ts">
  import { untrack } from 'svelte'
  import type { LinguisticType, TierConstraint, ParticipantJSON } from '@mumo/core'

  const { participant = '', parentLaneId = '', lingTypes, participants = [], validateName, onconfirm, onclose }: {
    participant?: string
    parentLaneId?: string
    lingTypes: LinguisticType[]
    participants?: ParticipantJSON[]
    /** Returns an error message if (name, participant) can't be used, else null. */
    validateName?: (name: string, participant: string) => string | null
    onconfirm: (vals: { name: string; participant: string; linguisticTypeId: string; constraint: TierConstraint | ''; inlineGloss: boolean }) => void
    onclose: () => void
  } = $props()

  let name = $state('')
  let participantVal = $state(untrack(() => participant))
  let linguisticTypeId = $state('')
  let isGlossTier = $state(false)
  let constraint = $state<TierConstraint | ''>(untrack(() => participant) ? 'symbolic_association' : '')

  const isChild = $derived(!!(participant || parentLaneId))
  const isAnnChild = $derived(parentLaneId.startsWith('ann:'))
  const title = $derived(
    participant ? `New sub-tier — Participant ${participant}`
    : parentLaneId.startsWith('tokens:') ? 'New sub-tier — tokens'
    : isAnnChild ? 'New sub-tier'
    : 'New annotation tier'
  )
  const nameError = $derived(validateName?.(name, participantVal) ?? null)
  const finalName = $derived(participantVal && name.trim() && participantVal !== name.trim() ? `${name.trim()}:${participantVal}` : name.trim())
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <h3 id="dlg-title">{title}</h3>
  <label>
    Name
    <!-- svelte-ignore a11y_autofocus -->
    <input bind:value={name} placeholder="e.g. gesture" autofocus />
  </label>
  {#if nameError}
    <p class="name-error">{nameError}</p>
  {:else if finalName && finalName !== name.trim()}
    <p class="name-preview">Will be created as <b>{finalName}</b></p>
  {/if}
  <label class="checkbox-label">
    <input
      type="checkbox"
      checked={isGlossTier}
      onchange={() => {
        isGlossTier = !isGlossTier
        if (isGlossTier) constraint = 'symbolic_association'
      }}
    />
    Gloss / translation tier — shown inline in transcript
  </label>
  {#if (isChild || isGlossTier)}
    <label>
      Constraint
      <select bind:value={constraint} disabled={isGlossTier}>
        <option value="" disabled>— choose a constraint —</option>
        <option value="symbolic_association">Symbolic association — 1:1 label per item</option>
        <option value="symbolic_subdivision">Symbolic subdivision — ordered labels that subdivide the item</option>
        <option value="included_in">Included in — annotations within item span, gaps allowed</option>
        <option value="time_subdivision">Time subdivision — annotations subdivide the item span</option>
      </select>
    </label>
  {/if}
  {#if !isChild || isAnnChild}
    <label>
      Participant (optional)
      <select bind:value={participantVal}>
        <option value="">— none —</option>
        {#each participants as p (p.id)}
          <option value={p.label}>{p.label}{p.attrs?.['name'] ? ` — ${p.attrs['name']}` : ''}</option>
        {/each}
      </select>
    </label>
  {/if}
  <label>
    Linguistic type (optional)
    <select bind:value={linguisticTypeId}>
      <option value="">— none —</option>
      {#each lingTypes as lt (lt.id)}
        <option value={lt.id}>{lt.name}{lt.constraint ? ` · ${lt.constraint}` : ''}</option>
      {/each}
    </select>
  </label>
  <div class="dlg-actions">
    <button onclick={onclose}>Cancel</button>
    <button class="add-btn" onclick={() => onconfirm({ name, participant: participantVal, linguisticTypeId, constraint, inlineGloss: isGlossTier })} disabled={!name.trim() || !!nameError || ((isChild || isGlossTier) && !constraint && !linguisticTypeId)}>Add</button>
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
