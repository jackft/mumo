import type { WaveformBins } from '@mumo/timeline'
import type { SignalPlugin, AudioCtx, SignalPost } from './SignalPlugin.js'

const MS_PER_BIN = 5

function computeWaveform(samples: Float32Array, sampleRate: number): WaveformBins {
  const numBins = Math.min(200_000, Math.max(100, Math.ceil(samples.length / sampleRate / (MS_PER_BIN / 1000))))
  const binSize = Math.max(1, Math.floor(samples.length / numBins))
  const binCount = Math.floor(samples.length / binSize)
  const peakPos = new Float32Array(binCount)
  const peakNeg = new Float32Array(binCount)
  const rms     = new Float32Array(binCount)

  for (let b = 0; b < binCount; b++) {
    let pk = 0, pn = 0, sq = 0
    const start = b * binSize, end = start + binSize
    for (let i = start; i < end; i++) {
      const v = samples[i]!
      if (v > pk) pk = v
      if (v < pn) pn = v
      sq += v * v
    }
    peakPos[b] = pk
    peakNeg[b] = pn
    rms[b]     = Math.sqrt(sq / binSize)
  }

  return { peakPos, peakNeg, rms, binDuration: binSize / sampleRate, binCount }
}

export const waveformPlugin: SignalPlugin = {
  id: 'waveform',

  // eslint-disable-next-line @typescript-eslint/require-await
  async analyze({ channels, sampleRate, trigger }: AudioCtx, post: SignalPost) {
    if (trigger === 'reanalyze') return

    for (let ch = 0; ch < channels.length; ch++) {
      const bins = computeWaveform(channels[ch]!, sampleRate)
      post(
        { type: 'waveform', channelIndex: ch, bins },
        [bins.peakPos.buffer, bins.peakNeg.buffer, bins.rms.buffer],
      )
    }
  },
}
