import type { Node } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import type { TokenStore } from '@mumo/core'

/** f0 samples for an utterance's time span, plus the y-scale to map Hz → band height. */
export type GetIntonation = (
  channel: number,
  t0: number,
  t1: number,
) => { samples: Array<[number, number]>; yMin: number; yMax: number } | null

export type GetTokenTime = (id: string) => { start: number; end: number } | undefined

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Height (px) of the contour band drawn above each visual text line. */
const BAND_H = 22
/** Gap (px) between the bottom of the band and the top of the text line. */
const BAND_GAP = 2

/** A word measured on screen: its time window and pixel extent (overlay-local coords). */
interface WordBox {
  t0: number
  t1: number
  left: number
  right: number
  top: number
  line: number
}

/**
 * Renders a pitch (f0) contour above the words of an utterance (Option 1 = "warp"): the contour is
 * time-warped so each word's melodic shape sits above that word. Owned by UtteranceNodeView and
 * only alive while `utterance.attrs.intonation` is true. Reads word times from the existing
 * token-timing store; no bespoke storage.
 */
export class ProsodyLayer {
  private overlay: HTMLDivElement
  private svg: SVGSVGElement

  constructor(
    private uttDom: HTMLElement,
    private contentDOM: HTMLElement,
    private view: EditorView,
    private getPos: () => number | undefined,
    private getNode: () => Node,
    private tokenStore: TokenStore | undefined,
    private getTokenTime: GetTokenTime | undefined,
    private getIntonation: GetIntonation | undefined,
    private getParticipantChannel: ((participant: string) => number | null) | undefined,
  ) {
    this.overlay = document.createElement('div')
    this.overlay.className = 'utt-intonation-overlay'
    this.overlay.contentEditable = 'false'
    this.svg = document.createElementNS(SVG_NS, 'svg')
    this.svg.setAttribute('class', 'utt-intonation-svg')
    this.overlay.appendChild(this.svg)
    this.uttDom.classList.add('utt--intonation')
    this.uttDom.appendChild(this.overlay)
  }

  /**
   * True if the mutation/event originated inside the overlay (so the NodeView can ignore it).
   * Must accept Node, not HTMLElement — the SVG contour elements are SVGElement, and missing them
   * here makes ProseMirror re-render the node on every draw → infinite loop.
   */
  contains(target: EventTarget | null): boolean {
    // globalThis.Node: the bare `Node` name is the (type-only) prosemirror-model import in this file.
    return target instanceof globalThis.Node && this.overlay.contains(target)
  }

  destroy(): void {
    this.overlay.remove()
    this.uttDom.classList.remove('utt--intonation')
  }

  /** Recompute and redraw the contour. Cheap enough to call on update/reflow. */
  draw(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild)

    const node = this.getNode()
    const uttStart = node.attrs.startTimeSeconds as number | null
    const uttEnd = node.attrs.endTimeSeconds as number | null
    if (uttStart == null || uttEnd == null || uttEnd <= uttStart) return

    // Resolve channel: per-block override, else the speaker's participant default, else 0.
    const override = node.attrs.intonationChannel as number | null
    const participant = (node.attrs.participant as string | null) ?? ''
    const channel = override ?? this.getParticipantChannel?.(participant) ?? 0
    const contour = this.getIntonation?.(channel, uttStart, uttEnd)
    if (!contour || contour.samples.length === 0) return

    const words = this._measureWords(node, uttStart, uttEnd)
    if (words.length === 0) return

    const uttRect = this.uttDom.getBoundingClientRect()
    this.svg.setAttribute('width', String(uttRect.width))
    this.svg.setAttribute('height', String(uttRect.height))
    this.svg.setAttribute('viewBox', `0 0 ${uttRect.width} ${uttRect.height}`)

    const { yMin, yMax } = contour
    const span = yMax - yMin || 1

    // Group words by visual line; draw one warped path per line so wrapping works.
    const lines = new Map<number, WordBox[]>()
    for (const w of words) {
      const arr = lines.get(w.line) ?? []
      arr.push(w)
      lines.set(w.line, arr)
    }

    for (const lineWords of lines.values()) {
      lineWords.sort((a, b) => a.left - b.left)
      const bandBottom = Math.min(...lineWords.map(w => w.top)) - BAND_GAP
      const bandTop = bandBottom - BAND_H
      const lineT0 = Math.min(...lineWords.map(w => w.t0))
      const lineT1 = Math.max(...lineWords.map(w => w.t1))

      let d = ''
      let penDown = false
      for (const [t, hz] of contour.samples) {
        if (t < lineT0 || t > lineT1 || Number.isNaN(hz)) { penDown = false; continue }
        const w = lineWords.find(w => t >= w.t0 && t <= w.t1)
        if (!w) { penDown = false; continue }  // in a gap between words
        const frac = w.t1 > w.t0 ? (t - w.t0) / (w.t1 - w.t0) : 0
        const x = w.left + frac * (w.right - w.left)
        const y = bandBottom - ((hz - yMin) / span) * BAND_H
        const yc = Math.max(bandTop, Math.min(bandBottom, y))
        d += `${penDown ? 'L' : 'M'}${x.toFixed(1)} ${yc.toFixed(1)}`
        penDown = true
      }
      if (!d) continue
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      path.setAttribute('class', 'utt-intonation-path')
      this.svg.appendChild(path)
    }
  }

  /** Measure each word token's time window + on-screen pixel box (overlay-local coords). */
  private _measureWords(node: Node, uttStart: number, uttEnd: number): WordBox[] {
    const pos = this.getPos()
    if (pos === undefined) return []
    const contentStart = pos + 1
    const uttId = node.attrs.id as string
    const tokens = this.tokenStore?.getUttTokens(uttId) ?? []
    const wordToks = tokens.filter(t => t.kind === 'word')
    if (wordToks.length === 0) return []

    const uttRect = this.uttDom.getBoundingClientRect()
    const n = wordToks.length
    const out: WordBox[] = []
    for (let i = 0; i < n; i++) {
      const tok = wordToks[i]!
      const time = this.getTokenTime?.(tok.id)
      // Fall back to an even spread across the utterance (symbolic-subdivision semantics).
      const t0 = time?.start ?? uttStart + ((uttEnd - uttStart) * i) / n
      const t1 = time?.end ?? uttStart + ((uttEnd - uttStart) * (i + 1)) / n

      const startPos = this._posForOffset(node, contentStart, tok.startOffset)
      const endPos = this._posForOffset(node, contentStart, tok.endOffset)
      let a: { left: number; right: number; top: number; bottom: number }
      let b: { left: number; right: number; top: number; bottom: number }
      try {
        a = this.view.coordsAtPos(startPos, 1)
        b = this.view.coordsAtPos(endPos, -1)
      } catch { continue }

      out.push({
        t0, t1,
        left: a.left - uttRect.left,
        right: b.right - uttRect.left,
        top: a.top - uttRect.top,
        line: Math.round(a.top),
      })
    }
    return out
  }

  /** Map a character offset within the utterance's text to a PM document position. */
  private _posForOffset(node: Node, contentStart: number, targetChar: number): number {
    let pos = contentStart
    let chars = 0
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child.isText) {
        const len = child.text?.length ?? 0
        if (chars + len >= targetChar) return pos + (targetChar - chars)
        chars += len
        pos += child.nodeSize
      } else {
        pos += child.nodeSize  // atom (overlap bracket / image / inline_ann): 0 chars
      }
    }
    return pos
  }
}
