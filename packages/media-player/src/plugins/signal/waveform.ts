import type { WaveformBins } from '@mumo/timeline'
import type { SignalPlugin, SignalRun, StreamInit, AudioSegment, SignalPost } from './SignalPlugin.js'

const MS_PER_BIN = 5

// Streaming min/max/RMS binning. Bin size is derived up front from the media duration; each
// segment's owned samples are folded into the running bin, and a partial bin carries across
// segment boundaries. Bins are held (a few MB at most) and emitted once, at finish.
export const waveformPlugin: SignalPlugin = {
  id: 'waveform',

  createRun(init: StreamInit, post: SignalPost): SignalRun {
    const active = init.trigger !== 'reanalyze'  // waveform is independent of spectrogram settings
    const nc = init.channelCount
    const totalSamples = Math.max(1, Math.round(init.durationSec * init.sampleRate))
    const numBins = Math.min(200_000, Math.max(100, Math.ceil(totalSamples / init.sampleRate / (MS_PER_BIN / 1000))))
    const binSize = Math.max(1, Math.floor(totalSamples / numBins))
    const maxBins = Math.floor(totalSamples / binSize) + 1

    const peakPos = Array.from({ length: nc }, () => new Float32Array(maxBins))
    const peakNeg = Array.from({ length: nc }, () => new Float32Array(maxBins))
    const rms     = Array.from({ length: nc }, () => new Float32Array(maxBins))
    const st = Array.from({ length: nc }, () => ({ bin: 0, pk: 0, pn: 0, sq: 0, cnt: 0 }))

    return {
      pushSegment(seg: AudioSegment): void {
        if (!active) return
        for (let ch = 0; ch < nc; ch++) {
          const s = seg.channels[ch]!, c = st[ch]!
          const owned = seg.ownedSamples
          for (let i = 0; i < owned; i++) {
            const v = s[i]!
            if (v > c.pk) c.pk = v
            if (v < c.pn) c.pn = v
            c.sq += v * v
            if (++c.cnt === binSize) {
              if (c.bin < maxBins) { peakPos[ch]![c.bin] = c.pk; peakNeg[ch]![c.bin] = c.pn; rms[ch]![c.bin] = Math.sqrt(c.sq / binSize) }
              c.bin++; c.pk = 0; c.pn = 0; c.sq = 0; c.cnt = 0
            }
          }
        }
      },

      finish(): void {
        if (!active) return
        for (let ch = 0; ch < nc; ch++) {
          const binCount = Math.min(st[ch]!.bin, maxBins)
          const pp = peakPos[ch]!.slice(0, binCount)
          const pn = peakNeg[ch]!.slice(0, binCount)
          const rr = rms[ch]!.slice(0, binCount)
          const bins: WaveformBins = { peakPos: pp, peakNeg: pn, rms: rr, binDuration: binSize / init.sampleRate, binCount }
          post({ type: 'waveform', channelIndex: ch, bins }, [pp.buffer, pn.buffer, rr.buffer])
        }
      },
    }
  },
}
