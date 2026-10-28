// Loading the editor's source: the webview decodes JPEG/PNG/WebP itself (upright, color-managed); everything
// else (RAW, HEIC, TIFF) arrives from Rust as raw pixels in the SRC1 container (see thumbs.rs).
import { editSource, type MediaDetail } from "../api";
import type { Small, Source } from "./renderer";

const SMALL = 640;

export async function loadSource(d: MediaDetail, maxTex: number, signal: AbortSignal): Promise<Source> {
  const s = editSource(d);
  if (!s.binary) {
    try {
      return await fromImage(s.url, maxTex, signal);
    } catch (e) {
      if (signal.aborted || !s.fallback) throw e;
    }
  }
  return fromBinary(`${s.fallback ?? s.url}&max=${maxTex}`, signal);
}

async function fromImage(url: string, maxTex: number, signal: AbortSignal): Promise<Source> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Couldn't read the photo (${res.status})`);
  const blob = await res.blob();
  const opts: ImageBitmapOptions = { imageOrientation: "from-image", premultiplyAlpha: "none" };
  let bmp = await createImageBitmap(blob, opts);
  const long = Math.max(bmp.width, bmp.height);
  if (long > maxTex) {
    const k = maxTex / long;
    const w = Math.max(1, Math.floor(bmp.width * k)),
      h = Math.max(1, Math.floor(bmp.height * k));
    bmp.close();
    bmp = await createImageBitmap(blob, { ...opts, resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
  }
  const k = Math.min(1, SMALL / Math.max(bmp.width, bmp.height));
  const sw = Math.max(1, Math.round(bmp.width * k)),
    sh = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement("canvas");
  c.width = sw;
  c.height = sh;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(bmp, 0, 0, sw, sh);
  const id = x.getImageData(0, 0, sw, sh).data;
  const px = new Float32Array(sw * sh * 3);
  for (let i = 0, j = 0; i < id.length; i += 4, j += 3) {
    px[j] = id[i] / 255;
    px[j + 1] = id[i + 1] / 255;
    px[j + 2] = id[i + 2] / 255;
  }
  return { w: bmp.width, h: bmp.height, enc: 0, pixels: bmp, small: { w: sw, h: sh, px } };
}

async function fromBinary(url: string, signal: AbortSignal): Promise<Source> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `Couldn't decode this photo (${res.status})`);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  if (buf.byteLength < 16 || String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== "SRC1") throw new Error("Unexpected source data");
  const w = dv.getUint32(4, true),
    h = dv.getUint32(8, true),
    fmt = dv.getUint32(12, true) as 0 | 1;
  const data = fmt === 1 ? new Uint32Array(buf, 16, w * h) : new Uint8Array(buf, 16, w * h * 4);
  return { w, h, enc: fmt, pixels: { fmt, data }, small: shrink(data, fmt, w, h) };
}

/** Nearest-neighbour CPU copy, in the source's own encoding. */
function shrink(data: Uint32Array | Uint8Array, fmt: 0 | 1, w: number, h: number): Small {
  const k = Math.min(1, SMALL / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * k)),
    sh = Math.max(1, Math.round(h * k));
  const px = new Float32Array(sw * sh * 3);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / k));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) / k));
      const o = (y * sw + x) * 3,
        i = sy * w + sx;
      if (fmt === 1) {
        const v = (data as Uint32Array)[i];
        px[o] = (v & 1023) / 1023;
        px[o + 1] = ((v >>> 10) & 1023) / 1023;
        px[o + 2] = ((v >>> 20) & 1023) / 1023;
      } else {
        const d = data as Uint8Array;
        px[o] = d[i * 4] / 255;
        px[o + 1] = d[i * 4 + 1] / 255;
        px[o + 2] = d[i * 4 + 2] / 255;
      }
    }
  }
  return { w: sw, h: sh, px };
}

/** Linear light from the small copy's encoding (matches the shader's `dec`). */
export const toLinear = (v: number, enc: 0 | 1) => (enc === 1 ? (Math.exp(v * 6.2402758) - 1) / 64 : v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
