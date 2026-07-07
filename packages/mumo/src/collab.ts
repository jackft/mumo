import { WebsocketProvider } from 'y-websocket'
import { WebrtcProvider } from 'y-webrtc'
import { encodeStateAsUpdate } from 'yjs'
import type { Doc as YDoc } from 'yjs'
import { peerColor } from './collab-awareness.js'

export type CollabMode     = 'server' | 'webrtc'
export type CollabStatus   = 'off' | 'connecting' | 'connected' | 'disconnected'
export type CollabIdentity = { name: string; email?: string }

export type AwarenessLike = {
  setLocalStateField(k: string, v: unknown): void
  getStates(): unknown
  on(e: string, cb: (...a: unknown[]) => void): void
}

export type PeerBarSel   = { nodeId: string; color: string }
export type PeerPatternSel = { patternId: string; color: string }

export interface CollabCallbacks {
  onStatus(status: CollabStatus, mode: CollabMode): void
  onAwareness(awareness: AwarenessLike): void
  onPeerSelections(bars: PeerBarSel[], patterns: PeerPatternSel[]): void
}

export class CollabManager {
  readonly defaultCollabServer: string
  readonly defaultSignalServer: string

  private _wsProvider:    WebsocketProvider | null = null
  private _rtcProvider:   WebrtcProvider    | null = null
  private _mode:          CollabMode        | null = null
  private _roomId:        string            | null = null
  private _user:          { name?: string; email?: string } | null = null

  constructor(
    private ydoc: YDoc,
    private callbacks: CollabCallbacks,
    opts: { collabServer?: string; signalServer?: string } = {},
  ) {
    this.defaultCollabServer = opts.collabServer ?? 'ws://localhost:1234'
    this.defaultSignalServer = opts.signalServer ?? 'wss://signaling.yjs.dev'
  }

  get mode():   CollabMode | null { return this._mode }
  get roomId(): string    | null { return this._roomId }

  get awareness(): AwarenessLike | null {
    const p = this._wsProvider ?? this._rtcProvider
    return p ? (p as unknown as { awareness: AwarenessLike }).awareness : null
  }

  /** Call once at startup to restore a session from URL params. */
  initFromUrl(params: URLSearchParams): void {
    const roomId = params.get('room')
    if (!roomId) return

    const mode: CollabMode = params.get('collab') === 'webrtc' ? 'webrtc' : 'server'
    const signalingUrl     = params.get('signal') ?? this.defaultSignalServer
    const serverUrl        = params.get('server') ?? this.defaultCollabServer

    if (mode === 'webrtc') {
      this._rtcProvider = new WebrtcProvider(roomId, this.ydoc, { signaling: [signalingUrl] })
      this._attach(this._rtcProvider, 'webrtc')
    } else {
      this._wsProvider = new WebsocketProvider(serverUrl, roomId, this.ydoc)
      this._attach(this._wsProvider, 'server')
    }

    this._roomId = roomId
    this._mode   = mode
    this.callbacks.onStatus('connecting', mode)
  }

