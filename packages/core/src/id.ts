import type { ID } from './types.js'

// IDs are structural anchors for annotations, relations, and collab sessions.
// The timestamp prefix keeps IDs roughly sortable by creation time; the suffix
// carries ~62 bits of crypto-strength randomness so concurrent clients creating
// IDs in the same millisecond cannot realistically collide.

export function newId(): ID {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let suffix = ''
  for (const b of bytes) suffix += b.toString(36).padStart(2, '0')
  return `${Date.now()}-${suffix.slice(0, 12)}`
}
