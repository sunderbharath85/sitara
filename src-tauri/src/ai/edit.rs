//! AI editing (stage 5): image-in, image-out operations for the editor. The editor sends pixels it already
//! has (any source format, upright and developed, sRGB) and decides how to layer the results
//! non-destructively. Every model here is an optional download.

use super::{es, Ai};
use fast_image_resize as fr;
use image::{GrayImage, RgbImage};
use ort::session::Session;
use ort::value::Tensor;

const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

impl Ai {
    fn with_model<T>(&self, key: &str, file: &'static str, f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
        if !self.pack_on(key) {
            return Err("This AI feature isn't downloaded yet.".into());
        }
        let mut e = self.engines.lock().unwrap();
        if !e.edit.contains_key(file) {
            let s = self.session(file)?;
            e.edit.insert(file, s);
        }
        f(e.edit.get_mut(file).unwrap())
    }

    /// Free the editing models (the editor closed).
    pub fn release_edit(&self) {
        self.engines.lock().unwrap().edit.clear();
    }
}

fn resize_rgb(img: &RgbImage, w: u32, h: u32) -> RgbImage {
    if img.dimensions() == (w, h) {
        return img.clone();
    }
    let from = fr::images::ImageRef::new(img.width(), img.height(), img.as_raw(), fr::PixelType::U8x3).unwrap();
    let mut to = fr::images::Image::new(w, h, fr::PixelType::U8x3);
    let opts = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::CatmullRom));
    fr::Resizer::new().resize(&from, &mut to, &opts).unwrap();
    RgbImage::from_raw(w, h, to.into_vec()).unwrap()
}

fn resize_gray(img: &GrayImage, w: u32, h: u32) -> GrayImage {
    if img.dimensions() == (w, h) {
        return img.clone();
    }
    let from = fr::images::ImageRef::new(img.width(), img.height(), img.as_raw(), fr::PixelType::U8).unwrap();
    let mut to = fr::images::Image::new(w, h, fr::PixelType::U8);
    let opts = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Bilinear));
    fr::Resizer::new().resize(&from, &mut to, &opts).unwrap();
    GrayImage::from_raw(w, h, to.into_vec()).unwrap()
}

/// CHW floats; `norm` maps (channel, 0..1 value) to the model's input range.
fn chw(img: &RgbImage, norm: impl Fn(usize, f32) -> f32) -> Vec<f32> {
    let (w, h) = img.dimensions();
    let plane = (w * h) as usize;
    let mut out = vec![0f32; plane * 3];
    for (i, p) in img.pixels().enumerate() {
        for c in 0..3 {
            out[c * plane + i] = norm(c, p[c] as f32 / 255.0);
        }
    }
    out
}

fn from_chw(v: &[f32], w: u32, h: u32, scale: f32) -> RgbImage {
    let plane = (w * h) as usize;
    let mut img = RgbImage::new(w, h);
    for (i, p) in img.pixels_mut().enumerate() {
        for c in 0..3 {
            p[c] = (v[c * plane + i] * scale).round().clamp(0.0, 255.0) as u8;
        }
    }
    img
}

fn gray_of(v: &[f32], w: u32, h: u32, f: impl Fn(f32) -> f32) -> GrayImage {
    GrayImage::from_raw(w, h, v.iter().map(|&x| (f(x) * 255.0).round().clamp(0.0, 255.0) as u8).collect()).unwrap()
}

fn first_output(out: &ort::session::SessionOutputs) -> Result<Vec<f32>, String> {
    Ok(out[0].try_extract_tensor::<f32>().map_err(es)?.1.to_vec())
}

/// Fill where `mask` is set (>127) from the surroundings (LaMa at 512×512). Same size out; untouched
/// outside the mask.
pub fn inpaint(ai: &Ai, img: &RgbImage, mask: &GrayImage) -> Result<RgbImage, String> {
    const S: u32 = 512;
    let (w, h) = img.dimensions();
    let small = resize_rgb(img, S, S);
    let m = resize_gray(mask, S, S);
    let mv: Vec<f32> = m.as_raw().iter().map(|&x| if x > 60 { 1.0 } else { 0.0 }).collect();
    let out = ai.with_model("erase", "lama.onnx", |s| {
        let o = s
            .run(ort::inputs![
                "image" => Tensor::from_array(([1usize, 3, S as usize, S as usize], chw(&small, |_, v| v))).map_err(es)?,
                "mask" => Tensor::from_array(([1usize, 1, S as usize, S as usize], mv)).map_err(es)?
            ])
            .map_err(es)?;
        first_output(&o)
    })?;
    let filled = resize_rgb(&from_chw(&out, S, S, 1.0), w, h);
    let mut res = img.clone();
    for (x, y, p) in res.enumerate_pixels_mut() {
        if mask.get_pixel(x, y)[0] > 127 {
            *p = *filled.get_pixel(x, y);
        }
    }
    Ok(res)
}

