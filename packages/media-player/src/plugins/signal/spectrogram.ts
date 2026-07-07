import type { SampleBuffer as WasmSampleBuffer } from 'audio-analysis-wasm'
import type { SpectrogramTile } from '@mumo/timeline'
const SPEC_DB_FLOOR = -160
const SPEC_DB_RANGE = 160
import type { SpectrogramSettings } from '../../types.js'
import { PREVIEW_SPEC_SETTINGS } from '../../types.js'
import type { SignalPlugin, AudioCtx, SignalPost } from './SignalPlugin.js'
import { runVadForAllChannels } from './vad.js'

let wasmSB: typeof WasmSampleBuffer | null = null
export function setSampleBuffer(sb: typeof WasmSampleBuffer): void { wasmSB = sb }

const TILE_FRAMES     = 2048
const OVERVIEW_MAX_WIDTH = 4096
const NUM_SNAP_BANDS  = 4

function windowCode(w: SpectrogramSettings['window']): number {
  if (w === 'hamming')  return 1
  if (w === 'gaussian') return 2
  return 0
}

function nearestPow2(n: number): number {
  const lower = Math.pow(2, Math.floor(Math.log2(Math.max(n, 1))))
  const upper = lower * 2
  return upper - n < n - lower ? upper : lower
}

function toSamples(settings: SpectrogramSettings, sampleRate: number) {
  return {
    windowSize: nearestPow2(settings.windowLengthSec * sampleRate),
    hop: Math.max(1, Math.round(settings.hopSec * sampleRate)),
  }
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]!; re[j] = t!
      t = im[i]; im[i] = im[j]!; im[j] = t!
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wRe = Math.cos(ang), wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0
      for (let j = 0; j < (len >> 1); j++) {
        const uRe = re[i + j]!, uIm = im[i + j]!
        const vRe = re[i + j + (len >> 1)]! * curRe - im[i + j + (len >> 1)]! * curIm
        const vIm = re[i + j + (len >> 1)]! * curIm + im[i + j + (len >> 1)]! * curRe
        re[i + j] = uRe + vRe;               im[i + j] = uIm + vIm
        re[i + j + (len >> 1)] = uRe - vRe;  im[i + j + (len >> 1)] = uIm - vIm
        const nr = curRe * wRe - curIm * wIm; curIm = curRe * wIm + curIm * wRe; curRe = nr
      }
    }
  }
}

function buildWindow(size: number, kind: SpectrogramSettings['window']): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    if (kind === 'hamming') {
      w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1))
    } else if (kind === 'gaussian') {
      const half = size / 2, t = (i - half) / half
      w[i] = Math.exp(-Math.PI * t * t)
    } else {
      w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
    }
  }
  return w
}


type MelBand = Array<[number, number]>

function buildMelFilterbankJS(sampleRate: number, numLinearBins: number, melBands: number, maxFreqHz: number): MelBand[] {
  const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700)
  const melToHz = (mel: number) => 700 * (Math.pow(10, mel / 2595) - 1)
  const maxFreq = Math.min(maxFreqHz, sampleRate / 2)
  const minMel = hzToMel(0), maxMel = hzToMel(maxFreq)
  const freqPerBin = sampleRate / (2 * numLinearBins)
  const melPoints = Array.from({ length: melBands + 2 }, (_, i) => minMel + (maxMel - minMel) * i / (melBands + 1))
  const binPoints = melPoints.map(m => Math.min(Math.round(melToHz(m) / freqPerBin), numLinearBins - 1))
  return Array.from({ length: melBands }, (_, m) => {
    const lo = binPoints[m]!, center = binPoints[m + 1]!, hi = binPoints[m + 2]!
    const band: MelBand = []
    if (center > lo) { for (let k = lo; k < center; k++) band.push([k, (k - lo) / (center - lo)]) }
    band.push([center, 1.0])
    if (hi > center) { for (let k = center + 1; k <= hi; k++) band.push([k, (hi - k) / (hi - center)]) }
    return band
  })
}

function applyMelJS(re: Float64Array, im: Float64Array, filterbank: MelBand[], curMag: Float32Array): void {
  for (let m = 0; m < filterbank.length; m++) {
    let energy = 0
    for (const [k, w] of filterbank[m]!) {
      const r = re[k]!, im_ = im[k]!
      energy += (r * r + im_ * im_) * w
    }
    curMag[m] = 10 * Math.log10(energy + 1e-20)
  }
}

