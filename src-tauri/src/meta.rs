//! Metadata extraction: pixel size, capture time, camera EXIF and GPS for photos;
//! size, duration and creation time for MP4/MOV video (tiny box parser, no FFmpeg).

use chrono::{Local, NaiveDate, TimeZone};
use exif::{In, Reader, Tag, Value};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

pub const PHOTO_EXT: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif", "avif", "dng", "cr2",
    "cr3", "nef", "nrw", "arw", "raf", "orf", "rw2", "pef", "srw",
];
pub const VIDEO_EXT: &[&str] = &["mp4", "m4v", "mov", "3gp", "mkv", "webm", "avi", "wmv", "mts", "m2ts"];

/// 0 = photo, 1 = video, None = not media.
pub fn kind_of(ext: &str) -> Option<i64> {
    if PHOTO_EXT.contains(&ext) {
        Some(crate::db::PHOTO)
    } else if VIDEO_EXT.contains(&ext) {
        Some(crate::db::VIDEO)
    } else {
        None
    }
}

pub fn ext_of(p: &Path) -> Option<String> {
    p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase())
}

#[derive(Default, Debug)]
pub struct Meta {
    pub width: i64,
    pub height: i64,
    pub taken: Option<i64>,
    pub duration: Option<f64>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub fnumber: Option<f64>,
    pub exposure: Option<String>,
    pub iso: Option<i64>,
    pub focal: Option<f64>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
}

/// Read what we can; never fails. `mtime_ms` is the fallback capture time.
pub fn read(path: &Path, kind: i64, mtime_ms: i64) -> Meta {
    let mut m = if kind == crate::db::VIDEO { video(path) } else { photo(path) };
    if m.taken.is_none() {
        m.taken = Some(local_wall_secs(mtime_ms / 1000));
    }
    m
}

/// A UTC instant expressed as local wall-clock seconds (the convention used for `taken`).
pub fn local_wall_secs(utc_secs: i64) -> i64 {
    match Local.timestamp_opt(utc_secs, 0) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => t.naive_local().and_utc().timestamp(),
        chrono::LocalResult::None => utc_secs,
    }
}

fn photo(path: &Path) -> Meta {
    let mut m = Meta::default();
    if let Ok(sz) = imagesize::size(path) {
        m.width = sz.width as i64;
        m.height = sz.height as i64;
    }
    let Ok(f) = File::open(path) else { return m };
    let Ok(ex) = Reader::new().read_from_container(&mut BufReader::new(f)) else { return m };

    let ascii = |t: Tag| -> Option<String> {
        let f = ex.get_field(t, In::PRIMARY)?;
        if let Value::Ascii(ref v) = f.value {
            let s = String::from_utf8_lossy(v.first()?).trim_matches(char::from(0)).trim().to_string();
            (!s.is_empty()).then_some(s)
        } else {
            None
        }
    };
    let rational = |t: Tag| -> Option<f64> {
        let f = ex.get_field(t, In::PRIMARY)?;
        match f.value {
            Value::Rational(ref v) if !v.is_empty() && v[0].denom != 0 => Some(v[0].to_f64()),
            Value::SRational(ref v) if !v.is_empty() && v[0].denom != 0 => Some(v[0].to_f64()),
            _ => None,
        }
    };
    let uint = |t: Tag| -> Option<u32> { ex.get_field(t, In::PRIMARY)?.value.get_uint(0) };

    for t in [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime] {
        if let Some(f) = ex.get_field(t, In::PRIMARY) {
            if let Value::Ascii(ref v) = f.value {
                if let Some(dt) = v.first().and_then(|b| exif::DateTime::from_ascii(b).ok()) {
                    if let Some(nd) = NaiveDate::from_ymd_opt(dt.year as i32, dt.month as u32, dt.day as u32)
                        .and_then(|d| d.and_hms_opt(dt.hour as u32, dt.minute as u32, dt.second as u32))
                    {
                        if dt.year > 1900 {
                            m.taken = Some(nd.and_utc().timestamp());
                            break;
                        }
                    }
                }
            }
        }
    }

    if m.width == 0 || m.height == 0 {
        if let (Some(w), Some(h)) = (uint(Tag::PixelXDimension), uint(Tag::PixelYDimension)) {
            m.width = w as i64;
            m.height = h as i64;
        }
    }
    // a RAW's first image is its thumbnail; ask the decoder for the real size
    if ext_of(path).is_some_and(|e| crate::raw::is_raw(&e)) {
        if let Some((w, h)) = crate::raw::dims(path) {
            m.width = w as i64;
            m.height = h as i64;
        }
    }
    // rotated 90/270: the stored pixels are sideways, the photo is not
    if matches!(uint(Tag::Orientation), Some(5..=8)) {
        std::mem::swap(&mut m.width, &mut m.height);
    }

    m.make = ascii(Tag::Make);
    m.model = ascii(Tag::Model);
    m.lens = ascii(Tag::LensModel);
    m.fnumber = rational(Tag::FNumber);
    m.focal = rational(Tag::FocalLength);
    m.iso = uint(Tag::PhotographicSensitivity).map(|v| v as i64);
    m.exposure = rational(Tag::ExposureTime).filter(|v| *v > 0.0).map(|v| {
        if v < 0.5 { format!("1/{}", (1.0 / v).round() as i64) } else { format!("{}s", (v * 10.0).round() / 10.0) }
    });

    let gps = |t: Tag, r: Tag, neg: &str| -> Option<f64> {
        let f = ex.get_field(t, In::PRIMARY)?;
        let Value::Rational(ref v) = f.value else { return None };
        if v.len() < 3 || v.iter().any(|x| x.denom == 0) {
            return None;
        }
        let mut d = v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0;
        if let Some(rf) = ex.get_field(r, In::PRIMARY) {
            if rf.display_value().to_string().contains(neg) {
                d = -d;
            }
        }
        (d != 0.0).then_some(d)
    };
    m.lat = gps(Tag::GPSLatitude, Tag::GPSLatitudeRef, "S");
    m.lon = gps(Tag::GPSLongitude, Tag::GPSLongitudeRef, "W");
    if m.lat.is_none() || m.lon.is_none() {
        m.lat = None;
        m.lon = None;
    }
    m
}

