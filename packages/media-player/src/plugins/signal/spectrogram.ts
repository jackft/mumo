import type { SampleBuffer as WasmSampleBuffer } from 'audio-analysis-wasm'
import type { SpectrogramTile } from '@mumo/timeline'
const SPEC_DB_FLOOR = -160
const SPEC_DB_RANGE = 160
import type { SpectrogramSettings } from '../../types.js'
import { SPEC_FREQ_HEADROOM } from '../../types.js'
import type { SignalPlugin, SignalRun, StreamInit, AudioSegment, SignalPost } from './SignalPlugin.js'

let wasmSB: typeof WasmSampleBuffer | null = null
export function setSampleBuffer(sb: typeof WasmSampleBuffer): void { wasmSB = sb }
/** The loaded Rust/WASM SampleBuffer class (null until the worker loads it), shared with the pitch plugin. */
export function getSampleBuffer(): typeof WasmSampleBuffer | null { return wasmSB }

const TILE_FRAMES     = 2048
const OVERVIEW_MAX_WIDTH = 4096
const NUM_SNAP_BANDS  = 4

function windowCode(w: SpectrogramSettings['window']): number {
  if (w === 'hamming')  return 1
  if (w === 'gaussian') return 2
  return 0
}

function nextPow2(n: number): number {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(n, 1))))
}

