// A faithful port of Praat's autocorrelation pitch method (Boersma 1993) + Viterbi path finder,
// from fon/Sound_to_Pitch.cpp and fon/Pitch.cpp. This is the "gold standard" pitch: per-frame AC
// normalized by the window's own autocorrelation, candidate maxima, then a cross-frame Viterbi path
// (octave-jump / voiced-unvoiced costs) that removes octave errors and stabilizes voicing.
//
// Simplification vs Praat: candidate frequency/strength use parabolic interpolation of the AC peak
// rather than Praat's sinc interpolation (NUM_interpolate_sinc). This is close enough to track Praat
// and to drive the same path decisions; sinc refinement can be added later for exact strengths.

export interface PraatPitchParams {
  timeStep: number            // s; 0 = auto (periodsPerWindow / floor / 4)
  pitchFloor: number          // Hz
  pitchCeiling: number        // Hz
  maxCandidates: number
  silenceThreshold: number
  voicingThreshold: number
  octaveCost: number
  octaveJumpCost: number
  voicedUnvoicedCost: number
}

export const PRAAT_PITCH_DEFAULTS: PraatPitchParams = {
  timeStep: 0, pitchFloor: 75, pitchCeiling: 600, maxCandidates: 15,
  silenceThreshold: 0.03, voicingThreshold: 0.45, octaveCost: 0.01, octaveJumpCost: 0.35, voicedUnvoicedCost: 0.14,
}

export interface PraatPitchResult {
  times: Float32Array
  f0: Float32Array        // Hz; 0 = unvoiced
  strength: Float32Array  // chosen candidate strength ([0,1]-ish)
}

const log2 = (x: number): number => Math.log(x) / Math.LN2

/**
 * Octave-jump correction for single-f0 detectors (e.g. SwiftF0, which has no candidates for a full
 * Viterbi path). Snaps each voiced frame toward the local median octave, removing isolated octave
 * errors while leaving real intonation untouched. A light analogue of Praat's path finder.
 * Returns a corrected copy; 0 (unvoiced) is preserved.
 */
export function smoothOctaves(f0: Float32Array, halfWindow = 3): Float32Array {
  const n = f0.length
  const out = Float32Array.from(f0)
  const win: number[] = []
  for (let i = 0; i < n; i++) {
    if (f0[i]! <= 0) continue
    win.length = 0
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(n - 1, i + halfWindow); j++) if (f0[j]! > 0) win.push(f0[j]!)
    if (win.length === 0) continue
    win.sort((a, b) => a - b)
    const med = win[win.length >> 1]!
    let f = f0[i]!
    while (f > med * Math.SQRT2) f /= 2   // > half-octave above median ⇒ octave-up error
    while (f < med / Math.SQRT2) f *= 2   // > half-octave below median ⇒ octave-down error
    out[i] = f
  }
  return out
}

// ---- radix-2 complex FFT (in place). dir = -1 forward, +1 inverse (unnormalized). ----
function fft(re: Float64Array, im: Float64Array, dir: number): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const tr = re[i]!; re[i] = re[j]!; re[j] = tr; const ti = im[i]!; im[i] = im[j]!; im[j] = ti }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = dir * 2 * Math.PI / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2
        const xr = re[b]! * cr - im[b]! * ci, xi = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - xr; im[b] = im[a]! - xi
        re[a] = re[a]! + xr; im[a] = im[a]! + xi
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr
      }
    }
  }
}

// Real autocorrelation of `sig` (length nfft, zero-padded), via FFT: IFFT(|FFT|²). Scale is
// arbitrary (callers normalize by lag 0), so FFT normalization is irrelevant.
function autocorrelation(sig: Float64Array, nfft: number): Float64Array {
  const re = new Float64Array(nfft), im = new Float64Array(nfft)
  re.set(sig)
  fft(re, im, -1)
  for (let k = 0; k < nfft; k++) { re[k] = re[k]! * re[k]! + im[k]! * im[k]!; im[k] = 0 }
  fft(re, im, 1)
  return re  // re[lag] = autocorrelation at lag (up to scale)
}

