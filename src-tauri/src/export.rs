//! Exported copies of edited photos: carries the original's camera metadata into the new JPEG.

use exif::experimental::Writer;
use exif::{Context, Field, In, Tag, Value};
use std::path::Path;

/// EXIF APP1 payload ("Exif\0\0" + TIFF) for an exported JPEG: the original's camera, lens, exposure and
/// capture time, marked upright with the new pixel size. The original's embedded thumbnail, MakerNote and
/// interop data are dropped (they would describe the unedited file), and so is location unless `keep_gps`.
pub fn exif_for_export(original: &Path, w: u32, h: u32, keep_gps: bool) -> Option<Vec<u8>> {
    let file = std::fs::File::open(original).ok()?;
    let ex = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)).ok();
    const TIFF_KEEP: [Tag; 6] = [Tag::Make, Tag::Model, Tag::DateTime, Tag::Artist, Tag::Copyright, Tag::ImageDescription];
    const EXIF_DROP: [Tag; 4] = [Tag::MakerNote, Tag::PixelXDimension, Tag::PixelYDimension, Tag::SubjectArea];
    let mut fields: Vec<Field> = ex
        .iter()
        .flat_map(|ex| ex.fields())
        .filter(|f| f.ifd_num == In::PRIMARY && !matches!(f.value, Value::Unknown(..)))
        .filter(|f| match f.tag.0 {
            Context::Tiff => TIFF_KEEP.contains(&f.tag),
            Context::Exif => !EXIF_DROP.contains(&f.tag),
            Context::Gps => keep_gps,
            _ => false,
        })
        .cloned()
        .collect();
    let field = |tag, value| Field { tag, ifd_num: In::PRIMARY, value };
    fields.push(field(Tag::Orientation, Value::Short(vec![1])));
    fields.push(field(Tag::Software, Value::Ascii(vec![b"Sitara".to_vec()])));
    fields.push(field(Tag::PixelXDimension, Value::Long(vec![w])));
    fields.push(field(Tag::PixelYDimension, Value::Long(vec![h])));
    let mut writer = Writer::new();
    for f in &fields {
        writer.push_field(f);
    }
    let mut tiff = std::io::Cursor::new(Vec::new());
    writer.write(&mut tiff, ex.as_ref().is_some_and(|e| e.little_endian())).ok()?;
    let mut out = b"Exif\0\0".to_vec();
    out.extend_from_slice(&tiff.into_inner());
    Some(out)
}

/// Insert an APP1 segment after SOI (and after JFIF's APP0, if present).
pub fn splice_app1(jpeg: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    if jpeg.len() < 4 || jpeg[0..2] != [0xFF, 0xD8] || payload.len() + 2 > 0xFFFF {
        return None;
    }
    let mut at = 2;
    if jpeg[2..4] == [0xFF, 0xE0] && jpeg.len() >= 6 {
        at = (4 + u16::from_be_bytes([jpeg[4], jpeg[5]]) as usize).min(jpeg.len());
    }
    let mut out = Vec::with_capacity(jpeg.len() + payload.len() + 4);
    out.extend_from_slice(&jpeg[..at]);
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(payload);
    out.extend_from_slice(&jpeg[at..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut out = vec![];
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([200, 120, 40]));
        img.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)).unwrap();
        out
    }

    #[test]
    fn exported_jpeg_keeps_camera_and_is_upright() {
        // an "original" with a camera, a rotation and a location
        let fields = [
            Field { tag: Tag::Make, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"FUJIFILM".to_vec()]) },
            Field { tag: Tag::Orientation, ifd_num: In::PRIMARY, value: Value::Short(vec![6]) },
            Field { tag: Tag::PhotographicSensitivity, ifd_num: In::PRIMARY, value: Value::Short(vec![400]) },
            Field { tag: Tag::GPSLatitudeRef, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"N".to_vec()]) },
        ];
        let mut w = Writer::new();
        fields.iter().for_each(|f| w.push_field(f));
        let mut tiff = std::io::Cursor::new(Vec::new());
        w.write(&mut tiff, false).unwrap();
        let app1 = [b"Exif\0\0".as_slice(), &tiff.into_inner()].concat();
        let dir = std::env::temp_dir().join(format!("sitara-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let orig = dir.join("orig.jpg");
        std::fs::write(&orig, splice_app1(&jpeg(16, 8), &app1).unwrap()).unwrap();

        let read = |bytes: &[u8]| exif::Reader::new().read_from_container(&mut std::io::Cursor::new(bytes.to_vec())).unwrap();
        for keep_gps in [false, true] {
            let payload = exif_for_export(&orig, 8, 16, keep_gps).unwrap();
            let out = splice_app1(&jpeg(8, 16), &payload).unwrap();
            assert!(image::load_from_memory(&out).is_ok(), "still a valid JPEG");
            let ex = read(&out);
            let get = |t| ex.get_field(t, In::PRIMARY).map(|f| f.display_value().to_string());
            assert_eq!(get(Tag::Make).as_deref(), Some("\"FUJIFILM\""));
            assert_eq!(ex.get_field(Tag::Orientation, In::PRIMARY).unwrap().value.get_uint(0), Some(1));
            assert_eq!(ex.get_field(Tag::PixelXDimension, In::PRIMARY).unwrap().value.get_uint(0), Some(8));
            assert_eq!(get(Tag::PhotographicSensitivity).as_deref(), Some("400"));
            assert_eq!(get(Tag::GPSLatitudeRef).is_some(), keep_gps);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
