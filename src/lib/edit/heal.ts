// CPU helpers that read the small copy of the source: where to take a heal patch from, how to color-match it,
// and one-click auto tone.
import type { Small } from "./renderer";
import { toLinear } from "./source";
import type { AdjKey, Spot } from "./stack";

type RGB = [number, number, number];

function sample(s: Small, asp: [number, number], x: number, y: number): RGB | null {
  const u = x / asp[0],
    v = y / asp[1];
  if (u < 0 || v < 0 || u > 1 || v > 1) return null;
  const fx = Math.min(s.w - 1.001, Math.max(0, u * s.w - 0.5)),
    fy = Math.min(s.h - 1.001, Math.max(0, v * s.h - 0.5));
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    tx = fx - x0,
    ty = fy - y0;
  const at = (xx: number, yy: number, c: number) => s.px[(yy * s.w + xx) * 3 + c];
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++)
    out[c] = (at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx) * (1 - ty) + (at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx) * ty;
  return out;
}

const RING = 24;
function ring(s: Small, asp: [number, number], x: number, y: number, r: number): RGB[] | null {
  const out: RGB[] = [];
  for (let k = 0; k < RING; k++) {
    const a = (k / RING) * Math.PI * 2;
    const p = sample(s, asp, x + Math.cos(a) * r * 1.18, y + Math.sin(a) * r * 1.18);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

const mean = (pts: RGB[]): RGB => {
  const m: RGB = [0, 0, 0];
  for (const p of pts) for (let c = 0; c < 3; c++) m[c] += p[c] / pts.length;
  return m;
};

/** The neighbouring patch whose surroundings best match the spot's, so the copy blends in. */
export function autoSource(s: Small, asp: [number, number], x: number, y: number, r: number): [number, number] {
  const want = ring(s, asp, x, y, r);
  let best: [number, number] = [Math.min(asp[0] - r, x + r * 2.6), y],
    score = Infinity;
  if (!want) return best;
  for (const dist of [2.3, 3.1, 4.2])
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + dist;
      const cx = x + Math.cos(a) * r * dist,
        cy = y + Math.sin(a) * r * dist;
      if (cx - r * 1.3 < 0 || cy - r * 1.3 < 0 || cx + r * 1.3 > asp[0] || cy + r * 1.3 > asp[1]) continue;
      const got = ring(s, asp, cx, cy, r);
      if (!got) continue;
      let d = 0;
      for (let i = 0; i < RING; i++) for (let c = 0; c < 3; c++) d += (got[i][c] - want[i][c]) ** 2;
      // avoid copying texture (or another blemish) from inside the candidate
      const inner: number[] = [];
      for (let i = 0; i < 12; i++) {
        const b = (i / 12) * Math.PI * 2;
        const p = sample(s, asp, cx + Math.cos(b) * r * 0.55, cy + Math.sin(b) * r * 0.55);
        if (p) inner.push(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
      }
      const im = inner.reduce((a2, b2) => a2 + b2, 0) / Math.max(1, inner.length);
      const iv = inner.reduce((a2, b2) => a2 + (b2 - im) ** 2, 0) / Math.max(1, inner.length);
      const sc = d / RING + iv * 0.8 + dist * 0.0004;
      if (sc < score) {
        score = sc;
        best = [cx, cy];
      }
    }
  return best;
}

/** Difference between the spot's surroundings and the source patch's, added to the copied pixels. */
export function colorOffset(s: Small, asp: [number, number], spot: Pick<Spot, "x" | "y" | "sx" | "sy" | "r">): [number, number, number] {
  const a = ring(s, asp, spot.x, spot.y, spot.r),
    b = ring(s, asp, spot.sx, spot.sy, spot.r);
  if (!a || !b) return [0, 0, 0];
  const ma = mean(a),
    mb = mean(b);
  return [ma[0] - mb[0], ma[1] - mb[1], ma[2] - mb[2]];
}

/** One-click tone: center the exposure, set the end points, add a little life. */
export function autoTone(s: Small, enc: 0 | 1): Partial<Record<AdjKey, number>> {
  const n = s.w * s.h;
  const L = new Float32Array(n);
  let satSum = 0;
  for (let i = 0; i < n; i++) {
    const r = toLinear(s.px[i * 3], enc),
      g = toLinear(s.px[i * 3 + 1], enc),
      b = toLinear(s.px[i * 3 + 2], enc);
    L[i] = Math.pow(Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b), 1 / 2.2);
    const mx = Math.max(r, g, b);
    satSum += mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
  }
  const sorted = L.slice().sort();
  const q = (f: number) => sorted[Math.min(n - 1, Math.floor(f * n))];
  const lo = q(0.005),
    mid = q(0.5),
    hi = q(0.995);
  const round = (v: number, k = 1) => Math.round(v * k) / k;
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  // perceptual 0.46 is a comfortable midtone; convert the gap to stops (perceptual = linear^(1/2.2))
  const exposure = clamp(round(2.2 * Math.log2(0.46 / Math.max(0.02, mid)), 100), -2, 2);
  const shifted = (v: number) => v * Math.pow(2, exposure / 2.2);
  const whites = clamp(round((0.97 - shifted(hi)) * 260), -40, 50);
  const blacks = clamp(round((0.03 - shifted(lo)) * 300), -40, 30);
  const sat = satSum / n;
  return {
    exposure,
    whites,
    blacks,
    contrast: clamp(round((0.85 - (hi - lo)) * 60 + 6), -10, 30),
    highlights: shifted(hi) > 0.95 ? -30 : -10,
    shadows: shifted(q(0.1)) < 0.12 ? 25 : 10,
    vibrance: clamp(round((0.32 - sat) * 80 + 12), 0, 30),
  };
}
