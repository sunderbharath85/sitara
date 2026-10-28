//! Camera RAW via rawler: full development to linear light for the editor, embedded previews for thumbnails.

use image::DynamicImage;
use rawler::decoders::RawDecodeParams;
use rawler::imgop::develop::{Intermediate, ProcessingStep, RawDevelop};
use rawler::rawsource::RawSource;
use rayon::prelude::*;
use std::path::Path;

pub const RAW_EXT: &[&str] = &["dng", "cr2", "cr3", "nef", "nrw", "arw", "raf", "orf", "rw2", "pef", "srw"];

pub fn is_raw(ext: &str) -> bool {
    RAW_EXT.contains(&ext)
}

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Linear-light encoding shared with the editor shader: v = (exp(e * ln(1 + K * MAX)) - 1) / K.
/// Ten bits of log code keep about four stops above white for highlight recovery.
pub const LOG_K: f32 = 64.0;
pub const LOG_MAX: f32 = 8.0;

/// Upright, demosaiced, white-balanced linear sRGB, packed as RGB10_A2 log codes (r | g<<10 | b<<20 | a<<30).
pub struct Developed {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u32>,
}

pub fn develop(path: &Path, max_side: usize) -> Result<Developed, String> {
    let src = RawSource::new(path).map_err(es)?;
    let dec = rawler::get_decoder(&src).map_err(es)?;
    let params = RawDecodeParams::default();
    let raw = dec.raw_image(&src, &params, false).map_err(es)?;
    let orientation = dec.raw_metadata(&src, &params).ok().and_then(|m| m.exif.orientation).unwrap_or(1);
    let dev = RawDevelop::new_with(&[
        ProcessingStep::Rescale,
        ProcessingStep::Demosaic,
        ProcessingStep::FujiRotate,
        ProcessingStep::CropActiveArea,
        ProcessingStep::WhiteBalance,
        ProcessingStep::Calibrate,
        ProcessingStep::CropDefault,
    ]);
    let (rgb, w, h): (Vec<[f32; 3]>, usize, usize) = match dev.develop_intermediate(&raw).map_err(es)? {
        Intermediate::ThreeColor(p) => {
            let d = p.dim();
            (p.data, d.w, d.h)
        }
        Intermediate::Monochrome(p) => {
            let d = p.dim();
            (p.data.into_iter().map(|v| [v, v, v]).collect(), d.w, d.h)
        }
        Intermediate::FourColor(_) => return Err("unsupported four-color raw".into()),
    };
    let (rgb, w, h) = shrink(rgb, w, h, max_side);
    let scale = 1023.0 / (1.0 + LOG_K * LOG_MAX).ln();
    let code = |v: f32| (((1.0 + LOG_K * v.clamp(0.0, LOG_MAX)).ln() * scale) + 0.5) as u32;
    let packed: Vec<u32> = rgb.par_iter().map(|p| code(p[0]) | code(p[1]) << 10 | code(p[2]) << 20 | 3 << 30).collect();
    let (px, w, h) = orient(packed, w, h, orientation);
    Ok(Developed { w, h, px })
}

/// Box-downscale by an integer factor so the result fits the GPU's texture limit.
fn shrink(px: Vec<[f32; 3]>, w: usize, h: usize, max_side: usize) -> (Vec<[f32; 3]>, usize, usize) {
    let f = w.max(h).div_ceil(max_side.max(1));
    if f <= 1 {
        return (px, w, h);
    }
    let (ow, oh) = (w / f, h / f);
    let out = (0..ow * oh)
        .into_par_iter()
        .map(|i| {
            let (x, y) = (i % ow, i / ow);
            let mut s = [0f32; 3];
            for dy in 0..f {
                let row = (y * f + dy) * w + x * f;
                for p in &px[row..row + f] {
                    s[0] += p[0];
                    s[1] += p[1];
                    s[2] += p[2];
                }
            }
            let n = (f * f) as f32;
            [s[0] / n, s[1] / n, s[2] / n]
        })
        .collect();
    (out, ow, oh)
}

/// Apply an EXIF orientation (1–8) to a row-major pixel buffer.
pub fn orient<T: Copy + Send + Sync>(src: Vec<T>, w: usize, h: usize, o: u16) -> (Vec<T>, usize, usize) {
    if !(2..=8).contains(&o) {
        return (src, w, h);
    }
    let (ow, oh) = if o >= 5 { (h, w) } else { (w, h) };
    let out = (0..ow * oh)
        .into_par_iter()
        .map(|i| {
            let (x, y) = (i % ow, i / ow);
            let (sx, sy) = match o {
                2 => (w - 1 - x, y),
                3 => (w - 1 - x, h - 1 - y),
                4 => (x, h - 1 - y),
                5 => (y, x),
                6 => (y, h - 1 - x),
                7 => (w - 1 - y, h - 1 - x),
                _ => (w - 1 - y, x),
            };
            src[sy * w + sx]
        })
        .collect();
    (out, ow, oh)
}

/// Developed size (the camera's default crop), before orientation. Reads headers only, no pixels.
pub fn dims(path: &Path) -> Option<(usize, usize)> {
    let src = RawSource::new(path).ok()?;
    let dec = rawler::get_decoder(&src).ok()?;
    let img = dec.raw_image(&src, &RawDecodeParams::default(), true).ok()?;
    let d = img.crop_area.or(img.active_area).map(|r| r.d)?;
    (d.w > 0 && d.h > 0).then_some((d.w, d.h))
}

/// The largest JPEG the camera embedded, upright. Fast enough for thumbnails.
pub fn preview(path: &Path) -> Result<DynamicImage, String> {
    let src = RawSource::new(path).map_err(es)?;
    let dec = rawler::get_decoder(&src).map_err(es)?;
    let params = RawDecodeParams::default();
    let img = dec
        .full_image(&src, &params)
        .ok()
        .flatten()
        .or_else(|| dec.preview_image(&src, &params).ok().flatten())
        .or_else(|| dec.thumbnail_image(&src, &params).ok().flatten())
        .ok_or("no embedded preview")?;
    let o = dec.raw_metadata(&src, &params).ok().and_then(|m| m.exif.orientation).unwrap_or(1);
    let mut img = img;
    if let Some(o) = image::metadata::Orientation::from_exif(o as u8) {
        img.apply_orientation(o);
    }
    Ok(img)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orientations_match_exif() {
        // 3x2 image, values are their source index
        let src: Vec<u32> = (0..6).collect();
        assert_eq!(orient(src.clone(), 3, 2, 1), (src.clone(), 3, 2));
        // 6 = rotate 90° clockwise: the bottom-left pixel becomes the top-left
        assert_eq!(orient(src.clone(), 3, 2, 6), (vec![3, 0, 4, 1, 5, 2], 2, 3));
        // 8 = rotate 90° counter-clockwise
        assert_eq!(orient(src.clone(), 3, 2, 8), (vec![2, 5, 1, 4, 0, 3], 2, 3));
        assert_eq!(orient(src.clone(), 3, 2, 3), (vec![5, 4, 3, 2, 1, 0], 3, 2));
        assert_eq!(orient(src, 3, 2, 2), (vec![2, 1, 0, 5, 4, 3], 3, 2));
    }

    #[test]
    fn shrink_averages_blocks() {
        let px = vec![[1.0, 0.0, 0.0], [3.0, 0.0, 0.0], [1.0, 0.0, 0.0], [3.0, 0.0, 0.0]];
        let (out, w, h) = shrink(px, 2, 2, 1);
        assert_eq!((w, h), (1, 1));
        assert_eq!(out[0][0], 2.0);
    }
}
