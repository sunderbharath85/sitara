//! Thumbnail and preview rendering with an on-disk JPEG cache.
//!
//! Formats the `image` crate decodes are rendered in Rust (EXIF orientation applied).
//! RAW uses the camera's embedded preview; video and HEIC go through the OS thumbnailer on Windows,
//! then FFmpeg if it is on PATH. Edited photos get their own renders, made by the editor (`et`, `ep`).

use fast_image_resize as fr;
use image::{DynamicImage, ImageDecoder, ImageReader, RgbImage};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Grid thumbnails are rendered to this height (justified rows are ~220 css px at up to 1.6x DPI).
pub const THUMB_H: u32 = 360;
/// Large previews for formats the webview can't show natively.
pub const PREVIEW_LONG: u32 = 2560;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Thumb,
    Preview,
}

pub fn cache_file(cache: &Path, id: i64, mode: Mode) -> PathBuf {
    let sub = if mode == Mode::Thumb { "t" } else { "p" };
    cache.join(sub).join(format!("{:03}", id % 1000)).join(format!("{id}.jpg"))
}

/// Renders of the edited photo, written by the editor when edits are saved. Served instead of the original's.
pub fn edited_file(cache: &Path, id: i64, mode: Mode) -> PathBuf {
    let sub = if mode == Mode::Thumb { "et" } else { "ep" };
    cache.join(sub).join(format!("{:03}", id % 1000)).join(format!("{id}.jpg"))
}

/// A private item's render, sealed to the Private key, next to where the plain one would be.
pub fn sealed(path: &Path) -> PathBuf {
    path.with_extension("sealed")
}

fn remove_both(path: PathBuf) {
    let _ = std::fs::remove_file(sealed(&path));
    let _ = std::fs::remove_file(path);
}

pub fn forget(cache: &Path, id: i64) {
    remove_both(cache_file(cache, id, Mode::Thumb));
    remove_both(cache_file(cache, id, Mode::Preview));
}

pub fn forget_edited(cache: &Path, id: i64) {
    remove_both(edited_file(cache, id, Mode::Thumb));
    remove_both(edited_file(cache, id, Mode::Preview));
}

pub fn face_file(cache: &Path, face_id: i64) -> PathBuf {
    cache.join("f").join(format!("{:03}", face_id % 1000)).join(format!("{face_id}.jpg"))
}

/// Every cached render of an item: thumbnail and preview, of the original and of its edits.
pub fn renders(cache: &Path, id: i64) -> [PathBuf; 4] {
    [
        cache_file(cache, id, Mode::Thumb),
        cache_file(cache, id, Mode::Preview),
        edited_file(cache, id, Mode::Thumb),
        edited_file(cache, id, Mode::Preview),
    ]
}

pub fn rust_decodable(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "jpe" | "jfif" | "png" | "webp" | "gif" | "bmp" | "tif" | "tiff")
}

/// Return cached bytes, rendering and caching them first if needed.
pub fn ensure(cache: &Path, id: i64, src: &Path, ext: &str, is_video: bool, mode: Mode) -> Result<Vec<u8>, String> {
    let out = cache_file(cache, id, mode);
    if let Ok(b) = std::fs::read(&out) {
        return Ok(b);
    }
    let bytes = render(src, ext, is_video, mode)?;
    write_atomic(&out, &bytes);
    Ok(bytes)
}