// Praat framing (`Sound_to_Spectrogram`): the user's `windowLengthSec` is the *effective* width; a
// Gaussian window is physically **twice** that (so its tails aren't chopped), other windows 1×. The
// physical window (rounded to an even sample count) is then **zero-padded up to a power-of-two FFT**
// (Praat pads up; we used to round to the *nearest* pow2, which truncated the window). The extra
// frequency interpolation + the wider Gaussian is what gives Praat its smooth, harmonic-resolving look.
function toSamples(settings: SpectrogramSettings, sampleRate: number) {
  const effSamples = settings.windowLengthSec * sampleRate
  const physical = settings.window === 'gaussian' ? 2 * effSamples : effSamples
  let physicalWindowSize = Math.max(2, Math.round(physical))
  if (physicalWindowSize & 1) physicalWindowSize += 1     // even, as Praat makes nsamp_window even
  const fftSize = Math.max(nextPow2(physicalWindowSize), 2)
  return {
    physicalWindowSize,
    fftSize,
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

// Window over `size` (physical) samples, using Praat's centered phase `p = (i − (n−1)/2)/n ∈ [−½, ½]`.
// Gaussian is Praat's truncated form `(exp(−48p²) − e⁻¹²)/(1 − e⁻¹²)` (≈0 at the physical edges),
// paired with the 2×-effective physical width from toSamples so the Gaussian is genuinely un-chopped.
function buildWindow(size: number, kind: SpectrogramSettings['window']): Float32Array {
  const w = new Float32Array(size)
  const edge = Math.exp(-12), gnorm = 1 / (1 - edge)
  for (let i = 0; i < size; i++) {
    const p = (i - (size - 1) / 2) / size   // [-0.5, 0.5]
    if (kind === 'hamming') {
      w[i] = 0.54 + 0.46 * Math.cos(2 * Math.PI * p)
    } else if (kind === 'gaussian') {
      w[i] = (Math.exp(-48 * p * p) - edge) * gnorm
    } else {
      w[i] = 0.5 + 0.5 * Math.cos(2 * Math.PI * p)   // Hann
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

function applyMelJS(re: Float64Array, im: Float64Array, filterbank: MelBand[], curMag: Float32Array, energyScale = 1): void {
  for (let m = 0; m < filterbank.length; m++) {
    let energy = 0
    for (const [k, w] of filterbank[m]!) {
      const r = re[k]!, im_ = im[k]!
      energy += (r * r + im_ * im_) * w
    }
    curMag[m] = 10 * Math.log10(energy * energyScale + 1e-20)
  }
}

function computeSpectrogramStatsJS(
  samples: Float32Array,
  sampleRate: number,
  fftSize: number,
  hop: number,
  maxFreqHz: number,
  dynamicRangeDb: number,
  win: Float32Array,   // win.length = physical window; frame is zero-padded to fftSize
  melFilterbank: MelBand[] | null,
  onProgress?: (done: number) => void,
) {
  maxFreqHz = Math.min(maxFreqHz, sampleRate / 2)
  const winLen = win.length
  const maxBin = Math.round(maxFreqHz / (sampleRate / fftSize))
  const numLinearBins = Math.min(maxBin, fftSize / 2)
  const numFreqBins = melFilterbank ? melFilterbank.length : numLinearBins
  const numFrames = Math.max(1, Math.floor((samples.length - fftSize) / hop) + 1)
  const overviewWidth = Math.min(numFrames, OVERVIEW_MAX_WIDTH)
  const overviewBinSize = Math.ceil(numFrames / overviewWidth)
  const overviewAccum = new Float64Array(overviewWidth * numFreqBins)
  const overviewCount = new Uint32Array(overviewWidth)
  const flux = new Float32Array(numFrames)
  const bandFlux = new Float32Array(numFrames * NUM_SNAP_BANDS)
  const frameRMS = new Float32Array(numFrames)
  let globalMin = Infinity, globalMax = -Infinity
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize)
  const prevMag = new Float32Array(numFreqBins), curMag = new Float32Array(numFreqBins)
  const framePeakDb = new Float32Array(numFrames)

  for (let f = 0; f < numFrames; f++) {
    const frameStart = f * hop
    re.fill(0); im.fill(0)
    for (let j = 0; j < winLen; j++) {
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

// Per-bin pre-emphasis in dB (Praat: `dbPerOct·log2(f/1000)`, 0 dB at 1 kHz, boosting highs). The
// DC/low bins get a large negative term (as in Praat, killing the DC component). null if disabled.
function buildPreEmphasis(
  dbPerOct: number, numFreqBins: number, melFb: MelBand[] | null,
  sampleRate: number, windowSize: number, maxFreqHz: number,
): Float32Array | null {
  if (!dbPerOct) return null
  const out = new Float32Array(numFreqBins)
  const binHz = sampleRate / windowSize
  const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700)
  const melToHz = (mel: number) => 700 * (Math.pow(10, mel / 2595) - 1)
  const maxMel = hzToMel(Math.min(maxFreqHz, sampleRate / 2))
  for (let k = 0; k < numFreqBins; k++) {
    const freq = melFb ? melToHz((maxMel * (k + 0.5)) / numFreqBins) : k * binHz
    out[k] = dbPerOct * (Math.log(Math.max(0, freq) / 1000 + 1e-308) / Math.LN2)
  }
  return out
}

// Produce a rawDb tile: one uint8 per (freq-bin, frame), quantised to SPEC_DB_FLOOR..+SPEC_DB_RANGE.
// The Timeline applies a per-viewport LUT when uploading to GPU.
function renderDetailTileRawDb(
  samples: Float32Array,
  fftSize: number, hop: number, win: Float32Array,   // win.length = physical window; rest zero-padded
  numLinearBins: number, numFreqBins: number,
  startFrame: number, endFrame: number,
  melFilterbank: MelBand[] | null,
  preEmphDb: Float32Array | null,   // per-bin dB to add (Praat pre-emphasis); null = none
): Uint8Array {
  const tileWidth = endFrame - startFrame
  const winLen = win.length
  // Normalize by the window's coherent gain (Σw) so magnitudes are independent of window length —
  // a full-scale sinusoid reads ~0 dB regardless of window size (Praat normalizes power by windowssq).
  let winSum = 0
  for (let j = 0; j < winLen; j++) winSum += win[j]!
  const invWinSum = winSum > 0 ? 1 / winSum : 1
  const rawDb = new Uint8Array(tileWidth * numFreqBins)
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize)
  const curMag = new Float32Array(numFreqBins)
  for (let f = startFrame; f < endFrame; f++) {
    const frameStart = f * hop
    re.fill(0); im.fill(0)
    for (let j = 0; j < winLen; j++) {
      const idx = frameStart + j
      re[j] = idx < samples.length ? (samples[idx]! * win[j]!) : 0
    }
    fft(re, im)
    if (melFilterbank) {
      applyMelJS(re, im, melFilterbank, curMag, invWinSum * invWinSum)
    } else {
      for (let k = 0; k < numLinearBins; k++) {
        curMag[k] = 20 * Math.log10(Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!) * invWinSum + 1e-10)
      }
    }
    const localF = f - startFrame
    for (let k = 0; k < numFreqBins; k++) {
      const db = curMag[k]! + (preEmphDb ? preEmphDb[k]! : 0)
      const q = Math.max(0, Math.min(255, Math.round((db - SPEC_DB_FLOOR) / SPEC_DB_RANGE * 255)))
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


// ---------------------------------------------------------------------------
// Streaming run — the file is decoded in ~1-2 min segments (see the worker) so the
// full-file PCM is never resident. Each segment computes its own flux/tiles; the
// overview and per-frame onset features accumulate across segments and are emitted at
// finish. Detail-tile pixels use a fixed dB encoding, so segments are self-contained
// (no cross-segment normalization). Flux at each segment's first frame is 0 (no prior
// frame carried across the boundary) — a negligible artifact every ~90s.
// ---------------------------------------------------------------------------

/** Frame/tile grid params the worker needs to size segments to the spectrogram grid. */
export function specFrameParams(settings: SpectrogramSettings, sampleRate: number): { hop: number; windowSize: number; tileFrames: number } {
  const { fftSize, hop } = toSamples(settings, sampleRate)
  // The segmenter must provide fftSize samples per frame (the JS tiles read only the physical window
  // and zero-pad, but the WASM stats path reads the full fftSize span).
  return { hop, windowSize: fftSize, tileFrames: TILE_FRAMES }
}

const NOOP_PROGRESS = (() => { /* per-segment progress is reported by the run */ }) as unknown as (done: number, total: number) => void

// Per-segment flux / band-flux / frame-RMS. WASM when available (native), else JS fallback.
function computeSegmentStats(
  samples: Float32Array, sampleRate: number, settings: SpectrogramSettings,
  fftSize: number, hop: number, win: Float32Array, melFb: MelBand[] | null,
): { flux: Float32Array; bandFlux: Float32Array; frameRMS: Float32Array; numSnapBands: number } {
  if (wasmSB) {
    const buf = new wasmSB(samples, fftSize, windowCode(settings.window))
    try {
      const melBands = settings.scale === 'mel' ? settings.melBands : 0
      const stats = buf.compute_stats(hop, settings.maxFreqHz, sampleRate, settings.dynamicRangeDb, melBands, NOOP_PROGRESS)
      const numSnapBands = stats.num_snap_bands
      stats.take_overview_pixels()  // discard — overview is built from detail tiles
      const flux     = new Float32Array(stats.take_flux())
      const bandFlux = new Float32Array(stats.take_band_flux())
      const frameRMS = new Float32Array(stats.take_frame_rms())
      stats.free()
      return { flux, bandFlux, frameRMS, numSnapBands }
    } finally {
      buf.free()
    }
  }
  const r = computeSpectrogramStatsJS(samples, sampleRate, fftSize, hop, settings.maxFreqHz, settings.dynamicRangeDb, win, melFb)
  return { flux: r.flux, bandFlux: r.bandFlux, frameRMS: r.frameRMS, numSnapBands: NUM_SNAP_BANDS }
}

interface ChannelAccum {
  ovAccum: Float64Array
  ovCount: Uint32Array
  flux: Float32Array
  frameRMS: Float32Array
  bandFlux: Float32Array | null  // lazily sized once numSnapBands is known
  numSnapBands: number
}

export const spectrogramPlugin: SignalPlugin = {
  id: 'spectrogram',

  createRun(init: StreamInit, post: SignalPost): SignalRun {
    const { sampleRate, channelCount, durationSec, settings } = init
    const { physicalWindowSize, fftSize, hop } = toSamples(settings, sampleRate)
    // Store bins up to a headroom ceiling (linear scale only) so the displayed frequency window can
    // be narrowed — or widened up to this ceiling — at render time without re-decoding. Mel bins are
    // non-uniform in Hz, so mel stores exactly maxFreqHz (frequency changes recompute).
    const storedMaxFreqHz = settings.scale === 'mel'
      ? settings.maxFreqHz
      : Math.min(sampleRate / 2, settings.maxFreqHz * SPEC_FREQ_HEADROOM)
    const binHz = sampleRate / fftSize
    const maxBin = Math.round(Math.min(storedMaxFreqHz, sampleRate / 2) / binHz)
    const numLinearBins = Math.min(maxBin, fftSize / 2)
    const melFb = settings.scale === 'mel'
      ? buildMelFilterbankJS(sampleRate, numLinearBins, settings.melBands, settings.maxFreqHz)
      : null
    const numFreqBins = melFb ? melFb.length : numLinearBins
    // Actual top frequency the stored rows cover (quantised to a bin edge for linear).
    const tileMaxFreqHz = melFb ? settings.maxFreqHz : numLinearBins * binHz
    const win = buildWindow(physicalWindowSize, settings.window)

    // Praat-style pre-emphasis: +preEmphasisDbPerOct·log2(f/1000) baked per frequency bin (0 = off).
    const preEmphDb = buildPreEmphasis(settings.preEmphasisDbPerOct, numFreqBins, melFb, sampleRate, fftSize, tileMaxFreqHz)

    // Frames span fftSize samples (matches the segmenter's per-frame provision); the physical window
    // is windowed into the zero-padded fftSize buffer inside renderDetailTileRawDb.
    const totalSamples  = Math.max(fftSize, Math.round(durationSec * sampleRate))
    const totalFrames   = Math.max(1, Math.floor((totalSamples - fftSize) / hop) + 1)
    const ovWidth       = Math.min(totalFrames, OVERVIEW_MAX_WIDTH)
    const ovBinSize     = Math.ceil(totalFrames / ovWidth)
    const hopDuration   = hop / sampleRate
    // totalFrames is estimated from the container duration; the actual decoded frame count
    // (filledFrames) can be smaller (containers often over-report audio length). Progress and
    // the overview extent are reconciled to filledFrames at finish so the overview isn't
    // stretched across a grid wider than the real content.
    const totalProgress = totalFrames
    const doneRef = { value: 0 }
    let filledFrames = 0

    const acc: ChannelAccum[] = Array.from({ length: channelCount }, () => ({
      ovAccum: new Float64Array(ovWidth * numFreqBins),
      ovCount: new Uint32Array(ovWidth),
      flux: new Float32Array(totalFrames),
      frameRMS: new Float32Array(totalFrames),
      bandFlux: null,
      numSnapBands: NUM_SNAP_BANDS,
    }))

    return {
      pushSegment(seg: AudioSegment): void {
        const F0 = seg.firstFrame
        const fc = Math.min(seg.frameCount, totalFrames - F0)
        if (fc <= 0) return
        for (let ch = 0; ch < channelCount; ch++) {
          const samples = seg.channels[ch]!
          const a = acc[ch]!
          const { flux, bandFlux, frameRMS, numSnapBands } = computeSegmentStats(samples, sampleRate, settings, fftSize, hop, win, melFb)
          if (!a.bandFlux) { a.bandFlux = new Float32Array(totalFrames * numSnapBands); a.numSnapBands = numSnapBands }
          const nsb = a.numSnapBands
          a.flux.set(flux.subarray(0, fc), F0)
          a.frameRMS.set(frameRMS.subarray(0, fc), F0)
          a.bandFlux.set(bandFlux.subarray(0, fc * nsb), F0 * nsb)

          const tileCount = Math.ceil(fc / TILE_FRAMES)
          for (let t = 0; t < tileCount; t++) {
            const sf = t * TILE_FRAMES, ef = Math.min((t + 1) * TILE_FRAMES, fc)
            const tw = ef - sf
            const rawDb = renderDetailTileRawDb(samples, fftSize, hop, win, numLinearBins, numFreqBins, sf, ef, melFb, preEmphDb)
            for (let lf = sf; lf < ef; lf++) {
              const g = F0 + lf
              const ob = Math.min(Math.floor(g / ovBinSize), ovWidth - 1)
              const col = lf - sf
              for (let k = 0; k < numFreqBins; k++) {
                a.ovAccum[ob * numFreqBins + k] = a.ovAccum[ob * numFreqBins + k]! + rawDb[(numFreqBins - 1 - k) * tw + col]!
              }
              a.ovCount[ob] = a.ovCount[ob]! + 1
            }
            const globalTile = (F0 / TILE_FRAMES) + t
            const timeStart = (F0 + sf) * hopDuration
            const timeEnd = (F0 + ef) * hopDuration
            const tile: SpectrogramTile = { tileIndex: globalTile, rawDb, width: tw, height: numFreqBins, timeStart, timeEnd, maxFreqHz: tileMaxFreqHz }
            post({ type: 'spectrogramTile', channelIndex: ch, tile }, [rawDb.buffer])
          }
        }
        filledFrames = Math.max(filledFrames, F0 + fc)
        doneRef.value += fc
        post({ type: 'progress', done: doneRef.value, total: totalProgress })
      },

      finish(): void {
        // Reconcile to the frames actually decoded: the overview covers [0, nActual) frames, so
        // emit only the columns those frames touched and place it at the true content end time.
        const nActual = Math.max(1, filledFrames)
        const ovUsed = Math.min(ovWidth, Math.max(1, Math.ceil(nActual / ovBinSize)))
        const contentEndSec = nActual * hopDuration
        for (let ch = 0; ch < channelCount; ch++) {
          const a = acc[ch]!
          const nsb = a.numSnapBands
          const bandFlux = a.bandFlux ?? new Float32Array(totalFrames * nsb)

          const { timestamps, strengths } = computeOnsets(a.flux, a.frameRMS, sampleRate, hop)
          const bandTimestamps: Float32Array[] = [], bandStrengths: Float32Array[] = []
          for (let b = 0; b < nsb; b++) {
            const slice = new Float32Array(totalFrames)
            for (let f = 0; f < totalFrames; f++) slice[f] = bandFlux[f * nsb + b]!
            const { timestamps: bt, strengths: bs } = detectFluxPeaks(slice, sampleRate, hop)
            bandTimestamps.push(bt); bandStrengths.push(bs)
          }
          const transfer = [timestamps.buffer, strengths.buffer, ...bandTimestamps.map(x => x.buffer), ...bandStrengths.map(x => x.buffer)]
          post({ type: 'onsets', channelIndex: ch, timestamps, strengths, bandTimestamps, bandStrengths }, transfer)

          const overviewRawDb = new Uint8Array(ovUsed * numFreqBins)
          for (let x = 0; x < ovUsed; x++) {
            const cnt = a.ovCount[x] || 1
            for (let k = 0; k < numFreqBins; k++) {
              overviewRawDb[(numFreqBins - 1 - k) * ovUsed + x] = Math.round(a.ovAccum[x * numFreqBins + k]! / cnt)
            }
          }
          post({ type: 'spectrogramOverview', channelIndex: ch, tile: { tileIndex: -1, rawDb: overviewRawDb, width: ovUsed, height: numFreqBins, timeStart: 0, timeEnd: contentEndSec, maxFreqHz: tileMaxFreqHz } }, [overviewRawDb.buffer])
        }
        // VAD is produced by the Silero plugin (sileroVad.ts); the spectrogram no longer emits an
        // energy-VAD fallback.
        // Container over-report leaves doneRef below totalFrames; force the bar to clear.
        post({ type: 'progress', done: totalProgress, total: totalProgress })
      },
    }
  },
}
