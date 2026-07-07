<script lang="ts">
  import { untrack } from 'svelte'
  import type { TrackSet } from '@mumo/core'
  import type { ID } from '@mumo/core'

  const { trackSet, participants, onconfirm, onclose }: {
    trackSet: TrackSet
    participants: string[]
    onconfirm: (rows: { trackId: ID; tierName: string; participant: string }[]) => void
    onclose: () => void
  } = $props()

  const listId = untrack(() => `track-participants-${trackSet.id}`)

  type Row = { trackId: ID; label: string; tierName: string; participant: string }
  const rows = $state<Row[]>(
    untrack(() => trackSet.tracks.map(t => ({ trackId: t.id, label: t.name, tierName: t.name, participant: '' })))
  )

  function onParticipantInput(row: Row) {
    if (!row.tierName || row.tierName === row.label) {
      row.tierName = row.participant ? `${row.participant} position` : row.label
    }
  }

  function submit() {
    onconfirm(
      rows
        .filter(r => r.tierName.trim())
        .map(r => ({ trackId: r.trackId, tierName: r.tierName.trim(), participant: r.participant.trim() }))
    )
  }
</script>

<datalist id={listId}>
  {#each participants as p (p)}<option value={p}></option>{/each}
</datalist>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <h3 id="dlg-title">Map tracks — {trackSet.name}</h3>
  <p class="hint">Assign each track to a participant. Unassigned tracks still get a tier.</p>

  <div class="track-table">
    <div class="track-row header">
      <span>Track</span>
      <span>Participant</span>
      <span>Tier name</span>
    </div>
    {#each rows as row (row.trackId)}
      <div class="track-row">
        <span class="track-label">{row.label}</span>
        <input
          class="participant-input"
          bind:value={row.participant}
          oninput={() => onParticipantInput(row)}
          list={listId}
          placeholder="e.g. Alice"
        />
        <input
          class="tier-name-input"
          bind:value={row.tierName}
          placeholder="tier name"
        />
      </div>
    {/each}
  </div>

  <div class="dlg-actions">
    <button onclick={onclose}>Cancel</button>
    <button class="add-btn" onclick={submit}>Create tiers</button>
  </div>
</div>

<style>
  .dlg { min-width: 520px; }

  .track-table { display: flex; flex-direction: column; gap: 0.35rem; }

  .track-row {
    display: grid;
    grid-template-columns: 7rem 1fr 1fr;
    gap: 0.5rem;
    align-items: center;
  }

  .track-row.header {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-2);
    padding-bottom: 0.15rem;
    border-bottom: 1px solid var(--color-border);
  }

  .track-label { font-size: 0.85rem; font-family: monospace; color: var(--color-text-1); }

  /* Compact inputs for grid layout */
  .dlg input { padding: 0.35rem 0.5rem; width: 100%; box-sizing: border-box; }
</style>
