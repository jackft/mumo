<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { MultiMediaPlayer, FrameStat } from '@mumo/media-player'
  import * as d3 from 'd3'
  import type { Bin } from 'd3'

  const { multiPlayer, onClose }: { multiPlayer: MultiMediaPlayer; onClose: () => void } = $props()

  interface PlayerStats {
    id:          string
    filename:    string
    stats:       readonly FrameStat[]
    n:           number
    mean:        number
    p50:         number
    p95:         number
    max:         number
    starveCount: number
  }

  let playerStats = $state<PlayerStats[]>([])

  function computeStats(): void {
    playerStats = multiPlayer.players.map(player => {
      const stats    = player.getDecodeStats()
      const filename = player.state?.filename ?? player.id
      const n        = stats.length
      if (n === 0) return { id: player.id, filename, stats, n: 0, mean: 0, p50: 0, p95: 0, max: 0, starveCount: 0 }
      const times       = Array.from(stats).map(s => s.interFrameMs).filter(v => v > 0).sort((a, b) => a - b)
      const mean        = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0
      const p50         = times.length ? quantile(times, 0.50) : 0
      const p95         = times.length ? quantile(times, 0.95) : 0
      const max         = times.length ? times[times.length - 1]! : 0
      const starveCount = stats.filter(s => s.queueDepth === 0).length
      return { id: player.id, filename, stats, n, mean, p50, p95, max, starveCount }
    })
  }

  function quantile(sorted: number[], q: number): number {
    const pos = (sorted.length - 1) * q
    const lo  = Math.floor(pos)
    const hi  = Math.ceil(pos)
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
  }

  function clearAll(): void {
    for (const player of multiPlayer.players) player.clearDecodeStats()
    computeStats()
  }

  function downloadCsv(): void {
    const rows: string[] = ['player_id,filename,frame_num,t_sec,inter_frame_ms,queue_depth']
    for (const ps of playerStats) {
      for (const s of ps.stats) {
        rows.push(`${ps.id},${JSON.stringify(ps.filename)},${s.frameNum},${s.tSec.toFixed(4)},${s.interFrameMs.toFixed(2)},${s.queueDepth}`)
      }
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = 'decode_stats.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  function frameTimeColor(ms: number): string {
    if (ms < 20)  return '#4caf50'  // <20ms = >50fps, smooth
    if (ms < 34)  return '#4a9eff'  // <34ms = >30fps, acceptable
    if (ms < 67)  return '#ff9800'  // <67ms = >15fps, stuttering
    return '#f44336'                // >67ms = <15fps, bad freeze
  }

  // D3 actions

  function plotInterFrameHist(node: SVGSVGElement, stats: readonly FrameStat[]) {
    draw()
    function draw() {
      const svg = d3.select(node)
      svg.selectAll('*').remove()
      if (stats.length === 0) return

      const W  = node.clientWidth  || 320
      const H  = node.clientHeight || 150
      const m  = { top: 8, right: 10, bottom: 42, left: 42 }
      const iw = W - m.left - m.right
      const ih = H - m.top  - m.bottom

      const times = Array.from(stats).map(s => s.interFrameMs).filter(v => v > 0)
      const xMax  = Math.min(200, (d3.max(times) ?? 50) * 1.05)
      const x     = d3.scaleLinear().domain([0, xMax]).range([0, iw])
      const bins: Bin<number, number>[] = d3.bin().domain([0, xMax]).thresholds(60)(times)
      const y     = d3.scaleLinear().domain([0, d3.max(bins, (b: Bin<number,number>) => b.length)!]).nice().range([ih, 0])
      const g     = svg.append('g').attr('transform', `translate(${m.left},${m.top})`)

      g.selectAll('rect').data(bins).join('rect')
        .attr('x',      (b: Bin<number,number>) => x(b.x0!))
        .attr('y',      (b: Bin<number,number>) => y(b.length))
        .attr('width',  (b: Bin<number,number>) => Math.max(0, x(b.x1!) - x(b.x0!) - 0.5))
        .attr('height', (b: Bin<number,number>) => ih - y(b.length))
        .attr('fill',   (b: Bin<number,number>) => frameTimeColor((b.x0! + b.x1!) / 2))
        .attr('opacity', 0.85)

      // 33ms reference line (30fps threshold)
      g.append('line')
        .attr('x1', x(33)).attr('x2', x(33)).attr('y1', 0).attr('y2', ih)
        .attr('stroke', '#fff').attr('stroke-width', 1).attr('stroke-dasharray', '4 3').attr('opacity', 0.45)

      g.append('g').attr('transform', `translate(0,${ih})`)
        .call(d3.axisBottom(x).ticks(5).tickSize(3).tickFormat(v => `${v}ms`))
        .call((ax: d3.Selection<SVGGElement, unknown, null, undefined>) => ax.select('.domain').remove())
        .selectAll<Element, unknown>('text, line').attr('fill', '#aaa').attr('stroke', '#aaa')

      g.append('text').attr('x', iw / 2).attr('y', ih + 36)
        .attr('text-anchor', 'middle').attr('fill', '#777').attr('font-size', 10).attr('font-family', 'monospace')
        .text('inter-pattern wall time  (33ms = 30fps)')

      g.append('g')
        .call(d3.axisLeft(y).ticks(3).tickSize(3))
        .call((ax: d3.Selection<SVGGElement, unknown, null, undefined>) => ax.select('.domain').remove())
        .selectAll<Element, unknown>('text, line').attr('fill', '#aaa').attr('stroke', '#aaa')

      g.append('text').attr('transform', 'rotate(-90)').attr('x', -ih / 2).attr('y', -32)
        .attr('text-anchor', 'middle').attr('fill', '#777').attr('font-size', 10).attr('font-family', 'monospace')
        .text('patterns')
    }
    return { update(s: readonly FrameStat[]) { stats = s; draw() }, destroy() {} }
  }

  function plotInterFrameOverTime(node: SVGSVGElement, stats: readonly FrameStat[]) {
    draw()
    function draw() {
      const svg = d3.select(node)
      svg.selectAll('*').remove()
      if (stats.length === 0) return

      const W  = node.clientWidth  || 320
      const H  = node.clientHeight || 150
      const m  = { top: 8, right: 10, bottom: 42, left: 42 }
      const iw = W - m.left - m.right
      const ih = H - m.top  - m.bottom

      const xMax = d3.max(stats, s => s.tSec)! || 1
      const times = Array.from(stats).map(s => s.interFrameMs).filter(v => v > 0)
      const yMax  = Math.min(200, (d3.max(times) ?? 50) * 1.05)
      const x     = d3.scaleLinear().domain([0, xMax]).range([0, iw])
      const y     = d3.scaleLinear().domain([0, yMax]).range([ih, 0])
      const g     = svg.append('g').attr('transform', `translate(${m.left},${m.top})`)

      const pts = stats.length > 4000
        ? Array.from(stats).filter((_, i) => i % Math.ceil(stats.length / 4000) === 0)
        : Array.from(stats)

      g.selectAll('circle').data(pts).join('circle')
        .attr('cx', s => x(s.tSec))
        .attr('cy', s => y(Math.min(yMax, s.interFrameMs)))
        .attr('r', 1.5)
        .attr('fill', s => frameTimeColor(s.interFrameMs))
        .attr('opacity', 0.6)

      // 33ms reference line (30fps)
      g.append('line')
        .attr('x1', 0).attr('x2', iw).attr('y1', y(33)).attr('y2', y(33))
        .attr('stroke', '#fff').attr('stroke-width', 1).attr('stroke-dasharray', '4 3').attr('opacity', 0.45)

      g.append('g').attr('transform', `translate(0,${ih})`)
        .call(d3.axisBottom(x).ticks(5).tickSize(3).tickFormat(v => `${v}s`))
        .call((ax: d3.Selection<SVGGElement, unknown, null, undefined>) => ax.select('.domain').remove())
        .selectAll<Element, unknown>('text, line').attr('fill', '#aaa').attr('stroke', '#aaa')

      g.append('text').attr('x', iw / 2).attr('y', ih + 36)
        .attr('text-anchor', 'middle').attr('fill', '#777').attr('font-size', 10).attr('font-family', 'monospace')
        .text('video time (s)')

      g.append('g')
        .call(d3.axisLeft(y).ticks(3).tickSize(3).tickFormat(v => `${v}ms`))
        .call((ax: d3.Selection<SVGGElement, unknown, null, undefined>) => ax.select('.domain').remove())
        .selectAll<Element, unknown>('text, line').attr('fill', '#aaa').attr('stroke', '#aaa')

      g.append('text').attr('transform', 'rotate(-90)').attr('x', -ih / 2).attr('y', -32)
        .attr('text-anchor', 'middle').attr('fill', '#777').attr('font-size', 10).attr('font-family', 'monospace')
        .text('inter-pattern ms')
    }
    return { update(s: readonly FrameStat[]) { stats = s; draw() }, destroy() {} }
  }

  function plotQueueDepth(node: SVGSVGElement, stats: readonly FrameStat[]) {
    draw()
    function draw() {
      const svg = d3.select(node)
      svg.selectAll('*').remove()
      if (stats.length === 0) return

      const W  = node.clientWidth  || 320
      const H  = node.clientHeight || 150
      const m  = { top: 8, right: 10, bottom: 42, left: 42 }
      const iw = W - m.left - m.right
      const ih = H - m.top  - m.bottom

      const maxDepth = d3.max(stats, s => s.queueDepth) ?? 0
      const counts   = Array.from({ length: maxDepth + 1 }, (_, i) =>
        ({ depth: i, count: stats.filter(s => s.queueDepth === i).length })
      )

      const x  = d3.scaleBand().domain(counts.map(c => String(c.depth))).range([0, iw]).padding(0.2)
      const y  = d3.scaleLinear().domain([0, d3.max(counts, c => c.count)!]).nice().range([ih, 0])
      const g  = svg.append('g').attr('transform', `translate(${m.left},${m.top})`)

      g.selectAll('rect').data(counts).join('rect')
        .attr('x',      c => x(String(c.depth))!)
        .attr('y',      c => y(c.count))
        .attr('width',  x.bandwidth())
        .attr('height', c => ih - y(c.count))
        .attr('fill',   c => c.depth === 0 ? '#f44336' : '#4a9eff')
        .attr('opacity', 0.85)

      g.append('g').attr('transform', `translate(0,${ih})`)
        .call(d3.axisBottom(x).tickSize(3))
        .call((ax: d3.Selection<SVGGElement, unknown, null, undefined>) => ax.select('.domain').remove())
        .selectAll<Element, unknown>('text, line').attr('fill', '#aaa').attr('stroke', '#aaa')

      g.append('text').attr('x', iw / 2).attr('y', ih + 36)
        .attr('text-anchor', 'middle').attr('fill', '#777').attr('font-size', 10).attr('font-family', 'monospace')
        .text('queue depth  (0 = starved)')

      g.append('g')
        .call(d3.axisLeft(y).ticks(3).tickSize(3))
        .call((ax: d3.Selection<SVGGElement, unknown, null, undefined>) => ax.select('.domain').remove())
        .selectAll<Element, unknown>('text, line').attr('fill', '#aaa').attr('stroke', '#aaa')

      g.append('text').attr('transform', 'rotate(-90)').attr('x', -ih / 2).attr('y', -32)
        .attr('text-anchor', 'middle').attr('fill', '#777').attr('font-size', 10).attr('font-family', 'monospace')
        .text('patterns')
    }
    return { update(s: readonly FrameStat[]) { stats = s; draw() }, destroy() {} }
  }

  let _interval: ReturnType<typeof setInterval>
  onMount(() => { computeStats(); _interval = setInterval(computeStats, 500) })
  onDestroy(() => clearInterval(_interval))

  let trayH = $state(320)

  function startResize(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = trayH
    function onMove(ev: PointerEvent) { trayH = Math.max(120, Math.min(800, startH - (ev.clientY - startY))) }
    function onUp() { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp) }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }
