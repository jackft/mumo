<script lang="ts">
  import { untrack } from 'svelte'
  import type { SymbolDef } from '@mumo/core'
  import { DEFAULT_SYMBOL_DEFS } from '@mumo/editor'

  const { defs: initialDefs, onconfirm, onclose }: {
    defs: SymbolDef[]
    onconfirm: (defs: SymbolDef[]) => void
    onclose: () => void
  } = $props()

  let defs = $state<SymbolDef[]>(
    untrack(() => initialDefs.length > 0 ? initialDefs.map(d => ({ ...d })) : DEFAULT_SYMBOL_DEFS.map(d => ({ ...d })))
  )

  let newUnicode     = $state('')
  let newShortcut    = $state('')
  let newDescription = $state('')

  function add() {
    const unicode = newUnicode.trim()
    if (!unicode) return
    const def: SymbolDef = { unicode }
    const shortcut = newShortcut.trim()
    const description = newDescription.trim()
    if (shortcut)    def.shortcut    = shortcut
    if (description) def.description = description
    defs = [...defs, def]
    newUnicode = ''
    newShortcut = ''
    newDescription = ''
  }

  function remove(idx: number) {
    defs = defs.filter((_, i) => i !== idx)
  }

  function loadCADefaults() {
    defs = DEFAULT_SYMBOL_DEFS.map(d => ({ ...d }))
  }

  function confirm() {
    onconfirm([...defs])
  }
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg sym-dlg" role="dialog" aria-modal="true" aria-labelledby="sym-dlg-title">
  <h3 id="sym-dlg-title">Transcription Symbols</h3>
  <div class="sym-table-wrap">
    <table class="sym-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Backslash shortcut</th>
          <th>Description</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each defs as def, i (def.unicode + i)}
          <tr>
            <td>
              <input
                class="sym-input sym-unicode"
                aria-label="Symbol"
                value={def.unicode}
                oninput={(e) => { defs[i] = { ...defs[i]!, unicode: e.currentTarget.value } }}
              />
            </td>
            <td>
              <input
                class="sym-input sym-shortcut"
                aria-label="Backslash shortcut"
                placeholder="(none)"
                value={def.shortcut ?? ''}
                oninput={(e) => {
                  const v = e.currentTarget.value.trim()
                  defs[i] = v ? { ...defs[i]!, shortcut: v } : { unicode: defs[i]!.unicode, ...(defs[i]!.description !== undefined ? { description: defs[i]!.description } : {}) }
                }}
              />
            </td>
            <td>
              <input
                class="sym-input sym-desc"
                aria-label="Description"
                placeholder="(optional)"
                value={def.description ?? ''}
                oninput={(e) => {
                  const v = e.currentTarget.value
                  defs[i] = v ? { ...defs[i]!, description: v } : { unicode: defs[i]!.unicode, ...(defs[i]!.shortcut !== undefined ? { shortcut: defs[i]!.shortcut } : {}) }
                }}
              />
            </td>
            <td>
              <button class="icon-btn danger" title="Remove symbol" onclick={() => remove(i)}>×</button>
            </td>
          </tr>
        {/each}
        <tr class="add-row">
          <td>
            <input
              class="sym-input sym-unicode"
              aria-label="New symbol"
              bind:value={newUnicode}
              placeholder="e.g. °"
              onkeydown={(e) => e.key === 'Enter' && add()}
            />
          </td>
          <td>
            <input
              class="sym-input sym-shortcut"
              aria-label="New shortcut"
              bind:value={newShortcut}
              placeholder="e.g. degree"
              onkeydown={(e) => e.key === 'Enter' && add()}
            />
          </td>
          <td>
            <input
              class="sym-input sym-desc"
              aria-label="New description"
              bind:value={newDescription}
              placeholder="(optional)"
              onkeydown={(e) => e.key === 'Enter' && add()}
            />
          </td>
          <td>
            <button class="add-btn" onclick={add} disabled={!newUnicode.trim()}>Add</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <p class="sym-hint">Type <code>\shortcut </code> (backslash + name + space) in the editor to insert the symbol.</p>
  <div class="dlg-actions">
    <button onclick={loadCADefaults} title="Replace current list with the standard CA symbol set">Load CA defaults</button>
    <span style="flex:1"></span>
    <button onclick={onclose}>Cancel</button>
    <button class="primary" onclick={confirm}>Save</button>
  </div>
</div>

<style>
  .sym-dlg { min-width: 560px; max-width: 720px; }

  .sym-table-wrap {
    border: 1px solid var(--color-border);
    border-radius: 4px;
    overflow: auto;
    max-height: 400px;
  }

  .sym-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-sm);
  }

  .sym-table thead th {
    position: sticky; top: 0;
    background: var(--color-bg-1);
    padding: 0.3rem 0.5rem;
    text-align: left;
    font-weight: 600;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-2);
  }

  .sym-table tbody tr:hover { background: var(--color-bg-1); }
  .sym-table td { padding: 0.2rem 0.4rem; }

  .add-row td { padding-top: 0.4rem; border-top: 1px solid var(--color-border); }

  .sym-input {
    width: 100%;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    font: inherit;
    font-size: var(--font-sm);
    background: var(--color-bg-0);
    color: var(--color-text-1);
    box-sizing: border-box;
  }
  .sym-input:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
    border-color: transparent;
  }
  .sym-unicode  { width: 80px; font-family: monospace; }
  .sym-shortcut { width: 120px; }
  .sym-desc     { width: 100%; }

  .sym-hint {
    font-size: var(--font-sm);
    color: var(--color-text-muted);
  }
  .sym-hint code {
    font-family: monospace;
    background: var(--color-bg-1);
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }

  /* align-items: center needed for the status message next to Cancel/Save */
  .dlg-actions { align-items: center; }
</style>
