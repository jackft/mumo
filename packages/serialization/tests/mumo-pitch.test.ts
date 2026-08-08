/**
 * Pitch tracks in the .mumo archive: packMumo stores each channel's raw f0 under pitch/<n>.f32 with
 * a manifest entry carrying mediaKey/channelIndex; unpackMumo returns the bytes keyed by archive
 * path. The sidecar holds [times, f0, confidence] concatenated (little-endian Float32).
 */

import { describe, it, expect } from 'vitest'
import { packMumo, unpackMumo } from '../src/index.js'

const MMEAF = '<?xml version="1.0"?><ANNOTATION_DOCUMENT/>'

function toBytes(times: number[], f0: number[], confidence: number[]): Uint8Array {
  const n = f0.length
  const buf = new Float32Array(n * 3)
  buf.set(times, 0)
  buf.set(f0, n)
  buf.set(confidence, n * 2)
  return new Uint8Array(buf.buffer)
}

describe('.mumo pitch tracks', () => {
  it('round-trips a pitch track with settings, bit-exact', () => {
    const times = [0, 0.016, 0.032]
    const f0 = [120.5, 0, 121.25]
    const confidence = [0.9, 0.1, 0.85]
    const settings = { backend: 'swiftf0', minHz: 50, maxHz: 600, threshold: 0.15, confidenceThreshold: 0.5 }

    const packed = packMumo({
      mmeaf: MMEAF,
      pitch: [{ mediaKey: '/media/a.wav', channelIndex: 0, numFrames: 3, settings, data: toBytes(times, f0, confidence) }],
    })

    const unpacked = unpackMumo(packed)
    expect(unpacked.manifest.pitch).toEqual([
      { path: 'pitch/0.f32', mediaKey: '/media/a.wav', channelIndex: 0, numFrames: 3, settings },
    ])

    const raw = unpacked.pitch.get('pitch/0.f32')!
    expect(raw).toBeDefined()
    const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    const n = 3
    expect(Array.from(all.slice(0, n))).toEqual(Array.from(new Float32Array(times)))
    expect(Array.from(all.slice(n, n * 2))).toEqual(Array.from(new Float32Array(f0)))
    expect(Array.from(all.slice(n * 2, n * 3))).toEqual(Array.from(new Float32Array(confidence)))
  })

  it('persists the enabled (overlay-on) flag', () => {
    const data = toBytes([0], [100], [1])
    const packed = packMumo({
      mmeaf: MMEAF,
      pitch: [
        { mediaKey: '/m.wav', channelIndex: 0, numFrames: 1, settings: {}, enabled: true, data },
        { mediaKey: '/m.wav', channelIndex: 1, numFrames: 1, settings: {}, data },
      ],
    })
    const entries = unpackMumo(packed).manifest.pitch!
    expect(entries.find(e => e.channelIndex === 0)!.enabled).toBe(true)
    expect(entries.find(e => e.channelIndex === 1)!.enabled).toBeUndefined()
  })

  it('handles multiple channels and media', () => {
    const data = toBytes([0], [100], [1])
    const packed = packMumo({
      mmeaf: MMEAF,
      pitch: [
        { mediaKey: '/a.wav', channelIndex: 0, numFrames: 1, settings: {}, data },
        { mediaKey: '/a.wav', channelIndex: 1, numFrames: 1, settings: {}, data },
        { mediaKey: '/b.wav', channelIndex: 0, numFrames: 1, settings: {}, data },
      ],
    })
    const entries = unpackMumo(packed).manifest.pitch!
    expect(entries.length).toBe(3)
    // Every entry's bytes are recoverable by its archive path, and paths are unique.
    const paths = new Set(entries.map(e => e.path))
    expect(paths.size).toBe(3)
    for (const e of entries) expect(unpackMumo(packed).pitch.get(e.path)).toBeDefined()
    expect(entries.filter(e => e.mediaKey === '/a.wav').length).toBe(2)
  })

  it('omits the pitch key entirely when there are no tracks', () => {
    const unpacked = unpackMumo(packMumo({ mmeaf: MMEAF }))
    expect('pitch' in unpacked.manifest).toBe(false)
    expect(unpacked.pitch.size).toBe(0)
  })
})
