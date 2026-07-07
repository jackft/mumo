import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import type { Doc as YDoc } from 'yjs'
import type { LeveldbPersistence } from 'y-leveldb'

const _require = createRequire(import.meta.url)
const { encodeStateAsUpdate } = _require('yjs') as typeof import('yjs')

export interface VersionMeta {
  id: string
  roomId: string
  name: string
  createdAt: number
  type: 'auto' | 'manual'
}

export class CheckpointStore {
  private dir: string
  private ldb: LeveldbPersistence
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(dir: string, ldb: LeveldbPersistence) {
    this.dir = dir
    this.ldb = ldb
  }

  private roomDir(roomId: string) { return path.join(this.dir, roomId) }

  private indexPath(roomId: string) { return path.join(this.roomDir(roomId), 'index.json') }

  private binPath(roomId: string, versionId: string) {
    return path.join(this.roomDir(roomId), `${versionId}.bin`)
  }

  listVersions(roomId: string): VersionMeta[] {
    try { return JSON.parse(fs.readFileSync(this.indexPath(roomId), 'utf8')) as VersionMeta[] }
    catch { return [] }
  }

  private appendIndex(meta: VersionMeta) {
    const existing = this.listVersions(meta.roomId)
    existing.push(meta)
    fs.mkdirSync(this.roomDir(meta.roomId), { recursive: true })
    fs.writeFileSync(this.indexPath(meta.roomId), JSON.stringify(existing, null, 2))
  }

  async saveVersion(roomId: string, name: string, type: 'auto' | 'manual'): Promise<VersionMeta> {
    const ydoc = await this.ldb.getYDoc(roomId)
    const update = encodeStateAsUpdate(ydoc)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    fs.mkdirSync(this.roomDir(roomId), { recursive: true })
    fs.writeFileSync(this.binPath(roomId, id), Buffer.from(update))
    const meta: VersionMeta = { id, roomId, name, createdAt: Date.now(), type }
    this.appendIndex(meta)
    return meta
  }

  getVersionBinary(roomId: string, versionId: string): Buffer | null {
    try { return fs.readFileSync(this.binPath(roomId, versionId)) }
    catch { return null }
  }

  /** Save a checkpoint from a live in-memory Y.Doc (called on disconnect). */
  // eslint-disable-next-line @typescript-eslint/require-await
  async checkpointDoc(roomId: string, ydoc: YDoc) {
    const update = encodeStateAsUpdate(ydoc)
    if (update.length <= 2) return // empty doc, skip
    const id = `${Date.now()}-auto`
    fs.mkdirSync(this.roomDir(roomId), { recursive: true })
    fs.writeFileSync(this.binPath(roomId, id), Buffer.from(update))
    const meta: VersionMeta = {
      id, roomId,
      name: `auto ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      createdAt: Date.now(),
      type: 'auto',
    }
    this.appendIndex(meta)
  }

  /** Auto-checkpoint all rooms from LevelDB on an interval. */
  startAutoCheckpoint(intervalMs: number, getRoomIds: () => string[]) {
    this.timer = setInterval(() => {
      void (async () => {
        for (const roomId of getRoomIds()) {
          try {
            await this.saveVersion(roomId, `auto ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, 'auto')
          } catch (err) {
            console.error(`Auto-checkpoint failed for room ${roomId}:`, err)
          }
        }
      })()
    }, intervalMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }
}
