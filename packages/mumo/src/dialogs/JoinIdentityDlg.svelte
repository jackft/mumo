<script lang="ts">
  import type { CollabIdentity } from '../collab.js'

  const { allowEmail = true, onjoin }: {
    allowEmail?: boolean
    onjoin: (identity: CollabIdentity) => void
  } = $props()

  let name      = $state('')
  let email     = $state('')
  let submitted = $state(false)

  const nameError = $derived(submitted && name.trim() === '')

  function submit() {
    submitted = true
    if (!name.trim()) return
    const emailVal = allowEmail ? email.trim() : ''
    onjoin(emailVal ? { name: name.trim(), email: emailVal } : { name: name.trim() })
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') submit()
  }
</script>

<div class="dlg-backdrop" aria-hidden="true"></div>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="join-ident-title">
  <h3 id="join-ident-title">Join collaborative session</h3>
  <p class="dlg-hint">Enter your name so other collaborators know who you are.</p>

  <div class="fields">
    <div class="field">
      <label for="ji-name">Name <span class="req">*</span></label>
      <!-- svelte-ignore a11y_autofocus -->
      <input id="ji-name" type="text"
        bind:value={name}
        class:field-error={nameError}
        onblur={() => submitted = true}
        onkeydown={onKeydown}
        placeholder="Your display name"
        autofocus
      />
      {#if nameError}<span class="err">Name is required</span>{/if}
    </div>

    {#if allowEmail}
      <div class="field">
        <label for="ji-email">Email <span class="optional">(optional)</span></label>
        <input id="ji-email" type="email"
          bind:value={email}
          onkeydown={onKeydown}
          placeholder="you@example.com"
        />
      </div>
    {/if}
  </div>

  <div class="dlg-actions">
    <button class="primary" onclick={submit} disabled={!name.trim()}>Join session</button>
  </div>
</div>

<style>
  .dlg { min-width: 340px; max-width: 400px; }

  .fields { display: flex; flex-direction: column; gap: 0.75rem; }

  .field { display: flex; flex-direction: column; gap: 0.3rem; }

  .optional {
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
    color: var(--color-text-muted);
    font-size: 0.75rem;
  }

  .err { font-size: 0.75rem; color: var(--color-danger); }

  .field-error { border-color: var(--color-danger) !important; }
</style>
