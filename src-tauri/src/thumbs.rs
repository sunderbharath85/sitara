//! Thumbnail and preview rendering with an on-disk JPEG cache.
//!
//! Formats the `image` crate decodes are rendered in Rust (EXIF orientation applied).
//! Video, HEIC and RAW go through the OS thumbnailer on Windows, then FFmpeg if it is on PATH.

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

pub fn forget(cache: &Path, id: i64) {
    let _ = std::fs::remove_file(cache_file(cache, id, Mode::Thumb));
    let _ = std::fs::remove_file(cache_file(cache, id, Mode::Preview));
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

fn write_atomic(path: &Path, bytes: &[u8]) {
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

fn decode(src: &Path) -> Result<DynamicImage, String> {
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
    for ss in seeks {
        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.args(["-v", "error", "-ss", ss, "-i"])
            .arg(src)
            .args(["-frames:v", "1", "-vf", &scale, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "-"])
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
