<script lang="ts">
  import { untrack } from 'svelte'
  import type { ControlledVocabulary } from '@mumo/core'

  const { x, y, currentValue, vocabId, vocabs, oncommit, onclose }: {
    x: number
    y: number
    currentValue: string
    vocabId: string
    vocabs: ControlledVocabulary[]
    oncommit: (value: string) => void
    onclose: () => void
  } = $props()

  let value = $state(untrack(() => currentValue))
  const vocab = $derived(vocabId ? vocabs.find(v => v.id === vocabId) : null)

  // Guard against double-commit when Enter keydown causes a blur event
  let committed = false

  function commit() {
    if (committed) return
    committed = true
    oncommit(value)
  }

  function cancel() {
    committed = true  // suppress any pending blur
    onclose()
  }

  function focusOnMount(node: HTMLElement) {
    node.focus()
  }
</script>

<button class="popover-backdrop" onclick={cancel} aria-label="Close"></button>
<div class="ann-popover" style="left:{x}px; top:{y}px">
  {#if vocab && vocab.entries.length > 0}
    <select
      {value}
      onchange={(e) => { oncommit((e.currentTarget as HTMLSelectElement).value) }}
      use:focusOnMount
    >
      <option value="">— select —</option>
      {#each vocab.entries as entry (entry.id)}
        <option value={entry.value}>{entry.value}{entry.description ? ` — ${entry.description}` : ''}</option>
      {/each}
    </select>
  {:else}
    <input
      bind:value
      placeholder="label…"
      onblur={commit}
      onkeydown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        if (e.key === 'Escape') { e.preventDefault(); cancel() }
      }}
      use:focusOnMount
    />
  {/if}
</div>

<style>
  .popover-backdrop {
    position: fixed; inset: 0; z-index: 400;
    background: transparent; border: none; padding: 0; cursor: default;
  }

  .ann-popover {
    position: fixed;
    z-index: 401;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 8px;
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.18),
      0 2px 8px rgba(0, 0, 0, 0.1);
    padding: 4px;
    min-width: 200px;
  }

  /* downward-pointing arrow */
  .ann-popover::after {
    content: '';
    position: absolute;
    bottom: -5px;
    left: 50%;
    transform: translateX(-50%) rotate(45deg);
    width: 8px;
    height: 8px;
    background: #fff;
    border-right: 1px solid rgba(0, 0, 0, 0.15);
    border-bottom: 1px solid rgba(0, 0, 0, 0.15);
  }

  .ann-popover input {
    width: 100%;
    padding: 0.45rem 0.65rem;
    background: transparent;
    border: none;
    outline: none;
    color: #111;
    font-size: 0.9rem;
    font-family: inherit;
    box-sizing: border-box;
    caret-color: #111;
  }

  .ann-popover input::placeholder {
    color: #aaa;
    font-style: italic;
  }

  .ann-popover select {
    width: 100%;
    padding: 0.4rem 0.6rem;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 5px;
    color: #111;
    font-size: 0.9rem;
    font-family: inherit;
    cursor: pointer;
    box-sizing: border-box;
    outline: none;
  }
</style>
