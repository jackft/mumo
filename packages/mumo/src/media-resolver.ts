import type { PlatformIO } from '@mumo/media-player'
import { guessMime, isDesktop } from '@mumo/media-player'
import type { EAFMediaDescriptor } from '@mumo/serialization'
import { mediaCandidatePaths } from '@mumo/serialization'

const MEDIA_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']

export type MediaResolveResult =
  | { kind: 'file'; file: File; path: string | null }
  | { kind: 'url'; url: string }

/** Any scheme with :// that isn't file:// or media:// — pass through to the media player as-is. */
function isRemoteMediaUrl(url: string): boolean {
  const i = url.indexOf('://')
  return i > 0 && !url.startsWith('file://') && !url.startsWith('media://')
}

/**
 * media://localhost/... is Electron's streaming scheme; older saves persisted it as
 * MEDIA_URL, but it's machine-specific. Returns the decoded filesystem path so the
 * cascade can treat it like any other local path, or null if the URL isn't that scheme.
 */
function extractMachineLocalPath(url: string): string | null {
  if (!url.startsWith('media://localhost/')) return null
  try {
    return decodeURIComponent(new URL(url).pathname)
  } catch {
    return null
  }
}

export class MediaResolver {
  private defaultMediaDir: string | null = null
  private lastMediaDir: string | null = null

  setDefaultMediaDir(dir: string | null): void { this.defaultMediaDir = dir }
  setLastMediaDir(dir: string | null): void { this.lastMediaDir = dir }

  /**
   * Resolves a media descriptor following ELAN's logic:
   *
   * - Remote URL (http/https/rtsp/…): returned as-is — the media player handles it directly.
   * - Local file on desktop: ELAN cascade (absolute → same dir → relative → ../Media/ →
   *   ../media/ → user prefs), then file picker as last resort. media://localhost/… URLs
   *   from older saves are normalized to plain paths and go through the same cascade.
   * - Local file on web: straight to file picker (no filesystem access).
   *
   * Desktop results carry an empty File shell + path; the media player streams the file
   * via its own URL scheme. Never reads media bytes here — files can be multi-GB videos.
   *
   * Returns null if the user cancels the picker.
   */
  async resolve(
    descriptor: EAFMediaDescriptor,
    eafPath: string | null,
    platform: PlatformIO,
  ): Promise<MediaResolveResult | null> {
    // Truly remote URLs bypass the cascade entirely — trust them as-is.
    if (isRemoteMediaUrl(descriptor.mediaUrl)) {
      console.log(`[media] remote url: ${descriptor.mediaUrl}`)
      return { kind: 'url', url: descriptor.mediaUrl }
    }

    // Normalize machine-specific media:// URLs to plain paths; the absolute path is
    // cascade candidate #1, so "still exists here" needs no special case.
    const machineLocalPath = extractMachineLocalPath(descriptor.mediaUrl)
    const desc = machineLocalPath ? { ...descriptor, mediaUrl: machineLocalPath } : descriptor

    if (eafPath && isDesktop(platform)) {
      const extraDirs = [this.defaultMediaDir, this.lastMediaDir].filter((d): d is string => d !== null)
      const candidates = mediaCandidatePaths(desc, eafPath, extraDirs)

      for (const candidatePath of candidates) {
        if (await platform.fileExists(candidatePath)) {
          const name = candidatePath.replace(/\\/g, '/').split('/').pop() ?? 'media'
          const mime = desc.mimeType ?? guessMime(name)
          console.log(`[media] resolved: ${name} → ${candidatePath}`)
          return { kind: 'file', file: new File([], name, { type: mime }), path: candidatePath }
        }
      }
      console.warn(`[media] not found on disk (${candidates.length} candidates tried): ${desc.mediaUrl}`)
    }

    // All automatic paths failed — prompt the user to locate the file.
    const expectedName = desc.mediaUrl.replace(/\\/g, '/').split('/').pop() ?? ''
    const description = expectedName
      ? `'${expectedName}' not found — locate it, or cancel to skip`
      : 'Locate media file'
    console.log(`[media] prompting file picker: ${description}`)
    const result = await platform.openBinaryFile(MEDIA_EXTENSIONS, description)
    if (!result) { console.log('[media] file picker cancelled'); return null }

    // Remember the directory for the next resolve call.
    if (result.path) {
      const normalized = result.path.replace(/\\/g, '/')
      const i = normalized.lastIndexOf('/')
      if (i >= 0) this.lastMediaDir = normalized.slice(0, i)
    }

    return { kind: 'file', file: result.file, path: result.path }
  }
}
