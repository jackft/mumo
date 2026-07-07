/// PYIN: Probabilistic YIN with Viterbi HMM pitch tracking.
///
/// Improvements over basic YIN:
/// 1. Multi-candidate: all CMNDF local minima are used, not just the first
///    sub-threshold one. This is the core mechanism that eliminates octave errors.
/// 2. Probabilistic voicing: Beta(2,18) distribution over CMNDF thresholds
///    gives smooth per-frame voicing probability rather than a binary cut.
/// 3. Temporal smoothing: Viterbi HMM finds the globally optimal pitch
///    trajectory over the full signal, dramatically reducing octave jumps.
///
/// Based on: Mauch & Dixon (2014) "PYIN: A Fundamental Frequency Estimator
/// using Probabilistic Threshold Distributions", ICASSP.

use crate::yin::YinEstimator;

// ─── Beta(2,18) voicing probability ────────────────────────────────────────

/// P(voiced | CMNDF minimum = d) = P(threshold > d) where threshold ~ Beta(2,18).
/// Closed form: (1−d)^18 · (1+18d).
#[inline]
fn beta_survival(d: f32) -> f32 {
    let d = d.clamp(0.0, 1.0);
    (1.0 - d).powi(18) * (1.0 + 18.0 * d)
}

// ─── Log-probability helpers ────────────────────────────────────────────────

#[inline]
fn lp(x: f32) -> f32 { (x + 1e-10).ln() }

// ─── Pitch bin quantization ─────────────────────────────────────────────────

/// Log-spaced pitch bins: 1 bin per semitone between min_hz and max_hz.
struct Bins {
    min_hz: f32,
    n:      usize,
}

impl Bins {
    fn new(min_hz: f32, max_hz: f32) -> Self {
        let n = ((max_hz / min_hz).log2() * 12.0).ceil() as usize + 1;
        Bins { min_hz, n }
    }
    #[inline]
    fn hz(&self, k: usize) -> f32 {
        self.min_hz * 2.0f32.powf(k as f32 / 12.0)
    }
    /// Nearest bin index for hz, or None if outside range.
    #[inline]
    fn bin(&self, hz: f32) -> Option<usize> {
        if hz <= 0.0 { return None; }
        let k = (12.0 * (hz / self.min_hz).log2()).round() as i32;
        if k < 0 || k as usize >= self.n { None } else { Some(k as usize) }
    }
    /// Continuous semitone position for hz (may be fractional, used for Gaussian spread).
    #[inline]
    fn semi(&self, hz: f32) -> f32 {
        12.0 * (hz / self.min_hz).log2()
    }
}

// ─── Public entry point ─────────────────────────────────────────────────────

