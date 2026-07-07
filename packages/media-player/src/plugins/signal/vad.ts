import type { VadSegment } from '../../types.ts'

export function computeEnergyVad(
  frameRMS: Float32Array,
  sampleRate: number,
  hop: number,
): VadSegment[] {
  const n = frameRMS.length
  const hopSec = hop / sampleRate

  const smoothFrames = Math.max(1, Math.round(0.020 * sampleRate / hop))
  const env = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0, cnt = 0
    for (let i = Math.max(0, f - smoothFrames); i <= Math.min(n - 1, f + smoothFrames); i++) {
      sum += frameRMS[i]!; cnt++
    }
    env[f] = sum / cnt
  }

  const sorted = Float32Array.from(env).sort()
  const noiseFloor = sorted[Math.floor(n * 0.10)]!
  const enterThresh = Math.max(noiseFloor * 8, 1e-4)
  const exitThresh  = Math.max(noiseFloor * 3, 5e-5)
  const minSilenceFrames = Math.max(1, Math.round(0.150 / hopSec))

  const segments: VadSegment[] = []
  let inSpeech = false, speechStart = 0, silenceCount = 0, speechCount = 0

  for (let f = 0; f < n; f++) {
    if (!inSpeech) {
      if (env[f]! >= enterThresh) {
        if (++speechCount >= 2) { inSpeech = true; speechStart = (f - 1) * hopSec; silenceCount = 0 }
      } else {
        speechCount = 0
      }
    } else {
      if (env[f]! < exitThresh) {
        if (++silenceCount >= minSilenceFrames) {
          const end = (f - silenceCount + 1) * hopSec
          if (end - speechStart >= 0.100) segments.push({ start: speechStart, end })
          inSpeech = false; speechCount = 0; silenceCount = 0
        }
      } else {
        silenceCount = 0
      }
    }
  }
  if (inSpeech) {
    const end = n * hopSec
    if (end - speechStart >= 0.100) segments.push({ start: speechStart, end })
  }
  return segments
}


async function runSileroVad(samples: Float32Array, sampleRate: number): Promise<VadSegment[] | null> {
  try {
    const { NonRealTimeVAD } = await import('@ricky0123/vad-web')
    const vad = await NonRealTimeVAD.new({
      modelURL: new URL('./silero_vad_legacy.onnx', import.meta.url).href,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      ortConfig: (ort: any) => { ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = new URL('./', import.meta.url).href },
    })
    const segments: VadSegment[] = []
    for await (const { start, end } of vad.run(samples, sampleRate)) {
      segments.push({ start: start / sampleRate, end: end / sampleRate })
    }
    return segments
  } catch {
    return null
  }
}

export async function runVadForAllChannels(
  channels: Float32Array[],
  sampleRate: number,
  frameRMSCache: Float32Array[],
  hop: number,
): Promise<VadSegment[]> {
  const all: VadSegment[] = []
  for (let ch = 0; ch < channels.length; ch++) {
    const result = await runSileroVad(channels[ch]!, sampleRate)
    all.push(...(result ?? computeEnergyVad(frameRMSCache[ch]!, sampleRate, hop)))
  }
  all.sort((a, b) => a.start - b.start)
  const merged: VadSegment[] = []
  for (const seg of all) {
    const last = merged[merged.length - 1]
    if (last && seg.start <= last.end + 0.05) last.end = Math.max(last.end, seg.end)
    else merged.push({ ...seg })
  }
  return merged
}
