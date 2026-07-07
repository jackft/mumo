use std::f64::consts::PI;

pub enum WindowFn {
    Hann,
    Hamming,
    /// PRAAT default: Gaussian with π-based envelope, essentially 0 at edges.
    Gaussian,
}

pub fn build_window(size: usize, kind: WindowFn) -> Vec<f32> {
    let n = size as f64;
    (0..size)
        .map(|i| {
            let i = i as f64;
            match kind {
                WindowFn::Hann => (0.5 - 0.5 * (2.0 * PI * i / (n - 1.0)).cos()) as f32,
                WindowFn::Hamming => (0.54 - 0.46 * (2.0 * PI * i / (n - 1.0)).cos()) as f32,
                // PRAAT: w(t) = exp(-π * ((i - N/2) / (N/2))²)
                WindowFn::Gaussian => {
                    let half = n / 2.0;
                    let t = (i - half) / half;
                    (-PI * t * t).exp() as f32
                }
            }
        })
        .collect()
}
