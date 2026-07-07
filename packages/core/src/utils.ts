import type { AnnotationStore, Pattern, PatternSchema } from './store.js'
import type { TokenStore } from './token-store.js'
import type { ID } from './types.js'

type PMNodeMark = {
  type: { name: string }
  attrs: Record<string, unknown>
}

/** Minimal structural interface for a ProseMirror document node. */
export type PMNode = {
  isText: boolean
  text: string | undefined
  textContent: string
  type?: { name: string }
  nodeSize?: number
  marks?: readonly PMNodeMark[]
  attrs: Record<string, unknown>
  descendants?: (fn: (node: PMNode, pos: number) => boolean | undefined) => void
  forEach(fn: (node: PMNode, offset: number) => void): void
}

/** Text content of a block node, excluding suggestion_insert runs. */
export function baseTextContent(node: PMNode): string {
  let text = ''
  node.forEach(child => {
    if (child.isText && !child.marks?.some(m => m.type.name === 'suggestion_insert')) {
      text += child.text ?? ''
    }
  })
  return text
}

export function patternLabel(pattern: Pattern, patterns: Pattern[], patternSchemas: PatternSchema[]): string {
  const s = patternSchemas.find(x => x.id === pattern.schemaId)
  if (!s) return pattern.id.slice(0, 8)
  const sameSchema = patterns.filter(f => f.schemaId === pattern.schemaId)
  const idx = sameSchema.indexOf(pattern) + 1
  return sameSchema.length > 1 ? `${s.name} ${idx}` : s.name
}

function blockTag(block: PMNode): string {
  const label = block.attrs['participant'] as string | undefined
  return label ? `[${label}]` : ''
}

export function getWordRangeText(doc: PMNode, fromWordId: ID, toWordId: ID, tokenStore?: TokenStore): string {
  if (tokenStore) {
    const fromTok = tokenStore.getToken(fromWordId)
    const toTok   = tokenStore.getToken(toWordId)
    if (!fromTok || !toTok || fromTok.uttId !== toTok.uttId) return '—'
    let text = ''
    let tag = ''
    doc.forEach(block => {
      if (block.attrs['id'] !== fromTok.uttId) return
      tag  = blockTag(block)
      text = baseTextContent(block).slice(fromTok.startOffset, toTok.endOffset).trim()
    })
    if (!text) return '—'
    return tag ? `${tag} "${text}"` : `"${text}"`
  }
  return '—'
}

export function getMarkText(doc: PMNode, markId: ID): string {
  const parts: string[] = []
  let tag = ''
  doc.forEach(block => {
    const before = parts.length
    block.descendants?.(node => {
      if (!node.isText) return true
      if (node.marks?.some(m => m.type.name === 'suggestion_insert')) return true
      if (node.marks?.some(m => m.type.name === 'annotation' && m.attrs['id'] === markId)) {
        parts.push(node.text ?? '')
      }
      return true
    })
    if (parts.length > before) tag = blockTag(block)
  })
  const text = parts.join('').trim()
  if (!text) return '—'
  return tag ? `${tag} "${text}"` : `"${text}"`
}

export function getTokenText(tokenId: ID, tokenStore: TokenStore, doc: PMNode, features?: Record<string, unknown>): string {
  let tok = tokenStore.getToken(tokenId)
  if (!tok) {
    const uttId = features?.['uttId'] as ID | undefined
    const startOffset = features?.['startOffset'] as number | undefined
    if (uttId !== undefined && startOffset !== undefined) {
      tok = tokenStore.getUttTokens(uttId).find(t => t.startOffset === startOffset)
    }
  }
  if (!tok) return '—'
  let speaker = ''
  doc.forEach(block => {
    if (block.attrs['id'] === tok.uttId) speaker = (block.attrs['participant'] as string | undefined) ?? ''
  })
  const tag = speaker ? `[${speaker}]` : ''
  return `${tag ? tag + ' ' : ''}"${tok.text}"`
}

export function getUttLabel(doc: PMNode, uttId: ID): string {
  let label = ''
  doc.forEach(node => {
    if (node.attrs['id'] !== uttId) return
    const speaker = (node.attrs['participant'] as string | undefined) ?? '?'
    let text = ''
    node.forEach(inline => {
      if (inline.isText && !inline.marks?.some(m => m.type.name === 'suggestion_insert')) {
        text += inline.text ?? ''
      }
    })
    const preview = text.trim().slice(0, 40)
    label = `[${speaker}] ${preview}${text.trim().length > 40 ? '…' : ''}`
  })
  return label || '—'
}

function frameBlockIndices(pattern: Pattern, doc: PMNode, store: AnnotationStore, tokenStore?: TokenStore): number[] {
  const blocks: PMNode[] = []
  doc.forEach(b => blocks.push(b))

  const blockIdxOf = (uttId: ID): number => blocks.findIndex(b => b.attrs['id'] === uttId)

  const indices: number[] = []
  for (const slot of pattern.slots) {
    const ann = store.getAnnotation(slot.annotationId)
    if (!ann) continue
    const uttId = ann.features['utteranceId']
    if (uttId) { const i = blockIdxOf(uttId); if (i >= 0) indices.push(i) }
    const tokenId = ann.features['tokenId'] as ID | undefined
    if (tokenId) {
      const tok = tokenStore?.getToken(tokenId)
      if (tok) { const i = blockIdxOf(tok.uttId); if (i >= 0) indices.push(i) }
    }
    const markAnchor = ann.anchors.find(a => a.type === 'mark')
    if (markAnchor) {
      blocks.forEach((block, bi) => {
        block.descendants?.(node => {
          if (node.marks?.some(m => m.type.name === 'annotation' && m.attrs['id'] === markAnchor.markId))
            indices.push(bi)
          return true
        })
      })
    }
  }
  return indices
}

export function patternDocPos(pattern: Pattern, doc: PMNode, store: AnnotationStore, tokenStore?: TokenStore): number {
  const blocks: PMNode[] = []
  const offsets: number[] = []
  doc.forEach((b, off) => { blocks.push(b); offsets.push(off) })
  const indices = frameBlockIndices(pattern, doc, store, tokenStore)
  if (!indices.length) return Number.MAX_SAFE_INTEGER
  const minIdx = Math.min(...indices)
  return offsets[minIdx] ?? Number.MAX_SAFE_INTEGER
}

export function patternLineNums(
  pattern: Pattern,
  doc: PMNode,
  store: AnnotationStore,
  tokenStore?: TokenStore,
): { first: number; last: number } | null {
  const indices = frameBlockIndices(pattern, doc, store, tokenStore)
  if (!indices.length) return null
  return { first: Math.min(...indices) + 1, last: Math.max(...indices) + 1 }
}

export function sortPatternsByDocPos(
  ids: ID[],
  patterns: Pattern[],
  doc: PMNode,
  store: AnnotationStore,
): ID[] {
  const frameMap = new Map(patterns.map(f => [f.id, f]))
  return [...ids].sort((a, b) => {
    const fa = frameMap.get(a)
    const fb = frameMap.get(b)
    if (!fa) return 1
    if (!fb) return -1
    return patternDocPos(fa, doc, store) - patternDocPos(fb, doc, store)
  })
}
