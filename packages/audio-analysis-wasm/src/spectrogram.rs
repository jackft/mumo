use std::sync::Arc;
use rustfft::{Fft, num_complex::Complex};
use crate::colormap::inferno_rgb;

const OVERVIEW_MAX_WIDTH: usize = 4096;

pub struct StatsResult {
    pub db_min: f32,
    pub db_range: f32,
    pub num_freq_bins: usize,
    pub num_linear_bins: usize,
    pub num_frames: usize,
    pub overview_pixels: Vec<u8>,
    pub overview_width: usize,
    pub flux: Vec<f32>,
    /// Per-band spectral flux. Layout: band_flux[f * num_snap_bands + b].
    /// 4 equal-width frequency bands, low (0) to high (3).
    pub band_flux: Vec<f32>,
    pub num_snap_bands: usize,
    pub frame_rms: Vec<f32>,
    /// Zero-crossing rate per frame (0.0–1.0).
    pub zcr: Vec<f32>,
    /// Quantized magnitudes (0..=255), len = num_frames * num_freq_bins.
    /// Empty when the file is too long to fit within the memory budget.
    pub mag_cache: Vec<u8>,
}

#[inline(always)]
fn norm_to_db(norm_sqr: f32) -> f32 {
    10.0 * (norm_sqr + 1e-20).log10()
}

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10f32.powf(mel / 2595.0) - 1.0)
}

pub struct MelFilterbank {
    pub num_mel_bands: usize,
    /// For each mel band: (fft_bin_index, weight) pairs.
    pub bands: Vec<Vec<(usize, f32)>>,
}

pub fn build_mel_filterbank(
    sample_rate: u32,
    num_linear_bins: usize,
    mel_bands: usize,
    max_freq_hz: f32,
) -> MelFilterbank {
    let sr = sample_rate as f32;
    let max_freq = max_freq_hz.min(sr / 2.0);
    let min_mel = hz_to_mel(0.0);
    let max_mel = hz_to_mel(max_freq);
    let freq_per_bin = sr / (2.0 * num_linear_bins as f32);

    let mel_points: Vec<f32> = (0..=(mel_bands + 1))
        .map(|i| min_mel + (max_mel - min_mel) * i as f32 / (mel_bands + 1) as f32)
        .collect();
    let bin_points: Vec<usize> = mel_points.iter()
        .map(|&m| {
            let bin = (mel_to_hz(m) / freq_per_bin).round() as usize;
            bin.min(num_linear_bins.saturating_sub(1))
        })
        .collect();

    let bands: Vec<Vec<(usize, f32)>> = (0..mel_bands).map(|m| {
        let lo     = bin_points[m];
        let center = bin_points[m + 1];
        let hi     = bin_points[m + 2].min(num_linear_bins.saturating_sub(1));
        let mut band: Vec<(usize, f32)> = Vec::new();
        if center > lo {
            for k in lo..center {
                band.push((k, (k - lo) as f32 / (center - lo) as f32));
            }
        }
        band.push((center, 1.0f32));
        if hi > center {
            for k in (center + 1)..=hi {
                band.push((k, (hi - k) as f32 / (hi - center) as f32));
            }
        }
        band
    }).collect();

    MelFilterbank { num_mel_bands: mel_bands, bands }
}

#[inline]
fn fill_output_mag(
    frame_buf: &[Complex<f32>],
    num_linear_bins: usize,
    cur_mag: &mut [f32],
    mel_filterbank: Option<&MelFilterbank>,
) {
    if let Some(fb) = mel_filterbank {
        for (m, band) in fb.bands.iter().enumerate() {
            let energy: f32 = band.iter().map(|&(k, w)| frame_buf[k].norm_sqr() * w).sum();
            cur_mag[m] = norm_to_db(energy);
        }
    } else {
        for k in 0..num_linear_bins {
            cur_mag[k] = norm_to_db(frame_buf[k].norm_sqr());
        }
    }
}

