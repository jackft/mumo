<script lang="ts">
  import { onMount } from 'svelte'

  interface Props {
    frameBlob: Blob
    onConfirm: (blob: Blob) => void
    onCancel: () => void
  }

  const { frameBlob, onConfirm, onCancel }: Props = $props()

  let canvas: HTMLCanvasElement
  let bitmap: ImageBitmap | null = null

  // Selection in canvas pixels, always normalized (w,h >= 0)
  let sel = $state<{ x: number; y: number; w: number; h: number } | null>(null)

  type DragMode = 'new' | 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
  let dragMode: DragMode | null = null
  let dragStart = { sx: 0, sy: 0 }   // screen px relative to canvas
  let dragStartSel: typeof sel = null

  const HANDLE_HALF = 5   // canvas px
  const HIT_PX      = 10  // screen px hit threshold

  onMount(() => {
    void createImageBitmap(frameBlob).then(bm => {
      bitmap = bm
      canvas.width  = bm.width
      canvas.height = bm.height
      drawFrame()
    })
    return () => bitmap?.close()
  })

  function drawFrame() {
    if (!bitmap || !canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0)

    if (!sel || sel.w < 1 || sel.h < 1) return
    const { x, y, w, h } = sel

    // Dim outside selection
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.clearRect(x, y, w, h)
    ctx.drawImage(bitmap, x, y, w, h, x, y, w, h)
    ctx.restore()

    // Border
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)

    // Handles at corners + edge midpoints
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#555'
    ctx.lineWidth = 0.5
    for (const [hx, hy] of [
      [x,       y      ], [x + w/2, y      ], [x + w,   y      ],
      [x,       y + h/2],                      [x + w,   y + h/2],
      [x,       y + h  ], [x + w/2, y + h  ], [x + w,   y + h  ],
    ] as [number, number][]) {
      ctx.fillRect(hx - HANDLE_HALF, hy - HANDLE_HALF, HANDLE_HALF * 2, HANDLE_HALF * 2)
      ctx.strokeRect(hx - HANDLE_HALF + 0.5, hy - HANDLE_HALF + 0.5, HANDLE_HALF * 2 - 1, HANDLE_HALF * 2 - 1)
    }
  }

  // Content rect: excludes the CSS border so origin and scale are correct.
  function contentRect() {
    const r = canvas.getBoundingClientRect()
    return {
      left:   r.left + canvas.clientLeft,
      top:    r.top  + canvas.clientTop,
      width:  canvas.clientWidth,
      height: canvas.clientHeight,
    }
  }

  function canvasCoords(e: MouseEvent): { x: number; y: number } {
    const r = contentRect()
    return {
      x: Math.round((e.clientX - r.left) * (canvas.width  / r.width)),
      y: Math.round((e.clientY - r.top)  * (canvas.height / r.height)),
    }
  }

  // Hit test in screen coordinates (relative to canvas content top-left)
  function hitTest(screenX: number, screenY: number): DragMode {
    if (!sel || sel.w < 1 || sel.h < 1) return 'new'
    const r = contentRect()
    const sx = sel.x  * (r.width  / canvas.width)
    const sy = sel.y  * (r.height / canvas.height)
    const sw = sel.w  * (r.width  / canvas.width)
    const sh = sel.h  * (r.height / canvas.height)
    const x2 = sx + sw, y2 = sy + sh
    const d = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by)

    // Corners
    if (d(screenX, screenY, sx,        sy       ) <= HIT_PX) return 'nw'
    if (d(screenX, screenY, x2,        sy       ) <= HIT_PX) return 'ne'
    if (d(screenX, screenY, sx,        y2       ) <= HIT_PX) return 'sw'
    if (d(screenX, screenY, x2,        y2       ) <= HIT_PX) return 'se'
    // Edge midpoints
    if (d(screenX, screenY, sx + sw/2, sy       ) <= HIT_PX) return 'n'
    if (d(screenX, screenY, sx + sw/2, y2       ) <= HIT_PX) return 's'
    if (d(screenX, screenY, sx,        sy + sh/2) <= HIT_PX) return 'w'
    if (d(screenX, screenY, x2,        sy + sh/2) <= HIT_PX) return 'e'
    // Edge lines
    if (Math.abs(screenY - sy) <= HIT_PX/2 && screenX >= sx && screenX <= x2) return 'n'
    if (Math.abs(screenY - y2) <= HIT_PX/2 && screenX >= sx && screenX <= x2) return 's'
    if (Math.abs(screenX - sx) <= HIT_PX/2 && screenY >= sy && screenY <= y2) return 'w'
    if (Math.abs(screenX - x2) <= HIT_PX/2 && screenY >= sy && screenY <= y2) return 'e'
    // Interior
    if (screenX >= sx && screenX <= x2 && screenY >= sy && screenY <= y2) return 'move'
    return 'new'
  }

  function applyDrag(screenX: number, screenY: number): void {
    if (!dragMode) return
    const r = contentRect()
    const scaleX = canvas.width  / r.width
    const scaleY = canvas.height / r.height
    const dxC = (screenX - dragStart.sx) * scaleX
    const dyC = (screenY - dragStart.sy) * scaleY
    const s = dragStartSel!
    const W = canvas.width, H = canvas.height
    const cl = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

    if (dragMode === 'new') {
      // screenX/Y are canvas-relative screen coords; convert to canvas pixels
      const startCX = cl(dragStart.sx * scaleX, 0, W)
      const startCY = cl(dragStart.sy * scaleY, 0, H)
      const endCX   = cl(screenX      * scaleX, 0, W)
      const endCY   = cl(screenY      * scaleY, 0, H)
      const x = Math.min(startCX, endCX)
      const y = Math.min(startCY, endCY)
      sel = { x, y, w: Math.abs(endCX - startCX), h: Math.abs(endCY - startCY) }
    } else if (dragMode === 'move') {
      sel = {
        x: cl(s.x + dxC, 0, W - s.w),
        y: cl(s.y + dyC, 0, H - s.h),
        w: s.w, h: s.h,
      }
    } else {
      let x1 = s.x, y1 = s.y, x2 = s.x + s.w, y2 = s.y + s.h
      if (dragMode === 'n'  || dragMode === 'nw' || dragMode === 'ne') y1 = cl(s.y + dyC, 0, y2 - 1)
      if (dragMode === 's'  || dragMode === 'sw' || dragMode === 'se') y2 = cl(s.y + s.h + dyC, y1 + 1, H)
      if (dragMode === 'w'  || dragMode === 'nw' || dragMode === 'sw') x1 = cl(s.x + dxC, 0, x2 - 1)
      if (dragMode === 'e'  || dragMode === 'ne' || dragMode === 'se') x2 = cl(s.x + s.w + dxC, x1 + 1, W)
      sel = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    }
  }

  const CURSOR_MAP: Record<DragMode, string> = {
    new: 'crosshair', move: 'move',
    n: 'n-resize', s: 's-resize', e: 'e-resize', w: 'w-resize',
    nw: 'nw-resize', ne: 'ne-resize', sw: 'sw-resize', se: 'se-resize',
  }

  function onMousedown(e: MouseEvent) {
    const r = contentRect()
    const sx = e.clientX - r.left
    const sy = e.clientY - r.top
    dragMode = hitTest(sx, sy)
    dragStart = { sx, sy }
    dragStartSel = sel ? { ...sel } : null
    if (dragMode === 'new') {
      const cc = canvasCoords(e)
      sel = { x: cc.x, y: cc.y, w: 0, h: 0 }
      dragStart = { sx, sy }
      dragStartSel = { x: cc.x, y: cc.y, w: 0, h: 0 }
    }
  }

  function onMousemove(e: MouseEvent) {
    const r = contentRect()
    const sx = e.clientX - r.left
    const sy = e.clientY - r.top
    if (!dragMode) {
      canvas.style.cursor = CURSOR_MAP[hitTest(sx, sy)] ?? 'crosshair'
      return
    }
    applyDrag(sx, sy)
    drawFrame()
  }

  function onMouseup(e: MouseEvent) {
    if (dragMode) {
      const r = contentRect()
      applyDrag(e.clientX - r.left, e.clientY - r.top)
      drawFrame()
    }
    dragMode = null
  }

  async function confirm() {
    const out = document.createElement('canvas')
    if (sel && sel.w > 1 && sel.h > 1) {
      const { x, y, w, h } = sel
      out.width  = w
      out.height = h
      out.getContext('2d')!.drawImage(bitmap!, x, y, w, h, 0, 0, w, h)
    } else {
      out.width  = canvas.width
      out.height = canvas.height
      out.getContext('2d')!.drawImage(bitmap!, 0, 0)
    }
    out.toBlob(blob => { if (blob) onConfirm(blob) }, 'image/png')
  }