pub fn write_atomic(path: &Path, bytes: &[u8]) {
    static N: AtomicU64 = AtomicU64::new(0);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension(format!("{}.{}.tmp", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    if std::fs::write(&tmp, bytes).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn target(w: u32, h: u32, mode: Mode) -> (u32, u32) {
    let (w, h) = (w.max(1), h.max(1));
    match mode {
        Mode::Thumb => {
            let th = THUMB_H.min(h);
            let tw = ((w as f64 * th as f64 / h as f64).round() as u32).clamp(1, THUMB_H * 4);
            (tw, th)
        }
        Mode::Preview => {
            let long = w.max(h);
            if long <= PREVIEW_LONG {
                return (w, h);
            }
            let s = PREVIEW_LONG as f64 / long as f64;
            (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1))
        }
    }
}

pub fn render(src: &Path, ext: &str, is_video: bool, mode: Mode) -> Result<Vec<u8>, String> {
    if !is_video && rust_decodable(ext) {
        let img = decode(src)?;
        return encode(&resize(img.to_rgb8(), mode)?);
    }
    let raw = !is_video && crate::raw::is_raw(ext);
    if raw && let Ok(img) = crate::raw::preview(src) {
        return encode(&resize(img.to_rgb8(), mode)?);
    }
    #[cfg(windows)]
    {
        let req = if mode == Mode::Thumb { 768 } else { PREVIEW_LONG as i32 };
        if let Ok(img) = crate::shell::thumbnail(src, req) {
            return encode(&resize(img, mode)?);
        }
    }
    if let Some(jpg) = ffmpeg_frame(src, is_video, mode) {
        return Ok(jpg);
    }
    Err(format!("no decoder for .{ext}"))
}

/// A square portrait around a face (box normalized to the upright photo), cached by face id.
pub fn face(cache: &Path, face_id: i64, src: &Path, ext: &str, b: [f32; 4]) -> Result<Vec<u8>, String> {
    let out = face_file(cache, face_id);
    if let Ok(bytes) = std::fs::read(&out) {
        return Ok(bytes);
    }
    let img = if rust_decodable(ext) {
        decode(src)?
    } else if crate::raw::is_raw(ext) {
        crate::raw::preview(src)?
    } else {
        os_decode(src, PREVIEW_LONG)?
    };
    let (w, h) = (img.width() as f32, img.height() as f32);
    let side = (b[2] * w).max(b[3] * h) * 1.7;
    let (cx, cy) = ((b[0] + b[2] / 2.0) * w, (b[1] + b[3] / 2.0) * h - 0.05 * side);
    let side = side.min(w).min(h).max(8.0);
    let x = (cx - side / 2.0).clamp(0.0, w - side);
    let y = (cy - side / 2.0).clamp(0.0, h - side);
    let crop = img.crop_imm(x as u32, y as u32, side as u32, side as u32);
    let crop = crop.resize_exact(256, 256, image::imageops::FilterType::CatmullRom).to_rgb8();
    let bytes = encode(&crop)?;
    write_atomic(&out, &bytes);
    Ok(bytes)
}

/// The editor's source pixels, full resolution and upright, as `SRC1` binary:
/// magic, width u32, height u32, format u32 (0 = RGBA8 sRGB, 1 = RGB10_A2 linear log, see `raw`), then pixels.
/// Formats the webview decodes itself (JPEG, PNG, WebP…) never come through here.
pub fn full_source(src: &Path, ext: &str, max_side: u32) -> Result<Vec<u8>, String> {
    let max_side = max_side.clamp(256, 32768);
    if crate::raw::is_raw(ext) {
        match crate::raw::develop(src, max_side as usize) {
            Ok(d) => {
                let mut out = header(d.w as u32, d.h as u32, 1, d.px.len() * 4);
                for p in d.px {
                    out.extend_from_slice(&p.to_le_bytes());
                }
                return Ok(out);
            }
            Err(e) => eprintln!("raw develop {}: {e}", src.display()),
        }
    }
    let img = if rust_decodable(ext) {
        decode(src)?
    } else if crate::raw::is_raw(ext) {
        crate::raw::preview(src)?
    } else {
        os_decode(src, max_side)?
    };
    let mut rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    if w.max(h) > max_side {
        let s = max_side as f64 / w.max(h) as f64;
        let (tw, th) = (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1));
        let from = fr::images::Image::from_vec_u8(w, h, rgba.into_raw(), fr::PixelType::U8x4).map_err(|e| e.to_string())?;
        let mut to = fr::images::Image::new(tw, th, fr::PixelType::U8x4);
        let opts = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::CatmullRom));
        fr::Resizer::new().resize(&from, &mut to, &opts).map_err(|e| e.to_string())?;
        rgba = image::RgbaImage::from_raw(tw, th, to.into_vec()).ok_or("resize buffer")?;
    }
    let (w, h) = rgba.dimensions();
    let raw = rgba.into_raw();
    let mut out = header(w, h, 0, raw.len());
    out.extend_from_slice(&raw);
    Ok(out)
}