export function praatPitchAc(samples: Float32Array | Float64Array, sampleRate: number, params: PraatPitchParams): PraatPitchResult {
  const p = params
  const dx = 1 / sampleRate
  const nx = samples.length
  const periodsPerWindow = 3.0  // AC (Hanning)
  const dt = p.timeStep > 0 ? p.timeStep : periodsPerWindow / p.pitchFloor / 4
  const ceiling = Math.min(p.pitchCeiling, 0.5 / dx)
  const maxnCandidates = Math.max(p.maxCandidates, Math.floor(ceiling / p.pitchFloor))

  const nsamp_period = Math.floor(1 / dx / p.pitchFloor)
  const dt_window = periodsPerWindow / p.pitchFloor
  let nsamp_window = Math.floor(dt_window / dx)
  const halfnsamp_window = Math.floor(nsamp_window / 2) - 1
  nsamp_window = halfnsamp_window * 2
  const halfnsamp_period = Math.floor(nsamp_period / 2) + 1

  const maximumLag = Math.min(Math.floor(nsamp_window / periodsPerWindow) + 2, nsamp_window)
  const interpolationDepth = 0.5
  let nsampFFT = 1
  while (nsampFFT < nsamp_window * (1 + interpolationDepth)) nsampFFT *= 2
  const brent_ixmax = Math.floor(nsamp_window * interpolationDepth)

  // Global peak (for silence/voicing).
  let mean = 0
  for (let i = 0; i < nx; i++) mean += samples[i]!
  mean /= nx || 1
  let globalPeak = 0
  for (let i = 0; i < nx; i++) { const v = Math.abs(samples[i]! - mean); if (v > globalPeak) globalPeak = v }

  // Hanning window (Praat form), and its normalized autocorrelation.
  const window = new Float64Array(nsamp_window + 1)  // 1-indexed
  for (let i = 1; i <= nsamp_window; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nsamp_window + 1))
  const windowPad = new Float64Array(nsampFFT)
  for (let i = 1; i <= nsamp_window; i++) windowPad[i - 1] = window[i]!
  const windowAc = autocorrelation(windowPad, nsampFFT)
  const windowR = new Float64Array(brent_ixmax + 2)
  windowR[0] = 1
  for (let i = 1; i <= brent_ixmax + 1; i++) windowR[i] = windowAc[i]! / windowAc[0]!

  // Frame timing (Sampled_shortTermAnalysis): fit windows symmetrically in the duration.
  const duration = nx * dx
  const numberOfFrames = Math.max(1, Math.floor((duration - dt_window) / dt) + 1)
  const t1 = 0.5 * duration - 0.5 * numberOfFrames * dt + 0.5 * dt  // centre of frame 0 (x1 = 0.5 dx)

  interface Cand { frequency: number; strength: number }
  const frames: { intensity: number; candidates: Cand[] }[] = []

  const frameBuf = new Float64Array(nsampFFT)
  for (let iframe = 0; iframe < numberOfFrames; iframe++) {
    const t = t1 + iframe * dt
    const leftSample = Math.floor(t / dx + 0.5)   // 1-indexed; Sampled_xToLowIndex with x1 = 0.5 dx
    const rightSample = leftSample + 1

    // Local mean over ±nsamp_period.
    let lmStart = rightSample - nsamp_period, lmEnd = leftSample + nsamp_period
    if (lmStart < 1) lmStart = 1
    if (lmEnd > nx) lmEnd = nx
    let localMean = 0
    for (let i = lmStart; i <= lmEnd; i++) localMean += samples[i - 1]!
    localMean /= 2 * nsamp_period

    // Windowed frame (minus local mean), zero-padded.
    const startSample = rightSample - halfnsamp_window
    frameBuf.fill(0)
    let localPeak = 0
    const peakStart = Math.max(1, halfnsamp_window + 1 - halfnsamp_period)
    const peakEnd = Math.min(nsamp_window, halfnsamp_window + halfnsamp_period)
    for (let j = 1; j <= nsamp_window; j++) {
      const si = startSample + j - 1  // 1-indexed source sample
      const s = si >= 1 && si <= nx ? samples[si - 1]! : 0
      const v = (s - localMean) * window[j]!
      frameBuf[j - 1] = v
      if (j >= peakStart && j <= peakEnd) { const a = Math.abs(v); if (a > localPeak) localPeak = a }
    }
    const intensity = localPeak > globalPeak ? 1 : localPeak / (globalPeak || 1)

    const candidates: Cand[] = [{ frequency: 0, strength: 0 }]  // unvoiced always present

    if (localPeak > 0) {
      const ac = autocorrelation(frameBuf, nsampFFT)
      const r = new Float64Array(brent_ixmax + 2)
      r[0] = 1
      for (let i = 1; i <= brent_ixmax + 1; i++) r[i] = ac[i]! / (ac[0]! * windowR[i]!)

      const iMax = Math.min(maximumLag, brent_ixmax)
      for (let i = 2; i < iMax; i++) {
        if (r[i]! > 0.5 * p.voicingThreshold && r[i]! > r[i - 1]! && r[i]! >= r[i + 1]!) {
          const dr = 0.5 * (r[i + 1]! - r[i - 1]!)
          const d2r = (r[i]! - r[i - 1]!) + (r[i]! - r[i + 1]!)
          if (d2r <= 0) continue
          const frequency = 1 / dx / (i + dr / d2r)
          if (frequency <= 0) continue
          let strength = r[i]! + 0.5 * dr * dr / d2r  // parabolic peak value (≈ Praat's sinc strength)
          if (strength > 1) strength = 1 / strength

          // Place candidate (grow to maxnCandidates, else replace the weakest by octave-adjusted strength).
          let place = -1
          if (candidates.length < maxnCandidates) {
            candidates.push({ frequency, strength })
            place = candidates.length - 1
          } else {
            let weakest = 2
            for (let iw = 1; iw < maxnCandidates; iw++) {
              const ls = candidates[iw]!.strength - p.octaveCost * log2(p.pitchFloor / candidates[iw]!.frequency)
              if (ls < weakest) { weakest = ls; place = iw }
            }
            if (strength - p.octaveCost * log2(p.pitchFloor / frequency) <= weakest) place = -1
            if (place >= 0) candidates[place] = { frequency, strength }
          }
        }
      }
    }
    frames.push({ intensity, candidates })
  }

  pathFinder(frames, dt, ceiling, p)

  // Extract the chosen path (candidate 0 after path finding is the winner; see pathFinder).
  const times = new Float32Array(numberOfFrames)
  const f0 = new Float32Array(numberOfFrames)
  const strength = new Float32Array(numberOfFrames)
  for (let i = 0; i < numberOfFrames; i++) {
    times[i] = t1 + i * dt
    const c = frames[i]!.candidates[0]!
    f0[i] = c.frequency
    strength[i] = c.strength
  }
  return { times, f0, strength }
}