/// Compute PYIN pitch track for an entire signal.
///
/// Returns `(pitch_hz, voiced_prob)` — one value per hop frame.
/// `pitch_hz` is 0.0 for unvoiced frames; `voiced_prob` ∈ [0,1].
pub fn compute_pyin(
    samples:     &[f32],
    sample_rate: f32,
    frame_size:  usize,
    hop:         usize,
    min_hz:      f32,
    max_hz:      f32,
) -> (Vec<f32>, Vec<f32>) {
    let nf = if samples.len() > frame_size {
        (samples.len() - frame_size) / hop + 1
    } else { 0 };

    if nf == 0 { return (vec![], vec![]); }

    // ── Pitch bins ─────────────────────────────────────────────────────────
    let bins = Bins::new(min_hz, max_hz);
    let nb = bins.n;    // number of voiced states
    let ns = nb + 1;    // +1 for unvoiced
    let uv = nb;        // index of unvoiced state

    // ── HMM transition log-probabilities ───────────────────────────────────
    //
    // From voiced[i]:
    //   → voiced[j]: Gaussian(|i−j|, σ=1 semitone) × 0.99, per-row normalised
    //   → unvoiced:  0.01
    // From unvoiced:
    //   → voiced[j]: 0.10 / nb  (uniform over bins)
    //   → unvoiced:  0.90
    const SIGMA: f32          = 1.0;
    const P_STAY_VOICED: f32  = 0.99;
    const P_TO_UV: f32        = 0.01;
    const P_STAY_UV: f32      = 0.90;
    const P_UV_TO_V: f32      = 0.10;

    let log_p_to_uv  = P_TO_UV.ln();
    let log_p_stay_uv = P_STAY_UV.ln();
    let log_p_uv_to_v = (P_UV_TO_V / nb as f32).ln();

    // Precompute voiced→voiced transition log-probs: log_vv[i*nb + j]
    let mut log_vv = vec![f32::NEG_INFINITY; nb * nb];
    for i in 0..nb {
        let mut row_sum = 0.0f32;
        for j in 0..nb {
            let d = (i as f32 - j as f32) / SIGMA;
            let w = (-0.5 * d * d).exp();
            log_vv[i * nb + j] = w;
            row_sum += w;
        }
        let log_norm = (P_STAY_VOICED / row_sum).ln();
        for j in 0..nb {
            log_vv[i * nb + j] = log_vv[i * nb + j].ln() + log_norm;
        }
    }

    // ── Per-frame emission log-probabilities ────────────────────────────────
    // emissions[f*ns .. f*ns+ns]: log P(observations_f | state s)
    let mut emissions = vec![f32::NEG_INFINITY; nf * ns];
    let mut yin = YinEstimator::new(frame_size);

    for f in 0..nf {
        let start = f * hop;
        let frame = &samples[start..start + frame_size];
        let minima = yin.frame_minima(frame, sample_rate, min_hz, max_hz);

        let ems = &mut emissions[f * ns..(f + 1) * ns];

        if minima.is_empty() {
            // Silent / no pitch structure → definitely unvoiced
            ems[uv] = lp(1.0);
            for s in 0..nb { ems[s] = lp(0.0); }
            continue;
        }

        // For each CMNDF minimum:
        //   voiced probability from Beta(2,18): p_v = beta_survival(d)
        //   spread probability across nearby pitch bins as a Gaussian blob
        //   (σ = 0.5 semitones ensures smooth gradients in the HMM)
        let mut bin_prob = vec![0.0f32; nb];
        let mut total_p_voiced = 0.0f32;

        for &(tau, d) in &minima {
            let hz = sample_rate / tau as f32;
            let p_v = beta_survival(d);
            total_p_voiced += p_v;

            let center = bins.semi(hz);
            for b in 0..nb {
                let delta = b as f32 - center;
                // Gaussian blob: σ = 0.5 semitone
                let w = (-2.0 * delta * delta).exp();
                bin_prob[b] += p_v * w;
            }
        }

        // Clamp total voiced probability to [0,1] and derive unvoiced probability
        let p_v_total  = total_p_voiced.min(1.0);
        let p_uv       = (1.0 - p_v_total).max(0.0);

        // Normalize voiced bin probs to sum to p_v_total
        let raw_sum: f32 = bin_prob.iter().sum();
        if raw_sum > 0.0 {
            let scale = p_v_total / raw_sum;
            for b in 0..nb { bin_prob[b] *= scale; }
        }

        for b in 0..nb { ems[b] = lp(bin_prob[b]); }
        ems[uv] = lp(p_uv);
    }

    // ── Viterbi decoding ────────────────────────────────────────────────────
    // All operations in log-space to avoid underflow.
    // Backpointers stored as u16 (sufficient for up to 65535 states).

    let mut dp   = vec![f32::NEG_INFINITY; ns];
    let mut dp2  = vec![f32::NEG_INFINITY; ns];
    let mut bp   = vec![0u16; nf * ns];

    // Frame 0: uniform prior
    let log_prior = -(ns as f32).ln();
    for s in 0..ns {
        dp[s] = log_prior + emissions[s];
    }

    // Forward Viterbi pass
    for f in 1..nf {
        let ems = &emissions[f * ns..(f + 1) * ns];
        let bpf = &mut bp[f * ns..(f + 1) * ns];

        for to in 0..ns {
            let (best_from, best_score) = if to == uv {
                // Best predecessor for unvoiced state:
                //   from voiced[i]: dp[i] + log_p_to_uv
                //   from unvoiced:  dp[uv] + log_p_stay_uv
                let mut best = (uv, dp[uv] + log_p_stay_uv);
                for i in 0..nb {
                    let s = dp[i] + log_p_to_uv;
                    if s > best.1 { best = (i, s); }
                }
                best
            } else {
                // Best predecessor for voiced[to]:
                //   from voiced[i]: dp[i] + log_vv[i*nb+to]
                //   from unvoiced:  dp[uv] + log_p_uv_to_v
                let mut best = (uv, dp[uv] + log_p_uv_to_v);
                for i in 0..nb {
                    let s = dp[i] + log_vv[i * nb + to];
                    if s > best.1 { best = (i, s); }
                }
                best
            };

            dp2[to] = best_score + ems[to];
            bpf[to] = best_from as u16;
        }

        dp.copy_from_slice(&dp2);
        dp2.fill(f32::NEG_INFINITY);
    }

    // Backtrace from the terminal state with highest log-probability
    let mut path = vec![0u16; nf];
    path[nf - 1] = (0..ns)
        .max_by(|&a, &b| dp[a].partial_cmp(&dp[b]).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(uv) as u16;

    for f in (0..nf - 1).rev() {
        path[f] = bp[(f + 1) * ns + path[f + 1] as usize];
    }

    // ── Extract pitch and voiced probability ────────────────────────────────
    let mut pitch_hz    = vec![0.0f32; nf];
    let mut voiced_prob = vec![0.0f32; nf];

    for f in 0..nf {
        let state = path[f] as usize;
        if state < nb {
            pitch_hz[f] = bins.hz(state);

            // Posterior voiced probability for this frame:
            // softmax over voiced[state] vs unvoiced emissions
            let e_v  = emissions[f * ns + state].exp();
            let e_uv = emissions[f * ns + uv].exp();
            let tot  = e_v + e_uv;
            voiced_prob[f] = if tot > 0.0 { e_v / tot } else { 0.0 };
        }
        // state == uv: pitch_hz = 0, voiced_prob = 0 (defaults)
    }

    (pitch_hz, voiced_prob)
}
