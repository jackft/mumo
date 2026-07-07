import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { RoomRegistry } from './rooms.js'
import type { CheckpointStore } from './checkpoints.js'

export interface ApiDeps {
  registry: RoomRegistry
  checkpoints: CheckpointStore
  seedRoom?: (roomId: string, update: Uint8Array) => Promise<void>
}

export function buildApp({ registry, checkpoints, seedRoom }: ApiDeps) {
  const app = new Hono()

  app.get('/', c => c.json({ ok: true, service: 'mumo-server' }))

  const api = new Hono()
  api.use(cors())

  api.get('/rooms', c => c.json(registry.list()))

  api.post('/rooms', async c => {
    const { id: clientId, name, initialState } = await c.req.json<{ id?: string; name?: string; initialState?: string }>()
    const id = clientId ?? crypto.randomUUID()
    if (initialState && seedRoom) {
      try {
        const bytes = Uint8Array.from(atob(initialState), c => c.charCodeAt(0))
        await seedRoom(id, bytes)
      } catch { /* ignore malformed initial state */ }
    }
    return c.json(registry.create(id, name ?? 'Untitled'), 201)
  })

  api.get('/rooms/:id', c => {
    const room = registry.get(c.req.param('id'))
    return room ? c.json(room) : c.json({ error: 'not found' }, 404)
  })

  api.get('/rooms/:id/versions', c =>
    c.json(checkpoints.listVersions(c.req.param('id')))
  )

  api.post('/rooms/:id/versions', async c => {
    const id = c.req.param('id')
    if (!registry.has(id)) return c.json({ error: 'not found' }, 404)
    const { name } = await c.req.json<{ name?: string }>()
    const version = await checkpoints.saveVersion(id, name ?? 'Unnamed', 'manual')
    return c.json(version, 201)
  })

  api.get('/rooms/:id/versions/:vid', c => {
    const buf = checkpoints.getVersionBinary(c.req.param('id'), c.req.param('vid'))
    if (!buf) return c.json({ error: 'not found' }, 404)
    const vid = c.req.param('vid')
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${vid}.bin"`,
      },
    })
  })

  app.route('/api', api)

  return app
}
