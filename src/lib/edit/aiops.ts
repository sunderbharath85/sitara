// AI editing, orchestrated in the editor: pixels come off the GPU (any source format, already upright),
// a model runs on this computer, and the result is kept as a content-addressed layer that the edit stack
// refers to. Nothing touches the original file.
import { api } from "../api";
import type { Renderer } from "./renderer";
import type { Patch, Stroke } from "./stack";

type Head = { op: string; w: number; h: number; q?: string; n?: number };
const op = (head: Head, ...parts: Uint8Array[]) => api.aiOp(head, parts);

function fit(w: number, h: number, max: number): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

function canvasOf(w: number, h: number, rgba: Uint8ClampedArray<ArrayBuffer>) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(rgba, w, h), 0, 0);
  return c;
}

/** Store RGBA pixels as a PNG layer, make it available to the renderer at once, return its hash. */
async function keep(r: Renderer, c: HTMLCanvasElement): Promise<string> {
  const png = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("couldn't encode the result"))), "image/png"));
  const hash = await api.layerPut(png);
  r.addLayer(hash, c);
  return hash;
}

/** A one-byte-per-pixel mask as a grayscale RGBA layer. */
async function keepMask(r: Renderer, w: number, h: number, gray: Uint8Array): Promise<string> {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([gray[i], gray[i], gray[i], 255], i * 4);
  return keep(r, canvasOf(w, h, rgba));
}

/** Remove what the strokes cover: inpaint a square around them, feather the edge, keep it as a patch. */
export async function removeObjects(r: Renderer, strokes: Stroke[]): Promise<Patch> {
  const [ax, ay] = r.asp;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of strokes)
    for (let i = 0; i + 1 < s.pts.length; i += 2) {
      x0 = Math.min(x0, s.pts[i] - s.r);
      y0 = Math.min(y0, s.pts[i + 1] - s.r);
      x1 = Math.max(x1, s.pts[i] + s.r);
      y1 = Math.max(y1, s.pts[i + 1] + s.r);
    }
  // a square with generous context around the strokes (LaMa works on squares)
  const side = Math.min(Math.max(ax, ay), Math.max(x1 - x0, y1 - y0) * 1.9 + 0.04);
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  const sx = Math.min(side, ax),
    sy = Math.min(side, ay);
  const px = Math.min(Math.max(0, cx - sx / 2), ax - sx),
    py = Math.min(Math.max(0, cy - sy / 2), ay - sy);
  const rect: [number, number, number, number] = [px / ax, py / ay, sx / ax, sy / ay];
  const [ow, oh] = fit(rect[2] * r.W, rect[3] * r.H, 1024);
  const pixels = r.extract("current", rect, ow, oh);
  // the mask, in region pixels
  const mc = document.createElement("canvas");
  mc.width = ow;
  mc.height = oh;
  const mx = mc.getContext("2d")!;
  const k = ow / sx;
  const paint = (grow: number) => {
    mx.clearRect(0, 0, ow, oh);
    mx.strokeStyle = mx.fillStyle = "#fff";
    mx.lineCap = mx.lineJoin = "round";
    for (const s of strokes) {
      mx.lineWidth = (s.r * 2 + grow) * k;
      mx.beginPath();
      for (let i = 0; i + 1 < s.pts.length; i += 2) {
        const X = (s.pts[i] - px) * k,
          Y = (s.pts[i + 1] - py) * k;
        if (i) mx.lineTo(X, Y);
        else mx.moveTo(X, Y);
      }
      if (s.pts.length === 2) mx.lineTo((s.pts[0] - px) * k + 0.1, (s.pts[1] - py) * k);
      mx.stroke();
    }
  };
  paint(0.006);
  const md = mx.getImageData(0, 0, ow, oh).data;
  const mask = new Uint8Array(ow * oh);
  for (let i = 0; i < ow * oh; i++) mask[i] = md[i * 4];
  const out = new Uint8ClampedArray(await op({ op: "inpaint", w: ow, h: oh }, pixels, mask));
  // feathered alpha: a slightly larger, blurred mask
  mx.filter = `blur(${Math.max(2, ow / 160)}px)`;
  paint(0.012);
  mx.filter = "none";
  const fa = mx.getImageData(0, 0, ow, oh).data;
  for (let i = 0; i < ow * oh; i++) out[i * 4 + 3] = fa[i * 4];
  const layer = await keep(r, canvasOf(ow, oh, out));
  return { layer, x: rect[0], y: rect[1], w: rect[2], h: rect[3] };
}

