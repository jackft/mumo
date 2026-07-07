// Scheme-agnostic permalinks. The main part is:
//   doc/<docKey>[/<refType>/<refId>][?t=<seconds>]
//   collection[/<id>]
// Prefix with mumo://, https://host/prefix/, or nothing (bare paste).
// docKey is the doc basename without .mumo - survives machine-specific paths.

export type PermalinkRefType = 'utt' | 'ann' | 'pat' | 'bm'

export type PermalinkTarget =
  | { kind: 'doc'; docKey: string; ref?: { type: PermalinkRefType; id: string }; t?: number }
  | { kind: 'collection'; id?: number }

const REF_TYPES: readonly string[] = ['utt', 'ann', 'pat', 'bm']

/** Returns the main part (no scheme). Prefix with `mumo://` or a web origin. */
export function buildPermalink(target: PermalinkTarget): string {
  if (target.kind === 'collection') {
    return target.id != null ? `collection/${target.id}` : 'collection'
  }
  let s = `doc/${encodeURIComponent(target.docKey)}`
  if (target.ref) s += `/${target.ref.type}/${encodeURIComponent(target.ref.id)}`
  if (target.t != null && Number.isFinite(target.t)) s += `?t=${target.t.toFixed(3)}`
  return s
}

/** Parse mumo://, https://host/prefix/, or bare main part. Returns null if unparseable. */
export function parsePermalink(input: string): PermalinkTarget | null {
  const raw = input.trim()
  if (!raw) return null

  let pathAndQuery: string
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      pathAndQuery = u.pathname + u.search
    } catch {
      return null
    }
  } else {
    pathAndQuery = raw.replace(/^mumo:\/\//i, '').replace(/^mumo:/i, '')
  }

  const qIdx = pathAndQuery.indexOf('?')
  const pathPart  = qIdx === -1 ? pathAndQuery : pathAndQuery.slice(0, qIdx)
  const queryPart = qIdx === -1 ? '' : pathAndQuery.slice(qIdx + 1)
  const segs = pathPart.split('/').filter(Boolean)

  // hosted prefixes may precede the main part - anchor on doc/collection
  const anchor = segs.findIndex(s => s === 'doc' || s === 'collection' || s === 'collections')
  if (anchor === -1) return null
  const rest = segs.slice(anchor)

  const tRaw = new URLSearchParams(queryPart).get('t')
  const t = tRaw != null ? Number(tRaw) : undefined

  if (rest[0] === 'collection' || rest[0] === 'collections') {
    const id = rest[1] != null ? Number(decodeURIComponent(rest[1])) : NaN
    return Number.isFinite(id) ? { kind: 'collection', id } : { kind: 'collection' }
  }

  const docKey = rest[1] != null ? decodeURIComponent(rest[1]) : ''
  if (!docKey) return null

  const refType = rest[2]
  const refId   = rest[3] != null ? decodeURIComponent(rest[3]) : undefined
  const ref = refType !== undefined && REF_TYPES.includes(refType) && refId
    ? { type: refType as PermalinkRefType, id: refId }
    : undefined

  return {
    kind: 'doc',
    docKey,
    ...(ref ? { ref } : {}),
    ...(t !== undefined && Number.isFinite(t) ? { t } : {}),
  }
}

/** Document key for a file path: basename without the .mumo extension. */
export function docKeyForPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path
  return base.replace(/\.mumo$/i, '')
}
