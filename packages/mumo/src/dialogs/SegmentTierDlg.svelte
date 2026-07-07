<script lang="ts">
  import { untrack } from 'svelte'
  import type { VadSegment, WaveformBins } from '@mumo/media-player'
  import { computeEnergyVad } from '@mumo/media-player'

  const {
    tiers,
    waveformChannels,
    mergedSegments,
    onconfirm,
    onclose,
  }: {
    tiers: Array<{ id: string; name: string }>
    waveformChannels: Array<{ id: string; label: string; bins: WaveformBins }>
    mergedSegments: VadSegment[]
    onconfirm: (params: {
      tierId: string
      channelId: string | null
      minDuration: number
      maxGap: number
      replaceExisting: boolean
    }) => void
    onclose: () => void
  } = $props()

  // untrack: intentionally captures initial value only — dialog initializes from current tier list
  let tierId = $state(untrack(() => tiers[0]?.id ?? ''))
  // 'merged' = all channels; otherwise a channel id
  let channelId = $state<string | 'merged'>('merged')
  let minDuration = $state(0.2)
  let maxGap = $state(0.3)
  let replaceExisting = $state(true)

  function rawSegments(): VadSegment[] {
    if (channelId === 'merged') return mergedSegments
    const ch = waveformChannels.find(c => c.id === channelId)
    if (!ch) return []
    return computeEnergyVad(ch.bins.rms, 1, ch.bins.binDuration)
  }

  function applyFilters(segs: VadSegment[]): VadSegment[] {
    const merged: VadSegment[] = []
    for (const s of segs) {
      const last = merged[merged.length - 1]
      if (last && s.start - last.end <= maxGap) {
        last.end = Math.max(last.end, s.end)
      } else {
        merged.push({ start: s.start, end: s.end })
      }
    }
    return merged.filter(s => s.end - s.start >= minDuration)
  }

  const preview = $derived(applyFilters(rawSegments()).length)

  const hasData = $derived(mergedSegments.length > 0 || waveformChannels.length > 0)
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="seg-dlg-title">
  <h3 id="seg-dlg-title">Segment tier</h3>

  {#if tiers.length > 1}
    <label>
      Target tier
      <select bind:value={tierId}>
        {#each tiers as t (t.id)}
          <option value={t.id}>{t.name}</option>
        {/each}
      </select>
    </label>
  {:else}
    <p class="tier-name">{tiers[0]?.name ?? ''}</p>
  {/if}

  {#if !hasData}
    <p class="no-data">No audio data available yet. Load a media file and wait for analysis to complete.</p>
  {:else}
    <label>
      Audio channel
      <select bind:value={channelId}>
        {#if mergedSegments.length > 0}
          <option value="merged">All channels (merged)</option>
        {/if}
        {#each waveformChannels as ch (ch.id)}
          <option value={ch.id}>{ch.label}</option>
        {/each}
      </select>
    </label>

    <div class="row">
      <label>
        Min segment duration
        <div class="input-unit">
          <input type="number" bind:value={minDuration} min="0.05" max="10" step="0.05" />
          <span class="unit">s</span>
        </div>
      </label>
      <label>
        Max gap to merge
        <div class="input-unit">
          <input type="number" bind:value={maxGap} min="0" max="10" step="0.05" />
          <span class="unit">s</span>
        </div>
      </label>
    </div>

    <label class="checkbox-label">
      <input type="checkbox" bind:checked={replaceExisting} />
      Replace existing annotations
    </label>

    <p class="preview">{preview} segment{preview !== 1 ? 's' : ''} found</p>
  {/if}

  <div class="dlg-actions">
    <button onclick={onclose}>Cancel</button>
    {#if hasData}
      <button
        class="confirm-btn"
        disabled={preview === 0 || !tierId}
        onclick={() => onconfirm({
          tierId,
          channelId: channelId === 'merged' ? null : channelId,
          minDuration,
          maxGap,
          replaceExisting,
        })}
      >Import {preview} segment{preview !== 1 ? 's' : ''}</button>
    {/if}
  </div>
</div>

<style>
  .dlg { min-width: 360px; }

  .tier-name { font-size: 0.9rem; font-weight: 500; color: var(--color-text-1); margin: 0; }

  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }

  .input-unit { display: flex; align-items: center; gap: 0.35rem; }
  .input-unit input { flex: 1; min-width: 0; }

  .unit { font-size: 0.85rem; color: var(--color-text-muted); font-weight: 400; text-transform: none; letter-spacing: normal; }

  .preview { font-size: 0.85rem; color: var(--color-text-muted); margin: 0; }
  .no-data  { font-size: 0.85rem; color: var(--color-text-faint); margin: 0; }
</style>