function computeSpectrogramStatsJS(
  samples: Float32Array,
  sampleRate: number,
  windowSize: number,
  hop: number,
  maxFreqHz: number,
  dynamicRangeDb: number,
  win: Float32Array,
  melFilterbank: MelBand[] | null,
  onProgress?: (done: number) => void,
) {
  maxFreqHz = Math.min(maxFreqHz, sampleRate / 2)
  const maxBin = Math.round(maxFreqHz / (sampleRate / windowSize))
  const numLinearBins = Math.min(maxBin, windowSize / 2)
  const numFreqBins = melFilterbank ? melFilterbank.length : numLinearBins
  const numFrames = Math.max(1, Math.floor((samples.length - windowSize) / hop) + 1)
  const overviewWidth = Math.min(numFrames, OVERVIEW_MAX_WIDTH)
  const overviewBinSize = Math.ceil(numFrames / overviewWidth)
  const overviewAccum = new Float64Array(overviewWidth * numFreqBins)
  const overviewCount = new Uint32Array(overviewWidth)
  const flux = new Float32Array(numFrames)
  const bandFlux = new Float32Array(numFrames * NUM_SNAP_BANDS)
  const frameRMS = new Float32Array(numFrames)
  let globalMin = Infinity, globalMax = -Infinity
  const re = new Float64Array(windowSize), im = new Float64Array(windowSize)
  const prevMag = new Float32Array(numFreqBins), curMag = new Float32Array(numFreqBins)
  const framePeakDb = new Float32Array(numFrames)

  for (let f = 0; f < numFrames; f++) {
    const frameStart = f * hop
    re.fill(0); im.fill(0)
    for (let j = 0; j < windowSize; j++) {
      const idx = frameStart + j
      re[j] = idx < samples.length ? (samples[idx]! * win[j]!) : 0
    }
    fft(re, im)
    if (melFilterbank) {
      applyMelJS(re, im, melFilterbank, curMag)
    } else {
      for (let k = 0; k < numLinearBins; k++) {
        curMag[k] = 20 * Math.log10(Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!) + 1e-10)
      }
    }
    let fluxSum = 0, framePeak = -Infinity
    for (let k = 0; k < numFreqBins; k++) {
      const db = curMag[k]!
      if (db < globalMin) globalMin = db
      if (db > globalMax) globalMax = db
      if (db > framePeak) framePeak = db
      if (f > 0) {
        const d = db - prevMag[k]!
        if (d > 0) {
          fluxSum += d
          const b = Math.min(NUM_SNAP_BANDS - 1, Math.floor(k * NUM_SNAP_BANDS / numFreqBins))
          const bIdx = f * NUM_SNAP_BANDS + b
          bandFlux[bIdx] = bandFlux[bIdx]! + d
        }
      }
    }
    framePeakDb[f] = framePeak
    flux[f] = fluxSum; prevMag.set(curMag)
    const oBin = Math.min(Math.floor(f / overviewBinSize), overviewWidth - 1)
    for (let k = 0; k < numFreqBins; k++) {
      const oIdx = oBin * numFreqBins + k
      overviewAccum[oIdx] = overviewAccum[oIdx]! + curMag[k]!
    }
    overviewCount[oBin] = overviewCount[oBin]! + 1
    let sq = 0
    const end = Math.min(frameStart + hop, samples.length)
    for (let i = frameStart; i < end; i++) sq += samples[i]! * samples[i]!
    frameRMS[f] = Math.sqrt(sq / (end - frameStart))
    if (onProgress && (f + 1) % TILE_FRAMES === 0) onProgress(f + 1)
  }
  if (onProgress) onProgress(numFrames)

  // Quantise the averaged overview dB values to rawDb (same encoding as detail tiles)
  // so the Timeline applies the same adaptive LUT to both.
  const overviewRawDb = new Uint8Array(overviewWidth * numFreqBins)
  for (let x = 0; x < overviewWidth; x++) {
    const cnt = overviewCount[x] || 1
    for (let k = 0; k < numFreqBins; k++) {
      const db = overviewAccum[x * numFreqBins + k]! / cnt
      const q = Math.max(0, Math.min(255, Math.round((db - SPEC_DB_FLOOR) / SPEC_DB_RANGE * 255)))
      overviewRawDb[(numFreqBins - 1 - k) * overviewWidth + x] = q
    }
  }
  return { numFreqBins, numLinearBins, numFrames, overviewRawDb, overviewWidth, flux, bandFlux, frameRMS }
}

