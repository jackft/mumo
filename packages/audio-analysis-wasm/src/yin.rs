/// Fast YIN pitch estimator using FFT-based autocorrelation.
///
/// The difference function d(τ) = Σ (x[t] - x[t+τ])² is equivalent to
/// d(τ) = 2·(r[0] - r[τ]) where r is the autocorrelation. Computing r via
/// a zero-padded FFT gives O(N log N) per frame instead of O(N²).
///
/// The CMNDF (cumulative mean normalized difference function) normalises d so
/// τ=0 is always 1, preventing the trivial zero-lag minimum. A first minimum
/// below `threshold` is taken as the pitch period; parabolic interpolation
/// refines it to sub-sample accuracy.
///
/// Closely follows de Cheveigné & Kawahara (2002) "YIN, a fundamental
/// frequency estimator for speech and music", JASA 111(4).

use rustfft::{Fft, FftPlanner, num_complex::Complex};
use std::sync::Arc;

pub struct YinEstimator {
    fft:         Arc<dyn Fft<f32>>,
    ifft:        Arc<dyn Fft<f32>>,
    pub frame_size:  usize,
    padded_size: usize,
    buf:         Vec<Complex<f32>>,
    power:       Vec<Complex<f32>>,
    scratch_fwd: Vec<Complex<f32>>,
    scratch_inv: Vec<Complex<f32>>,
    pub diff:    Vec<f32>,
    pub cmndf:   Vec<f32>,
}

impl YinEstimator {
    pub fn new(frame_size: usize) -> Self {
        let padded_size = (frame_size * 2).next_power_of_two();
        let mut planner = FftPlanner::<f32>::new();
        let fft  = planner.plan_fft_forward(padded_size);
        let ifft = planner.plan_fft_inverse(padded_size);
        let scratch_fwd = vec![Complex::default(); fft.get_inplace_scratch_len()];
        let scratch_inv = vec![Complex::default(); ifft.get_inplace_scratch_len()];
        Self {
            buf:   vec![Complex::default(); padded_size],
            power: vec![Complex::default(); padded_size],
            scratch_fwd,
            scratch_inv,
            diff:  vec![0f32; frame_size / 2 + 1],
            cmndf: vec![0f32; frame_size / 2 + 1],
            fft, ifft, frame_size, padded_size,
        }
    }

    /// Fill `self.diff` and `self.cmndf` for lags 0..=max_tau.
    /// Shared by `estimate()` and `frame_minima()`.
    pub fn fill_cmndf(&mut self, frame: &[f32], max_tau: usize) {
        // Zero-pad and FFT
        for (i, &s) in frame.iter().enumerate() {
            self.buf[i] = Complex::new(s, 0.0);
        }
        for i in self.frame_size..self.padded_size {
            self.buf[i] = Complex::default();
        }
        self.fft.process_with_scratch(&mut self.buf, &mut self.scratch_fwd);

        // Power spectrum → IFFT → linear autocorrelation
        let scale = 1.0 / self.padded_size as f32;
        for i in 0..self.padded_size {
            self.power[i] = Complex::new(self.buf[i].norm_sqr() * scale, 0.0);
        }
        self.ifft.process_with_scratch(&mut self.power, &mut self.scratch_inv);

        let r0 = self.power[0].re;

        // Normalized difference function: d[τ] = 2·(r[0]/N − r[τ]/(N−τ))
        // This makes d[T] = 0 for any pure periodic signal with period T,
        // eliminating the finite-frame end-effect bias of the raw formulation.
        let r0_mean = r0 / self.frame_size as f32;
        self.diff[0] = 0.0;
        for tau in 1..=max_tau {
            let r_tau_mean = self.power[tau].re / (self.frame_size - tau) as f32;
            self.diff[tau] = 2.0_f32 * (r0_mean - r_tau_mean).max(0.0);
        }

        // Cumulative mean normalized difference function
        self.cmndf[0] = 1.0;
        let mut running_sum = 0.0f32;
        for tau in 1..=max_tau {
            running_sum += self.diff[tau];
            self.cmndf[tau] = if running_sum > 0.0 {
                self.diff[tau] * tau as f32 / running_sum
            } else {
                1.0
            };
        }
    }