/// The main subject as a soft mask (BiRefNet-lite at 1024×1024).
pub fn subject(ai: &Ai, img: &RgbImage) -> Result<GrayImage, String> {
    const S: u32 = 1024;
    let (w, h) = img.dimensions();
    let input = chw(&resize_rgb(img, S, S), |c, v| (v - MEAN[c]) / STD[c]);
    let out = ai.with_model("subject", "birefnet.onnx", |s| {
        let o = s.run(ort::inputs!["input_image" => Tensor::from_array(([1usize, 3, S as usize, S as usize], input)).map_err(es)?]).map_err(es)?;
        first_output(&o)
    })?;
    Ok(resize_gray(&gray_of(&out, S, S, |x| 1.0 / (1.0 + (-x).exp())), w, h))
}

/// Sky as a soft mask (U²-Net at 320×320).
pub fn sky(ai: &Ai, img: &RgbImage) -> Result<GrayImage, String> {
    const S: u32 = 320;
    let (w, h) = img.dimensions();
    let input = chw(&resize_rgb(img, S, S), |c, v| (v - MEAN[c]) / STD[c]);
    let out = ai.with_model("sky", "skyseg.onnx", |s| {
        let o = s.run(ort::inputs!["input.1" => Tensor::from_array(([1usize, 3, S as usize, S as usize], input)).map_err(es)?]).map_err(es)?;
        first_output(&o)
    })?;
    Ok(resize_gray(&gray_of(&out, S, S, |x| x.clamp(0.0, 1.0)), w, h))
}

/// Relative depth, near = white (Depth Anything V2 Small), normalized per image.
pub fn depth(ai: &Ai, img: &RgbImage) -> Result<GrayImage, String> {
    let (w, h) = img.dimensions();
    let k = 518.0 / w.max(h) as f32;
    let snap = |v: u32| (((v as f32 * k) / 14.0).round() as u32).max(1) * 14;
    let (dw, dh) = (snap(w), snap(h));
    let input = chw(&resize_rgb(img, dw, dh), |c, v| (v - MEAN[c]) / STD[c]);
    let out = ai.with_model("depth", "depth.onnx", |s| {
        let o = s.run(ort::inputs!["pixel_values" => Tensor::from_array(([1usize, 3, dh as usize, dw as usize], input)).map_err(es)?]).map_err(es)?;
        first_output(&o)
    })?;
    let (lo, hi) = out.iter().fold((f32::MAX, f32::MIN), |(a, b), &x| (a.min(x), b.max(x)));
    Ok(resize_gray(&gray_of(&out, dw, dh, |x| (x - lo) / (hi - lo).max(1e-6)), w, h))
}

/// Remove sensor noise (NAFNet, trained on real camera noise). Works on any size; the editor sends tiles.
pub fn denoise(ai: &Ai, img: &RgbImage) -> Result<RgbImage, String> {
    let (w, h) = img.dimensions();
    let (pw, ph) = (w.div_ceil(16) * 16, h.div_ceil(16) * 16);
    let mut padded = RgbImage::new(pw, ph);
    for (x, y, p) in padded.enumerate_pixels_mut() {
        *p = *img.get_pixel(x.min(w - 1), y.min(h - 1));
    }
    let out = ai.with_model("denoise", "nafnet.onnx", |s| {
        let o = s.run(ort::inputs!["input" => Tensor::from_array(([1usize, 3, ph as usize, pw as usize], chw(&padded, |_, v| v))).map_err(es)?]).map_err(es)?;
        first_output(&o)
    })?;
    let full = from_chw(&out, pw, ph, 255.0);
    Ok(image::imageops::crop_imm(&full, 0, 0, w, h).to_image())
}

/// 4× super-resolution (Real-ESRGAN general x4v3). The editor sends tiles.
pub fn upscale(ai: &Ai, img: &RgbImage) -> Result<RgbImage, String> {
    let (w, h) = img.dimensions();
    let out = ai.with_model("upscale", "esrgan.onnx", |s| {
        let o = s.run(ort::inputs!["input" => Tensor::from_array(([1usize, 3, h as usize, w as usize], chw(img, |_, v| v))).map_err(es)?]).map_err(es)?;
        first_output(&o)
    })?;
    Ok(from_chw(&out, w * 4, h * 4, 255.0))
}

