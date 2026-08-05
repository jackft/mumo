import type { AudioSegment } from './plugins/signal/SignalPlugin.js'

/**
 * Buffers decoded PCM and cuts it into spectrogram-frame-aligned segments, each carrying a
 * trailing window overlap so its last owned frame is complete. Bounded to roughly one segment
 * of samples — the whole-file PCM is never resident.
 *
 * Frame F starts at absolute sample `F * hop`. A segment owns global frames `[firstFrame,
 * firstFrame + frameCount)` and provides samples `[firstFrame*hop, lastFrame*hop + windowSize)`
 * so every owned frame's window is complete; the trailing `windowSize - hop` samples are re-sent
 * at the start of the next segment. `ownedSamples` marks the non-overlapping prefix.
 */
export class SegmentProducer {
  private readonly chunks: Float32Array[][]
  private bufStart = 0   // absolute sample index of chunks[ch][0][0]
  private bufLen = 0     // samples buffered from bufStart
  private nextFrame = 0  // firstFrame of the next segment

  constructor(
    private readonly channelCount: number,
    private readonly hop: number,
    private readonly windowSize: number,
    private readonly segFrames: number,
    private readonly totalFrames: number,
  ) {
    this.chunks = Array.from({ length: channelCount }, () => [])
  }

  add(perChannel: Float32Array[], frames: number): void {
    for (let ch = 0; ch < this.channelCount; ch++) this.chunks[ch]!.push(perChannel[ch]!)
    this.bufLen += frames
  }

  private copyRange(ch: number, start: number, end: number): Float32Array {
    const out = new Float32Array(end - start)
    let pos = this.bufStart
    for (const c of this.chunks[ch]!) {
      const cStart = pos, cEnd = pos + c.length
      const from = Math.max(start, cStart), to = Math.min(end, cEnd)
      if (from < to) out.set(c.subarray(from - cStart, to - cStart), from - start)
      pos = cEnd
      if (pos >= end) break
    }
    return out
  }

  private trimTo(newStart: number): void {
    let drop = newStart - this.bufStart
    while (drop > 0 && this.chunks[0]!.length > 0 && drop >= this.chunks[0]![0]!.length) {
      const len = this.chunks[0]![0]!.length
      for (let ch = 0; ch < this.channelCount; ch++) this.chunks[ch]!.shift()
      drop -= len; this.bufStart += len; this.bufLen -= len
    }
    if (drop > 0 && this.chunks[0]!.length > 0) {
      for (let ch = 0; ch < this.channelCount; ch++) this.chunks[ch]![0] = this.chunks[ch]![0]!.subarray(drop)
      this.bufStart += drop; this.bufLen -= drop
    }
  }

  /** Return the next ready segment, or null if more data is needed (unless `final`). */
  tryCut(final: boolean): AudioSegment | null {
    const F0 = this.nextFrame
    if (F0 >= this.totalFrames) return null
    const bufEnd = this.bufStart + this.bufLen
    let F1 = Math.min(F0 + this.segFrames, this.totalFrames)
    const segStart = F0 * this.hop
    let neededEnd = (F1 - 1) * this.hop + this.windowSize
    if (!final && bufEnd < neededEnd) return null

    let segEnd: number
    if (bufEnd >= neededEnd) {
      segEnd = neededEnd
    } else {
      // final drain with fewer samples than a full segment: use what's buffered
      const avail = Math.floor((bufEnd - segStart - this.windowSize) / this.hop) + 1
      F1 = Math.min(F0 + Math.max(0, avail), this.totalFrames)
      if (F1 <= F0) { this.nextFrame = this.totalFrames; return null }
      neededEnd = (F1 - 1) * this.hop + this.windowSize
      segEnd = Math.min(neededEnd, bufEnd)
    }

    const frameCount = F1 - F0
    const isLast = F1 >= this.totalFrames
    const ownedSamples = isLast ? segEnd - segStart : frameCount * this.hop
    const channels = Array.from({ length: this.channelCount }, (_, ch) => this.copyRange(ch, segStart, segEnd))
    this.nextFrame = F1
    this.trimTo(F1 * this.hop)
    return { channels, startSample: segStart, ownedSamples, firstFrame: F0, frameCount, isLast }
  }
}
