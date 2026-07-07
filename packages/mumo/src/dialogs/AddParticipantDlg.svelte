<script lang="ts">
  const { onconfirm, onclose }: {
    onconfirm: (vals: { id: string; participant: string; annotator: string; defaultLocale: string }) => void
    onclose: () => void
  } = $props()

  let id            = $state('')
  let participant   = $state('')
  let annotator     = $state('')
  let defaultLocale = $state('')
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
  <h3 id="dlg-title">Add participant</h3>

  <label>
    ID <span class="req">*</span>
    <!-- svelte-ignore a11y_autofocus -->
    <input bind:value={id} placeholder="e.g. A" autofocus />
    <span class="hint">Short identifier — used internally and in exports.</span>
  </label>

  <label>
    Full name / label
    <input bind:value={participant} placeholder="e.g. Alice" />
    <span class="hint">ELAN PARTICIPANT attribute — displayed name for this speaker.</span>
  </label>

  <label>
    Annotator
    <input bind:value={annotator} placeholder="e.g. researcher initials" />
    <span class="hint">ELAN ANNOTATOR attribute — who transcribed this participant.</span>
  </label>

  <label>
    Default locale
    <input bind:value={defaultLocale} placeholder="e.g. en, en-US, de, ja" />
    <span class="hint">ELAN DEFAULT_LOCALE attribute — BCP 47 language tag for this tier.</span>
  </label>

  <div class="dlg-actions">
    <button onclick={onclose}>Cancel</button>
    <button class="add-btn" onclick={() => onconfirm({ id: id.trim(), participant: participant.trim(), annotator: annotator.trim(), defaultLocale: defaultLocale.trim() })} disabled={!id.trim()}>Add</button>
  </div>
</div>

<style>
  .dlg { min-width: 400px; }
</style>
