<script lang="ts">
  import { untrack } from 'svelte'
  import { ACTION_DEFS, defaultBindings, formatCombo, normalizeKeyEvent } from '../keybindings.js'
  import type { KeyBindings, ActionId } from '../keybindings.js'

  const TRANSCRIPT_FONTS: { label: string; value: string }[] = [
    { label: 'CMU Serif (default)', value: '' },
    { label: 'CMU Serif',           value: '"CMU Serif", "Computer Modern", Georgia, serif' },
    { label: 'Times New Roman',     value: '"Times New Roman", Times, serif' },
    { label: 'Arial',               value: 'Arial, Helvetica, sans-serif' },
    { label: 'Courier New',         value: '"Courier New", Courier, monospace' },
  ]

  const { transcriptFont, userName = 'Anonymous', preservePitch = true, keyBindings, onconfirm, onclose }: {
    transcriptFont: string
    userName?: string
    preservePitch?: boolean
    keyBindings: KeyBindings
    onconfirm: (prefs: { transcriptFont: string; userName: string; preservePitch: boolean; keyBindings: KeyBindings }) => void
    onclose: () => void
  } = $props()

  let selectedFont    = $state(untrack(() => transcriptFont))
  let editedName      = $state(untrack(() => userName))
  let pitchPref       = $state(untrack(() => preservePitch))
  let localBindings   = $state<KeyBindings>(untrack(() => ({ ...keyBindings })))
  let listeningId     = $state<ActionId | null>(null)

  const groups = $derived(
    [...new Set(ACTION_DEFS.map(d => d.group))].map(g => ({
      name: g,
      actions: ACTION_DEFS.filter(d => d.group === g),
    }))
  )

  function conflicts(id: ActionId, combo: string): ActionId | null {
    if (!combo) return null
    for (const def of ACTION_DEFS) {
      if (def.id !== id && localBindings[def.id] === combo) return def.id
    }
    return null
  }

  function startListening(id: ActionId) {
    listeningId = id
  }

  function captureKey(e: KeyboardEvent) {
    if (!listeningId) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') { listeningId = null; return }
    const combo = normalizeKeyEvent(e)
    if (!combo) return
    localBindings = { ...localBindings, [listeningId]: combo }
    listeningId = null
  }

  function clearBinding(id: ActionId) {
    localBindings = { ...localBindings, [id]: '' }
  }

  function resetBinding(id: ActionId) {
    const def = ACTION_DEFS.find(d => d.id === id)
    if (def) localBindings = { ...localBindings, [id]: def.defaultBinding }
  }

  function resetAll() {
    localBindings = defaultBindings()
  }

  function confirm() {
    onconfirm({ transcriptFont: selectedFont, userName: editedName, preservePitch: pitchPref, keyBindings: localBindings })
  }
</script>