pub fn compute_spectrogram_stats(
    samples: &[f32],
    sample_rate: u32,
    window_size: usize,
    hop: usize,
    max_freq_hz: f32,
    dynamic_range_db: f32,
    window_coeff: &[f32],
    fft: &Arc<dyn Fft<f32>>,
    scratch: &mut Vec<Complex<f32>>,
    frame_buf: &mut Vec<Complex<f32>>,
    mag_cache_limit: usize,
    mel_filterbank: Option<&MelFilterbank>,
    on_progress: &mut dyn FnMut(usize, usize),
) -> StatsResult {
    const PROGRESS_INTERVAL: usize = 2048;
    let sr = sample_rate as f32;
    let max_freq = max_freq_hz.min(sr / 2.0);
    let max_bin = (max_freq / (sr / window_size as f32)).round() as usize;
    let num_linear_bins = max_bin.min(window_size / 2);
    let num_freq_bins = mel_filterbank.map_or(num_linear_bins, |fb| fb.num_mel_bands);

    let num_frames = if samples.len() > window_size {
        (samples.len() - window_size) / hop + 1
    } else {
        1
    };

    // ── Phase 1: estimate dB range from 1/8 of frames ──────────────────────
    let step = 8usize;
    let mut global_min = f32::INFINITY;
    let mut global_max = f32::NEG_INFINITY;
    let mut tmp_mag = vec![0f32; num_freq_bins];

    for f in (0..num_frames).step_by(step) {
        let frame_start = f * hop;
        for j in 0..window_size {
            let idx = frame_start + j;
            let s = if idx < samples.len() { samples[idx] } else { 0.0 };
            frame_buf[j] = Complex::new(s * window_coeff[j], 0.0);
        }
        fft.process_with_scratch(frame_buf, scratch);
        fill_output_mag(frame_buf, num_linear_bins, &mut tmp_mag, mel_filterbank);
        for &db in &tmp_mag[..num_freq_bins] {
            if db < global_min { global_min = db; }
            if db > global_max { global_max = db; }
        }
    }

    let db_min   = global_min.max(global_max - dynamic_range_db);
    let db_range = (global_max - db_min).max(1.0);

    // ── Phase 2: full pass — overview + flux/rms + optional magnitude cache ─
    let overview_width = num_frames.min(OVERVIEW_MAX_WIDTH);
    let overview_bin_size = (num_frames as f32 / overview_width as f32).ceil() as usize;

    let mut overview_accum = vec![0f64; overview_width * num_freq_bins];
    let mut overview_count = vec![0u32; overview_width];
    let mut flux      = vec![0f32; num_frames];
    const NUM_SNAP_BANDS: usize = 4;
    let mut band_flux = vec![0f32; num_frames * NUM_SNAP_BANDS];
    let mut frame_rms = vec![0f32; num_frames];
    let mut zcr       = vec![0f32; num_frames];

    let cache_bytes = num_frames * num_freq_bins;
    let will_cache = cache_bytes <= mag_cache_limit;
    let mut mag_cache = if will_cache { vec![0u8; cache_bytes] } else { Vec::new() };

    let mut prev_mag = vec![0f32; num_freq_bins];
    let mut cur_mag  = vec![0f32; num_freq_bins];

    for f in 0..num_frames {
        let frame_start = f * hop;
        for j in 0..window_size {
            let idx = frame_start + j;
            let s = if idx < samples.len() { samples[idx] } else { 0.0 };
            frame_buf[j] = Complex::new(s * window_coeff[j], 0.0);
        }
        fft.process_with_scratch(frame_buf, scratch);
        fill_output_mag(frame_buf, num_linear_bins, &mut cur_mag, mel_filterbank);

        let mut flux_sum = 0f32;
        for k in 0..num_freq_bins {
            let db = cur_mag[k];

            if f > 0 {
                let d = db - prev_mag[k];
                if d > 0.0 {
                    flux_sum += d;
                    let b = (k * NUM_SNAP_BANDS) / num_freq_bins;
                    band_flux[f * NUM_SNAP_BANDS + b] += d;
                }
            }

            if will_cache {
                let q = ((db - db_min) / db_range).clamp(0.0, 1.0);
                mag_cache[f * num_freq_bins + k] = (q * 255.0) as u8;
            }
        }
        flux[f] = flux_sum;
        prev_mag.copy_from_slice(&cur_mag);

        let o_bin = (f / overview_bin_size).min(overview_width - 1);
        for k in 0..num_freq_bins {
            overview_accum[o_bin * num_freq_bins + k] += cur_mag[k] as f64;
        }
        overview_count[o_bin] += 1;

        let end = (frame_start + hop).min(samples.len());
        let hop_samples = &samples[frame_start..end];
        let sq: f32 = hop_samples.iter().map(|&s| s * s).sum();
        frame_rms[f] = (sq / hop_samples.len() as f32).sqrt();
        let zc = hop_samples.windows(2).filter(|w| (w[0] > 0.0) != (w[1] > 0.0)).count();
        zcr[f] = if hop_samples.len() > 1 { zc as f32 / (hop_samples.len() - 1) as f32 } else { 0.0 };

        if f % PROGRESS_INTERVAL == PROGRESS_INTERVAL - 1 || f == num_frames - 1 {
            on_progress(f + 1, num_frames);
        }
    }

    // ── Render overview to RGBA ─────────────────────────────────────────────
    let mut overview_pixels = vec![0u8; overview_width * num_freq_bins * 4];
    for x in 0..overview_width {
        let cnt = overview_count[x].max(1) as f64;
        for k in 0..num_freq_bins {
            let avg_db = (overview_accum[x * num_freq_bins + k] / cnt) as f32;
            let t = ((avg_db - db_min) / db_range).clamp(0.0, 1.0);
            let (r, g, b) = inferno_rgb(t);
            let y = num_freq_bins - 1 - k;
            let px = (y * overview_width + x) * 4;
            overview_pixels[px]     = r;
            overview_pixels[px + 1] = g;
            overview_pixels[px + 2] = b;
            overview_pixels[px + 3] = 255;
        }
    }

    StatsResult {
        db_min, db_range, num_freq_bins, num_linear_bins, num_frames,
        overview_pixels, overview_width, flux, band_flux,
        num_snap_bands: NUM_SNAP_BANDS, frame_rms, zcr, mag_cache,
    }
}

