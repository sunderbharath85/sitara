// Crop, straighten, rotate and flip as 2D affine maps. Every map ends in source uv (0..1 over the upright
// original), which is what the shaders sample. Screen space is y-down, so a positive angle turns clockwise.
import type { Crop, Geo } from "./stack";

/** Affine map: x' = a x + b y + c, y' = d x + e y + f. */
export type Mat = [number, number, number, number, number, number];

export const I: Mat = [1, 0, 0, 0, 1, 0];
export const T = (x: number, y: number): Mat => [1, 0, x, 0, 1, y];
export const S = (x: number, y: number): Mat => [x, 0, 0, 0, y, 0];
export const Rot = (r: number): Mat => [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0];

/** m ∘ n: apply n, then m. */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[3],
    m[0] * n[1] + m[1] * n[4],
    m[0] * n[2] + m[1] * n[5] + m[2],
    m[3] * n[0] + m[4] * n[3],
    m[3] * n[1] + m[4] * n[4],
    m[3] * n[2] + m[4] * n[5] + m[5],
  ];
}
export const chain = (...ms: Mat[]) => ms.reduce((acc, m) => mul(acc, m), I);

export function inv(m: Mat): Mat {
  const det = m[0] * m[4] - m[1] * m[3] || 1e-12;
  const a = m[4] / det,
    b = -m[1] / det,
    d = -m[3] / det,
    e = m[0] / det;
  return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
}
export const ap = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];

/** Column-major mat3 for a GLSL uniform. */
export const glMat = (m: Mat) => new Float32Array([m[0], m[3], 0, m[1], m[4], 0, m[2], m[5], 1]);

/** The rotated frame (after quarter turns): its size in source pixels. */
export const frame = (W: number, H: number, g: Geo): [number, number] => (g.rot % 2 ? [H, W] : [W, H]);

/** Frame uv → source uv: undo the quarter turns, then the mirror. */
function frameToSrc(g: Geo): Mat {
  const r: Mat[] = [I, [0, 1, 0, -1, 0, 1], [-1, 0, 1, 0, -1, 1], [0, -1, 1, 1, 0, 0]];
  return g.flip ? mul([-1, 0, 1, 0, 1, 0], r[g.rot]) : r[g.rot];
}

/** View px (the frame's pixel grid, turned by the straighten angle) → source uv. */
export function viewToSrc(W: number, H: number, g: Geo): Mat {
  const [fw, fh] = frame(W, H, g);
  const rad = (g.angle * Math.PI) / 180;
  return chain(frameToSrc(g), S(1 / fw, 1 / fh), T(fw / 2, fh / 2), Rot(-rad), T(-fw / 2, -fh / 2));
}

/** Output uv (0..1 across the crop) → view px. */
export const outToView = (W: number, H: number, g: Geo): Mat => {
  const [fw, fh] = frame(W, H, g);
  return chain(T(g.crop.x * fw, g.crop.y * fh), S(g.crop.w * fw, g.crop.h * fh));
};

export const outToSrc = (W: number, H: number, g: Geo) => mul(viewToSrc(W, H, g), outToView(W, H, g));

/** Output size in source pixels. */
export function outSize(W: number, H: number, g: Geo): [number, number] {
  const [fw, fh] = frame(W, H, g);
  return [Math.max(1, Math.round(g.crop.w * fw)), Math.max(1, Math.round(g.crop.h * fh))];
}

/** While cropping the whole turned frame is shown: its bounding box in view px. */
export function bbox(W: number, H: number, g: Geo) {
  const [fw, fh] = frame(W, H, g);
  const r = (g.angle * Math.PI) / 180,
    c = Math.abs(Math.cos(r)),
    s = Math.abs(Math.sin(r));
  const bw = fw * c + fh * s,
    bh = fw * s + fh * c;
  return { x: fw / 2 - bw / 2, y: fh / 2 - bh / 2, w: bw, h: bh };
}

/** Does every corner of the crop land on the photo? */
export function cropValid(W: number, H: number, g: Geo, c: Crop): boolean {
  const m = viewToSrc(W, H, g);
  const [fw, fh] = frame(W, H, g);
  const e = 1e-5;
  if (c.w <= 0 || c.h <= 0) return false;
  for (const [x, y] of [
    [c.x, c.y],
    [c.x + c.w, c.y],
    [c.x, c.y + c.h],
    [c.x + c.w, c.y + c.h],
  ]) {
    const [u, v] = ap(m, x * fw, y * fh);
    if (u < -e || v < -e || u > 1 + e || v > 1 + e) return false;
  }
  return true;
}

const lerp = (a: Crop, b: Crop, t: number): Crop => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t });

/** Move from a valid crop toward a wanted one as far as the photo allows. */
export function constrain(W: number, H: number, g: Geo, from: Crop, want: Crop): Crop {
  if (cropValid(W, H, g, want)) return want;
  if (!cropValid(W, H, g, from)) return want;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (cropValid(W, H, g, lerp(from, want, mid))) lo = mid;
    else hi = mid;
  }
  return lerp(from, want, lo);
}

/** Pixel aspect (w/h) of a preset, or null for free. */
export function aspectOf(preset: string, W: number, H: number, g: Geo): number | null {
  if (preset === "free") return null;
  if (preset === "orig") {
    const [fw, fh] = frame(W, H, g);
    return fw / fh;
  }
  const [a, b] = preset.split(":").map(Number);
  return a && b ? a / b : null;
}

/** The largest crop of a pixel aspect centered on (cx, cy) (normalized frame coords) that stays on the photo. */
export function largest(W: number, H: number, g: Geo, aspect: number | null, cx = 0.5, cy = 0.5): Crop {
  const [fw, fh] = frame(W, H, g);
  let w = 1,
    h = 1;
  if (aspect) {
    const fa = fw / fh;
    if (aspect > fa) h = fa / aspect;
    else w = aspect / fa;
  }
  const at = (s: number): Crop => ({ x: cx - (w * s) / 2, y: cy - (h * s) / 2, w: w * s, h: h * s });
  let lo = 0,
    hi = 1;
  if (cropValid(W, H, g, at(1))) return at(1);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (cropValid(W, H, g, at(mid))) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

/** Keep the crop legal after the angle or turns changed: largest when automatic, else shrink around its center. */
export function refit(W: number, H: number, g: Geo): Crop {
  const a = aspectOf(g.aspect, W, H, g);
  if (g.auto) return largest(W, H, g, a ?? (g.crop.w * frame(W, H, g)[0]) / (g.crop.h * frame(W, H, g)[1]));
  if (cropValid(W, H, g, g.crop)) return g.crop;
  const cx = g.crop.x + g.crop.w / 2,
    cy = g.crop.y + g.crop.h / 2;
  const zero = { x: cx, y: cy, w: 0, h: 0 };
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (cropValid(W, H, g, lerp(zero, g.crop, mid))) lo = mid;
    else hi = mid;
  }
  if (lo < 0.05) return largest(W, H, g, a);
  return lerp(zero, g.crop, lo);
}
