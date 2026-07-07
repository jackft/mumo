<script lang="ts">
  import type { EAFDocument, EAFTier, TokenTierEntry } from '@mumo/serialization'
  import { buildTimeMap, validateTokenTierMatch, DEFAULT_TOKENIZATION } from '@mumo/serialization'
  import type { TokenizationOpts } from '@mumo/serialization'
  import type { TokenizeOpts } from '@mumo/core'
  import { untrack } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'

  const { eaf, projectConfig, onconfirm, onclose }: {
    eaf: EAFDocument
    projectConfig: TokenizeOpts
    onconfirm: (opts: {
      transcriptTierIds: Set<string>
      glossTierIds: Set<string>
      tokenTiers: TokenTierEntry[]
      updatedProjectConfig?: TokenizationOpts
    }) => void
    onclose: () => void
  } = $props()

  // Tiers — step 1

  type TierRole = 'utterance' | 'other'
  const topTiers = untrack(() => eaf.tiers.filter(t => !t.parentRef))

  function defaultRole(tier: EAFTier): TierRole {
    if (tier.id.startsWith('utterance:')) return 'utterance'
    return 'other'
  }

  let tierRoles = $state(new Map<string, TierRole>(topTiers.map(t => [t.id, defaultRole(t)])))

  function setRole(tierId: string, role: TierRole) {
    tierRoles = new SvelteMap(tierRoles).set(tierId, role)
  }

  const transcriptTierIds = $derived(new Set([...tierRoles.entries()].filter(([, r]) => r === 'utterance').map(([id]) => id)))

  // Token tiers — step 2

  const timeMap = $derived(buildTimeMap(eaf.timeSlots))

  let workingProjectConfig = $state<TokenizationOpts>(untrack(() => ({
    ...DEFAULT_TOKENIZATION,
    ...(projectConfig.punctuationChars !== undefined ? { punctuationChars: projectConfig.punctuationChars } : {}),
  })))

  let tokenizations = $state(new Map<string, TokenizationOpts>())

  function getTierTokenization(tierId: string): TokenizationOpts {
    return tokenizations.get(tierId) ?? { ...workingProjectConfig }
  }

  function setTierTokenization(tierId: string, patch: Partial<TokenizationOpts>) {
    tokenizations = new SvelteMap(tokenizations).set(tierId, { ...getTierTokenization(tierId), ...patch })
  }

  const tokenCandidates = $derived(
    eaf.tiers.filter(t => {
      if (transcriptTierIds.has(t.id)) return false
      if (t.annotations.some(a => a.kind === 'alignable')) return true
      if (t.parentRef && transcriptTierIds.has(t.parentRef)) {
        const lt = eaf.linguisticTypes.find(l => l.id === t.linguisticTypeRef)
        if (lt?.constraint === 'Symbolic_Subdivision') return true
      }
      return false
    })
  )

  let tokenLinks = $state(new Map<string, string>())

  const transcriptTierList = $derived(eaf.tiers.filter(t => transcriptTierIds.has(t.id)))

  const defaultTokenLinks = $derived(
    (() => {
      const links = new SvelteMap<string, string>()
      for (const tier of tokenCandidates) {
        if (tier.parentRef && transcriptTierIds.has(tier.parentRef)) {
          const lt = eaf.linguisticTypes.find(l => l.id === tier.linguisticTypeRef)
          if (lt?.constraint === 'Symbolic_Subdivision') {
            links.set(tier.id, tier.parentRef)
            continue
          }
        }
        for (const tt of transcriptTierList) {
          const { matched, total } = validateTokenTierMatch(tier, tt, timeMap, workingProjectConfig)
          if (total > 0 && matched === total) { links.set(tier.id, tt.id); break }
        }
      }
      return links
    })()
  )

  function getTokenLink(tierId: string): string {
    return tokenLinks.has(tierId) ? (tokenLinks.get(tierId) ?? '') : (defaultTokenLinks.get(tierId) ?? '')
  }

  function setTokenLink(tierId: string, transcriptTierId: string) {
    tokenLinks = new SvelteMap(tokenLinks).set(tierId, transcriptTierId)
  }

  type MatchStatus = 'match' | 'partial' | 'no-match'

  function matchInfo(tier: EAFTier, transcriptTierId: string, opts: TokenizationOpts): { status: MatchStatus; label: string } {
    const transcriptTier = eaf.tiers.find(t => t.id === transcriptTierId)
    if (!transcriptTier) return { status: 'no-match', label: '' }
    const { matched, total } = validateTokenTierMatch(tier, transcriptTier, timeMap, opts)
    if (total === 0) return { status: 'no-match', label: '0 tokens' }
    const ratio = matched / total
    const label = `${matched}/${total}`
    if (ratio >= 0.8) return { status: 'match', label }
    if (ratio >= 0.35) return { status: 'partial', label }
    return { status: 'no-match', label }
  }

  const effectiveTokenTiers = $derived(
    (() => {
      const entries: TokenTierEntry[] = []
      const allLinks = new Map([...defaultTokenLinks, ...tokenLinks])
      for (const [tierId, transcriptTierId] of allLinks) {
        if (!transcriptTierId) continue
        const tier = eaf.tiers.find(t => t.id === tierId)
        if (!tier) continue
        const tierOpts = getTierTokenization(tierId)
        const { status } = matchInfo(tier, transcriptTierId, tierOpts)
        if (status === 'match' || status === 'partial') {
          entries.push({ tierId, tokenization: tierOpts, transcriptTierId })
        }
      }
      return entries
    })()
  )

  const effectiveTokenTierIds = $derived(new Set(effectiveTokenTiers.map(e => e.tierId)))

  // Glosses — step 3

  const glossCandidates = $derived(
    eaf.tiers.filter(t => {
      if (!t.parentRef) return false
      if (effectiveTokenTierIds.has(t.id)) return false
      return transcriptTierIds.has(t.parentRef)
    })
  )

  let glossLinks = $state(new Map<string, string>())

  function getGlossLink(tierId: string): string {
    return glossLinks.get(tierId) ?? ''
  }

  function setGlossLink(tierId: string, parentId: string) {
    glossLinks = new SvelteMap(glossLinks).set(tierId, parentId)
  }

  const effectiveGlossTierIds = $derived(
    new Set(glossCandidates.filter(t => getGlossLink(t.id) !== '').map(t => t.id))
  )

  // Confirm

  function confirm() {
    const configChanged = workingProjectConfig.punctuationChars !== (projectConfig.punctuationChars ?? DEFAULT_TOKENIZATION.punctuationChars)
      || workingProjectConfig.stripPunctuation !== DEFAULT_TOKENIZATION.stripPunctuation
    onconfirm({
      transcriptTierIds,
      glossTierIds: effectiveGlossTierIds,
      tokenTiers: effectiveTokenTiers,
      ...(configChanged ? { updatedProjectConfig: workingProjectConfig } : {}),
    })
  }