  /** Start a new session as host — generates a fresh room ID. Throws on server connection failure. */
  async start(mode: CollabMode, opts: { serverUrl: string; signalingUrl: string }): Promise<void> {
    const roomId = crypto.randomUUID()

    if (mode === 'server') {
      const httpBase = opts.serverUrl.replace('ws://', 'http://').replace('wss://', 'https://')
      const initialState = _encodeBase64(encodeStateAsUpdate(this.ydoc))
      const res = await fetch(`${httpBase}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: roomId, name: 'Untitled session', initialState }),
      })
      if (!res.ok) throw new Error(`Could not connect to server: ${httpBase}`)
      this._wsProvider = new WebsocketProvider(opts.serverUrl, roomId, this.ydoc)
      this._attach(this._wsProvider, 'server')
    } else {
      this._rtcProvider = new WebrtcProvider(roomId, this.ydoc, { signaling: [opts.signalingUrl] })
      this._attach(this._rtcProvider, 'webrtc')
    }

    this._roomId = roomId
    this._mode   = mode
    this.callbacks.onStatus('connecting', mode)
    this._updateUrl(roomId, mode, opts.signalingUrl)
  }

  /** Join an existing session by room ID (no room creation). */
  join(roomId: string, mode: CollabMode, opts: { serverUrl: string; signalingUrl: string }): void {
    if (mode === 'server') {
      this._wsProvider = new WebsocketProvider(opts.serverUrl, roomId, this.ydoc)
      this._attach(this._wsProvider, 'server')
    } else {
      this._rtcProvider = new WebrtcProvider(roomId, this.ydoc, { signaling: [opts.signalingUrl] })
      this._attach(this._rtcProvider, 'webrtc')
    }

    this._roomId = roomId
    this._mode   = mode
    this.callbacks.onStatus('connecting', mode)
    this._updateUrl(roomId, mode, opts.signalingUrl)
  }

  stop(): void {
    const mode = this._mode ?? 'server'
    this._wsProvider?.destroy()
    this._rtcProvider?.destroy()
    this._wsProvider  = null
    this._rtcProvider = null
    this._roomId      = null
    this._mode        = null
    const url = new URL(location.href)
    url.searchParams.delete('room')
    url.searchParams.delete('collab')
    url.searchParams.delete('signal')
    url.searchParams.delete('server')
    history.replaceState(null, '', url.toString())
    this.callbacks.onStatus('off', mode)
  }

  setLocalState(key: string, value: unknown): void {
    this.awareness?.setLocalStateField(key, value)
  }

  setUser(user: { name?: string; email?: string }): void {
    this._user = user
    const aw = this.awareness
    if (aw) aw.setLocalStateField('user', { name: this._displayName(), color: peerColor(this.ydoc.clientID) })
  }

  /** Returns current peer bar selections (used when timeline re-mounts). */
  peerBarSelections(): PeerBarSel[] {
    const aw = this.awareness
    if (!aw) return []
    const states = aw.getStates() as Map<number, Record<string, unknown>>
    return [...states.entries()]
      .filter(([id]) => id !== this.ydoc.clientID)
      .flatMap(([id, s]) => {
        const barId = s['selectedBarId'] as string | undefined
        return barId
          ? [{ nodeId: barId, color: ((s['user'] as { color?: string } | undefined)?.color) ?? peerColor(id) }]
          : []
      })
  }

  private _displayName(): string {
    if (this._user?.name) return this._user.name
    if (this._user?.email) return this._user.email.split('@')[0]!
    return `User ${this.ydoc.clientID % 1000}`
  }

  private _updateUrl(roomId: string, mode: CollabMode, signalingUrl: string): void {
    const url = new URL(location.href)
    url.searchParams.set('room', roomId)
    if (mode === 'webrtc') {
      url.searchParams.set('collab', 'webrtc')
      url.searchParams.set('signal', signalingUrl)
    }
    history.replaceState(null, '', url.toString())
  }

  private _attach(provider: WebsocketProvider | WebrtcProvider, mode: CollabMode): void {
    if (mode === 'server') {
      ;(provider as WebsocketProvider).on('status', ({ status }: { status: string }) => {
        this.callbacks.onStatus(status === 'connected' ? 'connected' : 'disconnected', 'server')
      })
    } else {
      ;(provider as WebrtcProvider).on('peers', ({ webrtcPeers, bcPeers }: { webrtcPeers: unknown[]; bcPeers: unknown[] }) => {
        const connected = webrtcPeers.length > 0 || bcPeers.length > 0
        this.callbacks.onStatus(connected ? 'connected' : 'connecting', 'webrtc')
      })
    }

    const myColor  = peerColor(this.ydoc.clientID)
    const awareness = (provider as unknown as { awareness: AwarenessLike }).awareness
    awareness.setLocalStateField('user', { name: this._displayName(), color: myColor })
    awareness.on('change', () => {
      const states = awareness.getStates() as Map<number, Record<string, unknown>>
      const myId   = this.ydoc.clientID
      const bars:   PeerBarSel[]   = []
      const patterns: PeerPatternSel[] = []
      for (const [id, state] of states) {
        if (id === myId) continue
        const color   = ((state['user'] as { color?: string } | undefined)?.color) ?? peerColor(id)
        const barId   = state['selectedBarId']   as string | undefined
        const patternId = state['selectedPatternId'] as string | undefined
        if (barId)   bars.push({ nodeId: barId, color })
        if (patternId) patterns.push({ patternId, color })
      }
      this.callbacks.onPeerSelections(bars, patterns)
    })

    this.callbacks.onAwareness(awareness)
  }
}

function _encodeBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
