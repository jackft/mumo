import type { EAFMediaDescriptor } from './types.js'

/**
 * Returns an ordered list of candidate filesystem paths for a media descriptor,
 * following ELAN's resolution cascade:
 *   1. Absolute path (MEDIA_URL)
 *   2. Same directory as the .eaf file + filename
 *   3. Relative path (RELATIVE_MEDIA_URL) resolved against the .eaf location
 *   4. ../Media/ + filename
 *   5. ../media/ + filename
 *   6. Any extra directories supplied by the caller (user prefs)
 *
 * Caller should try each path in order, stopping at the first that exists.
 */
export function mediaCandidatePaths(
  descriptor: EAFMediaDescriptor,
  eafPath: string,
  extraDirs: string[] = [],
): string[] {
  const candidates: string[] = []
  const filename = _basename(descriptor.mediaUrl)
  const eafDir = _dirname(eafPath)

  // 1. Absolute path
  const abs = _urlToPath(descriptor.mediaUrl)
  if (abs) candidates.push(abs)

  // 2. Same directory as .eaf
  if (eafDir && filename) {
    candidates.push(`${eafDir}/${filename}`)
  }

  // 3. Relative URL resolved against .eaf location
  if (descriptor.relativeUrl && eafPath) {
    try {
      const normalized = eafPath.replace(/\\/g, '/')
      const base = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
      const resolved = new URL(descriptor.relativeUrl, base)
      const p = _urlToPath(resolved.href)
      if (p && !candidates.includes(p)) candidates.push(p)
    } catch { /* skip malformed relative URL */ }
  }

  // 4–5. Sibling Media/media directory
  if (eafDir && filename) {
    candidates.push(`${eafDir}/../Media/${filename}`)
    candidates.push(`${eafDir}/../media/${filename}`)
  }

  // 6. Caller-supplied directories (DefaultMediaLocation, last used MediaDir)
  for (const dir of extraDirs) {
    if (filename) candidates.push(`${dir}/${filename}`)
  }

  return candidates
}

/**
 * Computes a RELATIVE_MEDIA_URL value ('./…' or '../…', forward slashes) from the
 * document's location to a media file, for writing into MEDIA_DESCRIPTOR on save.
 * This is what makes a document portable across machines: the absolute MEDIA_URL
 * breaks when the file moves, but the relative URL survives as long as the media
 * keeps its position relative to the document.
 *
 * Returns null when no relative path exists (different Windows drives) or either
 * path is not absolute.
 */
export function relativeMediaUrl(mediaPath: string, docPath: string): string | null {
  const media = mediaPath.replace(/\\/g, '/')
  const docDir = _dirname(docPath)
  if (!docDir) return null

  const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p)
  if (!isAbs(media) || !isAbs(docDir)) return null

  const driveOf = (p: string) => /^[A-Za-z]:/.exec(p)?.[0]?.toUpperCase() ?? ''
  if (driveOf(media) !== driveOf(docDir)) return null

  const mediaParts = media.split('/').filter(Boolean)
  const dirParts   = docDir.split('/').filter(Boolean)
  let common = 0
  while (
    common < mediaParts.length - 1 &&
    common < dirParts.length &&
    mediaParts[common] === dirParts[common]
  ) common++

  const ups = dirParts.length - common
  const down = mediaParts.slice(common)
  return ups === 0 ? `./${down.join('/')}` : `${'../'.repeat(ups)}${down.join('/')}`
}

function _urlToPath(url: string): string {
  if (!url) return ''
  if (!url.startsWith('file://')) return url
  const p = url.slice(7)
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p
}

function _dirname(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const i = normalized.lastIndexOf('/')
  return i >= 0 ? normalized.slice(0, i) : ''
}

function _basename(url: string): string {
  if (!url) return ''
  const path = _urlToPath(url).replace(/\\/g, '/')
  return path.split('/').pop() ?? ''
}
