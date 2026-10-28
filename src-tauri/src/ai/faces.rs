//! Faces: YuNet finds them (with five landmarks), SFace turns each aligned face into a 128-d vector.
//! Both come from the OpenCV model zoo (MIT / Apache-2.0).

use image::RgbImage;

pub const DIM: usize = 128;
pub const DET_SIZE: u32 = 640;

#[derive(Clone, Debug)]
pub struct Det {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub kps: [[f32; 2]; 5], // right eye, left eye, nose, right and left mouth corners (as seen in the image: left eye first)
    pub score: f32,
}

/// Letterbox into YuNet's 640×640 BGR input (0..255). Returns the input and the scale back to image pixels.
pub fn det_input(img: &RgbImage) -> (Vec<f32>, f32) {
    let w = img.width();
    let small = crate::thumbs::fit(img.clone(), DET_SIZE);
    let s = small.width() as f32 / w.max(1) as f32;
    let plane = (DET_SIZE * DET_SIZE) as usize;
    let mut out = vec![0f32; plane * 3];
    for (x, y, p) in small.enumerate_pixels() {
        let i = (y * DET_SIZE + x) as usize;
        out[i] = p[2] as f32;
        out[plane + i] = p[1] as f32;
        out[2 * plane + i] = p[0] as f32;
    }
    (out, 1.0 / s)
}

/// Decode YuNet's per-stride heads (cls, obj, bbox, kps for strides 8, 16, 32), then non-max suppression.
pub fn decode(cls: [&[f32]; 3], obj: [&[f32]; 3], bbox: [&[f32]; 3], kps: [&[f32]; 3], scale: f32, min_score: f32) -> Vec<Det> {
    let mut out = vec![];
    for (k, stride) in [8usize, 16, 32].into_iter().enumerate() {
        let cols = DET_SIZE as usize / stride;
        let n = cols * cols;
        for i in 0..n.min(cls[k].len()) {
            let score = (cls[k][i].clamp(0.0, 1.0) * obj[k][i].clamp(0.0, 1.0)).sqrt();
            if score < min_score {
                continue;
            }
            let (r, c) = ((i / cols) as f32, (i % cols) as f32);
            let s = stride as f32;
            let b = &bbox[k][i * 4..i * 4 + 4];
            let (cx, cy) = ((c + b[0]) * s, (r + b[1]) * s);
            let (bw, bh) = (b[2].exp() * s, b[3].exp() * s);
            let mut lm = [[0f32; 2]; 5];
            for (j, p) in lm.iter_mut().enumerate() {
                *p = [(kps[k][i * 10 + 2 * j] + c) * s * scale, (kps[k][i * 10 + 2 * j + 1] + r) * s * scale];
            }
            out.push(Det { x: (cx - bw / 2.0) * scale, y: (cy - bh / 2.0) * scale, w: bw * scale, h: bh * scale, kps: lm, score });
        }
    }
    nms(out, 0.3)
}

fn iou(a: &Det, b: &Det) -> f32 {
    let (x1, y1) = (a.x.max(b.x), a.y.max(b.y));
    let (x2, y2) = ((a.x + a.w).min(b.x + b.w), (a.y + a.h).min(b.y + b.h));
    let inter = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    inter / (a.w * a.h + b.w * b.h - inter).max(1e-6)
}

fn nms(mut v: Vec<Det>, thr: f32) -> Vec<Det> {
    v.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut keep: Vec<Det> = vec![];
    for d in v {
        if keep.iter().all(|k| iou(k, &d) < thr) {
            keep.push(d);
        }
    }
    keep
}

/// ArcFace's canonical landmark positions in a 112×112 crop.
const TEMPLATE: [[f32; 2]; 5] = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

/// Least-squares similarity transform (rotation, uniform scale, translation) taking `src` onto `dst`.
pub fn similarity(src: &[[f32; 2]; 5], dst: &[[f32; 2]; 5]) -> [f32; 4] {
    let mean = |p: &[[f32; 2]; 5]| {
        let (sx, sy) = p.iter().fold((0.0, 0.0), |(a, b), q| (a + q[0], b + q[1]));
        [sx / 5.0, sy / 5.0]
    };
    let (ms, md) = (mean(src), mean(dst));
    let (mut dot, mut cross, mut norm) = (0f32, 0f32, 0f32);
    for (s, d) in src.iter().zip(dst) {
        let (sx, sy, dx, dy) = (s[0] - ms[0], s[1] - ms[1], d[0] - md[0], d[1] - md[1]);
        dot += sx * dx + sy * dy;
        cross += sx * dy - sy * dx;
        norm += sx * sx + sy * sy;
    }
    let (a, b) = (dot / norm.max(1e-6), cross / norm.max(1e-6));
    // dst = [a -b; b a] src + t
    [a, b, md[0] - (a * ms[0] - b * ms[1]), md[1] - (b * ms[0] + a * ms[1])]
}

/// The face warped to 112×112 RGB (0..255, CHW), as SFace expects.
pub fn aligned(img: &RgbImage, d: &Det) -> Vec<f32> {
    let [a, b, tx, ty] = similarity(&d.kps, &TEMPLATE);
    let k = a * a + b * b;
    let (w, h) = img.dimensions();
    let plane = 112 * 112;
    let mut out = vec![0f32; plane * 3];
    for v in 0..112 {
        for u in 0..112 {
            // invert dst = M src + t
            let (px, py) = (u as f32 - tx, v as f32 - ty);
            let sx = (a * px + b * py) / k;
            let sy = (-b * px + a * py) / k;
            let (x0, y0) = (sx.floor(), sy.floor());
            let (fx, fy) = (sx - x0, sy - y0);
            let px_at = |x: f32, y: f32, c: usize| -> f32 {
                let (xi, yi) = (x.clamp(0.0, w as f32 - 1.0) as u32, y.clamp(0.0, h as f32 - 1.0) as u32);
                img.get_pixel(xi, yi)[c] as f32
            };
            for c in 0..3 {
                let top = px_at(x0, y0, c) * (1.0 - fx) + px_at(x0 + 1.0, y0, c) * fx;
                let bot = px_at(x0, y0 + 1.0, c) * (1.0 - fx) + px_at(x0 + 1.0, y0 + 1.0, c) * fx;
                out[c * plane + v * 112 + u] = top * (1.0 - fy) + bot * fy;
            }
        }
    }
    out
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similarity_recovers_a_known_transform() {
        // rotate 30°, scale 2, shift (5, -3)
        let (c, s) = (2.0 * 30f32.to_radians().cos(), 2.0 * 30f32.to_radians().sin());
        let src = TEMPLATE;
        let mut dst = [[0f32; 2]; 5];
        for (d, p) in dst.iter_mut().zip(&src) {
            *d = [c * p[0] - s * p[1] + 5.0, s * p[0] + c * p[1] - 3.0];
        }
        let [a, b, tx, ty] = similarity(&src, &dst);
        assert!((a - c).abs() < 1e-3 && (b - s).abs() < 1e-3);
        assert!((tx - 5.0).abs() < 1e-2 && (ty + 3.0).abs() < 1e-2);
    }

    #[test]
    fn nms_keeps_the_best_of_overlapping_boxes() {
        let d = |x: f32, s: f32| Det { x, y: 0.0, w: 10.0, h: 10.0, kps: [[0.0; 2]; 5], score: s };
        let kept = nms(vec![d(0.0, 0.8), d(1.0, 0.9), d(50.0, 0.7)], 0.3);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].score, 0.9);
    }
}
