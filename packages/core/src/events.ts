export type ListenerMap<Events extends Record<string, unknown[]>> = {
  [K in keyof Events]?: Array<(...args: Events[K]) => void>
}

export class TypedEmitter<Events extends Record<string, unknown[]>> {
  private listeners: ListenerMap<Events> = {}

  on<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void): void {
    (this.listeners[event] ??= [] as NonNullable<ListenerMap<Events>[K]>).push(fn)
  }

  off<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void): void {
    const arr = this.listeners[event]
    if (!arr) return
    const idx = arr.indexOf(fn)
    if (idx !== -1) arr.splice(idx, 1)
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const arr = this.listeners[event]
    if (!arr) return
    // Copy: a listener calling off() during emit must not skip other listeners.
    // Isolate errors: emits run inside Yjs observers, and a throwing listener
    // must not abort the remaining listeners or the transaction commit.
    for (const fn of [...arr]) {
      try {
        fn(...args)
      } catch (err) {
        console.error(`[TypedEmitter] listener for "${String(event)}" threw:`, err)
      }
    }
  }
}
