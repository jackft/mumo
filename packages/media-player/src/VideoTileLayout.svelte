<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import type { MultiMediaPlayer } from './MultiMediaPlayer.js'
  import type { MediaPlayer } from './MediaPlayer.js'
  import type { MediaState } from './types.js'
  import MediaPlayerView from './MediaPlayerView.svelte'

  let {
    multiPlayer,
    showVideoInfo   = false,
    showDecodeDebug = false,
    speed           = $bindable(1),
  }: { multiPlayer: MultiMediaPlayer; showVideoInfo?: boolean; showDecodeDebug?: boolean; speed?: number } = $props()

  let players = $state<readonly MediaPlayer[]>(untrack(() => multiPlayer.players))
  let playerStates = $state<Map<string, MediaState | null>>(untrack(() => new Map(multiPlayer.players.map(p => [p.id, p.state]))))
  let playing = $state(false)
  let volume = $state(1)
  let mixOpen   = $state(false)
  let focusedId = $state<string | null>(null)

  const unsubState   = new SvelteMap<string, () => void>()
  const unsubPlaying = new SvelteMap<string, () => void>()
  let unsubPlayers: (() => void) | null = null

  function subscribeToPlayer(p: MediaPlayer) {
    unsubState.get(p.id)?.()
    unsubPlaying.get(p.id)?.()
    playerStates = new SvelteMap(playerStates).set(p.id, p.state)
    unsubState.set(p.id, p.onStateUpdate(s => {
      playerStates = new SvelteMap(playerStates).set(p.id, s)
    }))
    if (p === multiPlayer.primary) {
      playing = !p.paused
      unsubPlaying.set(p.id, p.onPlayingUpdate(pl => { playing = pl }))
    }
  }

  function unsubscribePlayer(id: string) {
    unsubState.get(id)?.(); unsubState.delete(id)
    unsubPlaying.get(id)?.(); unsubPlaying.delete(id)
    playerStates = new Map([...playerStates].filter(([k]) => k !== id))
  }

  onMount(() => {
    for (const p of multiPlayer.players) subscribeToPlayer(p)
    unsubPlayers = multiPlayer.onPlayersChange(ps => {
      players = ps
      const ids = new Set(ps.map(p => p.id))
      for (const id of [...unsubState.keys()]) { if (!ids.has(id)) unsubscribePlayer(id) }
      for (const p of ps) { if (!unsubState.has(p.id)) subscribeToPlayer(p) }
      if (focusedId && !ids.has(focusedId)) focusedId = null
    })
  })

  onDestroy(() => {
    for (const unsub of unsubState.values()) unsub()
    for (const unsub of unsubPlaying.values()) unsub()
    unsubPlayers?.()
  })

  function setVolume(v: number) { volume = v; multiPlayer.setVolume(v) }
  function setSpeed(s: number)  { speed  = s; multiPlayer.setSpeed(s) }

  function snapVol(e: Event, playerId: string): void {
    const input = e.currentTarget as HTMLInputElement
    let v = parseFloat(input.value)
    if (Math.abs(v - 1) < 0.05) { v = 1; input.value = '1' }
    multiPlayer.setPlayerVolume(playerId, v)
  }

  function toggleChannel(playerId: string, state: MediaState, ch: number): void {
    const n = state.channelCount
    const current: number[] = state.activeChannel === 'mix'
      ? Array.from({ length: n }, (_, i) => i)
      : [...state.activeChannel]
    const idx = current.indexOf(ch)
    if (idx >= 0) current.splice(idx, 1)
    else current.push(ch)
    const next: readonly number[] | 'mix' = current.length === n
      ? 'mix'
      : current.sort((a, b) => a - b)
    multiPlayer.setPlayerActiveChannel(playerId, next)
  }

  function fmtDur(s: number): string {
    const h  = Math.floor(s / 3600)
    const m  = Math.floor((s % 3600) / 60)
    const ss = (s % 60).toFixed(3).padStart(6, '0')
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
  }

  function visiblePlayers(): readonly MediaPlayer[] {
    const videoPls = players.filter(p => playerStates.get(p.id)?.kind !== 'audio')
    if (focusedId) return videoPls.filter(p => p.id === focusedId)
    return videoPls
  }

  function gridCols(n: number): number {
    return n <= 1 ? 1 : Math.ceil(Math.sqrt(n))
  }

  function itemSpan(index: number, total: number, cols: number): number {
    const lastRowStart = Math.floor((total - 1) / cols) * cols
    if (index < lastRowStart) return 1
    const lastRowCount = total - lastRowStart
    if (lastRowCount === 1) return cols
    return 1
  }
</script>

