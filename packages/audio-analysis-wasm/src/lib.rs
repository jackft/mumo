mod colormap;
mod spectrogram;
mod window;
mod yin;
mod pyin;

use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use rustfft::{Fft, FftPlanner, num_complex::Complex};
use window::build_window;
use spectrogram::{
    compute_spectrogram_stats, render_detail_tile, render_from_cache,
    build_mel_filterbank, MelFilterbank,
};

fn window_fn_from_u8(v: u8) -> window::WindowFn {
    match v {
        1 => window::WindowFn::Hamming,
        2 => window::WindowFn::Gaussian,
        _ => window::WindowFn::Hann,
    }
}

// ~100 MB budget for the magnitude cache.
const MAG_CACHE_LIMIT: usize = 100 * 1024 * 1024;

#[wasm_bindgen]
pub struct SampleBuffer {
    samples: Vec<f32>,
    fft: Arc<dyn Fft<f32>>,
    window_coeff: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    frame_buf: Vec<Complex<f32>>,
    window_size: usize,

    mag_cache: Vec<u8>,
    cache_db_min: f32,
    cache_db_range: f32,
    cache_num_freq_bins: usize,
    cache_num_linear_bins: usize,
    mel_filterbank: Option<MelFilterbank>,
}

#[wasm_bindgen]
impl SampleBuffer {
    /// Copy samples into WASM memory and prepare the FFT plan.
    /// window_fn: 0 = Hann, 1 = Hamming, 2 = Gaussian (PRAAT default)
    #[wasm_bindgen(constructor)]
    pub fn new(samples: Vec<f32>, window_size: usize, window_fn: u8) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(window_size);
        let scratch_len = fft.get_inplace_scratch_len();
        let window_coeff = build_window(window_size, window_fn_from_u8(window_fn));
        Self {
            samples,
            fft,
            window_coeff,
            scratch: vec![Complex::new(0.0, 0.0); scratch_len],
            frame_buf: vec![Complex::new(0.0, 0.0); window_size],
            window_size,
            mag_cache: Vec::new(),
            cache_db_min: 0.0,
            cache_db_range: 1.0,
            cache_num_freq_bins: 0,
            cache_num_linear_bins: 0,
            mel_filterbank: None,
        }
    }

    /// on_progress is called with (frames_done, num_frames) every PROGRESS_INTERVAL frames.
    /// mel_bands: 0 = linear spectrogram, N > 0 = mel spectrogram with N bands.
    pub fn compute_stats(
        &mut self,
        hop: usize,
        max_freq_hz: f32,
        sample_rate: u32,
        dynamic_range_db: f32,
        mel_bands: u32,
        on_progress: &js_sys::Function,
    ) -> SpectrogramStats {
        // Build mel filterbank before the borrow in compute_spectrogram_stats
        if mel_bands > 0 {
            let sr = sample_rate as f32;
            let max_freq = max_freq_hz.min(sr / 2.0);
            let max_bin = (max_freq / (sr / self.window_size as f32)).round() as usize;
            let num_linear_bins = max_bin.min(self.window_size / 2);
            self.mel_filterbank = Some(build_mel_filterbank(
                sample_rate, num_linear_bins, mel_bands as usize, max_freq_hz,
            ));
        } else {
            self.mel_filterbank = None;
        }

        let cb = on_progress;
        let r = compute_spectrogram_stats(
            &self.samples,
            sample_rate,
            self.window_size,
            hop,
            max_freq_hz,
            dynamic_range_db,
            &self.window_coeff,
            &self.fft,
            &mut self.scratch,
            &mut self.frame_buf,
            MAG_CACHE_LIMIT,
            self.mel_filterbank.as_ref(),
            &mut |done: usize, total: usize| {
                let _ = cb.call2(
                    &JsValue::NULL,
                    &JsValue::from_f64(done as f64),
                    &JsValue::from_f64(total as f64),
                );
            },
        );

        self.mag_cache = r.mag_cache;
        self.cache_db_min = r.db_min;
        self.cache_db_range = r.db_range;
        self.cache_num_freq_bins = r.num_freq_bins;
        self.cache_num_linear_bins = r.num_linear_bins;

        SpectrogramStats {
            db_min: r.db_min,
            db_range: r.db_range,
            num_freq_bins: r.num_freq_bins,
            num_frames: r.num_frames,
            overview_width: r.overview_width,
            overview_pixels: r.overview_pixels,
            flux: r.flux,
            band_flux: r.band_flux,
            num_snap_bands: r.num_snap_bands,
            frame_rms: r.frame_rms,
            zcr: r.zcr,
        }
    }

    /// Run fast YIN pitch estimation (FFT-based autocorrelation) over the stored samples.
    pub fn compute_pitch(
        &self,
        hop: usize,
        frame_size: usize,
        sample_rate: f32,
        min_hz: f32,
        max_hz: f32,
        threshold: f32,
    ) -> PitchResult {
        let (pitch_hz, confidence) =
            yin::compute_pitch(&self.samples, sample_rate, frame_size, hop, min_hz, max_hz, threshold);
        PitchResult { pitch_hz, confidence }
    }

    /// Run PYIN (Probabilistic YIN + Viterbi HMM) pitch estimation.
    ///
    /// Returns per-frame pitch and voiced probability. Significantly reduces octave
    /// errors compared to raw YIN by considering all CMNDF local minima per frame
    /// and using temporal smoothing via a Hidden Markov Model.
    pub fn compute_pyin(
        &self,
        hop: usize,
        frame_size: usize,
        sample_rate: f32,
        min_hz: f32,
        max_hz: f32,
    ) -> PyinResult {
        let (pitch_hz, voiced_prob) =
            pyin::compute_pyin(&self.samples, sample_rate, frame_size, hop, min_hz, max_hz);
        PyinResult { pitch_hz, voiced_prob }
    }

    /// Render one detail tile. Uses cached magnitudes if available (no FFT),
    /// otherwise re-runs FFT for the frame range.
    pub fn render_tile(
        &mut self,
        num_freq_bins: usize,
        db_min: f32,
        db_range: f32,
        start_frame: usize,
        end_frame: usize,
        hop: usize,
    ) -> Vec<u8> {
        if !self.mag_cache.is_empty() {
            render_from_cache(
                &self.mag_cache,
                self.cache_num_freq_bins,
                start_frame,
                end_frame,
            )
        } else {
            render_detail_tile(
                &self.samples,
                self.window_size,
                hop,
                &self.window_coeff,
                &self.fft,
                &mut self.scratch,
                &mut self.frame_buf,
                self.cache_num_linear_bins,
                num_freq_bins,
                db_min,
                db_range,
                start_frame,
                end_frame,
                self.mel_filterbank.as_ref(),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// PitchResult — returned from compute_pitch
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct PitchResult {
    pitch_hz:   Vec<f32>,
    confidence: Vec<f32>,
}

#[wasm_bindgen]
impl PitchResult {
    #[wasm_bindgen(getter)] pub fn num_frames(&self) -> usize { self.pitch_hz.len() }
    pub fn take_pitch_hz(&mut self)   -> Vec<f32> { std::mem::take(&mut self.pitch_hz) }
    pub fn take_confidence(&mut self) -> Vec<f32> { std::mem::take(&mut self.confidence) }
}

// ---------------------------------------------------------------------------
// PyinResult — returned from compute_pyin
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct PyinResult {
    pitch_hz:    Vec<f32>,
    voiced_prob: Vec<f32>,
}

#[wasm_bindgen]
impl PyinResult {
    #[wasm_bindgen(getter)] pub fn num_frames(&self) -> usize { self.pitch_hz.len() }
    pub fn take_pitch_hz(&mut self)    -> Vec<f32> { std::mem::take(&mut self.pitch_hz) }
    pub fn take_voiced_prob(&mut self) -> Vec<f32> { std::mem::take(&mut self.voiced_prob) }
}

// ---------------------------------------------------------------------------
// SpectrogramStats — returned from compute_stats
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct SpectrogramStats {
    db_min: f32,
    db_range: f32,
    num_freq_bins: usize,
    num_frames: usize,
    overview_width: usize,
    overview_pixels: Vec<u8>,
    flux: Vec<f32>,
    band_flux: Vec<f32>,
    num_snap_bands: usize,
    frame_rms: Vec<f32>,
    zcr: Vec<f32>,
}

#[wasm_bindgen]
impl SpectrogramStats {
    #[wasm_bindgen(getter)] pub fn db_min(&self) -> f32 { self.db_min }
    #[wasm_bindgen(getter)] pub fn db_range(&self) -> f32 { self.db_range }
    #[wasm_bindgen(getter)] pub fn num_freq_bins(&self) -> usize { self.num_freq_bins }
    #[wasm_bindgen(getter)] pub fn num_frames(&self) -> usize { self.num_frames }
    #[wasm_bindgen(getter)] pub fn overview_width(&self) -> usize { self.overview_width }
    #[wasm_bindgen(getter)] pub fn num_snap_bands(&self) -> usize { self.num_snap_bands }

    pub fn take_overview_pixels(&mut self) -> Vec<u8>  { std::mem::take(&mut self.overview_pixels) }
    pub fn take_flux(&mut self)            -> Vec<f32> { std::mem::take(&mut self.flux) }
    pub fn take_band_flux(&mut self)       -> Vec<f32> { std::mem::take(&mut self.band_flux) }
    pub fn take_frame_rms(&mut self)       -> Vec<f32> { std::mem::take(&mut self.frame_rms) }
    pub fn take_zcr(&mut self)             -> Vec<f32> { std::mem::take(&mut self.zcr) }
}
