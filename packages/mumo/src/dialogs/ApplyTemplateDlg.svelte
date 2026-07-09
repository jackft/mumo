<script lang="ts">
  import type { ConflictEntry, PreviewSection } from '../apply-template-types.js'

  const {
    conflicts,
    preview,
    onconfirm,
    onclose,
  }: {
    conflicts: ConflictEntry[]
    preview: PreviewSection[]
    onconfirm: () => void
    onclose: () => void
  } = $props()

  const hasChanges = $derived(
    preview.some(s => s.items.some(i => i.action !== 'skip'))
  )
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg atd" role="dialog" aria-modal="true" aria-labelledby="atd-title">

  <div class="dlg-header">
    <h3 id="atd-title">Apply template</h3>
    <button class="close-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>

  <div class="dlg-body">

    {#if conflicts.length > 0}
      <div class="atd-error-banner">
        <span class="atd-error-icon">⚠</span>
        <span>Cannot apply — {conflicts.length} conflict{conflicts.length > 1 ? 's' : ''} found</span>
      </div>
      <div class="atd-conflict-list">
        {#each conflicts as c}
          <div class="atd-conflict-row">
            <span class="atd-conflict-cat">{c.category}</span>
            <span class="atd-conflict-name">"{c.name}"</span>
            <span class="atd-conflict-reason">{c.reason}</span>
          </div>
        {/each}
      </div>

    {:else if !hasChanges}
      <p class="atd-empty">All items in the template are already present — nothing to apply.</p>

    {:else}
      {#each preview as section}
        {@const visible = section.items.filter(i => i.action !== 'skip')}
        {@const skipped = section.items.filter(i => i.action === 'skip').length}
        {#if visible.length > 0 || skipped > 0}
          <div class="atd-section">
            <div class="atd-section-head">{section.category}</div>
            {#each visible as item}
              <div class="atd-item">
                <span class="atd-badge atd-badge-{item.action}">
                  {item.action === 'add' ? 'new' : 'merge'}
                </span>
                <div class="atd-item-body">
                  <span class="atd-item-name">{item.name}</span>
                  {#if item.detail}
                    <span class="atd-item-detail">{item.detail}</span>
                  {/if}
                  {#if item.additions && item.additions.length > 0}
                    <div class="atd-additions">
                      {#each item.additions as addition}
                        <span class="atd-addition">+ {addition}</span>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
            {#if skipped > 0}
              <div class="atd-skipped">{skipped} already present, unchanged</div>
            {/if}
          </div>
        {/if}
      {/each}
    {/if}

  </div>

  <div class="dlg-footer">
    {#if conflicts.length > 0 || !hasChanges}
      <button onclick={onclose}>Close</button>
    {:else}
      <button onclick={onclose}>Cancel</button>
      <button class="primary" onclick={() => { onconfirm(); onclose() }}>Apply</button>
    {/if}
  </div>

</div>

<style>
  .atd {
    width: min(90vw, 520px);
    max-height: 80vh;
    overflow: hidden;
    padding: 0;
  }

  .dlg-header {
    padding: 1.1rem 1.25rem 0.9rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .dlg-body {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    padding: 0.75rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* ── Error state ──────────────────────────────────────────────────────── */
  .atd-error-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: var(--radius-sm);
    color: #991b1b;
    font-size: var(--font-sm);
    font-weight: 600;
  }
  .atd-error-icon { font-size: 1rem; }

  .atd-conflict-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    font-size: var(--font-sm);
  }
  .atd-conflict-row {
    display: grid;
    grid-template-columns: 6rem 1fr;
    grid-template-rows: auto auto;
    gap: 0 0.5rem;
    padding: 0.45rem 0.75rem;
    border-top: 1px solid var(--color-bg-3);
  }
  .atd-conflict-row:first-child { border-top: none; }
  .atd-conflict-cat {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-3);
    font-weight: 600;
    grid-row: 1;
    grid-column: 1;
    align-self: center;
  }
  .atd-conflict-name {
    grid-row: 1;
    grid-column: 2;
    font-family: monospace;
    color: #222;
  }
  .atd-conflict-reason {
    grid-row: 2;
    grid-column: 2;
    color: #b91c1c;
    font-size: 0.8rem;
  }

  /* ── Preview state ────────────────────────────────────────────────────── */
  .atd-empty {
    color: var(--color-text-muted);
    font-size: var(--font-sm);
    margin: 0;
  }

  .atd-section {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .atd-section-head {
    padding: 0.3rem 0.6rem;
    background: var(--color-bg-2);
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-3);
  }

  .atd-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-top: 1px solid var(--color-bg-3);
    font-size: var(--font-sm);
  }

  .atd-badge {
    flex-shrink: 0;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 3px;
    margin-top: 1px;
  }
  .atd-badge-add   { background: #d1fae5; color: #065f46; }
  .atd-badge-merge { background: #dbeafe; color: #1e40af; }

  .atd-item-body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .atd-item-name   { font-family: monospace; color: #222; word-break: break-all; }
  .atd-item-detail { font-size: 0.78rem; color: var(--color-text-muted); }

  .atd-additions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.1rem;
  }
  .atd-addition {
    font-size: 0.75rem;
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-radius: 3px;
    padding: 1px 5px;
    color: #1e40af;
    font-family: monospace;
  }

  .atd-skipped {
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
    color: var(--color-text-muted);
    border-top: 1px solid var(--color-bg-3);
    background: var(--color-bg-1);
  }
</style>
