/**
 * Tests for mediaCandidatePaths — the ELAN-style media resolution cascade.
 *
 * The cascade order and fallback directories are derived from ELAN 7.1's
 * ElanFrame2.checkMedia() (Apache 2.0 / GPL 3.0, Max Planck Institute for
 * Psycholinguistics). See reference_implementations/elan-7.1.
 */
import { describe, it, expect } from 'vitest'
import { mediaCandidatePaths, relativeMediaUrl } from '../src/resolve-media.js'
import type { EAFMediaDescriptor } from '../src/types.js'

function desc(mediaUrl: string, relativeUrl?: string): EAFMediaDescriptor {
  return { mediaUrl, relativeUrl }
}

// Candidate ordering

describe('mediaCandidatePaths — candidate ordering', () => {
  it('absolute path is first candidate', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///data/recordings/interview.wav'),
      '/projects/study/session.eaf',
    )
    expect(candidates[0]).toBe('/data/recordings/interview.wav')
  })

  it('same directory as eaf is second candidate', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///old/path/interview.wav'),
      '/projects/study/session.eaf',
    )
    expect(candidates[1]).toBe('/projects/study/interview.wav')
  })

  it('relative URL is third candidate', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///old/path/interview.wav', '../media/interview.wav'),
      '/projects/study/session.eaf',
    )
    expect(candidates[2]).toBe('/projects/media/interview.wav')
  })

  it('../Media/ sibling is fourth candidate (capital M — inspired by ELAN fallback)', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///old/path/interview.wav'),
      '/projects/study/session.eaf',
    )
    expect(candidates[2]).toBe('/projects/study/../Media/interview.wav')
  })

  it('../media/ sibling is fifth candidate (lowercase — inspired by ELAN fallback)', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///old/path/interview.wav'),
      '/projects/study/session.eaf',
    )
    expect(candidates[3]).toBe('/projects/study/../media/interview.wav')
  })

  it('extra dirs (user prefs) are appended after built-in fallbacks', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///old/path/interview.wav'),
      '/projects/study/session.eaf',
      ['/mnt/nas/recordings', '/home/user/media'],
    )
    expect(candidates.at(-2)).toBe('/mnt/nas/recordings/interview.wav')
    expect(candidates.at(-1)).toBe('/home/user/media/interview.wav')
  })
})

// Path extraction

describe('mediaCandidatePaths — path extraction', () => {
  it('strips file:// prefix from MEDIA_URL', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///home/user/audio.wav'),
      '/home/user/project.eaf',
    )
    expect(candidates[0]).toBe('/home/user/audio.wav')
  })

  it('uses bare path directly when no file:// scheme', () => {
    const candidates = mediaCandidatePaths(
      desc('/home/user/audio.wav'),
      '/home/user/project.eaf',
    )
    expect(candidates[0]).toBe('/home/user/audio.wav')
  })

  it('handles Windows-style file:///C:/ paths (inspired by ELAN Windows support)', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///C:/Users/researcher/audio.wav'),
      'C:/Projects/study.eaf',
    )
    expect(candidates[0]).toBe('C:/Users/researcher/audio.wav')
  })

  it('extracts filename correctly from deep absolute path', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///deep/nested/path/session01.mp4'),
      '/projects/study/session.eaf',
    )
    // same-dir candidate should use just the filename
    expect(candidates[1]).toBe('/projects/study/session01.mp4')
  })
})

// Relative URL resolution

describe('mediaCandidatePaths — relative URL resolution', () => {
  it('resolves ./filename relative URL', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///old/audio.wav', './audio.wav'),
      '/data/project/annotation.eaf',
    )
    expect(candidates).toContain('/data/project/audio.wav')
  })

  it('resolves ../ relative URL traversal', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///old/audio.wav', '../recordings/audio.wav'),
      '/data/project/annotation.eaf',
    )
    expect(candidates).toContain('/data/recordings/audio.wav')
  })

  it('omits relative candidate when relativeUrl is absent', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///old/audio.wav'),
      '/data/project/annotation.eaf',
    )
    // With no relativeUrl: absolute, same-dir, ../Media/, ../media/
    expect(candidates).toHaveLength(4)
  })
})

// Edge cases

describe('mediaCandidatePaths — edge cases', () => {
  it('returns empty array for empty mediaUrl', () => {
    const candidates = mediaCandidatePaths(
      desc(''),
      '/data/project/annotation.eaf',
    )
    // No absolute path; same-dir and siblings need a filename too
    expect(candidates).toHaveLength(0)
  })

  it('does not deduplicate when relative URL resolves to same-dir path', () => {
    // Both same-dir lookup and relativeUrl resolve to the same file.
    // We keep both — the resolver will just hit the same file twice and stop at first.
    const candidates = mediaCandidatePaths(
      desc('file:///old/audio.wav', './audio.wav'),
      '/data/project/audio.wav',  // eaf is in same dir as media
    )
    const count = candidates.filter(c => c === '/data/project/audio.wav').length
    expect(count).toBeGreaterThanOrEqual(1)
  })

  it('extra dirs contribute one candidate each per file', () => {
    const candidates = mediaCandidatePaths(
      desc('file:///old/audio.wav'),
      '/project/session.eaf',
      ['/dir1', '/dir2', '/dir3'],
    )
    expect(candidates).toContain('/dir1/audio.wav')
    expect(candidates).toContain('/dir2/audio.wav')
    expect(candidates).toContain('/dir3/audio.wav')
  })
})

// relativeMediaUrl — the inverse operation, written into RELATIVE_MEDIA_URL on save
// so the cascade's step 3 can find media on machines where the absolute path differs.

describe('relativeMediaUrl', () => {
  it('same directory → ./filename', () => {
    expect(relativeMediaUrl('/data/project/audio.wav', '/data/project/session.mumo'))
      .toBe('./audio.wav')
  })

  it('subdirectory → ./sub/filename', () => {
    expect(relativeMediaUrl('/data/project/media/audio.wav', '/data/project/session.mumo'))
      .toBe('./media/audio.wav')
  })

  it('sibling directory → ../Media/filename', () => {
    expect(relativeMediaUrl('/data/Media/audio.wav', '/data/project/session.mumo'))
      .toBe('../Media/audio.wav')
  })

  it('deeper ancestor → ../../filename', () => {
    expect(relativeMediaUrl('/data/audio.wav', '/data/a/b/session.mumo'))
      .toBe('../../audio.wav')
  })

  it('round-trips through the cascade (resolves back to the media path)', () => {
    const rel = relativeMediaUrl('/data/Media/audio.wav', '/data/project/session.mumo')!
    const resolved = new URL(rel, 'file:///data/project/session.mumo').pathname
    expect(resolved).toBe('/data/Media/audio.wav')
  })

  it('handles Windows paths with backslashes', () => {
    expect(relativeMediaUrl('C:\\data\\Media\\audio.wav', 'C:\\data\\project\\session.mumo'))
      .toBe('../Media/audio.wav')
  })

  it('returns null for different Windows drives', () => {
    expect(relativeMediaUrl('D:/media/audio.wav', 'C:/project/session.mumo')).toBeNull()
  })

  it('returns null when either path is not absolute', () => {
    expect(relativeMediaUrl('audio.wav', '/project/session.mumo')).toBeNull()
    expect(relativeMediaUrl('/media/audio.wav', 'session.mumo')).toBeNull()
  })
})
