/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Schema } from 'prosemirror-model'
import type { NodeSpec, MarkSpec } from 'prosemirror-model'

const utteranceNode: NodeSpec = {
  group: 'block',
  content: 'text*',
  defining: true,
  attrs: {
    id: { default: null },
    tier: { default: '' },
    participant: { default: '' },
    startTimeSeconds: { default: null },
    endTimeSeconds: { default: null },
  },
  toDOM(node) {
    return ['p', {
      class: 'utt',
      'data-id': node.attrs.id,
      'data-tier': node.attrs.tier,
      'data-participant': node.attrs.participant,
    }, 0]
  },
  parseDOM: [{
    tag: 'p.utt',
    getAttrs(dom) {
      const el = dom
      return {
        id: el.getAttribute('data-id'),
        tier: el.getAttribute('data-tier') ?? '',
        participant: el.getAttribute('data-participant') ?? '',
      }
    },
  }],
}


const overlapBracketNode: NodeSpec = {
  inline: true,
  atom: true,
  selectable: true,
  group: 'inline',
  attrs: {
    id: {},
    kind: {},
  },
  toDOM(node) {
    const style = node.attrs.kind === 'end'
      ? `display:inline-block;width:0;overflow:hidden;margin-right:0.5em`
      : `display:inline-block;width:0.25em;overflow:hidden`
    return ['span', {
      class: `overlap-bracket overlap-bracket--${node.attrs.kind}`,
      'data-overlap-id': node.attrs.id,
      'data-overlap-kind': node.attrs.kind,
      contenteditable: 'false',
      style,
    }]
  },
  parseDOM: [{
    tag: 'span.overlap-bracket',
    getAttrs(dom) {
      const el = dom
      return {
        id: el.getAttribute('data-overlap-id') ?? '',
        kind: el.getAttribute('data-overlap-kind') ?? 'start',
      }
    },
  }],
}

export type ImageProvenance =
  | { kind: 'screenshot'; mediaPath: string; mediaTimeMs: number }
  | { kind: 'upload'; filename: string }
  | { kind: 'spectrogram-clip'; startSeconds: number; endSeconds: number }

const imageNode: NodeSpec = {
  inline: true,
  atom: true,
  selectable: true,
  group: 'inline',
  attrs: {
    id: {},
    label: { default: '' },
    provenance: { default: null },
    width: { default: 150 },
  },
  toDOM(node) {
    return ['span', {
      class: 'img-node',
      'data-id': node.attrs.id,
      'data-label': node.attrs.label,
      'data-provenance': node.attrs.provenance ? JSON.stringify(node.attrs.provenance) : '',
      'data-width': String(node.attrs.width as number),
      contenteditable: 'false',
    }]
  },
  parseDOM: [{
    tag: 'span.img-node',
    getAttrs(dom) {
      const el = dom
      const prov = el.getAttribute('data-provenance')
      return {
        id: el.getAttribute('data-id') ?? '',
        label: el.getAttribute('data-label') ?? '',
        provenance: prov ? JSON.parse(prov) as ImageProvenance : null,
        width: Number(el.getAttribute('data-width')) || 150,
      }
    },
  }],
}

/**
 * A visualization block. Has inline content (images, overlap brackets, inline
 * annotations, text) so images can be aligned with overlap brackets. Can be
 * independent (its own time range) or tied to a participant lane.
 */
const visualizationNode: NodeSpec = {
  group: 'block',
  content: '(text | overlap_bracket | image | inline_ann)*',
  defining: true,
  attrs: {
    id: { default: null },
    type: { default: 'screenshot' },  // user-defined type label
    label: { default: '' },
    startTimeSeconds: { default: null },
    endTimeSeconds: { default: null },
    participant: { default: '' },     // ties to participant column
    tier: { default: '' },            // participant timeline
    dependent: { default: false },    // if true, times follow parentNodeId
    parentNodeId: { default: null },  // id of the utterance this viz tracks
  },
  toDOM(node) {
    return ['div', {
      class: 'viz-block',
      'data-id': node.attrs.id,
      'data-viz-type': node.attrs.type,
      'data-label': node.attrs.label,
      'data-participant': node.attrs.participant,
      'data-tier': node.attrs.tier,
      'data-dependent': node.attrs.dependent ? 'true' : 'false',
      'data-parent-node-id': node.attrs.parentNodeId ?? '',
    }, 0]
  },
  parseDOM: [{
    tag: 'div.viz-block',
    getAttrs(dom) {
      const el = dom
      return {
        id: el.getAttribute('data-id'),
        type: el.getAttribute('data-viz-type') ?? 'screenshot',
        label: el.getAttribute('data-label') ?? '',
        participant: el.getAttribute('data-participant') ?? '',
        tier: el.getAttribute('data-tier') ?? '',
        dependent: el.getAttribute('data-dependent') === 'true',
        parentNodeId: el.getAttribute('data-parent-node-id') || null,
      }
    },
  }],
}

/**
 * Inline annotation: an atomic inline node with a user-defined value and an
 * optional reference to a visualization block (e.g. for attaching an image
 * at a specific point in an utterance).
 */