// Viterbi path finder (Pitch_pathFinder). Chooses one candidate per frame maximizing
// Σ delta − Σ transitionCost, then moves the winner to candidates[0].
function pathFinder(
  frames: { intensity: number; candidates: { frequency: number; strength: number }[] }[],
  dt: number, ceiling: number, p: PraatPitchParams,
): void {
  const n = frames.length
  if (n === 0) return
  const timeStepCorrection = 0.01 / dt
  const octaveJumpCost = p.octaveJumpCost * timeStepCorrection
  const voicedUnvoicedCost = p.voicedUnvoicedCost * timeStepCorrection
  const voiced = (f: number): boolean => f > 0 && f < ceiling

  const delta: number[][] = []
  const psi: number[][] = []
  for (let iframe = 0; iframe < n; iframe++) {
    const frame = frames[iframe]!
    let unvoiced = p.silenceThreshold <= 0 ? 0 : 2 - frame.intensity / (p.silenceThreshold / (1 + p.voicingThreshold))
    unvoiced = p.voicingThreshold + Math.max(0, unvoiced)
    const d = new Array<number>(frame.candidates.length)
    for (let c = 0; c < frame.candidates.length; c++) {
      const cand = frame.candidates[c]!
      d[c] = voiced(cand.frequency) ? cand.strength - p.octaveCost * log2(ceiling / cand.frequency) : unvoiced
    }
    delta.push(d)
    psi.push(new Array<number>(frame.candidates.length).fill(0))
  }

  for (let iframe = 1; iframe < n; iframe++) {
    const prev = frames[iframe - 1]!, cur = frames[iframe]!
    const prevDelta = delta[iframe - 1]!, curDelta = delta[iframe]!, curPsi = psi[iframe]!
    for (let c2 = 0; c2 < cur.candidates.length; c2++) {
      const f2 = cur.candidates[c2]!.frequency
      let best = -1e30, place = 0
      for (let c1 = 0; c1 < prev.candidates.length; c1++) {
        const f1 = prev.candidates[c1]!.frequency
        const pv = !voiced(f1), cv = !voiced(f2)
        let transition: number
        if (cv) transition = pv ? 0 : voicedUnvoicedCost
        else transition = pv ? voicedUnvoicedCost : octaveJumpCost * Math.abs(log2(f1 / f2))
        const value = prevDelta[c1]! - transition + curDelta[c2]!
        if (value > best) { best = value; place = c1 }
      }
      curDelta[c2] = best
      curPsi[c2] = place
    }
  }

  // Backtrack: record the chosen candidate index per frame (no mutation during backtrack).
  const chosen = new Array<number>(n)
  let place = 0, best = delta[n - 1]![0]!
  for (let c = 1; c < delta[n - 1]!.length; c++) if (delta[n - 1]![c]! > best) { best = delta[n - 1]![c]!; place = c }
  for (let iframe = n - 1; iframe >= 0; iframe--) {
    chosen[iframe] = place
    if (iframe > 0) place = psi[iframe]![place]!
  }
  // Move each frame's winner to slot 0 so the caller reads candidates[0].
  for (let iframe = 0; iframe < n; iframe++) {
    const cands = frames[iframe]!.candidates
    const c = chosen[iframe]!
    if (c !== 0) { const tmp = cands[0]!; cands[0] = cands[c]!; cands[c] = tmp }
  }
}
