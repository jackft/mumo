/**
 * Tests for MediaResolver — the ELAN-style media resolution cascade plus
 * remote URL pass-through.
 *
 * The cascade order (absolute path → same dir → relative URL → ../Media/ →
 * ../media/ → user prefs → file picker) is derived from ELAN 7.1's
 * ElanFrame2.checkMedia() (Apache 2.0 / GPL 3.0, Max Planck Institute for
 * Psycholinguistics). See reference_implementations/elan-7.1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// @mumo/media-player's barrel export includes .svelte files that vitest can't
// parse without the Svelte plugin. Mock only what media-resolver.ts needs.
vi.mock('@mumo/media-player', () => ({
  isDesktop: (p: unknown) => typeof p === 'object' && p !== null && 'fileExists' in p,
  guessMime: (filename: string) => {
    const ext = (filename.split('.').pop() ?? '').toLowerCase()
    const map: Record<string, string> = {
      wav: 'audio/wav', mp3: 'audio/mpeg', mp4: 'video/mp4',
      webm: 'video/webm', ogg: 'audio/ogg',
    }
    return map[ext] ?? 'application/octet-stream'
  },
}))

import { MediaResolver } from '../src/media-resolver.js'
import type { PlatformIO, DesktopPlatformIO } from '@mumo/media-player'
import type { EAFMediaDescriptor } from '@mumo/serialization'

// Mock helpers

function makeWebPlatform(pickerResult: { file: File; path: string | null } | null = null): PlatformIO {
  return {
    openTextFile: vi.fn(),
    openBinaryFile: vi.fn().mockResolvedValue(pickerResult),
    mediaUrlForFile: vi.fn().mockReturnValue('blob:mock'),
  }
}

function makeDesktopPlatform(opts: {
  existing?: string[]
  pickerResult?: { file: File; path: string | null } | null
}): DesktopPlatformIO {
  const existing = new Set(opts.existing ?? [])
  return {
    openTextFile: vi.fn(),
    openBinaryFile: vi.fn().mockResolvedValue(opts.pickerResult ?? null),
    mediaUrlForFile: vi.fn().mockReturnValue('media://mock'),
    fileExists: vi.fn().mockImplementation(async (path: string) => existing.has(path)),
    readFileAsBytes: vi.fn().mockImplementation(async (path: string) => {
      if (existing.has(path)) return new Uint8Array([1, 2, 3])
      throw new Error(`File not found: ${path}`)
    }),
  }
}

function desc(mediaUrl: string, relativeUrl?: string, mimeType?: string): EAFMediaDescriptor {
  return { mediaUrl, relativeUrl, mimeType }
}

// Remote URLs

describe('MediaResolver — remote URLs', () => {
  it('returns http:// URL directly without touching the platform', async () => {
    const resolver = new MediaResolver()
    const platform = makeWebPlatform()
    const result = await resolver.resolve(
      desc('http://corpus.example.com/audio/interview.wav'),
      null,
      platform,
    )
    expect(result).toEqual({ kind: 'url', url: 'http://corpus.example.com/audio/interview.wav' })
    expect(platform.openBinaryFile).not.toHaveBeenCalled()
  })

  it('returns https:// URL directly', async () => {
    const resolver = new MediaResolver()
    const result = await resolver.resolve(
      desc('https://example.com/video.mp4'),
      null,
      makeWebPlatform(),
    )
    expect(result).toEqual({ kind: 'url', url: 'https://example.com/video.mp4' })
  })

  it('returns rtsp:// URL directly (inspired by ELAN rtsp:// bypass)', async () => {
    const resolver = new MediaResolver()
    const result = await resolver.resolve(
      desc('rtsp://media-server.local/stream'),
      null,
      makeWebPlatform(),
    )
    expect(result).toEqual({ kind: 'url', url: 'rtsp://media-server.local/stream' })
  })

  it('does NOT treat file:// as a remote URL', async () => {
    const resolver = new MediaResolver()
    const platform = makeDesktopPlatform({ existing: ['/home/user/audio.wav'] })
    const result = await resolver.resolve(
      desc('file:///home/user/audio.wav'),
      '/home/user/project.eaf',
      platform,
    )
    expect(result?.kind).toBe('file')
  })
})

// Desktop cascade

describe('MediaResolver — desktop cascade (inspired by ELAN ElanFrame2.checkMedia)', () => {
  let resolver: MediaResolver

  beforeEach(() => { resolver = new MediaResolver() })

  it('resolves from absolute path (cascade step 1)', async () => {
    const platform = makeDesktopPlatform({ existing: ['/archive/audio.wav'] })
    const result = await resolver.resolve(
      desc('file:///archive/audio.wav'),
      '/project/session.eaf',
      platform,
    )
    expect(result).toMatchObject({ kind: 'file', path: '/archive/audio.wav' })
    expect(platform.openBinaryFile).not.toHaveBeenCalled()
  })

  it('resolves from same directory as eaf (cascade step 2)', async () => {
    const platform = makeDesktopPlatform({ existing: ['/project/audio.wav'] })
    const result = await resolver.resolve(
      desc('file:///old/path/audio.wav'),
      '/project/session.eaf',
      platform,
    )
    expect(result).toMatchObject({ kind: 'file', path: '/project/audio.wav' })
    expect(platform.openBinaryFile).not.toHaveBeenCalled()
  })

  it('resolves from relative URL (cascade step 3)', async () => {
    const platform = makeDesktopPlatform({ existing: ['/project/media/audio.wav'] })
    const result = await resolver.resolve(
      desc('file:///old/audio.wav', './media/audio.wav'),
      '/project/session.eaf',
      platform,
    )
    expect(result).toMatchObject({ kind: 'file', path: '/project/media/audio.wav' })
    expect(platform.openBinaryFile).not.toHaveBeenCalled()
  })

  it('resolves from ../Media/ sibling directory (cascade step 4, inspired by ELAN)', async () => {
    const platform = makeDesktopPlatform({
      existing: ['/project/session/../Media/audio.wav'],
    })
    const result = await resolver.resolve(
      desc('file:///old/audio.wav'),
      '/project/session/annotation.eaf',
      platform,
    )
    expect(result).toMatchObject({ kind: 'file', path: '/project/session/../Media/audio.wav' })
    expect(platform.openBinaryFile).not.toHaveBeenCalled()
  })

  it('resolves from ../media/ sibling directory (cascade step 5, inspired by ELAN)', async () => {
    const platform = makeDesktopPlatform({
      existing: ['/project/session/../media/audio.wav'],
    })
    const result = await resolver.resolve(
      desc('file:///old/audio.wav'),
      '/project/session/annotation.eaf',
      platform,
    )
    expect(result).toMatchObject({ kind: 'file', path: '/project/session/../media/audio.wav' })
    expect(platform.openBinaryFile).not.toHaveBeenCalled()
  })

  it('resolves from user-set default media directory (inspired by ELAN DefaultMediaLocation pref)', async () => {
    resolver.setDefaultMediaDir('/mnt/nas/recordings')
    const platform = makeDesktopPlatform({ existing: ['/mnt/nas/recordings/audio.wav'] })
    const result = await resolver.resolve(
      desc('file:///old/audio.wav'),
      '/project/session.eaf',
      platform,
    )
    expect(result).toMatchObject({ kind: 'file', path: '/mnt/nas/recordings/audio.wav' })
    expect(platform.openBinaryFile).not.toHaveBeenCalled()
  })

  it('resolves from last-used media directory (inspired by ELAN MediaDir pref)', async () => {
    resolver.setLastMediaDir('/recent/media')
    const platform = makeDesktopPlatform({ existing: ['/recent/media/audio.wav'] })
    const result = await resolver.resolve(
      desc('file:///old/audio.wav'),
      '/project/session.eaf',
      platform,
    )
    expect(result).toMatchObject({ kind: 'file', path: '/recent/media/audio.wav' })
    expect(platform.openBinaryFile).not.toHaveBeenCalled()
  })

  it('stops at the first hit — does not read further candidates', async () => {
    const platform = makeDesktopPlatform({ existing: ['/project/audio.wav', '/mnt/nas/recordings/audio.wav'] })
    resolver.setDefaultMediaDir('/mnt/nas/recordings')
    await resolver.resolve(
      desc('file:///old/audio.wav'),
      '/project/session.eaf',
      platform,
    )
    expect(platform.readFileAsBytes).toHaveBeenCalledTimes(1)
    expect(platform.readFileAsBytes).toHaveBeenCalledWith('/project/audio.wav')
  })
})

// Picker fallback

describe('MediaResolver — picker fallback', () => {
  it('falls back to picker when desktop cascade finds nothing', async () => {
    const pickerFile = new File([new Uint8Array([9])], 'audio.wav', { type: 'audio/wav' })
    const platform = makeDesktopPlatform({
      existing: [],
      pickerResult: { file: pickerFile, path: '/chosen/audio.wav' },
    })
    const result = await new MediaResolver().resolve(
      desc('file:///missing/audio.wav'),
      '/project/session.eaf',
      platform,
    )
    expect(result).toMatchObject({ kind: 'file', file: pickerFile, path: '/chosen/audio.wav' })
  })

  it('returns null when user cancels the picker', async () => {
    const platform = makeDesktopPlatform({ existing: [], pickerResult: null })
    const result = await new MediaResolver().resolve(
      desc('file:///missing/audio.wav'),
      '/project/session.eaf',
      platform,
    )
    expect(result).toBeNull()
  })

  it('remembers last-used directory after a picker selection', async () => {
    const pickerFile = new File([], 'audio.wav')
    const platform = makeDesktopPlatform({
      existing: [],
      pickerResult: { file: pickerFile, path: '/new/location/audio.wav' },
    })
    const resolver = new MediaResolver()
    await resolver.resolve(desc('file:///missing/audio.wav'), '/project/session.eaf', platform)

    // Second resolve should check /new/location/ before falling back to picker again
    const platform2 = makeDesktopPlatform({ existing: ['/new/location/audio.wav'] })
    const result2 = await resolver.resolve(
      desc('file:///also/missing/audio.wav'),
      '/project/session.eaf',
      platform2,
    )
    expect(result2).toMatchObject({ kind: 'file', path: '/new/location/audio.wav' })
    expect(platform2.openBinaryFile).not.toHaveBeenCalled()
  })

  // On web, there is no filesystem — go straight to the picker.
  it('skips cascade on web platform and goes straight to picker', async () => {
    const pickerFile = new File([new Uint8Array([1])], 'audio.wav')
    const platform = makeWebPlatform({ file: pickerFile, path: null })
    const result = await new MediaResolver().resolve(
      desc('file:///old/audio.wav'),
      '/project/session.eaf',
      platform,
    )
    expect(result).toMatchObject({ kind: 'file', file: pickerFile })
    expect(platform.openBinaryFile).toHaveBeenCalledTimes(1)
  })
})