{#if players.length > 0}
  {@const videoPlayers = players.filter(p => playerStates.get(p.id)?.kind !== 'audio')}
  {@const vp = visiblePlayers()}
  {@const cols = focusedId ? 1 : gridCols(vp.length)}
  <div class="vtl">
    <div class="vtl-tiles"
         class:vtl-grid={!focusedId && vp.length > 1}
         style:--cols={cols}>
      {#each vp as player, i (player.id)}
        <div class="vtl-cell" style:grid-column="span {itemSpan(i, vp.length, cols)}">
          <MediaPlayerView {player} {showVideoInfo} {showDecodeDebug} />
          {#if showVideoInfo}
            {@const vi = player.getVideoInfo()}
            {@const st = playerStates.get(player.id)}
            {#if vi && st}
              <div class="vtl-info-bar">
                <span>{vi.videoWidth}×{vi.videoHeight}</span>
                <span>{vi.framerate.toFixed(2)} fps</span>
                <span>{fmtDur(st.duration)}</span>
                <span>{st.sampleRate} Hz</span>
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>

    <div class="mpv-controls">
      <!-- Core transport (ELAN-style) -->
      <button class="mc-btn" title="Go to beginning" onclick={() => multiPlayer.seek(0)}>⏮</button>
      <button class="mc-btn" title="Step back 1 s (J)" onclick={() => multiPlayer.skip(-1)}>◀</button>
      <button class="mc-btn mc-play" title="Play / pause (Space)" onclick={() => multiPlayer.togglePlay()}>
        {playing ? '⏸' : '▶'}
      </button>
      <button class="mc-btn" title="Step forward 1 s (L)" onclick={() => multiPlayer.skip(1)}>▶</button>

      <div class="mc-sep"></div>

      <!-- Volume -->
      <div class="mc-vol-wrap">
        <button class="mc-btn" title="Volume">🔊</button>
        <div class="mc-popup mc-vol-popup">
          <input class="mc-vol-slider" type="range" min="0" max="1" step="0.05" aria-label="Volume"
            value={volume}
            oninput={(e) => setVolume(parseFloat((e.currentTarget as HTMLInputElement).value))}
          />
        </div>
      </div>

      <!-- Speed -->
      <select class="mc-speed" title="Playback speed (Ctrl+= faster · Ctrl+- slower)" value={speed}
        onchange={(e) => setSpeed(parseFloat((e.currentTarget as HTMLSelectElement).value))}>
        <option value={0.33}>0.33×</option>
        <option value={0.5}>0.5×</option>
        <option value={0.75}>0.75×</option>
        <option value={1}>1×</option>
        <option value={1.25}>1.25×</option>
        <option value={1.5}>1.5×</option>
        <option value={2}>2×</option>
        <option value={3}>3×</option>
        <option value={5}>5×</option>
      </select>

      <div class="mc-sep"></div>

      <!-- Unified mixer panel -->
      {#if players.length > 0}
        {@const someMuted = players.some(p => playerStates.get(p.id)?.muted === true)}
        <div class="mc-mix-wrap">
          <button class="mc-btn mc-mix-btn" title="Audio mix" onclick={() => mixOpen = !mixOpen}>
            Mix ▾
          </button>
          {#if mixOpen}
            <div class="mc-popup mc-mix-panel" role="menu" tabindex="0" onmouseleave={() => mixOpen = false}>
              <datalist id="mc-vol-snap"><option value="1"></option></datalist>
              <label class="mc-mix-row mc-mix-all">
                <input type="checkbox" checked={!someMuted}
                  onchange={() => multiPlayer.setAllMuted(!someMuted)} />
                <span>All</span>
              </label>
              {#each players as player, pi (player.id)}
                {@const state = playerStates.get(player.id)}
                {#if state}
                  {@const fname = state.filename?.replace(/\.[^.]+$/, '') ?? ''}
                  {@const vol = state.volume ?? 1}
                  <div class="mc-mix-sep"></div>
                  <label class="mc-mix-row mc-mix-file">
                    <input type="checkbox" checked={!state.muted}
                      onchange={() => multiPlayer.setPlayerMuted(player.id, !state.muted)} />
                    <span class="mc-mix-fname" title={fname}>{fname || `Track ${pi + 1}`}</span>
                  </label>
                  <div class="mc-mix-vol">
                    <input class="mc-mix-vol-slider" type="range" min="0" max="2" step="0.01"
                      list="mc-vol-snap" value={vol}
                      oninput={(e) => snapVol(e, player.id)} />
                    <span class="mc-mix-vol-pct">{Math.round(vol * 100)}%</span>
                  </div>
                  {#if state.channelCount > 1}
                    <div class="mc-mix-channels">
                      {#each Array.from({ length: state.channelCount }, (_, i) => i) as ch (ch)}
                        {@const checked = state.activeChannel === 'mix' || (state.activeChannel as number[]).includes(ch)}
                        <label class="mc-mix-ch">
                          <input type="checkbox" checked={checked}
                            onchange={() => toggleChannel(player.id, state, ch)} />
                          {ch === 0 ? 'L' : ch === 1 ? 'R' : `Ch${ch + 1}`}
                        </label>
                      {/each}
                    </div>
                  {/if}
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Focus/tile toggle (only when multiple video tiles) -->
      {#if videoPlayers.length > 1}
        <div class="mc-sep"></div>
        {#if focusedId}
          <button class="mc-btn" title="Show all videos tiled" onclick={() => focusedId = null}>⊞</button>
          {#each videoPlayers as player, i (player.id)}
            <button class="mc-btn" class:mc-active={focusedId === player.id}
              title="Focus: {playerStates.get(player.id)?.filename ?? ''}"
              onclick={() => focusedId = player.id}>
              V{i + 1}
            </button>
          {/each}
        {:else}
          {#each videoPlayers as player, i (player.id)}
            <button class="mc-btn"
              title="Focus on: {playerStates.get(player.id)?.filename ?? ''}"
              onclick={() => focusedId = player.id}>
              V{i + 1}
            </button>
          {/each}
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .vtl { display: flex; flex-direction: column; min-width: 0; flex: 1; min-height: 0; }
  .vtl-tiles { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .vtl-grid {
    display: grid;
    grid-template-columns: repeat(var(--cols, 2), 1fr);
    gap: 2px;
  }
  .vtl-cell { display: flex; flex-direction: column; min-height: 0; min-width: 0; flex: 1; }
  .mpv-controls {
    position: relative;
    display: flex; align-items: center; gap: 3px; flex-wrap: wrap;
    padding: 4px 6px;
    background: var(--color-bg-2, #f5f5f5);
    border-top: 1px solid var(--color-border, #ccc);
    color: var(--color-text-1, #222);
  }
  .mc-sep { width: 1px; height: 14px; background: var(--color-border, #ccc); margin: 0 2px; flex-shrink: 0; }
  .mc-btn {
    background: none;
    border: 1px solid var(--color-border, #ccc);
    border-radius: 3px;
    padding: 2px 6px; cursor: pointer; font-size: 12px;
    color: var(--color-text-1, #222); opacity: 0.8;
    white-space: nowrap;
  }
  .mc-btn:hover { opacity: 1; background: var(--color-bg-menu-hover, #ECF7FB); }
  .mc-active { opacity: 1; background: var(--color-bg-menu-hover, #ECF7FB); font-weight: 600; }
  .mc-play { min-width: 28px; }
  .mc-speed {
    font-size: 12px;
    background: var(--color-bg-2, #f5f5f5);
    border: 1px solid var(--color-border, #ccc);
    border-radius: 3px; padding: 2px 4px;
    color: var(--color-text-1, #222);
  }
  .mc-vol-wrap { position: relative; }
  .mc-popup {
    position: absolute; bottom: 100%; left: 0;
    background: var(--color-bg-1, #fafafa);
    border: 1px solid var(--color-border, #ccc);
    border-radius: 4px; z-index: 200;
    box-shadow: 0 -2px 8px rgba(0,0,0,0.15);
  }
  .mc-vol-popup { display: none; padding: 8px 6px 6px; align-items: center; justify-content: center; }
  .mc-vol-wrap:hover .mc-vol-popup { display: flex; }
  .mc-vol-slider {
    writing-mode: vertical-lr;
    direction: rtl;
    height: 80px;
    width: auto;
    cursor: grab;
  }
  /* Mixer panel */
  .mc-mix-wrap { position: relative; }
  .mc-mix-btn { min-width: 48px; }
  .mc-mix-panel { padding: 6px 10px 8px; min-width: 180px; max-width: 260px; }
  .mc-mix-sep { height: 1px; background: var(--color-border, #ccc); margin: 5px 0; }
  .mc-mix-row { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; color: var(--color-text-1, #222); }
  .mc-mix-row:hover { background: var(--color-bg-menu-hover, #ECF7FB); }
  .mc-mix-all { font-weight: 600; margin-bottom: 2px; }
  .mc-mix-file { font-weight: 500; }
  .mc-mix-fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }
  .mc-mix-vol { display: flex; align-items: center; gap: 6px; padding: 3px 0 1px 18px; }
  .mc-mix-vol-slider { flex: 1; accent-color: var(--color-primary, #5BBCD6); cursor: pointer; }
  .mc-mix-vol-pct { font-size: 10px; color: var(--color-text-3, #666); min-width: 32px; text-align: right; flex-shrink: 0; }
  .mc-mix-channels { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 3px 0 2px 18px; }
  .mc-mix-ch { display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; color: var(--color-text-1, #222); }

  .vtl-info-bar {
    display: flex; gap: 10px; flex-wrap: wrap;
    font-size: 10px; font-family: monospace;
    color: var(--color-text-2, #888);
    padding: 2px 6px;
    background: var(--color-surface, #f5f5f5);
    border-top: 1px solid var(--color-border, #e0e0e0);
    flex-shrink: 0;
  }
</style>
