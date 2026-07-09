<script lang="ts">
  import type { MediaEntry } from './linked-media-types.js'

  const {
    open,
    entries,
    onClose,
    onLink,
    onLoad,
    onRemove,
    onOffsetChange,
  }: {
    open: boolean
    entries: MediaEntry[]
    onClose: () => void
    onLink: () => void
    onLoad: (id: string) => void
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
      {#if entries.length === 0}
        <p class="lmd-empty">No media linked.</p>
      {:else}
        <div class="lmd-grid">
          {#each entries as entry (entry.id)}
            <span class="lmd-name" class:lmd-name-unloaded={entry.kind === 'unloaded'} title={entry.id}>{entry.name}</span>
            <span class="lmd-status">{entry.kind === 'unloaded' ? 'not loaded' : ''}</span>
            <label class="lmd-offset-label">
              Offset (s)
              <input class="lmd-offset" type="number" step="0.01"
                value={entry.offsetSec}
                oninput={(e) => onOffsetChange(entry.id, parseFloat((e.currentTarget as HTMLInputElement).value) || 0)}
              />
            </label>
            <div class="lmd-actions">
              {#if entry.kind === 'unloaded'}
                <button class="lmd-load" onclick={() => onLoad(entry.id)}>Load</button>
              {/if}
              <button class="lmd-remove" onclick={() => onRemove(entry.id)}>Remove</button>
            </div>
          {/each}
        </div>
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
    min-width: 420px; max-width: 580px; z-index: 201;
    box-shadow: 0 4px 24px rgba(0,0,0,.12);
    color: #222; font-size: 13px;
  }
  .lmd-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid #eee; font-weight: 600;
  }
  .lmd-close {
    background: none; border: none; cursor: pointer; opacity: 0.45; font-size: 14px; color: #222;
  }
  .lmd-close:hover { opacity: 0.9; }
  .lmd-body { padding: 10px 14px; }
  .lmd-empty { opacity: 0.5; font-size: 13px; margin: 0; }

  .lmd-grid {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    align-items: center;
    column-gap: 10px;
    row-gap: 8px;
  }
  .lmd-name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: #333; font-size: 12px; min-width: 0;
  }
  .lmd-name-unloaded { color: #888; font-style: italic; }
  .lmd-status {
    font-size: 10px; color: #999; white-space: nowrap;
    border: 1px solid transparent; border-radius: 8px; padding: 1px 5px;
  }
  .lmd-status:not(:empty) { border-color: #ddd; }
  .lmd-offset-label {
    display: flex; align-items: center; gap: 4px;
    white-space: nowrap; color: #555; font-size: 12px;
  }
  .lmd-offset {
    width: 62px; font-size: 12px; background: #fff;
    border: 1px solid #ccc; border-radius: 3px; padding: 2px 4px; color: #222;
  }
  .lmd-actions {
    display: flex; gap: 4px; justify-content: flex-end;
  }
  .lmd-load {
    background: none; border: 1px solid #1565c0; border-radius: 3px;
    color: #1565c0; cursor: pointer; padding: 2px 8px; font-size: 11px; white-space: nowrap;
  }
  .lmd-load:hover { background: #e3f2fd; }
  .lmd-remove {
    background: none; border: 1px solid #e57373; border-radius: 3px;
    color: #c62828; cursor: pointer; padding: 2px 8px; font-size: 11px; white-space: nowrap;
  }
  .lmd-remove:hover { background: #c62828; color: #fff; }
  .lmd-footer { padding: 10px 14px; border-top: 1px solid #eee; }
  .lmd-link-btn {
    background: none; border: 1px solid #1565c0; border-radius: 4px;
    padding: 5px 14px; cursor: pointer; font-size: 12px; width: 100%; color: #1565c0;
  }
  .lmd-link-btn:hover { background: #e3f2fd; }
</style>