fn header(w: u32, h: u32, fmt: u32, n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + n);
    out.extend_from_slice(b"SRC1");
    for v in [w, h, fmt] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// HEIC and friends: the OS decoder on Windows, else FFmpeg.
fn os_decode(src: &Path, max_side: u32) -> Result<DynamicImage, String> {
    #[cfg(windows)]
    if let Ok(img) = crate::shell::thumbnail(src, max_side.min(8192) as i32) {
        return Ok(DynamicImage::ImageRgb8(img));
    }
    let scale = format!("scale='if(gt(iw,ih),min({max_side},iw),-2)':'if(gt(iw,ih),-2,min({max_side},ih))'");
    let jpg = ffmpeg(src, &["0"], &scale, "2").ok_or("no decoder for this format")?;
    image::load_from_memory(&jpg).map_err(|e| e.to_string())
}

pub fn decode(src: &Path) -> Result<DynamicImage, String> {
    let reader = ImageReader::open(src).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?;
    let mut dec = reader.into_decoder().map_err(|e| e.to_string())?;
    let orientation = dec.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(dec).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn resize(src: RgbImage, mode: Mode) -> Result<RgbImage, String> {
    let (w, h) = src.dimensions();
    let (tw, th) = target(w, h, mode);
    if (tw, th) == (w, h) {
        return Ok(src);
    }
    let from = fr::images::Image::from_vec_u8(w, h, src.into_raw(), fr::PixelType::U8x3).map_err(|e| e.to_string())?;
    let mut to = fr::images::Image::new(tw, th, fr::PixelType::U8x3);
    let opts = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::CatmullRom));
    fr::Resizer::new().resize(&from, &mut to, &opts).map_err(|e| e.to_string())?;
    RgbImage::from_raw(tw, th, to.into_vec()).ok_or_else(|| "resize buffer".to_string())
}

/// Downscale so the long side is at most `max` (never upscales).
pub fn fit(img: RgbImage, max: u32) -> RgbImage {
    let (w, h) = img.dimensions();
    if w.max(h) <= max {
        return img;
    }
    let s = max as f64 / w.max(h) as f64;
    let (tw, th) = (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1));
    let from = img.clone();
    (|| -> Option<RgbImage> {
        let from = fr::images::Image::from_vec_u8(w, h, from.into_raw(), fr::PixelType::U8x3).ok()?;
        let mut to = fr::images::Image::new(tw, th, fr::PixelType::U8x3);
        let opts = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Bilinear));
        fr::Resizer::new().resize(&from, &mut to, &opts).ok()?;
        RgbImage::from_raw(tw, th, to.into_vec())
    })()
    .unwrap_or(img)
}

fn encode(img: &RgbImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity((img.width() * img.height() / 6) as usize);
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82);
    img.write_with_encoder(enc).map_err(|e| e.to_string())?;
    Ok(out)
}

/// One frame (video) or the decoded image (HEIC/RAW on macOS/Linux) via an FFmpeg found on PATH.
fn ffmpeg_frame(src: &Path, is_video: bool, mode: Mode) -> Option<Vec<u8>> {
    let scale = match mode {
        Mode::Thumb => format!("scale=-2:'min({THUMB_H},ih)'"),
        Mode::Preview => format!("scale='if(gt(iw,ih),min({PREVIEW_LONG},iw),-2)':'if(gt(iw,ih),-2,min({PREVIEW_LONG},ih))'"),
    };
    let seeks: &[&str] = if is_video { &["1", "0"] } else { &["0"] };
    ffmpeg(src, seeks, &scale, "4")
}

fn ffmpeg(src: &Path, seeks: &[&str], scale: &str, q: &str) -> Option<Vec<u8>> {
    for ss in seeks {
        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.args(["-v", "error", "-ss", ss, "-i"])
            .arg(src)
            .args(["-frames:v", "1", "-vf", scale, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", q, "-"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        if let Ok(out) = cmd.output() {
            if out.status.success() && out.stdout.len() > 100 {
                return Some(out.stdout);
            }
        }
    }
    None
}