// Produce a rawDb tile: one uint8 per (freq-bin, frame), quantised to SPEC_DB_FLOOR..+SPEC_DB_RANGE.
// The Timeline applies a per-viewport LUT when uploading to GPU.
function renderDetailTileRawDb(
  samples: Float32Array,
  windowSize: number, hop: number, win: Float32Array,
  numLinearBins: number, numFreqBins: number,
  startFrame: number, endFrame: number,
  melFilterbank: MelBand[] | null,
): Uint8Array {
  const tileWidth = endFrame - startFrame
  const rawDb = new Uint8Array(tileWidth * numFreqBins)
  const re = new Float64Array(windowSize), im = new Float64Array(windowSize)
  const curMag = new Float32Array(numFreqBins)
  for (let f = startFrame; f < endFrame; f++) {
    const frameStart = f * hop
    re.fill(0); im.fill(0)
    for (let j = 0; j < windowSize; j++) {
      const idx = frameStart + j
      re[j] = idx < samples.length ? (samples[idx]! * win[j]!) : 0
    }
    fft(re, im)
    if (melFilterbank) {
      applyMelJS(re, im, melFilterbank, curMag)
    } else {
      for (let k = 0; k < numLinearBins; k++) {
        curMag[k] = 20 * Math.log10(Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!) + 1e-10)
      }
    }
    const localF = f - startFrame
    for (let k = 0; k < numFreqBins; k++) {
      const q = Math.max(0, Math.min(255, Math.round((curMag[k]! - SPEC_DB_FLOOR) / SPEC_DB_RANGE * 255)))
      rawDb[(numFreqBins - 1 - k) * tileWidth + localF] = q
    }
  }
  return rawDb
}

function computeOnsets(flux: Float32Array, frameRMS: Float32Array, sampleRate: number, hop: number) {
  const n = flux.length
  if (n < 4) return { timestamps: new Float32Array(0), strengths: new Float32Array(0) }
  const hopSec = hop / sampleRate
  const smoothFrames = Math.max(1, Math.round(0.005 * sampleRate / hop))
  const env = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0, cnt = 0
    for (let i = Math.max(0, f - smoothFrames); i <= Math.min(n - 1, f + smoothFrames); i++) { sum += frameRMS[i]!; cnt++ }
    env[f] = sum / cnt
  }
  const rmsSorted = Float32Array.from(env).sort()
  const speechThreshold = Math.max(rmsSorted[Math.floor(n * 0.15)]! * 3, 1e-4)
  const deriv = new Float32Array(n)
  for (let f = 1; f < n - 1; f++) deriv[f] = env[f + 1]! - env[f - 1]!
  let maxPos = 0, maxNeg = 0
  for (let f = 0; f < n; f++) { if (deriv[f]! > maxPos) maxPos = deriv[f]!; if (deriv[f]! < maxNeg) maxNeg = deriv[f]! }

  const events: Array<{ time: number; strength: number }> = []
  for (let f = 1; f < n - 1; f++) {
    const d = deriv[f]!
    if (d > maxPos * 0.12 && d >= (deriv[f - 1] ?? 0) && d >= (deriv[f + 1] ?? 0))
      events.push({ time: f * hopSec, strength: maxPos > 0 ? 0.3 + 0.7 * (d / maxPos) : 0.5 })
    if (d < maxNeg * 0.12 && d <= (deriv[f - 1] ?? 0) && d <= (deriv[f + 1] ?? 0))
      events.push({ time: f * hopSec, strength: maxNeg !== 0 ? 0.25 + 0.55 * (d / maxNeg) : 0.4 })
  }

  let maxFlux = 0
  for (let t = 0; t < n; t++) if (flux[t]! > maxFlux) maxFlux = flux[t]!
  const FW = Math.round(0.25 * sampleRate / hop)
  for (let t = 1; t < n - 1; t++) {
    if (env[t]! < speechThreshold * 0.5) continue
    const lo = Math.max(0, t - FW), hi = Math.min(n, t + FW)
    const slice = Array.from(flux.slice(lo, hi)).sort((a, b) => a - b)
    const median = slice[Math.floor(slice.length / 2)]!
    if (flux[t]! >= median * 2.0 && flux[t]! >= (flux[t - 1] ?? 0) && flux[t]! >= (flux[t + 1] ?? 0))
      events.push({ time: t * hopSec, strength: maxFlux > 0 ? 0.15 + 0.45 * (flux[t]! / maxFlux) : 0.3 })
  }

  events.sort((a, b) => a.time - b.time)
  const merged: typeof events = []
  for (const ev of events) {
    const last = merged[merged.length - 1]
    if (last && ev.time - last.time < 0.030) { if (ev.strength > last.strength) merged[merged.length - 1] = ev }
    else merged.push(ev)
  }
  return { timestamps: new Float32Array(merged.map(e => e.time)), strengths: new Float32Array(merged.map(e => e.strength)) }
}

