import type { EditorView } from 'prosemirror-view'

export interface OverlayContext {
  getView(): EditorView | undefined
  getPane(): HTMLElement | null
  setSvgHeight(h: number): void
}

export interface OverlayPlugin {
  mount(group: SVGGElement, ctx: OverlayContext): void
  destroy(): void
}