<svelte:window onkeydown={listeningId ? captureKey : undefined} />

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg prefs-dlg" role="dialog" aria-modal="true" aria-labelledby="prefs-dlg-title">
  <h3 id="prefs-dlg-title">Preferences</h3>
  <div class="prefs-body">

  <section class="prefs-section">
    <h4 class="prefs-section-title">Identity</h4>
    <div class="prefs-row">
      <label for="prefs-name" class="prefs-label">Your name</label>
      <input
        id="prefs-name"
        class="prefs-input"
        type="text"
        bind:value={editedName}
        placeholder="Anonymous"
      />
    </div>
    <p class="prefs-hint">Used to identify your notes.</p>
  </section>

  <section class="prefs-section">
    <h4 class="prefs-section-title">Transcript</h4>
    <div class="prefs-row">
      <label for="prefs-font" class="prefs-label">Default font</label>
      <select id="prefs-font" class="prefs-select" bind:value={selectedFont}>
        {#each TRANSCRIPT_FONTS as f (f.label)}
          <option value={f.value} style={f.value ? `font-family: ${f.value}` : ''}>{f.label}</option>
        {/each}
      </select>
      {#if selectedFont}
        <span class="prefs-preview" style="font-family: {selectedFont}">The quick brown fox</span>
      {:else}
        <span class="prefs-preview">The quick brown fox</span>
      {/if}
    </div>
  </section>

  <section class="prefs-section">
    <h4 class="prefs-section-title">Media</h4>
    <div class="prefs-row">
      <label class="prefs-label prefs-check-label">
        <input type="checkbox" bind:checked={pitchPref} />
        Preserve pitch when changing playback speed
      </label>
    </div>
    <p class="prefs-hint">Keeps pitch natural when changing playback speed.</p>
  </section>

  <section class="prefs-section shortcuts-section">
    <div class="shortcuts-header">
      <h4 class="prefs-section-title">Shortcuts</h4>
      <button class="reset-all-btn" onclick={resetAll}>Reset all</button>
    </div>
    {#each groups as group (group.name)}
      <div class="shortcut-group">
        <div class="shortcut-group-label">{group.name}</div>
        {#each group.actions as def (def.id)}
          {@const combo = localBindings[def.id] ?? ''}
          {@const conflict = conflicts(def.id, combo)}
          {@const isListening = listeningId === def.id}
          <div class="shortcut-row" class:conflict={!!conflict}>
            <span class="shortcut-label">{def.label}</span>
            <div class="shortcut-controls">
              <button
                class="shortcut-chip"
                class:listening={isListening}
                class:empty={!combo && !isListening}
                title={isListening ? 'Press any key (Esc to cancel)' : 'Click to rebind'}
                onclick={() => isListening ? (listeningId = null) : startListening(def.id)}
              >
                {#if isListening}
                  <span class="listening-text">press a key…</span>
                {:else}
                  {formatCombo(combo)}
                {/if}
              </button>
              {#if combo}
                <button class="shortcut-clear" title="Clear binding" onclick={() => clearBinding(def.id)}>×</button>
              {:else if localBindings[def.id] !== def.defaultBinding}
                <button class="shortcut-clear" title="Restore default" onclick={() => resetBinding(def.id)}>↺</button>
              {/if}
            </div>
            {#if conflict}
              {@const conflictDef = ACTION_DEFS.find(d => d.id === conflict)}
              <span class="conflict-label">conflicts with "{conflictDef?.label}"</span>
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </section>

  </div><!-- /prefs-body -->
  <div class="dlg-actions">
    <button onclick={onclose}>Cancel</button>
    <button class="primary" onclick={confirm}>Save</button>
  </div>
</div>

<style>
  .prefs-dlg { min-width: 480px; max-height: 85vh; display: flex; flex-direction: column; }
  .prefs-dlg h3 { flex-shrink: 0; }
  .prefs-dlg .dlg-actions { flex-shrink: 0; }
  .prefs-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: inherit; padding-bottom: 0.5rem; }

  .prefs-section { display: flex; flex-direction: column; gap: 0.6rem; }

  .prefs-section-title {
    font-size: var(--font-sm);
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }

  .prefs-row { display: flex; align-items: center; gap: 0.75rem; }

  .prefs-label { font-size: var(--font-sm); color: var(--color-text-1); min-width: 90px; }
  .prefs-check-label { display: flex; align-items: center; gap: 0.5rem; min-width: 0; cursor: pointer; }

  .prefs-input {
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    font-size: var(--font-sm);
    font-family: inherit;
    background: var(--color-bg-0);
    color: var(--color-text-1);
    flex: 1;
  }
  .prefs-input:focus { outline: 2px solid var(--color-primary); outline-offset: -1px; border-color: transparent; }

  .prefs-hint {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    margin: 0;
    line-height: 1.4;
  }

  .prefs-select {
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    font-size: var(--font-sm);
    font-family: inherit;
    background: var(--color-bg-0);
    color: var(--color-text-1);
    cursor: pointer;
  }
  .prefs-select:focus { outline: 2px solid var(--color-primary); outline-offset: -1px; border-color: transparent; }

  .prefs-preview {
    font-size: 0.9rem;
    color: var(--color-text-2);
    font-family: 'CMU Serif', 'Computer Modern', Georgia, serif;
  }

  /* ── Shortcuts ── */
  .shortcuts-section { display: flex; flex-direction: column; }
  .shortcuts-header { display: flex; align-items: center; justify-content: space-between; }

  .reset-all-btn {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 2px 6px;
    cursor: pointer;
  }
  .reset-all-btn:hover { color: var(--color-text-1); border-color: var(--color-text-muted); }

  .shortcut-group {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .shortcut-group-label {
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 4px 0 2px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 2px;
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 3px 0;
    flex-wrap: wrap;
  }
  .shortcut-row.conflict .shortcut-chip { border-color: var(--color-danger, #e74c3c); }

  .shortcut-label {
    flex: 1;
    font-size: var(--font-sm);
    color: var(--color-text-1);
    min-width: 160px;
  }

  .shortcut-controls { display: flex; align-items: center; gap: 3px; }

  .shortcut-chip {
    font-size: 0.72rem;
    font-family: monospace;
    padding: 2px 7px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: var(--color-bg-1);
    color: var(--color-text-1);
    cursor: pointer;
    min-width: 64px;
    text-align: center;
    transition: border-color 0.1s;
  }
  .shortcut-chip:hover { border-color: var(--color-primary); }
  .shortcut-chip.listening {
    border-color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 8%, var(--color-bg-0));
    color: var(--color-primary);
  }
  .shortcut-chip.empty { color: var(--color-text-muted); font-family: inherit; font-style: italic; }

  .listening-text { font-family: inherit; font-style: italic; font-size: 0.68rem; }

  .shortcut-clear {
    background: none;
    border: none;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: 0.9rem;
    line-height: 1;
    padding: 0 2px;
  }
  .shortcut-clear:hover { color: var(--color-text-1); }

  .conflict-label {
    flex-basis: 100%;
    font-size: 0.68rem;
    color: var(--color-danger, #e74c3c);
    padding-left: calc(160px + 0.5rem);
  }
</style>