</script>

<div class="debug-tray" style="height:{trayH}px">
  <div class="dt-resize-handle" onpointerdown={startResize} role="separator" aria-label="Resize tray"></div>

  <div class="dt-header">
    <span class="dt-title">Decode</span>
    <div class="dt-actions">
      <button onclick={computeStats}>Refresh</button>
      <button onclick={clearAll}>Clear</button>
      <button onclick={downloadCsv}>CSV</button>
      <button class="dt-close" onclick={onClose}>×</button>
    </div>
  </div>

  <div class="dt-body">
    {#if playerStats.length === 0}
      <p class="dt-empty">No players loaded.</p>
    {:else}
      {#each playerStats as ps (ps.id)}
        <div class="dt-player">
          <div class="dt-player-header">
            <span class="dt-filename">{ps.filename}</span>
            <span class="dt-kv">n={ps.n}</span>
            <span class="dt-kv">mean={ps.mean.toFixed(1)}ms</span>
            <span class="dt-kv">p50={ps.p50.toFixed(1)}ms</span>
            <span class="dt-kv">p95={ps.p95.toFixed(1)}ms</span>
            <span class="dt-kv">max={ps.max.toFixed(1)}ms</span>
            <span class="dt-kv dt-warn" class:dt-warn-active={ps.starveCount > 0}>starve={ps.starveCount}</span>
          </div>

          {#if ps.n === 0}
            <p class="dt-empty">No data — play some video first.</p>
          {:else}
            <div class="dt-plots">
              <svg class="dt-plot" use:plotInterFrameHist={ps.stats}></svg>
              <svg class="dt-plot" use:plotInterFrameOverTime={ps.stats}></svg>
              <svg class="dt-plot" use:plotQueueDepth={ps.stats}></svg>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .debug-tray {
    flex-shrink: 0;
    background: #1a1a1a;
    border-top: 2px solid #333;
    display: flex;
    flex-direction: column;
    font-family: monospace;
    font-size: 12px;
    color: #ccc;
  }

  .dt-resize-handle {
    height: 5px;
    flex-shrink: 0;
    cursor: ns-resize;
    background: transparent;
  }
  .dt-resize-handle:hover { background: #2196f3; }

  .dt-header {
    display: flex;
    align-items: stretch;
    background: #252525;
    border-bottom: 1px solid #333;
    flex-shrink: 0;
  }

  .dt-title {
    padding: 0 14px;
    color: #888;
    font-size: 11px;
    font-family: monospace;
    display: flex;
    align-items: center;
  }

  .dt-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    margin-left: auto;
  }

  .dt-actions button {
    background: #333;
    border: 1px solid #444;
    color: #ccc;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    font-family: monospace;
  }
  .dt-actions button:hover { background: #444; color: #fff; }

  .dt-close { font-size: 16px !important; padding: 0 8px !important; }

  .dt-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .dt-empty { color: #666; font-style: italic; }

  .dt-player { display: flex; flex-direction: column; gap: 6px; }

  .dt-player-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }

  .dt-filename {
    color: #eee;
    font-weight: bold;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dt-kv { color: #aaa; }
  .dt-warn { color: #aaa; }
  .dt-warn-active { color: #ff9800; }

  .dt-plots {
    display: flex;
    gap: 8px;
  }

  .dt-plot {
    flex: 1;
    min-width: 0;
    height: 150px;
    display: block;
  }
</style>
