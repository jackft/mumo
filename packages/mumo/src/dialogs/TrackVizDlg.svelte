<script lang="ts">
  import type { TrackSet } from '@mumo/core'
  import type { ID } from '@mumo/core'
  import { TRACK_COLORS } from '@mumo/media-player'
  import type { VizOptions } from '@mumo/media-player'
  import { SvelteMap } from 'svelte/reactivity'

  const { trackSets, hiddenTrackIds, vizOptions, trackParticipants = new Map(), colorOffset = 0, onsetvisible, onsetviz, onclose }: {
    trackSets: TrackSet[]
    hiddenTrackIds: ReadonlySet<ID>
    vizOptions: Readonly<VizOptions>
    /** trackId → participant label (from tier definitions) */
    trackParticipants?: Map<ID, string>
    colorOffset?: number
    onsetvisible: (trackId: ID, visible: boolean) => void
    onsetviz: (opts: Partial<VizOptions>) => void
    onclose: () => void
  } = $props()

  function hexColor(colorIdx: number): string {
    const c = TRACK_COLORS[colorIdx % TRACK_COLORS.length]!
    return '#' + c.toString(16).padStart(6, '0')
  }

  const globalIdx = $derived.by(() => {
    const m = new SvelteMap<ID, number>()
    let i = colorOffset
    for (const ts of trackSets) {
      for (const t of ts.tracks) { m.set(t.id, i++) }
    }
    return m
  })
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="tvd-title">
  <div class="dlg-header">
    <h3 id="tvd-title">Track visualization</h3>
    <button class="close-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>

  <div class="viz-opts-section">
    <span class="section-label">Show</span>
    <div class="viz-opts-grid">
      <label class="viz-opt">
        <input type="checkbox" checked={vizOptions.showPath}
          onchange={(e) => onsetviz({ showPath: (e.currentTarget as HTMLInputElement).checked })} />
        Path
      </label>
      <label class="viz-opt">
        <input type="checkbox" checked={vizOptions.showPoint}
          onchange={(e) => onsetviz({ showPoint: (e.currentTarget as HTMLInputElement).checked })} />
        Point
      </label>
      <label class="viz-opt">
        <input type="checkbox" checked={vizOptions.showBbox}
          onchange={(e) => onsetviz({ showBbox: (e.currentTarget as HTMLInputElement).checked })} />
        Bounding box
      </label>
      <label class="viz-opt">
        <input type="checkbox" checked={vizOptions.showKeypoints}
          onchange={(e) => onsetviz({ showKeypoints: (e.currentTarget as HTMLInputElement).checked })} />
        Keypoints
      </label>
    </div>
  </div>

  {#if trackSets.length === 0}
    <p class="empty">No tracks loaded.</p>
  {:else}
    <div class="track-list">
      {#each trackSets as ts (ts.id)}
        <div class="track-set">
          <div class="ts-header">
            <span class="ts-name">{ts.name}</span>
            <span class="ts-meta">{ts.frameRate} fps · {ts.tracks.length} track{ts.tracks.length !== 1 ? 's' : ''}</span>
            <div class="ts-actions">
              <button class="text-btn" onclick={() => { for (const t of ts.tracks) onsetvisible(t.id, true) }}>All</button>
              <button class="text-btn" onclick={() => { for (const t of ts.tracks) onsetvisible(t.id, false) }}>None</button>
            </div>
          </div>
          {#each ts.tracks as track (track.id)}
            {@const cidx = globalIdx.get(track.id) ?? 0}
            {@const visible = !hiddenTrackIds.has(track.id)}
            {@const participant = trackParticipants.get(track.id)}
            <label class="track-row" class:hidden={!visible}>
              <input type="checkbox" checked={visible}
                onchange={(e) => onsetvisible(track.id, (e.currentTarget as HTMLInputElement).checked)} />
              <span class="track-swatch" style="background:{hexColor(cidx)}"></span>
              <span class="track-info">
                <span class="track-name">{track.name || track.id.slice(0, 8)}</span>
                <span class="track-sub">
                  {#if participant}<span class="track-participant">{participant}</span>{/if}
                  <span class="track-id" title={track.id}>{track.id.slice(0, 8)}</span>
                  <span class="track-type">{track.type}</span>
                </span>
              </span>
            </label>
          {/each}
        </div>
      {/each}
    </div>
  {/if}

  <div class="dlg-footer">
    <button onclick={onclose}>Close</button>
  </div>
</div>

<style>
  .dlg { padding: 1.25rem 1.5rem; min-width: 340px; max-width: 480px; max-height: 70vh; gap: 0.75rem; }

  /* ── Viz options ─────────────────────────────────────────── */
  .viz-opts-section {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.6rem;
    background: var(--color-bg-1, #f5f5f5);
    border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--color-border);
  }

  .section-label { flex-shrink: 0; }

  .viz-opts-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
  }

  .viz-opt {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 0.82rem;
    color: var(--color-text-1);
    cursor: pointer;
    white-space: nowrap;
  }

  /* ── Track list ──────────────────────────────────────────── */
  .empty {
    font-size: 0.85rem;
    color: #888;
    margin: 0;
  }

  .track-list {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .track-set {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ts-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 4px;
  }

  .ts-name {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--color-text-1);
  }

  .ts-meta {
    font-size: 0.75rem;
    color: #999;
    flex: 1;
  }

  .ts-actions {
    display: flex;
    gap: 2px;
  }

  .text-btn {
    border: none;
    background: none;
    font-size: 0.72rem;
    color: var(--color-primary);
    padding: 0 3px;
    cursor: pointer;
    text-decoration: underline;
  }
  .text-btn:hover { background: none; color: var(--color-primary-dark); }

  .track-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 4px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.82rem;
    color: var(--color-text-1);
  }
  .track-row:hover { background: var(--color-bg-2); }
  .track-row.hidden { opacity: 0.45; }

  .track-swatch {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 1px solid rgba(0,0,0,0.15);
  }

  .track-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .track-name {
    font-size: 0.82rem;
    color: var(--color-text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .track-sub {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .track-participant {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--color-primary, #26a69a);
  }

  .track-id {
    font-size: 0.7rem;
    color: #bbb;
    font-family: monospace;
    letter-spacing: 0.02em;
  }

  .track-type {
    font-size: 0.7rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

</style>
