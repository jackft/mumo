<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import type { MediaPlayer } from './MediaPlayer.js'
  import type { MediaState } from './types.js'
  import { FrameNumberPlugin } from './plugins/video/FrameNumberPlugin.js'
  import { DecodeDebugPlugin } from './plugins/video/DecodeDebugPlugin.js'

  const {
    player,
    showVideoInfo  = false,
    showDecodeDebug = false,
  }: { player: MediaPlayer; showVideoInfo?: boolean; showDecodeDebug?: boolean } = $props()

  let canvasEl: HTMLCanvasElement | undefined
  let state = $state<MediaState | null>(untrack(() => player.state))
  let unsubState: (() => void) | null = null

  onMount(() => {
    if (canvasEl) player.attachCanvas(canvasEl)
    // Getters close over reactive props — plugins read current value on every onFrame call
    player.addVideoPlugin(new FrameNumberPlugin(() => showVideoInfo))
    player.addVideoPlugin(new DecodeDebugPlugin(() => showDecodeDebug))
    unsubState = player.onStateUpdate(s => { state = s })
  })

  onDestroy(() => {
    player.detachCanvas()
    unsubState?.()
  })
</script>

<div class="mpv">
  {#if state}
    <div class="mpv-filename" title={state.filename}>{state.filename}</div>
  {/if}

  <!-- Flex-fill wrapper — gives canvas.parentElement defined clientWidth/clientHeight for _refit() -->
  <div class="mpv-wrap" class:mpv-wrap-hidden={state?.kind !== 'video'}>
    <canvas bind:this={canvasEl}></canvas>
  </div>
</div>

<style>
  .mpv { display: flex; flex-direction: column; min-width: 0; min-height: 0; flex: 1; }
  .mpv-filename {
    font-size: 11px; opacity: 0.7; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; padding: 2px 6px;
    flex-shrink: 0;
  }
  .mpv-wrap { flex: 1; min-height: 0; min-width: 0; overflow: hidden; display: flex; align-items: flex-start; }
  .mpv-wrap-hidden { display: none; }
  /* Canvas is sized by VideoRenderer._refit() via canvas.width/height — no CSS sizing here */
  .mpv-wrap canvas { display: block; }
</style>
