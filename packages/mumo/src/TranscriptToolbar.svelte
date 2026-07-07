<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import { runToggleBold, runToggleItalic, runToggleStrike, runToggleUnderline, runInsertChar, runInsertOverlapBracket, runApplyFont, DEFAULT_SYMBOL_DEFS } from '@mumo/editor'
  import type { EditorView } from '@mumo/editor'
  import type { SymbolDef } from '@mumo/core'
  import type { FontEntry } from '@mumo/media-player'

  const FALLBACK_FONTS: FontEntry[] = [
    { label: 'CMU Serif',       value: '"CMU Serif", "Computer Modern", Georgia, serif' },
    { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
    { label: 'Arial',           value: 'Arial, Helvetica, sans-serif' },
    { label: 'Courier New',     value: '"Courier New", Courier, monospace' },
  ]

  const { getView, onInsertVisualization, editable = true, fontSizePx = 16, onFontSizeChange,
        boldActive = false, italicActive = false, strikeActive = false, underlineActive = false,
        currentFont = '', defaultFont = '',
        onDefaultFontChange, symbolDefs = DEFAULT_SYMBOL_DEFS,
        defaultFonts = FALLBACK_FONTS, systemFonts = [] }: {
    getView: () => EditorView | undefined
    onInsertVisualization: (type: string) => void
    editable?: boolean
    fontSizePx?: number
    onFontSizeChange?: (px: number) => void
    boldActive?: boolean
    italicActive?: boolean
    strikeActive?: boolean
    underlineActive?: boolean
    /** CSS font-family of the mark at the cursor, or empty if none. */
    currentFont?: string
    /** Project-level default font. */
    defaultFont?: string
    onDefaultFontChange?: (family: string) => void
    /** Current project symbol defs — drives the symbol palette. */
    symbolDefs?: SymbolDef[]
    /** Preferred fonts shown at the top (from font-defaults.json or built-in fallback). */
    defaultFonts?: FontEntry[]
    /** System font family names listed below the defaults. */
    systemFonts?: string[]
  } = $props()

  function applyFontSize(raw: string) {
    const n = parseInt(raw, 10)
    if (!isNaN(n) && n >= 8 && n <= 72) onFontSizeChange?.(n)
  }

  let insertOpen  = $state(false)
  let symbolOpen  = $state(false)

  function onFontChange(family: string) {
    const v = getView()
    if (!v) return
    if (!v.state.selection.empty) {
      runApplyFont(v, family)
    } else {
      onDefaultFontChange?.(family)
    }
  }

  function act(fn: (v: EditorView) => void) {
    const v = getView()
    if (v) fn(v)
  }

  // Deduplicated palette: one entry per unique unicode value, keeping first description and
  // collecting all shortcuts for the tooltip.
  type PaletteEntry = { char: string; label: string; shortcuts: string[] }
  function buildPalette(defs: SymbolDef[]): PaletteEntry[] {
    const seen = new SvelteMap<string, PaletteEntry>()
    for (const def of defs) {
      if (!def.unicode) continue
      const existing = seen.get(def.unicode)
      if (existing) {
        if (def.shortcut) existing.shortcuts.push(def.shortcut)
      } else {
        seen.set(def.unicode, {
          char: def.unicode,
          label: def.description ?? def.unicode,
          shortcuts: def.shortcut ? [def.shortcut] : [],
        })
      }
    }
    return Array.from(seen.values())
  }

  function paletteTitle(entry: PaletteEntry): string {
    if (!entry.shortcuts.length) return entry.label
    return `${entry.label} — ${entry.shortcuts.map(s => `\\${s}`).join(', ')}`
  }
</script>

<!-- Font family -->
<select
  class="tb-font-select"
  aria-label="Transcript font"
  title="Font — applies to selection if text is selected, otherwise sets project default"
  value={currentFont || defaultFont}
  onchange={(e) => onFontChange(e.currentTarget.value)}
>
  <option value="">Default</option>
  {#each defaultFonts as f (f.value)}
    <option value={f.value} style="font-family: {f.value}">{f.label}</option>
  {/each}
  {#if systemFonts.length > 0}
    <optgroup label="System Fonts">
      {#each systemFonts as name (name)}
        <option value='"{name}"' style='font-family: "{name}"'>{name}</option>
      {/each}
    </optgroup>
  {/if}
</select>

<span class="tb-sep"></span>

<!-- Font size -->
<div class="tb-fs-wrap">
  <input
    class="tb-fs-input"
    type="text"
    inputmode="numeric"
    value="{fontSizePx} pt"
    aria-label="Font size"
    onchange={(e) => applyFontSize((e.target as HTMLInputElement).value)}
    onfocus={(e) => { (e.target as HTMLInputElement).select() }}
  />
  <div class="tb-fs-arrow">
    <select
      class="tb-fs-select"
      value={fontSizePx}
      aria-label="Font size presets"
      onchange={(e) => { applyFontSize((e.target as HTMLSelectElement).value) }}
    >
      {#each [8,9,10,11,12,13,14,15,16,18,20,22,24,26,28,30,32] as s (s)}
        <option value={s}>{s} pt</option>
      {/each}
    </select>
    <span class="tb-fs-chevron" aria-hidden="true">▾</span>
  </div>
</div>

<span class="tb-sep"></span>

<!-- Text formatting -->
<button
  class="tb-btn tb-bold"
  class:active={boldActive}
  title="Bold — Ctrl+B"
  disabled={!editable}
  onmousedown={(e) => { e.preventDefault(); act(runToggleBold) }}
>B</button>
<button
  class="tb-btn tb-italic"
  class:active={italicActive}
  title="Italic — Ctrl+I"
  disabled={!editable}
  onmousedown={(e) => { e.preventDefault(); act(runToggleItalic) }}
>I</button>
<button
  class="tb-btn tb-underline"
  class:active={underlineActive}
  title="Underline / stress — Ctrl+U"
  disabled={!editable}
  onmousedown={(e) => { e.preventDefault(); act(runToggleUnderline) }}
>U</button>
<button
  class="tb-btn tb-strike"
  class:active={strikeActive}
  title="Strikethrough — Ctrl+Shift+S"
  disabled={!editable}
  onmousedown={(e) => { e.preventDefault(); act(runToggleStrike) }}
>S</button>

<span class="tb-sep"></span>

<!-- Overlap brackets (direct) -->
<button
  class="tb-btn tb-overlap"
  title="Insert overlap start bracket — /[ or /groupname["
  disabled={!editable}
  onmousedown={(e) => { e.preventDefault(); act(v => runInsertOverlapBracket(v, 'start')) }}
>[</button>
<button
  class="tb-btn tb-overlap"
  title="Insert overlap end bracket — /] or /groupname]"
  disabled={!editable}
  onmousedown={(e) => { e.preventDefault(); act(v => runInsertOverlapBracket(v, 'end')) }}
>]</button>

<span class="tb-sep"></span>

<!-- Insert dropdown -->
<div class="tb-palette-wrap">
  <button
    class="tb-btn"
    title="Insert block"
    disabled={!editable}
    onmousedown={(e) => { e.preventDefault(); if (editable) { insertOpen = !insertOpen; symbolOpen = false } }}
  >Insert <span class="tb-arrow">▾</span></button>
  {#if insertOpen}
    <button class="tb-backdrop" onmousedown={() => { insertOpen = false }} aria-label="Close"></button>
    <div class="tb-palette tb-palette--insert">
      <button class="tb-insert-btn" onmousedown={(e) => { e.preventDefault(); onInsertVisualization('screenshot'); insertOpen = false }}>
        Image <span class="tb-insert-cmd">/image</span>
      </button>
      <button class="tb-insert-btn" onmousedown={(e) => { e.preventDefault(); onInsertVisualization('spectrogram'); insertOpen = false }}>
        Spectrogram <span class="tb-insert-cmd">/spectrogram</span>
      </button>
    </div>
  {/if}
</div>

<!-- Symbols dropdown -->
<div class="tb-palette-wrap">
  <button
    class="tb-btn"
    title="Insert transcription symbol"
    disabled={!editable}
    onmousedown={(e) => { e.preventDefault(); if (editable) { symbolOpen = !symbolOpen; insertOpen = false } }}
  >Symbols <span class="tb-arrow">▾</span></button>
  {#if symbolOpen}
    <button class="tb-backdrop" onmousedown={() => { symbolOpen = false }} aria-label="Close"></button>
    <div class="tb-palette tb-palette--symbols">
      {#each buildPalette(symbolDefs) as entry (entry.char)}
        <button
          class="tb-char-btn"
          title={paletteTitle(entry)}
          onmousedown={(e) => { e.preventDefault(); act(v => runInsertChar(v, entry.char)); symbolOpen = false }}
        >{entry.char}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tb-bold      { font-weight: 700; }
  .tb-italic    { font-style: italic; }
  .tb-underline { text-decoration: underline; }
  .tb-strike    { text-decoration: line-through; }

  .tb-overlap {
    font-family: monospace;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: none;
    letter-spacing: 0;
  }

  .tb-sep {
    display: inline-block;
    width: 1px;
    height: 13px;
    background: #ccc;
    margin: 0 4px;
    flex-shrink: 0;
  }

  .tb-arrow { font-size: 0.7em; opacity: 0.55; }

  .tb-palette-wrap { position: relative; display: inline-flex; }

  .tb-backdrop {
    position: fixed;
    inset: 0;
    z-index: 299;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
  }

  .tb-palette {
    position: absolute;
    top: calc(100% + 3px);
    left: 0;
    z-index: 300;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-shadow: 0 3px 10px rgba(0,0,0,0.12);
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 4px;
    min-width: 140px;
    max-width: 220px;
  }

  .tb-palette--insert {
    flex-direction: column;
    gap: 1px;
    min-width: 190px;
    max-width: 220px;
  }

  .tb-palette--symbols {
    min-width: 160px;
    max-width: 260px;
  }

  .tb-char-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 30px;
    padding: 3px 5px;
    border: 1px solid #e0e0e0;
    border-radius: 3px;
    background: #fafafa;
    font-size: 0.88em;
    font-family: 'CMU Serif', Georgia, serif;
    cursor: pointer;
    color: #333;
  }
  .tb-char-btn:hover { background: #eef; border-color: #99b; }

  .tb-insert-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 4px 8px;
    border: none;
    border-radius: 3px;
    background: transparent;
    font-size: 0.82rem;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    color: #333;
  }
  .tb-insert-btn:hover { background: #f0f0f0; }

  .tb-insert-cmd {
    font-family: monospace;
    font-size: 0.8em;
    color: #999;
    margin-left: 0.5em;
  }

  .tb-font-select {
    padding: 1px 4px;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    background: #fff;
    font-size: 0.72rem;
    font-family: inherit;
    color: #444;
    height: 22px;
    cursor: pointer;
    max-width: 130px;
  }
  .tb-font-select:focus { outline: 1px solid var(--color-primary, #4a9eff); border-color: var(--color-primary, #4a9eff); }

  .tb-fs-wrap {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    background: #fff;
    font-size: 0.72rem;
    font-family: inherit;
    overflow: hidden;
    height: 22px;
  }
  .tb-fs-wrap:focus-within { border-color: var(--color-primary, #4a9eff); outline: 1px solid var(--color-primary, #4a9eff); }
  .tb-fs-input {
    width: 3.6rem;
    padding: 1px 4px;
    border: none;
    background: transparent;
    font-size: inherit;
    font-family: inherit;
    color: #444;
    font-variant-numeric: tabular-nums;
    outline: none;
  }
  .tb-fs-arrow {
    position: relative;
    display: flex;
    align-items: center;
    border-left: 1px solid #d0d0d0;
    background: #f5f5f5;
    padding: 0 3px;
  }
  .tb-fs-select {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    width: 100%;
  }
  .tb-fs-chevron {
    font-size: 0.6rem;
    color: #666;
    pointer-events: none;
    line-height: 1;
  }
</style>
