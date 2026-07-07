import type { PlatformIO } from '@mumo/media-player'
import { guessMime, isDesktop } from '@mumo/media-player'
import type { EAFMediaDescriptor } from '@mumo/serialization'
import { mediaCandidatePaths } from '@mumo/serialization'

const MEDIA_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']

export type MediaResolveResult =
  | { kind: 'file'; file: File; path: string | null }
  | { kind: 'url'; url: string }

/** Any scheme with :// that isn't file:// — pass through to the media player as-is. */
function isRemoteMediaUrl(url: string): boolean {
  const i = url.indexOf('://')
  return i > 0 && !url.startsWith('file://')
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
   *   ../media/ → user prefs), then file picker as last resort.
   * - Local file on web: straight to file picker (no filesystem access).
   *
   * Returns null if the user cancels the picker.
   */
  async resolve(
    descriptor: EAFMediaDescriptor,
    eafPath: string | null,
    platform: PlatformIO,
  ): Promise<MediaResolveResult | null> {
    // Remote URLs bypass the cascade entirely — trust them as-is.
    if (isRemoteMediaUrl(descriptor.mediaUrl)) {
      return { kind: 'url', url: descriptor.mediaUrl }
    }

    if (eafPath && isDesktop(platform)) {
      const extraDirs = [this.defaultMediaDir, this.lastMediaDir].filter((d): d is string => d !== null)
      const candidates = mediaCandidatePaths(descriptor, eafPath, extraDirs)

      for (const candidatePath of candidates) {
        if (await platform.fileExists(candidatePath)) {
          const bytes = await platform.readFileAsBytes(candidatePath)
          const name = candidatePath.replace(/\\/g, '/').split('/').pop() ?? 'media'
          const mime = descriptor.mimeType ?? guessMime(name)
          return { kind: 'file', file: new File([bytes as Uint8Array<ArrayBuffer>], name, { type: mime }), path: candidatePath }
        }
      }
    }

    // All automatic paths failed — prompt the user to locate the file.
    const expectedName = descriptor.mediaUrl.replace(/\\/g, '/').split('/').pop() ?? ''
    const description = expectedName ? `Locate media file: ${expectedName}` : 'Locate media file'
    const result = await platform.openBinaryFile(MEDIA_EXTENSIONS, description)
    if (!result) return null

    // Remember the directory for the next resolve call.
    if (result.path) {
      const normalized = result.path.replace(/\\/g, '/')
      const i = normalized.lastIndexOf('/')
      if (i >= 0) this.lastMediaDir = normalized.slice(0, i)
    }

    return { kind: 'file', file: result.file, path: result.path }
  }
}