</script>

<button class="dlg-backdrop" onclick={onclose} aria-label="Close dialog"></button>
<div class="dlg eaf-import-dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">

  <div class="dlg-header">
    <h3 id="dlg-title">Import EAF</h3>
    <button class="close-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>

  <div class="dlg-body">

    <!-- ── Section 1: Tier roles ──────────────────────────────────────────── -->
    <div class="section">
      <div class="section-head">
        <span class="section-title">Tier roles</span>
        <span class="section-desc">Assign each top-level tier a role. <em>Utterance</em> tiers become transcript blocks.</span>
      </div>
      {#if topTiers.length === 0}
        <p class="empty">No top-level tiers found.</p>
      {:else}
        <div class="tier-table">
          <div class="tier-table-head">
            <span class="col-name">Tier</span>
            <span class="col-count">Anns</span>
            <span class="col-role">Role</span>
          </div>
          {#each topTiers as tier (tier.id)}
            {@const role = tierRoles.get(tier.id) ?? 'other'}
            <div class="tier-table-row">
              <span class="col-name tier-name">{tier.id}</span>
              <span class="col-count tier-count">{tier.annotations.length}</span>
              <span class="col-role">
                <label class="radio-label"><input type="radio" name="role-{tier.id}" checked={role === 'utterance'} onchange={() => setRole(tier.id, 'utterance')} /> Utterance</label>
                <label class="radio-label"><input type="radio" name="role-{tier.id}" checked={role === 'other'}     onchange={() => setRole(tier.id, 'other')}     /> —</label>
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- ── Section 2: Token tiers ─────────────────────────────────────────── -->
    <div class="section">
      <div class="section-head">
        <span class="section-title">Token tiers</span>
        <span class="section-desc">Tiers with a 100% match are linked automatically. Per-tier overrides appear when a tier is linked.</span>
      </div>
      <div class="proj-tok-row">
        <span class="tok-label">Project default — punct chars:</span>
        <input
          class="punct-input-sm"
          type="text"
          value={workingProjectConfig.punctuationChars}
          oninput={(e) => { workingProjectConfig = { ...workingProjectConfig, punctuationChars: (e.target as HTMLInputElement).value }; tokenizations = new Map() }}
          placeholder="e.g. .,!?"
        />
        <label class="radio-label">
          <input type="checkbox" checked={workingProjectConfig.stripPunctuation} onchange={() => { workingProjectConfig = { ...workingProjectConfig, stripPunctuation: !workingProjectConfig.stripPunctuation }; tokenizations = new Map() }} />
          Strip
        </label>
      </div>
      {#if tokenCandidates.length === 0}
        <p class="empty">No eligible tiers (all classified as utterances).</p>
      {:else}
        <div class="tier-table tok-tier-table">
          <div class="tier-table-head">
            <span class="col-name">Tier</span>
            <span class="col-count">Anns</span>
            <span class="col-link">Token tier of</span>
            <span class="col-badge">Match</span>
          </div>
          {#each tokenCandidates as tier (tier.id)}
            {@const linkedId = getTokenLink(tier.id)}
            {@const tierTok = getTierTokenization(tier.id)}
            {@const info = linkedId ? matchInfo(tier, linkedId, tierTok) : null}
            <div class="tier-table-row">
              <span class="col-name tier-name">{tier.id}</span>
              <span class="col-count tier-count">{tier.annotations.length}</span>
              <span class="col-link">
                <select class="link-select" value={linkedId}
                  onchange={(e) => setTokenLink(tier.id, (e.target as HTMLSelectElement).value)}>
                  <option value="">— not a token tier —</option>
                  {#each transcriptTierList as tt (tt.id)}
                    <option value={tt.id}>{tt.id}</option>
                  {/each}
                </select>
              </span>
              <span class="col-badge">
                {#if info}<span class="match-badge match-{info.status}">{info.label}</span>{/if}
              </span>
            </div>
            {#if linkedId}
              <div class="tier-tok-controls">
                <span class="tok-sub-label">Split on</span>
                <label class="radio-label">
                  <input type="radio" name="splitMode-{tier.id}" checked={tierTok.splitMode === 'whitespace'} onchange={() => setTierTokenization(tier.id, { splitMode: 'whitespace' })} /> Whitespace
                </label>
                <label class="radio-label">
                  <input type="radio" name="splitMode-{tier.id}" checked={tierTok.splitMode === 'delimiter'} onchange={() => setTierTokenization(tier.id, { splitMode: 'delimiter' })} /> Delim:
                </label>
                <input class="small-input" type="text" value={tierTok.delimiter}
                  oninput={(e) => setTierTokenization(tier.id, { delimiter: (e.target as HTMLInputElement).value })}
                  disabled={tierTok.splitMode !== 'delimiter'} placeholder="|" maxlength="4" />
                <span class="tok-sub-label tok-sub-sep">Punct:</span>
                <input class="punct-input-sm" type="text" value={tierTok.punctuationChars}
                  oninput={(e) => setTierTokenization(tier.id, { punctuationChars: (e.target as HTMLInputElement).value })}
                  placeholder="e.g. .,;:!?" />
                {#if tierTok.punctuationChars}
                  <label class="radio-label">
                    <input type="checkbox" checked={tierTok.stripPunctuation} onchange={() => setTierTokenization(tier.id, { stripPunctuation: !tierTok.stripPunctuation })} /> Strip
                  </label>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>

    <!-- ── Section 3: Glosses ─────────────────────────────────────────────── -->
    <div class="section">
      <div class="section-head">
        <span class="section-title">Glosses</span>
        <span class="section-desc">Link child tiers to an utterance tier to import them as gloss / translation annotations.</span>
      </div>
      {#if glossCandidates.length === 0}
        <p class="empty">No child tiers of utterance tiers found.</p>
      {:else}
        <div class="tier-table">
          <div class="tier-table-head">
            <span class="col-name">Tier</span>
            <span class="col-count">Anns</span>
            <span class="col-link">Gloss of</span>
          </div>
          {#each glossCandidates as tier (tier.id)}
            {@const linked = getGlossLink(tier.id)}
            <div class="tier-table-row">
              <span class="col-name tier-name">{tier.id}</span>
              <span class="col-count tier-count">{tier.annotations.length}</span>
              <span class="col-link">
                <select class="link-select" value={linked}
                  onchange={(e) => setGlossLink(tier.id, (e.target as HTMLSelectElement).value)}>
                  <option value="">— not a gloss —</option>
                  {#each transcriptTierList as tt (tt.id)}
                    <option value={tt.id}>{tt.id}</option>
                  {/each}
                </select>
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

  </div><!-- /dlg-body -->

  <div class="dlg-footer">
    <button onclick={onclose}>Cancel</button>
    <button class="primary" onclick={confirm}>Import</button>
  </div>
</div>

<style>
  .eaf-import-dlg {
    width: min(90vw, 640px);
    max-height: 85vh;
    padding: 0;
    overflow: hidden;
  }

  .dlg-header {
    padding: 1.25rem 1.5rem 1rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .dlg-body {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
    flex: 1;
    min-height: 0;
  }

  .dlg-footer {
    padding: 0.75rem 1.5rem;
  }

  /* ── Sections ──────────────────────────────────────────────────────────── */
  .section {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--color-border);
  }
  .section:last-child { border-bottom: none; }

  .section-head { display: flex; flex-direction: column; gap: 0.2rem; }

  .section-title {
    font-size: var(--font-sm);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-3);
  }

  .section-desc {
    font-size: var(--font-sm);
    color: var(--color-text-muted);
    line-height: 1.4;
  }

  /* ── Project tokenizer row ─────────────────────────────────────────────── */
  .proj-tok-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding: 0.4rem 0.6rem;
    background: var(--color-bg-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--font-sm);
  }

  .tok-label { color: var(--color-text-3); font-weight: 500; flex-shrink: 0; }

  /* ── Tier table ────────────────────────────────────────────────────────── */
  .empty { color: #999; font-size: 0.85rem; margin: 0; }

  .tier-table {
    display: flex; flex-direction: column; gap: 0;
    border: 1px solid var(--color-border); border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .tier-table-head {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 4px 8px;
    background: var(--color-bg-2);
    font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; color: #888;
    position: sticky; top: 0;
  }
  .tier-table-row {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 4px 8px;
    font-size: 0.85rem;
    border-top: 1px solid var(--color-bg-3);
  }

  .col-name  { flex: 1; min-width: 0; }
  .col-count { width: 40px; flex-shrink: 0; text-align: right; }
  .col-role  { display: flex; gap: 0.5rem; flex-shrink: 0; }
  .col-link  { flex-shrink: 0; }
  .col-badge { width: 90px; flex-shrink: 0; }

  .tier-name  { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tier-count { color: #999; }

  .radio-label { display: flex; align-items: center; gap: 3px; cursor: pointer; white-space: nowrap; font-size: var(--font-sm); }
  .link-select { font-size: 0.82rem; border: 1px solid var(--color-border); border-radius: 3px; padding: 1px 4px; cursor: pointer; max-width: 200px; }

  .match-badge { font-size: 0.72rem; padding: 1px 6px; border-radius: 3px; white-space: nowrap; }
  .match-match    { background: #d4edda; color: #155724; }
  .match-partial  { background: #fff3cd; color: #856404; }
  .match-no-match { background: #f8d7da; color: #721c24; }

  /* ── Token tier sub-row ────────────────────────────────────────────────── */
  .tier-tok-controls {
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
    padding: 3px 8px 5px 20px;
    background: var(--color-bg-1);
    border-top: 1px solid var(--color-bg-3);
    font-size: 0.78rem;
  }
  .tok-sub-label { color: #666; font-weight: 500; flex-shrink: 0; }
  .tok-sub-sep   { margin-left: 0.5rem; }
  .small-input   { width: 48px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: 3px; font-size: 0.82rem; font-family: monospace; }
  .punct-input-sm { width: 120px; padding: 2px 6px; border: 1px solid var(--color-border); border-radius: 3px; font-size: 0.82rem; font-family: monospace; }
  .small-input:disabled { opacity: 0.4; }
</style>
