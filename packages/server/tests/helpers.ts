import * as net from 'node:net'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { createRequire } from 'node:module'
import WebSocket_impl from 'ws'
import { createAdaptorServer } from '@hono/node-server'
import { RoomRegistry } from '../src/rooms.js'
import { CheckpointStore } from '../src/checkpoints.js'
import { buildApp } from '../src/api.js'
import type { LeveldbPersistence } from 'y-leveldb'
import type { WebsocketProvider } from 'y-websocket'
import type { Doc as YDoc } from 'yjs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { IncomingMessage } from 'node:http'

const _require = createRequire(import.meta.url)
// Load yjs, y-leveldb, and y-websocket all via CJS so they share one yjs instance.
// `import type` is erased at compile time — only the _require calls execute at runtime.
const { applyUpdate, encodeStateAsUpdate } = _require('yjs') as typeof import('yjs')
const { LeveldbPersistence: LeveldbPersistenceCtor } = _require('y-leveldb') as typeof import('y-leveldb')
const { WebsocketProvider: WebsocketProviderCtor } = _require('y-websocket') as typeof import('y-websocket')
const { setupWSConnection, setPersistence } = _require('y-websocket/bin/utils') as {
  setupWSConnection: (ws: WebSocket, req: IncomingMessage, opts?: { docName?: string }) => void
  setPersistence: (p: {
    bindState: (name: string, doc: YDoc) => Promise<void>
    writeState: (name: string, doc: YDoc) => Promise<void>
  }) => void
}

export interface TestServer {
  httpUrl: string
  wsUrl: string
  stop: () => Promise<void>
  registry: RoomRegistry
  checkpoints: CheckpointStore
  ldb: LeveldbPersistence
  dataDir: string
}

function getFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer()
    s.listen(0, () => {
      const addr = s.address() as net.AddressInfo
      s.close(() => resolve(addr.port))
    })
  })
}

export async function startTestServer(): Promise<TestServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mumo-test-'))
  const ldb = new LeveldbPersistenceCtor(`${dataDir}/docs`)
  const registry = new RoomRegistry(`${dataDir}/rooms.json`)
  const checkpoints = new CheckpointStore(`${dataDir}/versions`, ldb)

  setPersistence({
    bindState: async (docName, ydoc) => {
      const persisted = await ldb.getYDoc(docName)
      applyUpdate(ydoc, encodeStateAsUpdate(persisted))
      // Attach the handler BEFORE snapshotting, with no await in between:
      // every update is then either in the snapshot or seen by the handler.
      // The snapshot persists updates that arrived while LevelDB was loading.
      ydoc.on('update', (update: Uint8Array) => { ldb.storeUpdate(docName, update) })
      void ldb.storeUpdate(docName, encodeStateAsUpdate(ydoc))
    },
    writeState: async () => {},
  })

  const port = await getFreePort()
  const app    = buildApp({ registry, checkpoints })
  const server = createAdaptorServer({ fetch: app.fetch }) as unknown as import('node:http').Server

  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    const roomId = (req.url ?? '/').slice(1).split('?')[0]
    if (!roomId || !registry.has(roomId)) { ws.close(4004, 'Room not found'); return }
    setupWSConnection(ws, req, { docName: roomId })
  })

  await new Promise<void>(resolve => server.listen(port, resolve))

  return {
    httpUrl: `http://localhost:${port}`,
    wsUrl:  `ws://localhost:${port}`,
    registry,
    checkpoints,
    ldb,
    dataDir,
    stop: async () => {
      checkpoints.stop()
      await ldb.destroy()
      // Force-close any clients a failed test left behind — wss.close()
      // otherwise waits for them and times out the afterAll hook
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve, reject) => {
        wss.close(err => err ? reject(err) : server.close(err2 => err2 ? reject(err2) : resolve()))
      })
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// Encode the persisted room state using the server-side (CJS) yjs instance.
// Callers apply the binary update to their own doc — updates are portable
// across yjs instances, unlike doc objects.
export async function getPersistedUpdate(server: TestServer, roomId: string): Promise<Uint8Array> {
  const doc = await server.ldb.getYDoc(roomId)
  return encodeStateAsUpdate(doc)
}

export async function createTestRoom(server: TestServer, name: string): Promise<string> {
  const res = await fetch(`${server.httpUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const room = await res.json() as { id: string }
  return room.id
}

export function waitForSync(...providers: WebsocketProvider[]): Promise<void> {
  return Promise.all(
    providers.map(p =>
      p.synced
        ? Promise.resolve()
        : new Promise<void>(resolve => p.once('synced', resolve))
    )
  ).then(() => {})
}

export function makeProvider(server: TestServer, roomId: string, ydoc: YDoc): WebsocketProvider {
  return new WebsocketProviderCtor(server.wsUrl, roomId, ydoc, {
    // @ts-expect-error ws.WebSocket interface differs from browser WebSocket
    WebSocketPolyfill: WebSocket_impl,
  })
}