</script>

<button class="crop-backdrop" onclick={onCancel} aria-label="Cancel crop"></button>
<div class="crop-dlg" role="dialog" aria-modal="true" aria-label="Crop image" tabindex="-1"
  onclick={e => e.stopPropagation()}
  onkeydown={e => e.stopPropagation()}>
    <p class="crop-hint">Drag to select · drag edges/corners to resize · Confirm uses full frame if no selection.</p>
    <canvas
      bind:this={canvas}
      class="crop-canvas"
      onmousedown={onMousedown}
      onmousemove={onMousemove}
      onmouseup={onMouseup}
      onmouseleave={onMouseup}
    ></canvas>
    <div class="crop-actions">
      <button class="crop-btn crop-btn--cancel" onclick={onCancel}>Cancel</button>
      <button class="crop-btn crop-btn--confirm" onclick={confirm}>Confirm</button>
    </div>
</div>

<style>
  .crop-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    z-index: 1000;
    border: none;
    padding: 0;
    cursor: default;
  }
  .crop-dlg {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: #1e1e1e;
    border-radius: 6px;
    padding: 16px;
    max-width: 90vw;
    max-height: 90vh;
    position: fixed;
    z-index: 1001;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
  .crop-hint {
    margin: 0;
    font-size: 0.8em;
    color: #aaa;
  }
  .crop-canvas {
    max-width: 80vw;
    max-height: 70vh;
    display: block;
    align-self: center;
    border: 1px solid #444;
    cursor: crosshair;
  }
  .crop-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .crop-btn {
    padding: 4px 14px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    font-size: 0.85em;
  }
  .crop-btn--cancel  { background: #333; color: #ccc; }
  .crop-btn--confirm { background: #2563eb; color: #fff; }
</style>