    /// Estimate pitch for one raw (unwindowed) frame.
    ///
    /// Returns `(pitch_hz, confidence)`.
    /// `confidence` is `1 − cmndf[best_tau]`, clamped to [0,1].
    pub fn estimate(
        &mut self,
        frame:       &[f32],
        sample_rate: f32,
        min_hz:      f32,
        max_hz:      f32,
        threshold:   f32,
    ) -> (f32, f32) {
        debug_assert_eq!(frame.len(), self.frame_size);

        let max_tau = ((sample_rate / min_hz).ceil() as usize).min(self.frame_size / 2);
        let min_tau = ((sample_rate / max_hz).floor() as usize).max(2);
        if max_tau <= min_tau { return (0.0, 0.0); }

        self.fill_cmndf(frame, max_tau);

        let best_tau = self.find_best_tau(min_tau, max_tau, threshold);

        // Parabolic interpolation for sub-sample accuracy
        let refined = if best_tau > min_tau && best_tau < max_tau {
            let d0 = self.cmndf[best_tau - 1];
            let d1 = self.cmndf[best_tau];
            let d2 = self.cmndf[best_tau + 1];
            let denom = 2.0 * (2.0 * d1 - d0 - d2);
            if denom.abs() > 1e-10 {
                best_tau as f32 + (d2 - d0) / denom
            } else {
                best_tau as f32
            }
        } else {
            best_tau as f32
        };

        if refined <= 0.0 { return (0.0, 0.0); }

        let pitch      = sample_rate / refined;
        let confidence = (1.0 - self.cmndf[best_tau]).clamp(0.0, 1.0);
        (pitch, confidence)
    }

    /// Return all local CMNDF minima in [min_tau, max_tau] as (tau, cmndf_value).
    /// If no local minima exist, the global minimum is returned as the single entry.
    /// Used by PYIN to build multi-candidate pitch hypotheses per frame.
    pub fn frame_minima(
        &mut self,
        frame:       &[f32],
        sample_rate: f32,
        min_hz:      f32,
        max_hz:      f32,
    ) -> Vec<(usize, f32)> {
        debug_assert_eq!(frame.len(), self.frame_size);

        let max_tau = ((sample_rate / min_hz).ceil() as usize).min(self.frame_size / 2);
        let min_tau = ((sample_rate / max_hz).floor() as usize).max(2);
        if max_tau <= min_tau { return vec![]; }

        self.fill_cmndf(frame, max_tau);

        let mut minima = Vec::new();
        let mut tau = min_tau + 1;
        while tau + 1 <= max_tau {
            if self.cmndf[tau] < self.cmndf[tau - 1] && self.cmndf[tau] <= self.cmndf[tau + 1] {
                // Slide to the true local minimum
                while tau + 1 <= max_tau && self.cmndf[tau + 1] < self.cmndf[tau] {
                    tau += 1;
                }
                minima.push((tau, self.cmndf[tau]));
            }
            tau += 1;
        }

        // Fallback: if no local minimum was found, return the global minimum
        if minima.is_empty() {
            if let Some(best) = (min_tau..=max_tau).min_by(|&a, &b| {
                self.cmndf[a].partial_cmp(&self.cmndf[b])
                    .unwrap_or(std::cmp::Ordering::Equal)
            }) {
                minima.push((best, self.cmndf[best]));
            }
        }

        minima
    }

    fn find_best_tau(&self, min_tau: usize, max_tau: usize, threshold: f32) -> usize {
        let mut tau = min_tau;
        while tau < max_tau {
            if self.cmndf[tau] < threshold {
                while tau + 1 < max_tau && self.cmndf[tau + 1] < self.cmndf[tau] {
                    tau += 1;
                }
                return tau;
            }
            tau += 1;
        }
        (min_tau..=max_tau)
            .min_by(|&a, &b| self.cmndf[a].partial_cmp(&self.cmndf[b])
                .unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or(min_tau)
    }
}

/// Compute pitch for an entire audio signal, returning parallel arrays of
/// `pitch_hz` and `confidence` (one value per hop frame).
pub fn compute_pitch(
    samples:     &[f32],
    sample_rate: f32,
    frame_size:  usize,
    hop:         usize,
    min_hz:      f32,
    max_hz:      f32,
    threshold:   f32,
) -> (Vec<f32>, Vec<f32>) {
    let num_frames = if samples.len() > frame_size {
        (samples.len() - frame_size) / hop + 1
    } else { 0 };

    let mut pitch_hz   = vec![0f32; num_frames];
    let mut confidence = vec![0f32; num_frames];
    let mut yin = YinEstimator::new(frame_size);

    for f in 0..num_frames {
        let start = f * hop;
        let frame = &samples[start..start + frame_size];
        let (p, c) = yin.estimate(frame, sample_rate, min_hz, max_hz, threshold);
        pitch_hz[f]   = p;
        confidence[f] = c;
    }

    (pitch_hz, confidence)
}
