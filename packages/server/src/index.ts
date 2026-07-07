import { createAdaptorServer } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import type { Doc as YDoc } from 'yjs'
import type { IncomingMessage } from 'node:http'
import { RoomRegistry } from './rooms.js'
import { CheckpointStore } from './checkpoints.js'
import { buildApp } from './api.js'
import { setupSignaling } from './signaling.js'

const _require = createRequire(import.meta.url)
// Load yjs, y-leveldb, and y-websocket/bin/utils all via CJS so they share one yjs instance.
// y-leveldb's ESM entry imports yjs ESM; y-websocket/bin/utils requires yjs CJS — mixing them
// causes Yjs's "already imported" warning due to Node's separate ESM/CJS module caches.
// `import type` is erased at compile time and never causes a runtime module load.
const { applyUpdate, encodeStateAsUpdate } = _require('yjs') as typeof import('yjs')
const { LeveldbPersistence } = _require('y-leveldb') as typeof import('y-leveldb')
const { setupWSConnection, setPersistence } = _require('y-websocket/bin/utils') as {
  setupWSConnection: (ws: WebSocket, req: IncomingMessage, opts?: { docName?: string; gc?: boolean }) => void
  setPersistence: (p: {
    bindState: (name: string, doc: YDoc) => Promise<void>
    writeState: (name: string, doc: YDoc) => Promise<void>
  }) => void
}

const DATA_DIR               = process.env['DATA_DIR']  ?? './data'
fs.mkdirSync(`${DATA_DIR}/docs`, { recursive: true })
const PORT                   = parseInt(process.env['PORT'] ?? '1234', 10)
const CHECKPOINT_INTERVAL_MS = parseInt(process.env['CHECKPOINT_INTERVAL_MS'] ?? String(15 * 60 * 1000), 10)

const ldb         = new LeveldbPersistence(`${DATA_DIR}/docs`)
const registry    = new RoomRegistry(`${DATA_DIR}/rooms.json`)
const checkpoints = new CheckpointStore(`${DATA_DIR}/versions`, ldb)

setPersistence({
  bindState: async (docName, ydoc) => {
    const persisted = await ldb.getYDoc(docName)
    applyUpdate(ydoc, encodeStateAsUpdate(persisted))
    // Attach the handler BEFORE snapshotting, with no await in between:
    // every update is then either in the snapshot or seen by the handler.
    // The snapshot persists updates that arrived while LevelDB was loading.
    ydoc.on('update', (update: Uint8Array) => {
      void ldb.storeUpdate(docName, update)
      registry.touch(docName)
    })
    void ldb.storeUpdate(docName, encodeStateAsUpdate(ydoc))
  },
  writeState: async (_docName, _ydoc) => {},
})

checkpoints.startAutoCheckpoint(CHECKPOINT_INTERVAL_MS, () => registry.list().map(r => r.id))

const app    = buildApp({ registry, checkpoints, seedRoom: (id, update) => ldb.storeUpdate(id, update) })
const server = createAdaptorServer({ fetch: app.fetch }) as unknown as import('node:http').Server

// Two WebSocket servers on the same HTTP server, routed by path:
//   /signal      — y-webrtc peer discovery (signaling)
//   /<room-uuid> — y-websocket Yjs state sync
const wss       = new WebSocketServer({ noServer: true })
const wssSig    = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/signal') {
    wssSig.handleUpgrade(req, socket, head, ws => wssSig.emit('connection', ws, req))
  } else {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  }
})

setupSignaling(wssSig)

wss.on('connection', (ws, req) => {
  const roomId = (req.url ?? '/').slice(1).split('?')[0]
  if (!roomId || !registry.has(roomId)) {
    ws.close(4004, 'Room not found')
    return
  }
  setupWSConnection(ws, req, { docName: roomId })
})

server.listen(PORT, () => {
  console.log(`mumo collab server listening on :${PORT}`)
})

process.on('SIGTERM', () => { checkpoints.stop(); process.exit(0) })
process.on('SIGINT',  () => { checkpoints.stop(); process.exit(0) })
