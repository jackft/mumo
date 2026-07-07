import * as fs from 'node:fs'
import * as path from 'node:path'

export interface RoomMeta {
  id: string
  name: string
  createdAt: number
  lastModifiedAt: number
}

export class RoomRegistry {
  private filePath: string
  private rooms = new Map<string, RoomMeta>()

  constructor(filePath: string) {
    this.filePath = filePath
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const list = JSON.parse(raw) as RoomMeta[]
      for (const r of list) this.rooms.set(r.id, r)
    } catch { /* first run */ }
  }

  has(id: string) { return this.rooms.has(id) }
  get(id: string) { return this.rooms.get(id) }
  list() { return [...this.rooms.values()] }

  create(id: string, name: string): RoomMeta {
    const room: RoomMeta = { id, name, createdAt: Date.now(), lastModifiedAt: Date.now() }
    this.rooms.set(id, room)
    this.persist()
    return room
  }

  touch(id: string) {
    const room = this.rooms.get(id)
    if (!room) return
    room.lastModifiedAt = Date.now()
    this.persist()
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify([...this.rooms.values()], null, 2))
  }
}
