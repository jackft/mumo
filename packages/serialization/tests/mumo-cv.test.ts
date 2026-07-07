/**
 * CV artifacts in the .mumo archive: packMumo stores them under cv/ with
 * manifest entries; unpackMumo returns entries + bytes. Legacy manifests
 * (cv: null or the old MumoCVPaths shape) must still parse as empty.
 */

import { describe, it, expect } from 'vitest'
import { zipSync, strToU8, strFromU8 } from 'fflate'
import { packMumo, unpackMumo } from '../src/index.js'
import type { MumoManifest } from '../src/index.js'

const MMEAF = '<?xml version="1.0"?><ANNOTATION_DOCUMENT/>'

describe('.mumo cv artifacts', () => {
  it('round-trips cv artifacts with kind, label, and params', () => {
    const homography = strToU8('{"matrix":[1,0,0,0,1,0,0,0,1]}')
    const packed = packMumo({
      mmeaf: MMEAF,
      cvArtifacts: [
        { filename: 'homography.json', data: homography, kind: 'homography', label: 'Camera 1 → floor plan', params: { camera: 'cam1' } },
        { filename: 'masks.bin', data: new Uint8Array([1, 2, 3]), kind: 'segmentation' },
      ],
    })

    const unpacked = unpackMumo(packed)
    expect(unpacked.cvEntries).toEqual([
      { path: 'cv/homography.json', kind: 'homography', label: 'Camera 1 → floor plan', params: { camera: 'cam1' } },
      { path: 'cv/masks.bin', kind: 'segmentation' },
    ])
    expect(strFromU8(unpacked.cvFiles.get('cv/homography.json')!)).toContain('matrix')
    expect(Array.from(unpacked.cvFiles.get('cv/masks.bin')!)).toEqual([1, 2, 3])
  })

  it('omits the cv key entirely when there are no artifacts', () => {
    const unpacked = unpackMumo(packMumo({ mmeaf: MMEAF }))
    expect('cv' in unpacked.manifest).toBe(false)
    expect(unpacked.cvEntries).toEqual([])
    expect(unpacked.cvFiles.size).toBe(0)
  })

  it('treats legacy cv: null and MumoCVPaths manifests as empty', () => {
    for (const legacyCv of [null, { homography: null, annotations: null }]) {
      const manifest = {
        version: 1,
        mmeaf: 'project.mmeaf',
        images: [],
        spectrograms: [],
        cv: legacyCv,
      } as unknown as MumoManifest
      const zipped = zipSync({
        'manifest.json': strToU8(JSON.stringify(manifest)),
        'project.mmeaf': strToU8(MMEAF),
      })
      const unpacked = unpackMumo(zipped)
      expect(unpacked.cvEntries).toEqual([])
      expect(unpacked.cvFiles.size).toBe(0)
    }
  })
})
