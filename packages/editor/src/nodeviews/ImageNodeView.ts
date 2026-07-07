import type { Node } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'

type Corner = 'nw' | 'ne' | 'sw' | 'se'

function cornerDelta(corner: Corner, dx: number, dy: number): number {
  switch (corner) {
    case 'se': return (dx + dy) / 2
    case 'sw': return (-dx + dy) / 2
    case 'ne': return (dx - dy) / 2
    case 'nw': return (-dx - dy) / 2
  }
}

export class ImageNodeView implements NodeView {
  dom: HTMLElement
  node: Node

  private _img: HTMLImageElement
  private _placeholder: HTMLElement
  private _getRegistry: () => Map<string, string>
  private _view: EditorView
  private _getPos: () => number | undefined
  private _onActivate: ((id: string, x: number, y: number) => void) | undefined
  private _onImageLoad: (() => void) | undefined

  constructor(
    node: Node,
    view: EditorView,
    getPos: () => number | undefined,
    getRegistry: () => Map<string, string>,
    onActivate?: (id: string, x: number, y: number) => void,
    onImageLoad?: () => void,
  ) {
    this.node = node
    this._getRegistry = getRegistry
    this._view = view
    this._getPos = getPos
    this._onActivate = onActivate
    this._onImageLoad = onImageLoad

    this.dom = document.createElement('span')
    this.dom.className = 'img-node'
    this.dom.contentEditable = 'false'
    this.dom.draggable = true
    this.dom.dataset.id = node.attrs.id as string

    this._img = document.createElement('img')
    this._img.className = 'img-node__img'
    this._img.draggable = false
    this._img.alt = node.attrs.label as string
    this._img.addEventListener('contextmenu', this._onContextMenu)
    this._img.addEventListener('load', this._onLoad)
    this.dom.appendChild(this._img)

    this._placeholder = document.createElement('span')
    this._placeholder.className = 'img-node__placeholder'
    this._placeholder.textContent = 'Right-click to add image'
    this._placeholder.addEventListener('contextmenu', this._onContextMenu)
    this.dom.appendChild(this._placeholder)

    for (const corner of ['nw', 'ne', 'sw', 'se'] as Corner[]) {
      const handle = document.createElement('span')
      handle.className = `img-node__handle img-node__handle--${corner}`
      handle.contentEditable = 'false'
      handle.draggable = false
      handle.addEventListener('dragstart', e => { e.preventDefault(); })
      handle.addEventListener('pointerdown', (e) => { this._onResizeStart(e, corner); })
      this.dom.appendChild(handle)
    }

    this._syncSrc(node)
    this._syncSize(node)
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.dom.dataset.id = node.attrs.id as string
    this._img.alt = node.attrs.label as string
    this._syncSrc(node)
    this._syncSize(node)
    return true
  }

  ignoreMutation(): boolean { return true }

  destroy(): void {
    this._img.removeEventListener('contextmenu', this._onContextMenu)
    this._img.removeEventListener('load', this._onLoad)
    this._placeholder.removeEventListener('contextmenu', this._onContextMenu)
  }

  private _syncSrc(node: Node): void {
    const url = this._getRegistry().get(node.attrs.id as string)
    this._img.src = url ?? ''
    this._img.style.display = url ? '' : 'none'
    this._placeholder.style.display = url ? 'none' : ''
  }

  private _syncSize(node: Node): void {
    this._img.style.width  = `${node.attrs.width as number}px`
    this._img.style.height = 'auto'
  }

  private _onLoad = (): void => {
    this._onImageLoad?.()
  }

  private _onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    this._onActivate?.(this.node.attrs.id as string, e.clientX, e.clientY)
  }

  private _onResizeStart(e: PointerEvent, corner: Corner): void {
    e.preventDefault()
    e.stopPropagation()

    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture(e.pointerId)

    const startX = e.clientX
    const startY = e.clientY
    const startW = this.node.attrs.width as number

    const onMove = (ev: PointerEvent): void => {
      const delta = cornerDelta(corner, ev.clientX - startX, ev.clientY - startY)
      this._img.style.width = `${Math.max(20, Math.round(startW + delta))}px`
    }

    const onUp = (ev: PointerEvent): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      const delta = cornerDelta(corner, ev.clientX - startX, ev.clientY - startY)
      const w = Math.max(20, Math.round(startW + delta))
      const pos = this._getPos()
      if (pos === undefined) return
      this._view.dispatch(
        this._view.state.tr
          .setNodeAttribute(pos, 'width', w)
          .setMeta('allowWhenReadonly', true)
      )
    }

    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }
}
