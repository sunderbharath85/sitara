// On-device pixel analysis of a thumbnail: RGB histogram, dominant palette, simple mood tags.

export interface Analysis {
  hist: { R: number[]; G: number[]; B: number[] };
  pal: string[];
  tags: string[];
  expo: string;
}

const cache = new Map<string, Promise<Analysis | null>>();
const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function compute(im: HTMLImageElement): Analysis {
  const w = 96,
    h = Math.max(1, Math.round((96 * im.naturalHeight) / Math.max(1, im.naturalWidth)));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(im, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data,
    n = d.length / 4;
  const R = new Array(64).fill(0),
    G = new Array(64).fill(0),
    B = new Array(64).fill(0);
  const bk = new Map<number, { c: number; r: number; g: number; b: number }>();
  let sl = 0,
    sl2 = 0,
    ss = 0,
    sw = 0,
    lo = 0,
    hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    R[r >> 2]++;
    G[g >> 2]++;
    B[b >> 2]++;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sl += L;
    sl2 += L * L;
    if (L < 12) lo++;
    if (L > 243) hi++;
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b);
    ss += mx ? (mx - mn) / mx : 0;
    sw += r - b;
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = bk.get(k) ?? { c: 0, r: 0, g: 0, b: 0 };
    e.c++;
    e.r += r;
    e.g += g;
    e.b += b;
    bk.set(k, e);
  }
  const mean = sl / n,
    sd = Math.sqrt(Math.max(0, sl2 / n - mean * mean)),
    sat = ss / n,
    warm = sw / n;
  const pal: number[][] = [];
  for (const e of [...bk.values()].sort((a, b) => b.c - a.c)) {
    const col = [e.r / e.c, e.g / e.c, e.b / e.c];
    if (pal.every((q) => dist(q, col) > 52)) pal.push(col);
    if (pal.length >= 6) break;
  }
  while (pal.length < 6) pal.push(pal[pal.length - 1] ?? [40, 40, 40]);
  const tags = [
    mean < 85 ? "Low-key" : mean > 165 ? "High-key" : "Balanced light",
    warm > 16 ? "Warm" : warm < -10 ? "Cool" : "Neutral tones",
    sat > 0.42 ? "Vivid" : sat < 0.18 ? "Muted" : "Natural color",
  ];
  if (sd > 62) tags.push("High contrast");
  else if (sd < 36) tags.push("Soft contrast");
  return { hist: { R, G, B }, pal: pal.map(hex), tags, expo: `shadows ${((lo / n) * 100).toFixed(1)}% · highlights ${((hi / n) * 100).toFixed(1)}%` };
}

export function analyze(src: string): Promise<Analysis | null> {
  let p = cache.get(src);
  if (!p) {
    p = new Promise((res) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => {
        try {
          res(compute(im));
        } catch {
          res(null);
        }
      };
      im.onerror = () => res(null);
      im.src = src;
    });
    cache.set(src, p);
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return p;
}

export function drawHist(cv: HTMLCanvasElement, h: Analysis["hist"]) {
  const dpr = devicePixelRatio || 1,
    W = cv.clientWidth || 244,
    H = 80;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const x = cv.getContext("2d")!;
  x.scale(dpr, dpr);
  x.clearRect(0, 0, W, H);
  x.strokeStyle = "rgba(255,255,255,.06)";
  for (let q = 1; q < 4; q++) {
    x.beginPath();
    x.moveTo((W * q) / 4, 0);
    x.lineTo((W * q) / 4, H);
    x.stroke();
  }
  let mx = 1;
  for (const ch of [h.R, h.G, h.B]) for (let i = 1; i < 63; i++) mx = Math.max(mx, ch[i]);
  x.globalCompositeOperation = "lighter";
  (
    [
      [h.R, "rgba(255,72,72,.55)"],
      [h.G, "rgba(72,230,120,.5)"],
      [h.B, "rgba(80,140,255,.6)"],
    ] as const
  ).forEach(([ch, col]) => {
    x.beginPath();
    x.moveTo(0, H);
    for (let i = 0; i < 64; i++) x.lineTo((i / 63) * W, H - Math.min(1, ch[i] / mx) * (H - 4));
    x.lineTo(W, H);
    x.closePath();
    x.fillStyle = col;
    x.fill();
  });
  x.globalCompositeOperation = "source-over";
}
