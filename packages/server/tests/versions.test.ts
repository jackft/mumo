import { describe, test, beforeAll, afterAll, expect } from 'vitest'
import * as Y from 'yjs'
import { AnnotationStore } from '@mumo/core'
import { startTestServer, createTestRoom, waitForSync, makeProvider, getPersistedUpdate, type TestServer } from './helpers.js'

describe('versions & checkpoints', () => {
  let server: TestServer
  let roomId: string

  beforeAll(async () => {
    server = await startTestServer()
    roomId = await createTestRoom(server, 'version-test')
  })

  afterAll(() => server.stop())

  test('manual version is listed after creation', async () => {
    const doc = new Y.Doc()
    const p = makeProvider(server, roomId, doc)
    await waitForSync(p)

    const store = new AnnotationStore(doc)
    store.addAnnotation('v1-annotation', [], {})
    await new Promise(r => setTimeout(r, 100))

    const res = await fetch(`${server.httpUrl}/api/rooms/${roomId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'v1.0' }),
    })
    expect(res.status).toBe(201)
    const version = await res.json() as { id: string; name: string; type: string }
    expect(version.name).toBe('v1.0')
    expect(version.type).toBe('manual')

    const listRes = await fetch(`${server.httpUrl}/api/rooms/${roomId}/versions`)
    const list = await listRes.json() as { id: string }[]
    expect(list.some(v => v.id === version.id)).toBe(true)

    p.destroy()
  })

  test('version binary can be downloaded and applied to a fresh doc', { timeout: 15_000 }, async () => {
    const roomId2 = await createTestRoom(server, 'restore-test')
    const doc = new Y.Doc()
    const p = makeProvider(server, roomId2, doc)
    await waitForSync(p)

    const store = new AnnotationStore(doc)
    const ann = store.addAnnotation('saved-before-version', [], {})

    // Versions snapshot from LevelDB, so wait until the annotation has made
    // both async hops (websocket → server doc → ldb.storeUpdate)
    await expect.poll(async () => {
      const check = new Y.Doc()
      Y.applyUpdate(check, await getPersistedUpdate(server, roomId2))
      return new AnnotationStore(check).getAnnotation(ann.id)
    }, { timeout: 5000 }).toBeDefined()

    // Save version
    const vRes = await fetch(`${server.httpUrl}/api/rooms/${roomId2}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'snapshot' }),
    })
    const version = await vRes.json() as { id: string }
    p.destroy()

    // Download binary
    const binRes = await fetch(`${server.httpUrl}/api/rooms/${roomId2}/versions/${version.id}`)
    expect(binRes.status).toBe(200)
    const buf = await binRes.arrayBuffer()

    // Apply to a fresh Y.Doc — simulates restore
    const restoredDoc = new Y.Doc()
    Y.applyUpdate(restoredDoc, new Uint8Array(buf))
    const restoredStore = new AnnotationStore(restoredDoc)
    expect(restoredStore.getAnnotation(ann.id)).toBeDefined()
  })

  test('auto-checkpoint from checkpointDoc saves state', async () => {
    const roomId3 = await createTestRoom(server, 'autocheckpoint-test')
    const doc = new Y.Doc()
    const p = makeProvider(server, roomId3, doc)
    await waitForSync(p)

    const store = new AnnotationStore(doc)
    store.addAnnotation('auto-checkpoint-ann', [], {})
    await new Promise(r => setTimeout(r, 100))

    // Simulate checkpoint-on-disconnect
    await server.checkpoints.checkpointDoc(roomId3, doc)

    const versions = server.checkpoints.listVersions(roomId3)
    expect(versions.length).toBeGreaterThan(0)
    expect(versions[0]?.type).toBe('auto')

    p.destroy()
  })
})
