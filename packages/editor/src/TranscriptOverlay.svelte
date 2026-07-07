<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { EditorView } from 'prosemirror-view'
  import type { OverlayPlugin, OverlayContext } from './overlay.js'

  const {
    getView,
    editorPane,
    plugins = [],
  }: {
    getView: () => EditorView | undefined
    editorPane: HTMLElement | null
    plugins?: OverlayPlugin[]
  } = $props()

  let svg: SVGSVGElement
  let svgHeight = $state(0)

  onMount(() => {
    const NS = 'http://www.w3.org/2000/svg'
    for (const plugin of plugins) {
      const g = document.createElementNS(NS, 'g') as SVGGElement
      // eslint-disable-next-line svelte/no-dom-manipulating -- overlay plugins own the SVG children; Svelte renders none
      svg.appendChild(g)
      const ctx: OverlayContext = {
        getView,
        getPane: () => editorPane,
        setSvgHeight: (h) => { svgHeight = h },
      }
      plugin.mount(g, ctx)
    }
  })

  onDestroy(() => {
    for (const p of plugins) p.destroy()
  })
</script>

<svg bind:this={svg} class="transcript-overlay" style="height:{svgHeight}px" aria-hidden="true">
</svg>

<style>
  .transcript-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    pointer-events: none;
    z-index: 3;
  }
</style>