const inlineAnnNode: NodeSpec = {
  inline: true,
  atom: true,
  selectable: false,
  group: 'inline',
  attrs: {
    id: {},
    value: { default: '' },
    vizId: { default: null },  // optional ref to a visualization block ID
  },
  toDOM(node) {
    return ['span', {
      class: 'inline-ann',
      'data-id': node.attrs.id,
      'data-value': node.attrs.value,
      'data-viz-id': node.attrs.vizId ?? '',
      contenteditable: 'false',
    }]
  },
  parseDOM: [{
    tag: 'span.inline-ann',
    getAttrs(dom) {
      const el = dom
      return {
        id: el.getAttribute('data-id') ?? '',
        value: el.getAttribute('data-value') ?? '',
        vizId: el.getAttribute('data-viz-id') || null,
      }
    },
  }],
}

const boldMark: MarkSpec = {
  toDOM() { return ['strong', 0] },
  parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
}

const italicMark: MarkSpec = {
  toDOM() { return ['em', 0] },
  parseDOM: [{ tag: 'em' }, { tag: 'i' }],
}

const strikeMark: MarkSpec = {
  toDOM() { return ['s', 0] },
  parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
}

const underlineMark: MarkSpec = {
  toDOM() { return ['u', 0] },
  parseDOM: [{ tag: 'u' }],
}

const fontMark: MarkSpec = {
  attrs: { family: {} },
  toDOM(mark) {
    return ['span', { class: 'font-mark', style: `font-family: ${mark.attrs.family as string}` }, 0]
  },
  parseDOM: [{
    tag: 'span.font-mark',
    getAttrs(dom) {
      return { family: (dom).style.fontFamily || '' }
    },
  }],
}

// Suggestion marks: track-changes style. Text with suggestion_insert is a pending addition;
// text with suggestion_delete is a pending deletion (text still present in doc, shown struck).
const suggestionInsertMark: MarkSpec = {
  attrs: { suggestionId: {}, authorId: {} },
  spanning: true,
  excludes: 'suggestion_delete suggestion_insert',
  toDOM(mark) {
    return ['span', {
      class: 'suggestion-insert',
      'data-suggestion-id': mark.attrs.suggestionId,
      'data-author-id': mark.attrs.authorId,
    }, 0]
  },
  parseDOM: [{
    tag: 'span.suggestion-insert',
    getAttrs(dom) {
      const el = dom
      return {
        suggestionId: el.getAttribute('data-suggestion-id') ?? '',
        authorId: el.getAttribute('data-author-id') ?? '',
      }
    },
  }],
}

const suggestionDeleteMark: MarkSpec = {
  attrs: { suggestionId: {}, authorId: {} },
  spanning: true,
  excludes: 'suggestion_insert suggestion_delete',
  toDOM(mark) {
    return ['span', {
      class: 'suggestion-delete',
      'data-suggestion-id': mark.attrs.suggestionId,
      'data-author-id': mark.attrs.authorId,
    }, 0]
  },
  parseDOM: [{
    tag: 'span.suggestion-delete',
    getAttrs(dom) {
      const el = dom
      return {
        suggestionId: el.getAttribute('data-suggestion-id') ?? '',
        authorId: el.getAttribute('data-author-id') ?? '',
      }
    },
  }],
}

// Annotation mark: UUID-only span anchor. All metadata lives in the external store.
const annotationMark: MarkSpec = {
  attrs: {
    id: {},
  },
  spanning: true,
  excludes: '',  // allow multiple overlapping annotation marks
  toDOM(mark) {
    return ['span', { class: 'ann-span', 'data-ann-id': mark.attrs.id }, 0]
  },
  parseDOM: [{
    tag: 'span.ann-span',
    getAttrs(dom) {
      const el = dom
      return { id: el.getAttribute('data-ann-id') ?? '' }
    },
  }],
}

const commentNode: NodeSpec = {
  group: 'block',
  content: 'text*',
  defining: true,
  attrs: {
    id: { default: null },
  },
  toDOM(node) {
    return ['div', { class: 'comment-row', 'data-id': node.attrs.id }, 0]
  },
  parseDOM: [{
    tag: 'div.comment-row',
    getAttrs(dom) {
      return { id: (dom).getAttribute('data-id') }
    },
  }],
}

const utteranceWithOverlap = { ...utteranceNode, content: '(text | overlap_bracket | inline_ann)*' }

export const schema = new Schema({
  nodes: {
    doc: { content: '(utterance | visualization | comment)+' },
    text: { group: 'inline' },
    utterance: utteranceWithOverlap,
    visualization: visualizationNode,
    comment: commentNode,
    overlap_bracket: overlapBracketNode,
    image: imageNode,
    inline_ann: inlineAnnNode,
  },
  marks: {
    annotation: annotationMark,
    suggestion_insert: suggestionInsertMark,
    suggestion_delete: suggestionDeleteMark,
    bold: boldMark,
    italic: italicMark,
    strike: strikeMark,
    underline: underlineMark,
    font: fontMark,
  },
})
