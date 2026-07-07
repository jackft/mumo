<script lang="ts">
  const { roomId, inviteUrl, onclose }: {
    roomId:    string
    inviteUrl: string
    onclose:   () => void
  } = $props()

  const roomToken = $derived.by(() => {
    const url = new URL(inviteUrl)
    const signal = url.searchParams.get('signal')
    const server = url.searchParams.get('server')
    if (signal) return `${roomId}?signal=${signal}`
    if (server) return `${roomId}?server=${server}`
    return roomId
  })

  let copiedLink  = $state(false)
  let copiedToken = $state(false)

  function copyLink() {
    void navigator.clipboard.writeText(inviteUrl)
    copiedLink = true
    setTimeout(() => { copiedLink = false }, 1500)
  }

  function copyToken() {
    void navigator.clipboard.writeText(roomToken)
    copiedToken = true
    setTimeout(() => { copiedToken = false }, 1500)
  }
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="invite-dlg-title">
  <div class="dlg-header">
    <h3 id="invite-dlg-title">Invite collaborators</h3>
    <button class="close-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>

  <p class="dlg-hint">Share this link — anyone with it can join the session.</p>

  <div class="link-row">
    <input class="link-input" type="text" readonly value={inviteUrl} spellcheck={false}
      onclick={(e) => (e.currentTarget as HTMLInputElement).select()} />
    <button class="copy-link-btn" class:copied={copiedLink} onclick={copyLink}>
      {copiedLink ? '✓ Copied' : 'Copy link'}
    </button>
  </div>

  <details class="token-details">
    <summary>Room token only</summary>
    <div class="token-row">
      <input class="token-input" type="text" readonly value={roomToken} spellcheck={false}
        onclick={(e) => (e.currentTarget as HTMLInputElement).select()} />
      <button class="copy-token-btn" class:copied={copiedToken} onclick={copyToken}>
        {copiedToken ? '✓' : 'Copy'}
      </button>
    </div>
  </details>

  <div class="dlg-actions">
    <button onclick={onclose}>Close</button>
  </div>
</div>

<style>
  .dlg { width: 480px; }

  .link-row {
    display: flex; align-items: stretch; gap: 0;
    border: 1px solid var(--color-primary-border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .link-input {
    flex: 1;
    padding: 0.4rem 0.6rem;
    border: none;
    font-size: var(--font-sm);
    font-family: monospace;
    background: var(--color-primary-light);
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    cursor: text;
  }

  .copy-link-btn {
    padding: 0.4rem 0.9rem;
    font-size: var(--font-sm);
    font-weight: 600;
    border: none;
    border-left: 1px solid var(--color-primary-border);
    border-radius: 0;
    background: var(--color-primary);
    color: #fff;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.1s;
    min-width: 5.5rem;
  }
  .copy-link-btn:hover  { background: var(--color-primary-hover); }
  .copy-link-btn.copied { background: var(--color-active); }

  .token-details {
    font-size: var(--font-xs);
    color: var(--color-text-muted);
  }
  .token-details summary {
    cursor: pointer;
    user-select: none;
    padding: 0.1rem 0;
    list-style: none;
  }
  .token-details summary::-webkit-details-marker { display: none; }
  .token-details summary::before { content: '▸ '; font-size: 0.65rem; }
  .token-details[open] summary::before { content: '▾ '; }

  .token-row {
    display: flex; align-items: center; gap: 0.4rem;
    margin-top: 0.35rem;
  }

  .token-input {
    flex: 1;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    font-size: var(--font-xs);
    font-family: monospace;
    background: var(--color-bg-1);
    color: var(--color-text-1);
    min-width: 0;
    cursor: text;
  }

  .copy-token-btn {
    padding: 0.2rem 0.5rem;
    font-size: var(--font-xs);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: var(--color-bg-1);
    color: var(--color-text-1);
    cursor: pointer;
    white-space: nowrap;
    min-width: 2.8rem;
  }
  .copy-token-btn:hover  { background: var(--color-bg-2); }
  .copy-token-btn.copied { background: var(--color-active); color: #fff; border-color: var(--color-active); }
</style>
