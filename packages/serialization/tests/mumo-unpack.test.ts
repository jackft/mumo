/**
 * unpackMumo tolerance for hand-rolled archives: compressing a folder in a file
 * manager (e.g. Nautilus) nests every entry under the folder name — the shared
 * directory prefix must be stripped so manifest lookups still work.
 */

import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { unpackMumo } from '../src/index.js'

const MMEAF = '<?xml version="1.0"?><ANNOTATION_DOCUMENT/>'
const MANIFEST = JSON.stringify({ version: 1, mmeaf: 'project.mmeaf', images: [{ path: 'images/a.png' }], spectrograms: [] })

describe('unpackMumo archive layouts', () => {
  it('opens archives with entries nested under a folder', () => {
    const zipped = zipSync({
      'my_project/': new Uint8Array(0),
      'my_project/manifest.json': strToU8(MANIFEST),
      'my_project/project.mmeaf': strToU8(MMEAF),
      'my_project/images/a.png': new Uint8Array([1, 2, 3]),
    })
    const unpacked = unpackMumo(zipped)
    expect(unpacked.manifest.mmeaf).toBe('project.mmeaf')
    expect(unpacked.mmeaf).toBe(MMEAF)
    expect(Array.from(unpacked.images.get('images/a.png')!)).toEqual([1, 2, 3])
  })

  it('opens doubly-nested archives', () => {
    const zipped = zipSync({
      'outer/inner/manifest.json': strToU8(MANIFEST),
      'outer/inner/project.mmeaf': strToU8(MMEAF),
    })
    expect(unpackMumo(zipped).manifest.mmeaf).toBe('project.mmeaf')
  })

  it('still rejects archives without a manifest', () => {
    const zipped = zipSync({
      'a/project.mmeaf': strToU8(MMEAF),
      'b/readme.txt': strToU8('nope'),
    })
    expect(() => unpackMumo(zipped)).toThrow('missing manifest.json')
  })
})
