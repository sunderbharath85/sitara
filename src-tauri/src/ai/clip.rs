//! CLIP (OpenAI ViT-B/32): images and text in one embedding space, so a sentence can find photos.
//! The byte-level BPE tokenizer is CLIP's own, reimplemented here (lowercased, no ftfy).

use fast_image_resize as fr;
use image::RgbImage;
use regex::Regex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

pub const DIM: usize = 512;
const SIZE: u32 = 224;
const MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const STD: [f32; 3] = [0.268_629_54, 0.261_302_58, 0.275_777_11];
const SOT: i64 = 49406;
const EOT: i64 = 49407;
const CONTEXT: usize = 77;

pub struct Tokenizer {
    vocab: HashMap<String, i64>,
    ranks: HashMap<(String, String), usize>,
    bytes: [char; 256],
    pat: Regex,
    cache: Mutex<HashMap<String, Vec<i64>>>,
}

/// GPT-2's reversible byte → printable-unicode table.
fn bytes_to_unicode() -> [char; 256] {
    let mut bs: Vec<u32> = (b'!' as u32..=b'~' as u32).chain(0xA1..=0xAC).chain(0xAE..=0xFF).collect();
    let mut cs = bs.clone();
    let mut n = 0;
    for b in 0..256u32 {
        if !bs.contains(&b) {
            bs.push(b);
            cs.push(256 + n);
            n += 1;
        }
    }
    let mut out = ['\0'; 256];
    for (b, c) in bs.iter().zip(&cs) {
        out[*b as usize] = char::from_u32(*c).unwrap_or('?');
    }
    out
}

impl Tokenizer {
    pub fn load(vocab: &Path, merges: &Path) -> Result<Self, String> {
        let vocab: HashMap<String, i64> = serde_json::from_slice(&std::fs::read(vocab).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let text = std::fs::read_to_string(merges).map_err(|e| e.to_string())?;
        let ranks = text
            .lines()
            .filter(|l| !l.starts_with("#version"))
            .filter_map(|l| l.split_once(' '))
            .enumerate()
            .map(|(i, (a, b))| ((a.to_string(), b.to_string()), i))
            .collect();
        let pat =
            Regex::new(r"<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+").map_err(|e| e.to_string())?;
        Ok(Self { vocab, ranks, bytes: bytes_to_unicode(), pat, cache: Mutex::new(HashMap::new()) })
    }

    fn bpe(&self, token: &str) -> Vec<i64> {
        if let Some(v) = self.cache.lock().unwrap().get(token) {
            return v.clone();
        }
        let chars: Vec<char> = token.chars().collect();
        let mut word: Vec<String> = chars.iter().map(|c| c.to_string()).collect();
        if let Some(last) = word.last_mut() {
            last.push_str("</w>");
        }
        while word.len() > 1 {
            let best = (0..word.len() - 1).filter_map(|i| self.ranks.get(&(word[i].clone(), word[i + 1].clone())).map(|r| (*r, i))).min();
            let Some((_, i)) = best else { break };
            let (a, b) = (word[i].clone(), word[i + 1].clone());
            let mut next = Vec::with_capacity(word.len());
            let mut k = 0;
            while k < word.len() {
                if k + 1 < word.len() && word[k] == a && word[k + 1] == b {
                    next.push(format!("{a}{b}"));
                    k += 2;
                } else {
                    next.push(word[k].clone());
                    k += 1;
                }
            }
            word = next;
        }
        let ids: Vec<i64> = word.iter().filter_map(|w| self.vocab.get(w).copied()).collect();
        self.cache.lock().unwrap().insert(token.to_string(), ids.clone());
        ids
    }

    /// Token ids with start/end markers, at most 77.
    pub fn encode(&self, text: &str) -> Vec<i64> {
        let clean = text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        let mut out = vec![SOT];
        for m in self.pat.find_iter(&clean) {
            let mapped: String = m.as_str().bytes().map(|b| self.bytes[b as usize]).collect();
            out.extend(self.bpe(&mapped));
            if out.len() >= CONTEXT - 1 {
                out.truncate(CONTEXT - 1);
                break;
            }
        }
        out.push(EOT);
        out
    }
}

/// Resize the short side to 224 and center-crop, normalized CHW floats (CLIP's preprocessing).
pub fn pixels(img: &RgbImage, out: &mut Vec<f32>) {
    let (w, h) = img.dimensions();
    let s = SIZE as f32 / w.min(h).max(1) as f32;
    let (rw, rh) = (((w as f32 * s).round() as u32).max(SIZE), ((h as f32 * s).round() as u32).max(SIZE));
    let mut buf = vec![0u8; (rw * rh * 3) as usize];
    let ok = (|| -> Option<()> {
        let from = fr::images::ImageRef::new(w, h, img.as_raw(), fr::PixelType::U8x3).ok()?;
        let mut to = fr::images::Image::from_slice_u8(rw, rh, &mut buf, fr::PixelType::U8x3).ok()?;
        let opts = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::CatmullRom));
        fr::Resizer::new().resize(&from, &mut to, &opts).ok()
    })();
    let (x0, y0) = ((rw - SIZE) / 2, (rh - SIZE) / 2);
    let plane = (SIZE * SIZE) as usize;
    let start = out.len();
    out.resize(start + plane * 3, 0.0);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let p = (((y + y0) * rw + (x + x0)) * 3) as usize;
            for c in 0..3 {
                let v = if ok.is_some() { buf[p + c] as f32 / 255.0 } else { 0.5 };
                out[start + c * plane + (y * SIZE + x) as usize] = (v - MEAN[c]) / STD[c];
            }
        }
    }
}

pub fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    v.iter_mut().for_each(|x| *x /= n);
}

/// Embeddings are stored as int8 (×127) after normalizing: 512 bytes per photo.
pub fn quantize(v: &[f32]) -> Vec<u8> {
    v.iter().map(|x| ((x * 127.0).round().clamp(-127.0, 127.0) as i8) as u8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_table_is_a_bijection() {
        let t = bytes_to_unicode();
        let set: std::collections::HashSet<char> = t.iter().copied().collect();
        assert_eq!(set.len(), 256);
        assert_eq!(t[b'a' as usize], 'a');
        assert_eq!(t[b' ' as usize], 'Ġ');
    }

    #[test]
    fn pixels_are_normalized_chw() {
        let img = RgbImage::from_pixel(300, 200, image::Rgb([255, 0, 0]));
        let mut v = vec![];
        pixels(&img, &mut v);
        assert_eq!(v.len(), 3 * 224 * 224);
        assert!((v[0] - (1.0 - MEAN[0]) / STD[0]).abs() < 0.02);
        assert!((v[224 * 224] - (0.0 - MEAN[1]) / STD[1]).abs() < 0.02);
    }
}