function detectFluxPeaks(flux: Float32Array, sampleRate: number, hop: number) {
  const n = flux.length
  if (n < 3) return { timestamps: new Float32Array(0), strengths: new Float32Array(0) }
  const hopSec = hop / sampleRate
  let maxFlux = 0
  for (let t = 0; t < n; t++) if (flux[t]! > maxFlux) maxFlux = flux[t]!
  const W = Math.round(0.3 * sampleRate / hop)
  const events: Array<{ time: number; strength: number }> = []
  for (let t = 1; t < n - 1; t++) {
    const lo = Math.max(0, t - W), hi = Math.min(n, t + W)
    const slice = Array.from(flux.slice(lo, hi)).sort((a, b) => a - b)
    const median = slice[Math.floor(slice.length / 2)]!
    if (flux[t]! >= median * 2.5 && flux[t]! >= (flux[t - 1] ?? 0) && flux[t]! >= (flux[t + 1] ?? 0))
      events.push({ time: t * hopSec, strength: maxFlux > 0 ? 0.15 + 0.45 * (flux[t]! / maxFlux) : 0.3 })
  }
  return { timestamps: new Float32Array(events.map(e => e.time)), strengths: new Float32Array(events.map(e => e.strength)) }
}

type RunResult = { flux: Float32Array; bandFlux: Float32Array; numSnapBands: number; frameRMS: Float32Array }