export interface MaskData {
  w: number;
  h: number;
  gray: Uint8Array;
}

/** A subject or sky mask over the whole photo, as pixels. */
export async function segmentData(r: Renderer, what: "subject" | "sky"): Promise<MaskData> {
  const [w, h] = fit(r.W, r.H, 1024);
  return { w, h, gray: new Uint8Array(await op({ op: what, w, h }, r.extract("current", [0, 0, 1, 1], w, h))) };
}
export const keepMaskData = (r: Renderer, m: MaskData) => keepMask(r, m.w, m.h, m.gray);
export const segment = async (r: Renderer, what: "subject" | "sky") => keepMaskData(r, await segmentData(r, what));

/** Relative depth (near = white), and the depth at the subject (the focus plane). */
export async function depth(r: Renderer, subject: MaskData | null): Promise<{ layer: string; focus: number }> {
  const [w, h] = fit(r.W, r.H, 768);
  const d = new Uint8Array(await op({ op: "depth", w, h }, r.extract("current", [0, 0, 1, 1], w, h)));
  let focus = 0.85;
  if (subject) {
    // the subject's typical depth, read where the subject mask is solid
    const under: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sx = Math.min(subject.w - 1, Math.floor((x / w) * subject.w)),
          sy = Math.min(subject.h - 1, Math.floor((y / h) * subject.h));
        if (subject.gray[sy * subject.w + sx] > 160) under.push(d[y * w + x]);
      }
    if (under.length > 50) focus = under.sort((a, b) => a - b)[Math.floor(under.length * 0.3)] / 255;
  }
  return { layer: await keepMask(r, w, h, d), focus };
}

/** Denoise (full resolution) or upscale ×4, tile by tile. */
export async function tiled(r: Renderer, kind: "denoise" | "upscale", progress: (f: number) => void): Promise<string> {
  const [W, H] = r.sourceSize;
  const scale = kind === "upscale" ? 4 : 1;
  const tile = kind === "upscale" ? 256 : 512,
    pad = 24;
  const c = document.createElement("canvas");
  c.width = W * scale;
  c.height = H * scale;
  const cx = c.getContext("2d")!;
  const nx = Math.ceil(W / tile),
    ny = Math.ceil(H / tile);
  let done = 0;
  for (let ty = 0; ty < ny; ty++)
    for (let tx = 0; tx < nx; tx++) {
      const x0 = tx * tile,
        y0 = ty * tile;
      const ix0 = Math.max(0, x0 - pad),
        iy0 = Math.max(0, y0 - pad);
      const ix1 = Math.min(W, x0 + tile + pad),
        iy1 = Math.min(H, y0 + tile + pad);
      const w = ix1 - ix0,
        h = iy1 - iy0;
      const px = r.extract("orig", [ix0 / W, iy0 / H, w / W, h / H], w, h);
      const out = new Uint8ClampedArray(await op({ op: kind, w, h }, px));
      const img = new ImageData(out, w * scale, h * scale);
      // keep only the tile's own pixels (the padding was context for the model)
      cx.putImageData(img, ix0 * scale, iy0 * scale, (x0 - ix0) * scale, (y0 - iy0) * scale, Math.min(tile, W - x0) * scale, Math.min(tile, H - y0) * scale);
      progress(++done / (nx * ny));
    }
  return keep(r, c);
}

/** Face boxes (normalized to the photo) for face-aware edits. */
export async function faces(r: Renderer): Promise<[number, number, number, number][]> {
  const [w, h] = fit(r.W, r.H, 1280);
  return JSON.parse(new TextDecoder().decode(await op({ op: "faces", w, h }, r.extract("current", [0, 0, 1, 1], w, h))));
}

/** CLIP similarity of a description to each of several renders (224×224 RGBA each). */
export async function rank(q: string, renders: Uint8Array[]): Promise<number[]> {
  const all = new Uint8Array(renders.length * 224 * 224 * 4);
  renders.forEach((p, i) => all.set(p, i * 224 * 224 * 4));
  return JSON.parse(new TextDecoder().decode(await op({ op: "rank", w: 224, h: 224, q, n: renders.length }, all)));
}