/// Fast path: no FFT — reads quantized magnitudes from cache and applies colormap.
pub fn render_from_cache(
    mag_cache: &[u8],
    num_freq_bins: usize,
    start_frame: usize,
    end_frame: usize,
) -> Vec<u8> {
    let tile_width = end_frame - start_frame;
    let mut pixels = vec![0u8; tile_width * num_freq_bins * 4];

    for f in start_frame..end_frame {
        let local_f = f - start_frame;
        let base = f * num_freq_bins;
        for k in 0..num_freq_bins {
            let t = mag_cache[base + k] as f32 / 255.0;
            let (r, g, b) = inferno_rgb(t);
            let y = num_freq_bins - 1 - k;
            let px = (y * tile_width + local_f) * 4;
            pixels[px]     = r;
            pixels[px + 1] = g;
            pixels[px + 2] = b;
            pixels[px + 3] = 255;
        }
    }

    pixels
}

/// Slow path (long files): re-runs FFT for the given frame range.
pub fn render_detail_tile(
    samples: &[f32],
    window_size: usize,
    hop: usize,
    window_coeff: &[f32],
    fft: &Arc<dyn Fft<f32>>,
    scratch: &mut Vec<Complex<f32>>,
    frame_buf: &mut Vec<Complex<f32>>,
    num_linear_bins: usize,
    num_freq_bins: usize,
    db_min: f32,
    db_range: f32,
    start_frame: usize,
    end_frame: usize,
    mel_filterbank: Option<&MelFilterbank>,
) -> Vec<u8> {
    let tile_width = end_frame - start_frame;
    let mut pixels = vec![0u8; tile_width * num_freq_bins * 4];
    let mut cur_mag = vec![0f32; num_freq_bins];

    for f in start_frame..end_frame {
        let frame_start = f * hop;
        for j in 0..window_size {
            let idx = frame_start + j;
            let s = if idx < samples.len() { samples[idx] } else { 0.0 };
            frame_buf[j] = Complex::new(s * window_coeff[j], 0.0);
        }
        fft.process_with_scratch(frame_buf, scratch);
        fill_output_mag(frame_buf, num_linear_bins, &mut cur_mag, mel_filterbank);

        let local_f = f - start_frame;
        for k in 0..num_freq_bins {
            let t = ((cur_mag[k] - db_min) / db_range).clamp(0.0, 1.0);
            let (r, g, b) = inferno_rgb(t);
            let y = num_freq_bins - 1 - k;
            let px = (y * tile_width + local_f) * 4;
            pixels[px]     = r;
            pixels[px + 1] = g;
            pixels[px + 2] = b;
            pixels[px + 3] = 255;
        }
    }

    pixels
}
