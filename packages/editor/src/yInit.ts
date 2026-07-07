import * as Y from 'yjs'
import { prosemirrorToYXmlFragment, prosemirrorJSONToYDoc } from 'y-prosemirror'
import { schema } from '@mumo/core'
import type { Node } from 'prosemirror-model'

/** Populate an empty Y.XmlFragment (keyed 'prosemirror') from a PM doc. Only call once on first load. */
export function initYXmlFragment(ydoc: Y.Doc, doc: Node): void {
  prosemirrorToYXmlFragment(doc, ydoc.getXmlFragment('prosemirror'))
}

/** Replace the content of an existing Y.XmlFragment with a new PM doc (for file reloads). */
export function replaceYXmlFragment(ydoc: Y.Doc, yXmlFragment: Y.XmlFragment, doc: Node): void {
  const tempYDoc = prosemirrorJSONToYDoc(schema, doc.toJSON())
  ydoc.transact(() => {
    yXmlFragment.delete(0, yXmlFragment.length)
  }, null)
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(tempYDoc), null)
}
