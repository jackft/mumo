export type MediaEntry =
  | { kind: 'loaded';   id: string; name: string; offsetSec: number }
  | { kind: 'unloaded'; id: string; name: string; offsetSec: number }
