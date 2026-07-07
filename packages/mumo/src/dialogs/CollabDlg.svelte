<script lang="ts">
  import type { CollabMode, CollabIdentity } from '../collab.js'
  import type { CollabCapability } from '../embed.js'

  const { serverUrl, signalingUrl, capability = 'both', allowEmail = true,
          prefillName = '', prefillEmail = '',
          onhost, onjoin, onclose }: {
    serverUrl:     string
    signalingUrl:  string
    capability?:   CollabCapability
    allowEmail?:   boolean
    prefillName?:  string
    prefillEmail?: string
    onhost: (mode: CollabMode, opts: { serverUrl: string; signalingUrl: string }, identity: CollabIdentity) => void
    onjoin: (roomId: string, mode: CollabMode, opts: { serverUrl: string; signalingUrl: string }, identity: CollabIdentity) => void
    onclose: () => void
  } = $props()

  type Flow = 'host' | 'join'
  let flow = $state<Flow>('host')

  // Identity
  // svelte-ignore state_referenced_locally
  let identName   = $state(prefillName)
  // svelte-ignore state_referenced_locally
  let identEmail  = $state(prefillEmail)
  let nameTouched = $state(false)
  const nameError = $derived(nameTouched && identName.trim() === '')

  // Host state
  // svelte-ignore state_referenced_locally
  let hostMode   = $state<CollabMode>(capability === 'webrtc' ? 'webrtc' : 'server')
  // svelte-ignore state_referenced_locally
  let hostSrvUrl = $state(serverUrl)
  // svelte-ignore state_referenced_locally
  let hostSigUrl = $state(signalingUrl)

  // Join state
  let joinInput  = $state('')
  let joinRoomId = $state('')
  // svelte-ignore state_referenced_locally
  let joinMode   = $state<CollabMode>(capability === 'server' ? 'server' : 'webrtc')
  // svelte-ignore state_referenced_locally
  let joinSrvUrl = $state(serverUrl)
  // svelte-ignore state_referenced_locally
  let joinSigUrl = $state(signalingUrl)

  const _canServer = $derived(capability === 'server' || capability === 'both')
  const _canWebrtc = $derived(capability === 'webrtc' || capability === 'both')

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  function onJoinInput(raw: string) {
    joinInput = raw
    const s = raw.trim()
    try {
      const url = new URL(s)
      const room = url.searchParams.get('room')
      if (room) {
        joinRoomId = room
        const parsed: CollabMode = url.searchParams.get('collab') === 'webrtc' ? 'webrtc' : 'server'
        if (capability === 'both') joinMode = parsed
        const sig = url.searchParams.get('signal')
        const srv = url.searchParams.get('server')
        if (sig) joinSigUrl = sig
        if (srv) joinSrvUrl = srv
        return
      }
    } catch {}
    const qIdx = s.indexOf('?')
    if (qIdx > 0) {
      const maybeUuid = s.slice(0, qIdx)
      if (UUID_RE.test(maybeUuid)) {
        const params = new URLSearchParams(s.slice(qIdx + 1))
        const sig = params.get('signal')
        const srv = params.get('server')
        joinRoomId = maybeUuid
        if (sig && capability !== 'server') { if (capability === 'both') joinMode = 'webrtc'; joinSigUrl = sig }
        else if (srv && capability !== 'webrtc') { if (capability === 'both') joinMode = 'server'; joinSrvUrl = srv }
        return
      }
    }
    joinRoomId = UUID_RE.test(s) ? s : ''
  }

  function identity(): CollabIdentity {
    const email = allowEmail ? identEmail.trim() : ''
    return email ? { name: identName.trim(), email } : { name: identName.trim() }
  }

  function host() {
    nameTouched = true
    if (!identName.trim()) return
    onhost(hostMode, { serverUrl: hostSrvUrl, signalingUrl: hostSigUrl }, identity())
  }

  function join() {
    nameTouched = true
    if (!joinRoomId || !identName.trim()) return
    onjoin(joinRoomId, joinMode, { serverUrl: joinSrvUrl, signalingUrl: joinSigUrl }, identity())
  }
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="collab-dlg-title">
  <div class="dlg-header">
    <h3 id="collab-dlg-title">Collaborate</h3>
    <button class="close-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>

  <!-- Flow picker -->
  <div class="flow-picker" role="group" aria-label="Session type">
    <button class="flow-card" class:flow-selected={flow === 'host'} onclick={() => flow = 'host'}>
      <span class="flow-icon">⊕</span>
      <span class="flow-title">Start a session</span>
      <span class="flow-desc">Create a room and invite others</span>
    </button>
    <button class="flow-card" class:flow-selected={flow === 'join'} onclick={() => flow = 'join'}>
      <span class="flow-icon">→</span>
      <span class="flow-title">Join a session</span>
      <span class="flow-desc">Enter a link or room ID</span>
    </button>
  </div>

  <!-- Identity -->
  <div class="identity-section">
    <div class="ident-field">
      <label for="ident-name" class="field-label">
        Your name <span class="req">*</span>
      </label>
      <!-- svelte-ignore a11y_autofocus -->
      <input id="ident-name" class="field-input" class:field-error={nameError} type="text"
        bind:value={identName}
        onblur={() => nameTouched = true}
        placeholder="Shown to collaborators"
        autofocus
      />
      {#if nameError}<span class="field-hint-err">Name is required</span>{/if}
    </div>
    {#if allowEmail}
      <div class="ident-field">
        <label for="ident-email" class="field-label">Email <span class="optional">(optional)</span></label>
        <input id="ident-email" class="field-input" type="email"
          bind:value={identEmail} placeholder="you@example.com" />
      </div>
    {/if}
  </div>

  <!-- Host flow -->
  {#if flow === 'host'}
    <div class="options">
      {#if _canServer}
        <label class="option" class:selected={hostMode === 'server'}>
          <div class="option-header">
            {#if capability === 'both'}
              <input type="radio" name="collab-mode" value="server" bind:group={hostMode} />
            {/if}
            <span class="option-title">Mumo Server</span>
          </div>
          <p class="option-desc">Sync via a shared server. Supports persistence. Others can join after you go offline.</p>
          {#if hostMode === 'server'}
            <div class="option-field">
              <label for="collab-server-url" class="field-label">Server URL</label>
              <input id="collab-server-url" class="field-input" type="text"
                bind:value={hostSrvUrl} placeholder="ws://localhost:1234" spellcheck={false} />
            </div>
          {/if}
        </label>
      {/if}
      {#if _canWebrtc}
        <label class="option" class:selected={hostMode === 'webrtc'}>
          <div class="option-header">
            {#if capability === 'both'}
              <input type="radio" name="collab-mode" value="webrtc" bind:group={hostMode} />
            {/if}
            <span class="option-title">Peer-to-peer (WebRTC)</span>
          </div>
          <p class="option-desc">Direct sync, no server required. Uses a signaling server only to establish the connection.</p>
          {#if hostMode === 'webrtc'}
            <div class="option-field">
              <label for="collab-signal-url" class="field-label">Signaling URL</label>
              <input id="collab-signal-url" class="field-input" type="text"
                bind:value={hostSigUrl} placeholder="wss://signaling.yjs.dev" spellcheck={false} />
            </div>
          {/if}
        </label>
      {/if}
    </div>
    <div class="dlg-actions">
      <button onclick={onclose}>Cancel</button>
      <button class="primary" onclick={host} disabled={!identName.trim()}>Start session</button>
    </div>

  <!-- Join flow -->
  {:else}
    <div class="join-body">
      <div class="join-field">
        <label for="join-input" class="field-label">Invite link or room ID</label>
        <input id="join-input" class="field-input join-input" type="text"
          value={joinInput}
          oninput={(e) => onJoinInput((e.target as HTMLInputElement).value)}
          placeholder="Paste the link or room ID you received…"
          spellcheck={false}
        />
      </div>
      {#if joinRoomId}
        {#if capability === 'both'}
          <div class="join-mode">
            <span class="field-label">Mode</span>
            <label class="radio-label">
              <input type="radio" name="join-mode" value="webrtc" bind:group={joinMode} />WebRTC</label>
            <label class="radio-label">
              <input type="radio" name="join-mode" value="server" bind:group={joinMode} />Mumo Server</label>
          </div>
        {/if}
        {#if joinMode === 'server'}
          <div class="join-field">
            <label for="join-server-url" class="field-label">Server URL</label>
            <input id="join-server-url" class="field-input" type="text"
              bind:value={joinSrvUrl} placeholder="ws://localhost:1234" spellcheck={false} />
          </div>
        {:else}
          <div class="join-field">
            <label for="join-signal-url" class="field-label">Signaling URL</label>
            <input id="join-signal-url" class="field-input" type="text"
              bind:value={joinSigUrl} placeholder="wss://signaling.yjs.dev" spellcheck={false} />
          </div>
        {/if}
      {/if}
    </div>
    <div class="dlg-actions">
      <button onclick={onclose}>Cancel</button>
      <button class="primary" onclick={join} disabled={!joinRoomId}>Join session</button>
    </div>
  {/if}
</div>

<style>
  .dlg { width: 500px; }

  /* ── Flow picker ──────────────────────────────────────────────────────── */
  .flow-picker {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }

  .flow-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.2rem;
    padding: 0.85rem 1rem;
    border: 2px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-0);
    cursor: pointer;
    text-align: left;
    transition: border-color 0.12s, background 0.12s;
  }
  .flow-card:hover { border-color: var(--color-primary-border); background: var(--color-bg-1); }
  .flow-card.flow-selected {
    border-color: var(--color-primary);
    background: var(--color-primary-light);
  }

  .flow-icon {
    font-size: 1.25rem;
    line-height: 1;
    color: var(--color-text-muted);
    margin-bottom: 0.15rem;
  }
  .flow-selected .flow-icon { color: var(--color-primary-dark); }

  .flow-title {
    font-size: var(--font-base);
    font-weight: 600;
    color: var(--color-text-1);
  }

  .flow-desc {
    font-size: var(--font-sm);
    color: var(--color-text-muted);
    line-height: 1.35;
  }
  .flow-selected .flow-desc { color: var(--color-text-3); }

  /* ── Identity ─────────────────────────────────────────────────────────── */
  .identity-section {
    display: flex;
    gap: 0.75rem;
    padding: 0.75rem;
    background: var(--color-bg-1);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
  }

  .ident-field { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; min-width: 0; }

  .optional { font-weight: 400; text-transform: none; letter-spacing: normal; color: var(--color-text-muted); font-size: 0.75rem; }

  .field-error { border-color: var(--color-danger) !important; }
  .field-hint-err { font-size: 0.75rem; color: var(--color-danger); }

  /* ── Transport options (host flow) ────────────────────────────────────── */
  .options { display: flex; flex-direction: column; gap: 0.5rem; }

  .option {
    display: flex; flex-direction: column; gap: 0.4rem;
    padding: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: border-color 0.1s, background 0.1s;
  }
  .option:hover    { background: var(--color-bg-1); }
  .option.selected { border-color: var(--color-primary); background: var(--color-bg-1); }

  .option-header { display: flex; align-items: center; gap: 0.5rem; }

  .option-title { font-size: var(--font-sm); font-weight: 600; color: var(--color-text-1); }

  .option-desc {
    font-size: var(--font-sm); color: var(--color-text-muted);
    line-height: 1.45; margin: 0 0 0 1.4rem;
  }

  .option-field {
    display: flex; align-items: center; gap: 0.5rem;
    margin: 0.25rem 0 0 1.4rem;
  }

  /* ── Join flow ────────────────────────────────────────────────────────── */
  .join-body { display: flex; flex-direction: column; gap: 0.75rem; }

  .join-field { display: flex; flex-direction: column; gap: 0.3rem; }

  .join-input { width: 100%; box-sizing: border-box; }

  .join-mode { display: flex; align-items: center; gap: 0.75rem; }

  .radio-label {
    display: flex; align-items: center; gap: 0.3rem;
    font-size: var(--font-sm); color: var(--color-text-1); cursor: pointer;
  }

  /* ── Shared field styles ──────────────────────────────────────────────── */
  .field-label { font-size: var(--font-sm); color: var(--color-text-1); white-space: nowrap; }

  .field-input {
    flex: 1;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    font-size: var(--font-sm);
    font-family: monospace;
    background: var(--color-bg-0);
    color: var(--color-text-1);
  }
  .field-input:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
    border-color: transparent;
  }
</style>
