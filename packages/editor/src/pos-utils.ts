import type { Node } from 'prosemirror-model'

/**
 * Convert a character offset within a block's text content to an absolute
 * ProseMirror document position. Inline atom nodes (e.g. overlap_bracket)
 * occupy one PM position but contribute zero characters, so a naive
 * `blockStart + charOffset` is wrong whenever atoms precede the target.
 *
 * blockStart: the PM position of the first content node inside the block
 *             (i.e. `blockOffset + 1` from doc.forEach).
 */
export function charOffsetToDocPos(doc: Node, blockStart: number, charOffset: number): number {
  const block = doc.nodeAt(blockStart - 1)
  if (!block) return blockStart + charOffset
  let chars = 0
  let pmPos = blockStart
  for (let i = 0; i < block.childCount; i++) {
    const child = block.child(i)
    if (child.isText) {
      // suggestion_insert text is not part of the base content — advance the PM
      // position but do not count these characters toward the char offset.
      if (child.marks.some(m => m.type.name === 'suggestion_insert')) {
        pmPos += child.text!.length
        continue
      }
      const len = child.text!.length
      if (chars + len >= charOffset) return pmPos + (charOffset - chars)
      chars += len
      pmPos += len
    } else {
      pmPos += child.nodeSize
    }
  }
  return pmPos
}