/// How well each image matches a description (CLIP), for choosing looks from words.
pub fn rank(ai: &Ai, q: &str, imgs: &[RgbImage]) -> Result<Vec<f32>, String> {
    if !ai.search_on() {
        return Err("Describing edits with looks needs Search by meaning.".into());
    }
    let t = ai.embed_text(q)?;
    let e = ai.embed_images(&imgs.iter().collect::<Vec<_>>())?;
    Ok(e.iter().map(|v| v.iter().zip(&t).map(|(a, b)| a * b).sum::<f32>()).collect())
}

/// Face boxes (x, y, w, h, normalized) in an image, for face-aware edits.
pub fn faces(ai: &Ai, img: &RgbImage) -> Result<Vec<[f32; 4]>, String> {
    if !ai.people_on() {
        return Err("Finding faces needs People.".into());
    }
    let (w, h) = (img.width() as f32, img.height() as f32);
    Ok(ai.faces_raw(img)?.into_iter().map(|d| [d.x / w, d.y / h, d.w / w, d.h / h]).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// Every editing model on real photos: `SITARA_MODELS=<dir> SITARA_FACES=<dir> cargo test -- --ignored`.
    /// Writes results next to the inputs as `out-*.png` for a look.
    #[test]
    #[ignore]
    fn editing_models_end_to_end() {
        let (Ok(m), Ok(f)) = (std::env::var("SITARA_MODELS"), std::env::var("SITARA_FACES")) else { return };
        let ai = Ai::new(PathBuf::from(m));
        let dir = Path::new(&f);
        let load = |n: &str| crate::thumbs::fit(crate::thumbs::decode(&dir.join(n)).unwrap().to_rgb8(), 1024);
        let t = std::time::Instant::now();
        let street = load("street.jpg");
        let sky = sky(&ai, &street).unwrap();
        let top = sky.get_pixel(street.width() / 2, 5)[0];
        let bottom = sky.get_pixel(street.width() / 2, street.height() - 5)[0];
        println!("sky {:?} top={top} bottom={bottom}", t.elapsed());
        sky.save(dir.join("out-sky.png")).unwrap();
        let portrait = load("obama1.jpg");
        let t = std::time::Instant::now();
        let subj = subject(&ai, &portrait).unwrap();
        println!("subject {:?} center={} corner={}", t.elapsed(), subj.get_pixel(portrait.width() / 2, portrait.height() / 2)[0], subj.get_pixel(3, 3)[0]);
        subj.save(dir.join("out-subject.png")).unwrap();
        let t = std::time::Instant::now();
        let d = depth(&ai, &street).unwrap();
        println!("depth {:?}", t.elapsed());
        d.save(dir.join("out-depth.png")).unwrap();
        // erase a speck
        let specks = crate::thumbs::decode(&dir.join("../testlib/Editor/heal_specks.jpg")).map(|i| i.to_rgb8());
        if let Ok(img) = specks {
            let (x0, y0) = (1200 - 80, 800 - 80);
            let crop = image::imageops::crop_imm(&img, x0, y0, 160, 160).to_image();
            let mut mask = GrayImage::new(160, 160);
            for (x, y, p) in mask.enumerate_pixels_mut() {
                let (dx, dy) = (x as f32 - 80.0, y as f32 - 80.0);
                p[0] = if dx * dx + dy * dy < 34.0 * 34.0 { 255 } else { 0 };
            }
            let t = std::time::Instant::now();
            let out = inpaint(&ai, &crop, &mask).unwrap();
            let c = out.get_pixel(80, 80);
            let edge = crop.get_pixel(10, 80);
            println!("inpaint {:?} center={:?} (was {:?}) surroundings={:?}", t.elapsed(), c, crop.get_pixel(80, 80), edge);
            out.save(dir.join("out-inpaint.png")).unwrap();
        }
        let small = crate::thumbs::fit(portrait.clone(), 256);
        let t = std::time::Instant::now();
        let up = upscale(&ai, &small).unwrap();
        println!("upscale {:?} {:?} -> {:?}", t.elapsed(), small.dimensions(), up.dimensions());
        up.save(dir.join("out-upscale.png")).unwrap();
        let mut noisy = crate::thumbs::fit(portrait, 512);
        let mut seed = 7u32;
        for p in noisy.pixels_mut() {
            for c in 0..3 {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let n = ((seed >> 16) % 41) as i32 - 20;
                p[c] = (p[c] as i32 + n).clamp(0, 255) as u8;
            }
        }
        noisy.save(dir.join("out-noisy.png")).unwrap();
        let t = std::time::Instant::now();
        let clean = denoise(&ai, &noisy).unwrap();
        println!("denoise {:?} {:?}", t.elapsed(), clean.dimensions());
        clean.save(dir.join("out-denoise.png")).unwrap();
    }
}
