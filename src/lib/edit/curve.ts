// Tone curves: monotone cubic splines (Fritsch–Carlson), so a curve never overshoots between its points.
import type { Curves, Pt } from "./stack";

export const LUT_N = 1024;

/** Evaluate a curve through sorted points at x in [0, 1]. */
export function spline(pts: Pt[]): (x: number) => number {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n < 2) return (x) => x;
  const dx: number[] = [],
    m: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(1e-6, p[i + 1][0] - p[i][0]);
    s[i] = (p[i + 1][1] - p[i][1]) / dx[i];
  }
  m[0] = s[0];
  m[n - 1] = s[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (s[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / s[i],
      b = m[i + 1] / s[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * s[i];
      m[i + 1] = t * b * s[i];
    }
  }
  return (x) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (i < n - 2 && x > p[i + 1][0]) i++;
    const h = dx[i],
      t = (x - p[i][0]) / h,
      t2 = t * t,
      t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}

/** One RGBA lookup row: the look's curve (blended by amount), then RGB, then each channel's own curve. */
export function buildLut(c: Curves, look: Pt[] | null, amt: number): Float32Array {
  const lk = look ? spline(look) : null;
  const [m, r, g, b] = [spline(c.rgb), spline(c.r), spline(c.g), spline(c.b)];
  const out = new Float32Array(LUT_N * 4);
  for (let i = 0; i < LUT_N; i++) {
    const x = i / (LUT_N - 1);
    const base = m(lk ? x + (lk(x) - x) * amt : x);
    const cl = (v: number) => Math.min(1, Math.max(0, v));
    out[i * 4] = cl(r(cl(base)));
    out[i * 4 + 1] = cl(g(cl(base)));
    out[i * 4 + 2] = cl(b(cl(base)));
    out[i * 4 + 3] = 1;
  }
  return out;
}
