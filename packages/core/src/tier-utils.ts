import type { TierDef } from './store.js'

/** Return tiers in depth-first order: parents before their children. */
export function orderTiersDepthFirst(tiers: TierDef[]): TierDef[] {
  const childrenOf = new Map<string | undefined, TierDef[]>()
  for (const t of tiers) {
    const key = t.parentTierId
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key)!.push(t)
  }
  const result: TierDef[] = []
  const walk = (parentId: string | undefined) => {
    for (const t of childrenOf.get(parentId) ?? []) {
      result.push(t)
      walk(t.id)
    }
  }
  walk(undefined)
  return result
}

/** Build a map of tier ID => depth (0 = root). */
export function buildTierDepths(tiers: TierDef[]): Map<string, number> {
  const depths = new Map<string, number>()
  const depth = (id: string): number => {
    if (depths.has(id)) return depths.get(id)!
    const tier = tiers.find(t => t.id === id)
    const d = tier?.parentTierId ? 1 + depth(tier.parentTierId) : 0
    depths.set(id, d)
    return d
  }
  for (const t of tiers) depth(t.id)
  return depths
}
