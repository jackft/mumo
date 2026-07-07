import { describe, it, expect } from 'vitest'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'
import { schema } from '@mumo/core'

describe('yjs marks round-trip', () => {
  it('preserves suggestion_delete and suggestion_insert marks through Yjs', () => {
    const docJSON = {
      type: 'doc',
      content: [{
        type: 'utterance',
        attrs: { id: 'utt1', participant: 'A', startTimeSeconds: 1, endTimeSeconds: 2, tier: '' },
        content: [
          { type: 'text', text: 'say ' },
          { type: 'text', text: 'hello', marks: [{ type: 'suggestion_delete', attrs: { suggestionId: 'sug1', authorId: 'user:local' } }] },
          { type: 'text', text: 'goodbye', marks: [{ type: 'suggestion_insert', attrs: { suggestionId: 'sug1', authorId: 'user:local' } }] },
        ]
      }]
    }
    const pmNode = schema.nodeFromJSON(docJSON)
    const tempYDoc = prosemirrorJSONToYDoc(schema, pmNode.toJSON())
    const backJSON = yDocToProsemirrorJSON(tempYDoc) as { content: Array<{ content: Array<{ type: string; text?: string; marks?: Array<{type: string}> }> }> }
    const uttContent = backJSON.content[0]!.content
    console.log('Yjs round-trip result:', JSON.stringify(uttContent, null, 2))
    const delNode = uttContent.find(n => n.marks?.some(m => m.type === 'suggestion_delete'))
    const insNode = uttContent.find(n => n.marks?.some(m => m.type === 'suggestion_insert'))
    expect(delNode?.text).toBe('hello')
    expect(insNode?.text).toBe('goodbye')
  })
})
