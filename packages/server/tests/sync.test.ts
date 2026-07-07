import { describe, test, beforeAll, afterAll, expect } from 'vitest'
import * as Y from 'yjs'
import { AnnotationStore } from '@mumo/core'
import { startTestServer, createTestRoom, waitForSync, makeProvider, type TestServer } from './helpers.js'

describe('two-client sync', () => {
  let server: TestServer
  let roomId: string

  beforeAll(async () => {
    server = await startTestServer()
    roomId = await createTestRoom(server, 'sync-test')
  })

  afterAll(() => server.stop())

  test('annotation added on client 1 appears on client 2', async () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const p1 = makeProvider(server, roomId, doc1)
    const p2 = makeProvider(server, roomId, doc2)

    await waitForSync(p1, p2)

    const store1 = new AnnotationStore(doc1)
    const ann = store1.addAnnotation('test-label', [], {})

    await new Promise(r => setTimeout(r, 100)) // let update propagate

    const store2 = new AnnotationStore(doc2)
    expect(store2.getAnnotation(ann.id)).toBeDefined()
    expect(store2.getAnnotation(ann.id)?.type).toBe('test-label')

    p1.destroy(); p2.destroy()
  })

  test('offline edits from two clients both survive merge', async () => {
    const roomId2 = await createTestRoom(server, 'offline-test')
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const p1 = makeProvider(server, roomId2, doc1)
    const p2 = makeProvider(server, roomId2, doc2)

    await waitForSync(p1, p2)

    // Take doc2 offline
    p2.disconnect()
    await new Promise(r => setTimeout(r, 50))

    const store1 = new AnnotationStore(doc1)
    const store2 = new AnnotationStore(doc2)

    const ann1 = store1.addAnnotation('from-client-1', [], {})
    const ann2 = store2.addAnnotation('from-client-2', [], {})

    // Reconnect doc2 — Yjs CRDT merges both inserts
    p2.connect()
    await waitForSync(p1, p2)
    await new Promise(r => setTimeout(r, 150))

    expect(store1.getAnnotation(ann2.id)).toBeDefined()
    expect(store2.getAnnotation(ann1.id)).toBeDefined()

    p1.destroy(); p2.destroy()
  })
})