function runChannelWasm(
  samples: Float32Array, sampleRate: number, duration: number,
  settings: SpectrogramSettings, channelIndex: number,
  doneRef: { value: number }, totalFrames: number,
  post: SignalPost,
): RunResult {
  const SB = wasmSB
  if (!SB) throw new Error('WASM not loaded')
  const { windowSize, hop } = toSamples(settings, sampleRate)
  const buf = new SB(samples, windowSize, windowCode(settings.window))
  try {
    const base = doneRef.value
    const melBands = settings.scale === 'mel' ? settings.melBands : 0
    const stats = buf.compute_stats(hop, settings.maxFreqHz, sampleRate, settings.dynamicRangeDb, melBands, (done: number, _total: number) => {
      doneRef.value = base + done
      post({ type: 'progress', done: doneRef.value, total: totalFrames })
    })
    const { num_freq_bins: numFreqBins, num_frames: numFrames, num_snap_bands: numSnapBands } = stats
    // Discard WASM overview pixels — we build a rawDb overview from JS tiles instead.
    stats.take_overview_pixels()
    const flux     = new Float32Array(stats.take_flux())
    const bandFlux = new Float32Array(stats.take_band_flux())
    const frameRMS = new Float32Array(stats.take_frame_rms())
    stats.free()

    doneRef.value = base + numFrames
    post({ type: 'progress', done: doneRef.value, total: totalFrames })

    // Emit rawDb detail tiles and accumulate into overview simultaneously.
    const win = buildWindow(windowSize, settings.window)
    const maxBin = Math.round(Math.min(settings.maxFreqHz, sampleRate / 2) / (sampleRate / windowSize))
    const numLinearBinsJS = Math.min(maxBin, windowSize / 2)
    const melFbJS = settings.scale === 'mel'
      ? buildMelFilterbankJS(sampleRate, numLinearBinsJS, settings.melBands, settings.maxFreqHz)
      : null

    const hopDuration = hop / sampleRate, tileCount = Math.ceil(numFrames / TILE_FRAMES)
    const ovWidth = Math.min(numFrames, OVERVIEW_MAX_WIDTH)
    const ovBinSize = Math.ceil(numFrames / ovWidth)
    const ovAccum = new Float32Array(ovWidth * numFreqBins)
    const ovCount = new Uint32Array(ovWidth)
    const p2Base = doneRef.value
    for (let t = 0; t < tileCount; t++) {
      const sf = t * TILE_FRAMES, ef = Math.min((t + 1) * TILE_FRAMES, numFrames)
      const rawDb = renderDetailTileRawDb(samples, windowSize, hop, win, numLinearBinsJS, numFreqBins, sf, ef, melFbJS)
      // Accumulate into overview (work in rawDb units to avoid float↔dB conversions)
      for (let f = sf; f < ef; f++) {
        const ob = Math.min(Math.floor(f / ovBinSize), ovWidth - 1)
        const localF = f - sf
        for (let k = 0; k < numFreqBins; k++) {
          const idx = ob * numFreqBins + k
          ovAccum[idx] = (ovAccum[idx]! + rawDb[(numFreqBins - 1 - k) * (ef - sf) + localF]!)
        }
        ovCount[ob] = ovCount[ob]! + 1
      }
      const tile: SpectrogramTile = { tileIndex: t, rawDb, width: ef - sf, height: numFreqBins, timeStart: sf * hopDuration, timeEnd: t === tileCount - 1 ? duration : ef * hopDuration }
      doneRef.value = p2Base + ef
      post({ type: 'progress', done: doneRef.value, total: totalFrames })
      post({ type: 'spectrogramTile', channelIndex, tile }, [rawDb.buffer])
    }
    // Build and send the overview after all tiles so it uses the same rawDb encoding.
    const overviewRawDb = new Uint8Array(ovWidth * numFreqBins)
    for (let x = 0; x < ovWidth; x++) {
      const cnt = ovCount[x] || 1
      for (let k = 0; k < numFreqBins; k++)
        overviewRawDb[(numFreqBins - 1 - k) * ovWidth + x] = Math.round(ovAccum[x * numFreqBins + k]! / cnt)
    }
    post({ type: 'spectrogramOverview', channelIndex, tile: { tileIndex: -1, rawDb: overviewRawDb, width: ovWidth, height: numFreqBins, timeStart: 0, timeEnd: duration } }, [overviewRawDb.buffer])

    return { flux, bandFlux, numSnapBands, frameRMS }
  } finally {
    buf.free()
  }
}

function runChannelJS(
  samples: Float32Array, sampleRate: number, duration: number,
  settings: SpectrogramSettings, channelIndex: number,
  doneRef: { value: number }, totalFrames: number,
  post: SignalPost,
): RunResult {
  const { windowSize, hop } = toSamples(settings, sampleRate)
  const win = buildWindow(windowSize, settings.window)
  const p1Base = doneRef.value
  const maxBin = Math.round(Math.min(settings.maxFreqHz, sampleRate / 2) / (sampleRate / windowSize))
  const numLinearBinsJS = Math.min(maxBin, windowSize / 2)
  const melFilterbankJS = settings.scale === 'mel'
    ? buildMelFilterbankJS(sampleRate, numLinearBinsJS, settings.melBands, settings.maxFreqHz)
    : null

  const { numFreqBins, numLinearBins, numFrames: nf, overviewRawDb, overviewWidth, flux, bandFlux, frameRMS }
    = computeSpectrogramStatsJS(samples, sampleRate, windowSize, hop, settings.maxFreqHz, settings.dynamicRangeDb, win, melFilterbankJS, done => {
        doneRef.value = p1Base + done
        post({ type: 'progress', done: doneRef.value, total: totalFrames })
      })

  doneRef.value = p1Base + nf
  post({ type: 'spectrogramOverview', channelIndex, tile: { tileIndex: -1, rawDb: overviewRawDb, width: overviewWidth, height: numFreqBins, timeStart: 0, timeEnd: duration } }, [overviewRawDb.buffer])

  const hopDuration = hop / sampleRate, tileCount = Math.ceil(nf / TILE_FRAMES), p2Base = doneRef.value
  for (let t = 0; t < tileCount; t++) {
    const sf = t * TILE_FRAMES, ef = Math.min((t + 1) * TILE_FRAMES, nf)
    const rawDb = renderDetailTileRawDb(samples, windowSize, hop, win, numLinearBins, numFreqBins, sf, ef, melFilterbankJS)
    const tile: SpectrogramTile = { tileIndex: t, rawDb, width: ef - sf, height: numFreqBins, timeStart: sf * hopDuration, timeEnd: t === tileCount - 1 ? duration : ef * hopDuration }
    doneRef.value = p2Base + ef
    post({ type: 'progress', done: doneRef.value, total: totalFrames })
    post({ type: 'spectrogramTile', channelIndex, tile }, [rawDb.buffer])
  }

  return { flux, bandFlux, numSnapBands: NUM_SNAP_BANDS, frameRMS }
}

