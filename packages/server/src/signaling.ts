/**
 * WebRTC signaling server for y-webrtc peer discovery.
 *
 * Implements the y-webrtc signaling protocol: a simple pub/sub over WebSocket
 * where peers subscribe to room topics and the server relays messages between
 * them. Once two peers have exchanged signals, they communicate directly via
 * WebRTC and no longer need the signaling server.
 *
 * Protocol (JSON messages):
 *   { type: 'subscribe',   topics: string[] }   — join rooms
 *   { type: 'unsubscribe', topics: string[] }   — leave rooms
 *   { type: 'publish',     topic: string, ... } — broadcast to room peers
 *   { type: 'ping' }                            — keepalive (server replies 'pong')
 */
import type { WebSocket } from 'ws'
import type { WebSocketServer } from 'ws'

type SignalingMessage = {
  type: 'subscribe' | 'unsubscribe' | 'publish' | 'ping'
  topics?: string[]
  topic?: string
  [key: string]: unknown
}

export function setupSignaling(wss: WebSocketServer): void {
  // topic → set of subscribed clients
  const topics = new Map<string, Set<WebSocket>>()

  function subscribe(ws: WebSocket, topic: string): void {
    if (!topics.has(topic)) topics.set(topic, new Set())
    topics.get(topic)!.add(ws)
  }

  function unsubscribe(ws: WebSocket, topic: string): void {
    const subs = topics.get(topic)
    if (!subs) return
    subs.delete(ws)
    if (subs.size === 0) topics.delete(topic)
  }

  function unsubscribeAll(ws: WebSocket): void {
    for (const [topic, subs] of topics) {
      subs.delete(ws)
      if (subs.size === 0) topics.delete(topic)
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw: Buffer) => {
      let msg: SignalingMessage
      try { msg = JSON.parse(raw.toString()) as SignalingMessage } catch { return }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
        return
      }

      if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
        for (const topic of msg.topics) subscribe(ws, topic)
        return
      }

      if (msg.type === 'unsubscribe' && Array.isArray(msg.topics)) {
        for (const topic of msg.topics) unsubscribe(ws, topic)
        return
      }

      if (msg.type === 'publish' && typeof msg.topic === 'string') {
        const subs = topics.get(msg.topic)
        if (!subs) return
        const payload = JSON.stringify(msg)
        for (const peer of subs) {
          if (peer !== ws && peer.readyState === peer.OPEN) peer.send(payload)
        }
      }
    })

    ws.on('close', () => { unsubscribeAll(ws); })
    ws.on('error', () => { unsubscribeAll(ws); })
  })
}