fn video(path: &Path) -> Meta {
    let mut m = Meta::default();
    let ext = ext_of(path).unwrap_or_default();
    if matches!(ext.as_str(), "mp4" | "m4v" | "mov" | "3gp") {
        if let Some(v) = mp4(path) {
            m.width = v.0;
            m.height = v.1;
            m.duration = v.2;
            m.taken = v.3.map(local_wall_secs);
        }
    }
    m
}

fn be32(b: &[u8], i: usize) -> Option<u32> {
    b.get(i..i + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}
fn be64(b: &[u8], i: usize) -> Option<u64> {
    b.get(i..i + 8).map(|s| u64::from_be_bytes(s.try_into().unwrap()))
}

/// Iterate ISO-BMFF boxes in a buffer: (type, payload).
fn boxes(buf: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = vec![];
    let mut i = 0usize;
    while i + 8 <= buf.len() {
        let size = be32(buf, i).unwrap_or(0) as usize;
        let typ: [u8; 4] = buf[i + 4..i + 8].try_into().unwrap();
        let (hdr, size) = match size {
            1 => (16, be64(buf, i + 8).unwrap_or(0) as usize),
            0 => (8, buf.len() - i),
            s => (8, s),
        };
        if size < hdr || i + size > buf.len() {
            break;
        }
        out.push((typ, &buf[i + hdr..i + size]));
        i += size;
    }
    out
}

/// (width, height, duration secs, creation time as UTC unix secs)
fn mp4(path: &Path) -> Option<(i64, i64, Option<f64>, Option<i64>)> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut pos = 0u64;
    let mut moov = None;
    // walk top-level boxes by seeking; moov can sit after a multi-GB mdat
    while pos + 8 <= len {
        let mut hdr = [0u8; 16];
        f.seek(SeekFrom::Start(pos)).ok()?;
        f.read_exact(&mut hdr[..8]).ok()?;
        let mut size = u32::from_be_bytes(hdr[0..4].try_into().unwrap()) as u64;
        let mut hl = 8u64;
        if size == 1 {
            f.read_exact(&mut hdr[8..16]).ok()?;
            size = u64::from_be_bytes(hdr[8..16].try_into().unwrap());
            hl = 16;
        } else if size == 0 {
            size = len - pos;
        }
        if size < hl {
            return None;
        }
        if &hdr[4..8] == b"moov" {
            let body = size - hl;
            if body > 64 * 1024 * 1024 {
                return None;
            }
            let mut buf = vec![0u8; body as usize];
            f.read_exact(&mut buf).ok()?;
            moov = Some(buf);
            break;
        }
        pos += size;
    }
    let moov = moov?;
    let (mut w, mut h, mut dur, mut created) = (0i64, 0i64, None, None);
    for (t, b) in boxes(&moov) {
        match &t {
            b"mvhd" => {
                let v1 = b.first() == Some(&1);
                let (ct, ts, d) = if v1 {
                    (be64(b, 4), be32(b, 20).map(|x| x as u64), be64(b, 24))
                } else {
                    (be32(b, 4).map(u64::from), be32(b, 12).map(u64::from), be32(b, 16).map(u64::from))
                };
                if let (Some(ts), Some(d)) = (ts, d) {
                    if ts > 0 && d > 0 && d != u32::MAX as u64 {
                        dur = Some(d as f64 / ts as f64);
                    }
                }
                // seconds since 1904-01-01 UTC
                created = ct.filter(|&c| c > 2_082_844_800).map(|c| c as i64 - 2_082_844_800);
            }
            b"trak" if w == 0 => {
                let kids = boxes(b);
                let is_video = kids.iter().any(|(t, b)| {
                    t == b"mdia" && boxes(b).iter().any(|(t, b)| t == b"hdlr" && b.get(8..12) == Some(b"vide"))
                });
                if let (true, Some((_, tk))) = (is_video, kids.iter().find(|(t, _)| t == b"tkhd")) {
                    let base = if tk.first() == Some(&1) { 52 } else { 40 };
                    let a = be32(tk, base).unwrap_or(0x10000) as i32;
                    let bb = be32(tk, base + 4).unwrap_or(0) as i32;
                    let tw = (be32(tk, base + 36).unwrap_or(0) >> 16) as i64;
                    let th = (be32(tk, base + 40).unwrap_or(0) >> 16) as i64;
                    if tw > 0 && th > 0 {
                        // matrix [a b] with a=0, |b|=1 means a 90/270 degree rotation
                        if a == 0 && bb.abs() == 0x10000 { (w, h) = (th, tw) } else { (w, h) = (tw, th) }
                    }
                }
            }
            _ => {}
        }
    }
    Some((w, h, dur, created))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bx(t: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(t);
        v.extend_from_slice(body);
        v
    }

    fn movie(rotate: bool) -> Vec<u8> {
        let mut mvhd = vec![0u8; 100];
        mvhd[4..8].copy_from_slice(&(2_082_844_800u32 + 1_700_000_000).to_be_bytes()); // created
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes()); // timescale
        mvhd[16..20].copy_from_slice(&4500u32.to_be_bytes()); // duration
        let mut tkhd = vec![0u8; 84];
        let (a, b) = if rotate { (0i32, 0x10000i32) } else { (0x10000, 0) };
        tkhd[40..44].copy_from_slice(&a.to_be_bytes());
        tkhd[44..48].copy_from_slice(&b.to_be_bytes());
        tkhd[76..80].copy_from_slice(&(1920u32 << 16).to_be_bytes());
        tkhd[80..84].copy_from_slice(&(1080u32 << 16).to_be_bytes());
        let mut hdlr = vec![0u8; 24];
        hdlr[8..12].copy_from_slice(b"vide");
        let trak = bx(b"trak", &[bx(b"tkhd", &tkhd), bx(b"mdia", &bx(b"hdlr", &hdlr))].concat());
        let moov = bx(b"moov", &[bx(b"mvhd", &mvhd), trak].concat());
        [bx(b"ftyp", b"isom\0\0\0\0"), bx(b"mdat", &[0u8; 64]), moov].concat()
    }

    #[test]
    fn mp4_size_duration_date_and_rotation() {
        let dir = std::env::temp_dir();
        for (rotate, want) in [(false, (1920, 1080)), (true, (1080, 1920))] {
            let p = dir.join(format!("sitara-test-{rotate}.mp4"));
            std::fs::write(&p, movie(rotate)).unwrap();
            let (w, h, dur, created) = mp4(&p).unwrap();
            assert_eq!((w, h), want);
            assert_eq!(dur, Some(4.5));
            assert_eq!(created, Some(1_700_000_000));
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn kinds_by_extension() {
        assert_eq!(kind_of("jpg"), Some(crate::db::PHOTO));
        assert_eq!(kind_of("cr3"), Some(crate::db::PHOTO));
        assert_eq!(kind_of("mov"), Some(crate::db::VIDEO));
        assert_eq!(kind_of("txt"), None);
    }
}
