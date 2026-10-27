//! Per-photo signals computed from the cached 360 px thumbnail (cheap: no original decode).

use image::{imageops, GrayImage};

#[derive(Debug, Clone, Copy)]
pub struct Analysis {
    /// 64-bit difference hash: near-identical images differ in a few bits even after resize/re-encode.
    pub dhash: i64,
    /// Variance of the Laplacian; low values mean little fine detail (blur or a flat scene).
    pub sharp: f64,
    pub luma: f64,
    pub contrast: f64,
    /// Fraction of pixels crushed to black or blown to white.
    pub clip: f64,
}

pub fn from_jpeg(bytes: &[u8]) -> Option<Analysis> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).ok()?;
    Some(compute(&img.to_luma8()))
}

pub fn compute(g: &GrayImage) -> Analysis {
    let (w, h) = g.dimensions();
    let small = imageops::resize(g, 9, 8, imageops::FilterType::Triangle);
    let mut bits: u64 = 0;
    for y in 0..8 {
        for x in 0..8 {
            bits = (bits << 1) | (small.get_pixel(x, y)[0] > small.get_pixel(x + 1, y)[0]) as u64;
        }
    }

    let px = g.as_raw();
    let n = px.len().max(1) as f64;
    let (mut s, mut s2, mut clipped) = (0f64, 0f64, 0u64);
    for &p in px {
        let v = p as f64;
        s += v;
        s2 += v * v;
        if !(8..=247).contains(&p) {
            clipped += 1;
        }
    }
    let luma = s / n;
    let contrast = (s2 / n - luma * luma).max(0.0).sqrt();

    let (w, h) = (w as usize, h as usize);
    let (mut l, mut l2, mut m) = (0f64, 0f64, 0f64);
    if w > 2 && h > 2 {
        for y in 1..h - 1 {
            let row = y * w;
            for x in 1..w - 1 {
                let c = px[row + x] as i32 * 4
                    - px[row + x - 1] as i32
                    - px[row + x + 1] as i32
                    - px[row - w + x] as i32
                    - px[row + w + x] as i32;
                let c = c as f64;
                l += c;
                l2 += c * c;
                m += 1.0;
            }
        }
    }
    let sharp = if m > 0.0 { l2 / m - (l / m).powi(2) } else { 0.0 };
    Analysis { dhash: bits as i64, sharp, luma, contrast, clip: clipped as f64 / n }
}

pub fn hamming(a: i64, b: i64) -> u32 {
    (a ^ b).count_ones()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Luma;

    fn scene(w: u32, h: u32, blur: bool) -> GrayImage {
        let img = GrayImage::from_fn(w, h, |x, y| {
            let v = ((x / 6 + y / 9) % 2) as u8 * 180 + (x * 60 / w) as u8;
            Luma([v])
        });
        if blur { imageops::blur(&img, 3.0) } else { img }
    }

    #[test]
    fn resized_copy_keeps_its_hash_and_blur_loses_sharpness() {
        let a = scene(540, 360, false);
        let b = imageops::resize(&a, 270, 180, imageops::FilterType::Lanczos3);
        let (fa, fb) = (compute(&a), compute(&b));
        assert!(hamming(fa.dhash, fb.dhash) <= 4, "resized copy: {}", hamming(fa.dhash, fb.dhash));
        let blurred = compute(&scene(540, 360, true));
        assert!(blurred.sharp < fa.sharp / 10.0, "blur {} vs sharp {}", blurred.sharp, fa.sharp);
        let flat = compute(&GrayImage::from_pixel(100, 100, Luma([255])));
        assert_eq!(flat.clip, 1.0);
        assert_eq!(flat.contrast, 0.0);
    }
}
