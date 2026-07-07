// Inferno colormap control points: (t, r, g, b)
const STOPS: &[(f32, u8, u8, u8)] = &[
    (0.00,   0,   0,   4),
    (0.13,  20,  11,  52),
    (0.25,  81,  11, 109),
    (0.38, 141,  22,  98),
    (0.50, 194,  55,  68),
    (0.63, 234,  96,  38),
    (0.75, 249, 142,   9),
    (0.88, 249, 199,  65),
    (1.00, 252, 255, 164),
];

pub fn inferno_rgb(t: f32) -> (u8, u8, u8) {
    let t = t.clamp(0.0, 1.0);
    let mut i = 0;
    while i < STOPS.len() - 2 && STOPS[i + 1].0 < t {
        i += 1;
    }
    let (t0, r0, g0, b0) = STOPS[i];
    let (t1, r1, g1, b1) = STOPS[i + 1];
    let alpha = if t1 == t0 { 0.0 } else { (t - t0) / (t1 - t0) };
    (
        (r0 as f32 + alpha * (r1 as f32 - r0 as f32)).round() as u8,
        (g0 as f32 + alpha * (g1 as f32 - g0 as f32)).round() as u8,
        (b0 as f32 + alpha * (b1 as f32 - b0 as f32)).round() as u8,
    )
}
