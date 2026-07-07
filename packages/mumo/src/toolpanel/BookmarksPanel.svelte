<script lang="ts">
  import type { Bookmark } from '@mumo/core'
  import type { ID } from '@mumo/core'

  const {
    bookmarks = [],
    playhead = 0,
    tlSelection = null,
    onCreateBookmark,
    onUpdateBookmark,
    onDeleteBookmark,
    onSeek,
    onAddToCollection,
    activeCollectionName = null,
  }: {
    bookmarks?: Bookmark[]
    playhead?: number
    tlSelection?: { start: number; end: number } | null
    onCreateBookmark: (start: number, end: number, label: string, note?: string, code?: string) => void
    onUpdateBookmark: (id: ID, patch: { label?: string; startSeconds?: number; endSeconds?: number; note?: string | undefined; code?: string | undefined }) => void
    onDeleteBookmark: (id: ID) => void
    onSeek?: (t: number) => void
    onAddToCollection?: (bm: Bookmark) => void
    activeCollectionName?: string | null
  } = $props()

  let creating   = $state(false)
  let newLabel   = $state('')
  let newNote    = $state('')
  let newCode    = $state('')
  let newStart   = $state(0)
  let newEnd     = $state(0)

  let editingId  = $state<ID | null>(null)
  let editLabel  = $state('')
  let editNote   = $state('')
  let editCode   = $state('')
  let editStart  = $state(0)
  let editEnd    = $state(0)

  function startCreate() {
    newLabel = ''
    newNote  = ''
    newCode  = ''
    newStart = +(tlSelection?.start ?? playhead).toFixed(3)
    newEnd   = +(tlSelection?.end   ?? Math.max(playhead + 1, playhead)).toFixed(3)
    creating = true
  }

  function commitCreate() {
    const label = newLabel.trim() || `Bookmark ${fmtTime(newStart)}`
    if (newEnd > newStart) onCreateBookmark(newStart, newEnd, label, newNote.trim() || undefined, newCode.trim() || undefined)
    creating = false
  }

  function cancelCreate() { creating = false }

  function startEdit(bm: Bookmark) {
    editingId = bm.id
    editLabel = bm.label
    editNote  = bm.note  ?? ''
    editCode  = bm.code  ?? ''
    editStart = bm.startSeconds
    editEnd   = bm.endSeconds
  }

  function commitEdit() {
    if (!editingId) return
    onUpdateBookmark(editingId, {
      label: editLabel.trim() || editLabel,
      startSeconds: editStart,
      endSeconds: editEnd,
      note: editNote.trim() || undefined,
      code: editCode.trim() || undefined,
    })
    editingId = null
  }

  function fmtTime(s: number): string {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = (s % 60).toFixed(2).padStart(5, '0')
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${sec}` : `${m}:${sec}`
  }

  function fmtDuration(start: number, end: number): string {
    const d = end - start
    return d >= 60
      ? `${Math.floor(d / 60)}m ${(d % 60).toFixed(1)}s`
      : `${d.toFixed(2)}s`
  }
</script>

<svelte:window onclick={(e) => { if (editingId && !(e.target as Element)?.closest('.bookmark-edit-form')) editingId = null }} />

<div class="bookmarks-panel">
  <div class="bookmarks-header">
    <span class="bookmarks-count">{bookmarks.length} bookmark{bookmarks.length === 1 ? '' : 's'}</span>
    <button class="new-btn" onclick={startCreate}>+ New</button>
  </div>

  {#if creating}
    <div class="bookmark-create-form">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="field-input"
        type="text"
        placeholder="Label"
        bind:value={newLabel}
        onkeydown={(e) => { if (e.key === 'Enter') commitCreate(); if (e.key === 'Escape') cancelCreate() }}
        autofocus
      />
      <div class="time-row">
        <label>Start <input class="time-input" type="number" step="0.001" bind:value={newStart} /></label>
        <label>End <input class="time-input" type="number" step="0.001" bind:value={newEnd} /></label>
      </div>
      <input class="field-input" type="text" placeholder="Note (optional)" bind:value={newNote} />
      <input class="field-input" type="text" placeholder="Code (optional)" bind:value={newCode} />
      <div class="form-actions">
        <button class="btn-cancel" onclick={cancelCreate}>Cancel</button>
        <button class="btn-save" onclick={commitCreate} disabled={newEnd <= newStart}>Save</button>
      </div>
    </div>
  {/if}

  {#if bookmarks.length === 0 && !creating}
    <div class="bookmarks-empty">
      Select a time range in the timeline, then click <strong>+ New</strong> to add a bookmark.
    </div>
  {:else}
    <div class="bookmarks-list">
      {#each bookmarks as bm (bm.id)}
        {#if editingId === bm.id}
          <div class="bookmark-edit-form">
            <input class="field-input" type="text" placeholder="Label" bind:value={editLabel} />
            <div class="time-row">
              <label>Start <input class="time-input" type="number" step="0.001" bind:value={editStart} /></label>
              <label>End <input class="time-input" type="number" step="0.001" bind:value={editEnd} /></label>
            </div>
            <input class="field-input" type="text" placeholder="Note (optional)" bind:value={editNote} />
            <input class="field-input" type="text" placeholder="Code (optional)" bind:value={editCode} />
            <div class="form-actions">
              <button class="btn-delete" onclick={() => { if (confirm(`Delete bookmark "${bm.label}"?`)) { onDeleteBookmark(bm.id); editingId = null } }}>Delete</button>
              <button class="btn-cancel" onclick={() => editingId = null}>Cancel</button>
              <button class="btn-save" onclick={commitEdit}>Save</button>
            </div>
          </div>
        {:else}
          <div class="bookmark-row">
            <button
              class="bookmark-seek-btn"
              onclick={() => onSeek?.(bm.startSeconds)}
              title="Seek to bookmark"
            >▶</button>
            <div class="bookmark-info" role="button" tabindex="0"
              onclick={() => startEdit(bm)}
              onkeydown={(e) => e.key === 'Enter' && startEdit(bm)}
            >
              <span class="bookmark-label">{bm.label}</span>
              <span class="bookmark-time">{fmtTime(bm.startSeconds)} – {fmtTime(bm.endSeconds)} <em>({fmtDuration(bm.startSeconds, bm.endSeconds)})</em></span>
              {#if bm.code}<span class="bookmark-code">{bm.code}</span>{/if}
              {#if bm.note}<span class="bookmark-note">{bm.note}</span>{/if}
            </div>
            {#if onAddToCollection}
              <button
                class="bookmark-coll-btn"
                onclick={() => onAddToCollection(bm)}
                title={activeCollectionName ? `Add to "${activeCollectionName}"` : 'Add to collection'}
              >＋</button>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .bookmarks-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .bookmarks-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid var(--color-border, #ddd);
    flex-shrink: 0;
  }

  .bookmarks-count {
    font-size: 0.72rem;
    color: var(--color-text-muted, #888);
  }

  .new-btn {
    background: none;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 0.75rem;
    cursor: pointer;
    color: var(--color-text-1, #333);
  }
  .new-btn:hover { background: var(--color-bg-2, #f0f0f0); }

  .bookmarks-empty {
    padding: 1.5rem 1rem;
    font-size: 0.8rem;
    color: var(--color-text-muted, #888);
    text-align: center;
    font-style: italic;
  }

  .bookmarks-list {
    flex: 1;
    overflow-y: auto;
  }

  .bookmark-row {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--color-border, #eee);
  }
  .bookmark-row:hover { background: var(--color-bg-1, #f9f9f9); }

  .bookmark-seek-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted, #aaa);
    font-size: 0.65rem;
    padding: 3px 2px;
    flex-shrink: 0;
    line-height: 1;
    margin-top: 1px;
  }
  .bookmark-seek-btn:hover { color: var(--color-primary, #4a90d9); }

  .bookmark-coll-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted, #aaa);
    font-size: 0.8rem;
    padding: 2px 3px;
    flex-shrink: 0;
    line-height: 1;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .bookmark-row:hover .bookmark-coll-btn { opacity: 1; }
  .bookmark-coll-btn:hover { color: var(--color-primary, #4a90d9); }

  .bookmark-info {
    flex: 1;
    min-width: 0;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .bookmark-label {
    font-size: 0.82rem;
    font-weight: 500;
    color: var(--color-text-1, #333);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bookmark-info:hover .bookmark-label { color: var(--color-primary, #4a90d9); }

  .bookmark-time {
    font-size: 0.7rem;
    color: var(--color-text-muted, #888);
    font-variant-numeric: tabular-nums;
  }
  .bookmark-time em { font-style: normal; }

  .bookmark-code {
    font-size: 0.7rem;
    background: var(--color-primary-dim, #e8f0fb);
    color: var(--color-primary, #4a90d9);
    border-radius: 2px;
    padding: 0 4px;
    align-self: flex-start;
  }

  .bookmark-note {
    font-size: 0.72rem;
    color: var(--color-text-muted, #888);
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Forms ── */

  .bookmark-create-form,
  .bookmark-edit-form {
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-border, #ddd);
    display: flex;
    flex-direction: column;
    gap: 5px;
    background: var(--color-bg-1, #f9f9f9);
    flex-shrink: 0;
  }

  .field-input {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 6px;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 3px;
    font-size: 0.8rem;
    background: var(--color-bg-0, #fff);
    color: var(--color-text-1, #333);
    font-family: inherit;
  }
  .field-input:focus { outline: 2px solid var(--color-primary, #4a90d9); outline-offset: -1px; border-color: transparent; }

  .time-row {
    display: flex;
    gap: 8px;
    font-size: 0.75rem;
    color: var(--color-text-muted, #888);
  }
  .time-row label { display: flex; align-items: center; gap: 4px; flex: 1; }

  .time-input {
    flex: 1;
    padding: 3px 5px;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 3px;
    font-size: 0.75rem;
    background: var(--color-bg-0, #fff);
    color: var(--color-text-1, #333);
    min-width: 0;
  }

  .form-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
    align-items: center;
  }

  .btn-save, .btn-cancel, .btn-delete {
    border-radius: 3px;
    padding: 3px 10px;
    font-size: 0.75rem;
    cursor: pointer;
    border: 1px solid var(--color-border, #ddd);
  }
  .btn-save { background: var(--color-primary, #4a90d9); color: #fff; border-color: var(--color-primary, #4a90d9); }
  .btn-save:disabled { opacity: 0.5; cursor: default; }
  .btn-save:not(:disabled):hover { filter: brightness(1.1); }
  .btn-cancel { background: none; color: var(--color-text-muted, #888); }
  .btn-cancel:hover { background: var(--color-bg-2, #f0f0f0); }
  .btn-delete { background: none; color: var(--color-danger, #e74c3c); border-color: transparent; margin-right: auto; }
  .btn-delete:hover { background: color-mix(in srgb, var(--color-danger, #e74c3c) 10%, transparent); }
</style>