function runPreview(ctx: AudioCtx, post: SignalPost): void {
  const { channels, sampleRate, duration, settings } = ctx
  const { windowSize, hop } = toSamples(PREVIEW_SPEC_SETTINGS, sampleRate)
  const { maxFreqHz, dynamicRangeDb } = PREVIEW_SPEC_SETTINGS
  const melBands = settings.scale === 'mel' ? settings.melBands : 0
  const win = buildWindow(windowSize, PREVIEW_SPEC_SETTINGS.window)

  for (let ch = 0; ch < channels.length; ch++) {
    const samples = channels[ch]!
    const maxBin = Math.round(Math.min(maxFreqHz, sampleRate / 2) / (sampleRate / windowSize))
    const numLinearBins = Math.min(maxBin, windowSize / 2)
    const melFb = melBands > 0 ? buildMelFilterbankJS(sampleRate, numLinearBins, melBands, maxFreqHz) : null
    const { overviewRawDb, overviewWidth, numFreqBins } = computeSpectrogramStatsJS(samples, sampleRate, windowSize, hop, maxFreqHz, dynamicRangeDb, win, melFb)
    post(
      { type: 'spectrogramOverview', channelIndex: ch, tile: { tileIndex: -1, rawDb: overviewRawDb, width: overviewWidth, height: numFreqBins, timeStart: 0, timeEnd: duration } },
      [overviewRawDb.buffer],
    )
  }
}

export const spectrogramPlugin: SignalPlugin = {
  id: 'spectrogram',

  async analyze(ctx: AudioCtx, post: SignalPost): Promise<void> {
    const { channels, sampleRate, duration, settings, trigger } = ctx
    const { windowSize, hop } = toSamples(settings, sampleRate)
    const sampleLen  = channels[0]!.length
    const numFrames  = Math.max(1, Math.floor((sampleLen - windowSize) / hop) + 1)
    const totalFrames = numFrames * channels.length * 2
    const doneRef = { value: 0 }
    const frameRMSCache: Float32Array[] = []

    if (trigger !== 'reanalyze') runPreview(ctx, post)

    for (let ch = 0; ch < channels.length; ch++) {
      const samples = channels[ch]!
      let result: RunResult

      if (wasmSB) {
        result = runChannelWasm(samples, sampleRate, duration, settings, ch, doneRef, totalFrames, post)
      } else {
        result = runChannelJS(samples, sampleRate, duration, settings, ch, doneRef, totalFrames, post)
      }

      const { flux, bandFlux, numSnapBands, frameRMS } = result
      frameRMSCache[ch] = frameRMS

      const { timestamps, strengths } = computeOnsets(flux, frameRMS, sampleRate, hop)
      const bandTimestamps: Float32Array[] = [], bandStrengths: Float32Array[] = []
      for (let b = 0; b < numSnapBands; b++) {
        const slice = new Float32Array(flux.length)
        for (let f = 0; f < flux.length; f++) slice[f] = bandFlux[f * numSnapBands + b]!
        const { timestamps: bt, strengths: bs } = detectFluxPeaks(slice, sampleRate, hop)
        bandTimestamps.push(bt); bandStrengths.push(bs)
      }

      const transfer = [timestamps.buffer, strengths.buffer, ...bandTimestamps.map(a => a.buffer), ...bandStrengths.map(a => a.buffer)]
      post({ type: 'onsets', channelIndex: ch, timestamps, strengths, bandTimestamps, bandStrengths }, transfer)
    }

    const segments = await runVadForAllChannels(channels, sampleRate, frameRMSCache, hop)
    if (segments.length > 0) post({ type: 'vad', segments })
  },
}
