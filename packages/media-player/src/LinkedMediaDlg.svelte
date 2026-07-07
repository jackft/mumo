<script lang="ts">
  import type { MediaPlayer } from './MediaPlayer.js'

  const {
    open,
    players,
    onClose,
    onLink,
    onRemove,
    onOffsetChange,
  }: {
    open: boolean
    players: readonly MediaPlayer[]
    onClose: () => void
    onLink: () => void
    onRemove: (id: string) => void
    onOffsetChange: (id: string, offsetSec: number) => void
  } = $props()
</script>

{#if open}
  <button class="lmd-backdrop" onclick={onClose} aria-label="Close"></button>
  <div class="lmd-panel">
    <div class="lmd-header">
      <span>Linked media files</span>
      <button class="lmd-close" aria-label="Close" onclick={onClose}>✕</button>
    </div>

    <div class="lmd-body">
      {#if players.length === 0}
        <p class="lmd-empty">No media linked.</p>
      {:else}
        {#each players as player, i (player.id)}
          <div class="lmd-row">
            <span class="lmd-name" title={player.state?.filename ?? ''}>{player.state?.filename ?? '(loading…)'}</span>
            {#if i > 0}
              <label class="lmd-offset-label">
                Offset (s)
                <input class="lmd-offset" type="number" step="0.01"
                  value={player.track?.offsetSec ?? 0}
                  oninput={(e) => onOffsetChange(player.id, parseFloat((e.currentTarget as HTMLInputElement).value) || 0)}
                />
              </label>
              <button class="lmd-remove" onclick={() => onRemove(player.id)}>Remove</button>
            {:else}
              <span class="lmd-primary-badge">primary</span>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <div class="lmd-footer">
      <button class="lmd-link-btn" onclick={onLink}>+ Link media file…</button>
    </div>
  </div>
{/if}

<style>
  .lmd-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: transparent; border: none; padding: 0; cursor: default;
  }
  .lmd-panel {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: #fff; border: 1px solid #d0d0d0; border-radius: 6px;
    min-width: 340px; max-width: 500px; z-index: 201;
    box-shadow: 0 4px 24px rgba(0,0,0,.12);
    color: #222;
    font-size: 13px;
  }
  .lmd-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid #eee; font-weight: 600;
  }
  .lmd-close {
    background: none; border: none; cursor: pointer; opacity: 0.45; font-size: 14px; color: #222;
  }
  .lmd-close:hover { opacity: 0.9; }
  .lmd-body { padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; }
  .lmd-empty { opacity: 0.5; font-size: 13px; margin: 0; }
  .lmd-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .lmd-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #333; }
  .lmd-primary-badge {
    font-size: 11px; color: #777; padding: 1px 6px;
    border: 1px solid #ccc; border-radius: 10px;
  }
  .lmd-offset-label { display: flex; align-items: center; gap: 4px; white-space: nowrap; color: #555; }
  .lmd-offset {
    width: 70px; font-size: 12px; background: #fff;
    border: 1px solid #ccc; border-radius: 3px; padding: 2px 4px; color: #222;
  }
  .lmd-remove {
    background: none; border: 1px solid #e57373; border-radius: 3px;
    color: #c62828; cursor: pointer; padding: 2px 8px; font-size: 11px;
  }
  .lmd-remove:hover { background: #c62828; color: #fff; }
  .lmd-footer { padding: 10px 14px; border-top: 1px solid #eee; }
  .lmd-link-btn {
    background: none; border: 1px solid #1565c0; border-radius: 4px;
    padding: 5px 14px; cursor: pointer; font-size: 12px; width: 100%;
    color: #1565c0;
  }
  .lmd-link-btn:hover { background: #e3f2fd; }
</style>
