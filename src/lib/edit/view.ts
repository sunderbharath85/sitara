// Where the photo sits on screen, and the maps between screen, output, source and p-space.
import { bbox, chain, frame, inv, mul, outSize, outToSrc, S, T, viewToSrc, type Mat } from "./geometry";
import type { Geo } from "./stack";

export interface View {
  z: number; // 1 = fit
  x: number; // pan, css px
  y: number;
}

export interface Layout {
  rect: { x: number; y: number; w: number; h: number }; // css rect of what's shown (output, or the whole frame while cropping)
  dispToSrc: Mat;
  cssToDisp: Mat;
  fragToSrc: Mat;
  fragToOut: Mat;
  outPx: [number, number];
  pToCss: Mat;
  cssToP: Mat;
  scale: number; // css px per source px
  fit: number; // scale at z = 1
  /** Crop mode: frame-normalized ↔ css (axis-aligned). */
  normToCss?: (x: number, y: number) => [number, number];
  cssToNorm?: (x: number, y: number) => [number, number];
}

export function layout(W: number, H: number, g: Geo, stage: { w: number; h: number }, dpr: number, v: View, cropping: boolean): Layout {
  const [fw, fh] = frame(W, H, g);
  const bb = bbox(W, H, g);
  const dispToSrc = cropping ? chain(viewToSrc(W, H, g), T(bb.x, bb.y), S(bb.w, bb.h)) : outToSrc(W, H, g);
  const [dw, dh] = cropping ? [bb.w, bb.h] : outSize(W, H, g);
  const m = cropping ? 70 : 34;
  const fit = Math.max(1e-6, Math.min((stage.w - 2 * m) / dw, (stage.h - 2 * m) / dh));
  const scale = cropping ? fit : fit * v.z;
  const rw = dw * scale,
    rh = dh * scale;
  const rect = { x: (stage.w - rw) / 2 + (cropping ? 0 : v.x), y: (stage.h - rh) / 2 + (cropping ? 0 : v.y), w: rw, h: rh };
  const cssToDisp = chain(S(1 / rect.w, 1 / rect.h), T(-rect.x, -rect.y));
  const fragToCss: Mat = [1 / dpr, 0, 0, 0, -1 / dpr, stage.h];
  const fragToDisp = mul(cssToDisp, fragToCss);
  let fragToOut = fragToDisp;
  if (cropping) {
    const c = g.crop;
    fragToOut = chain(S(1 / (c.w * fw), 1 / (c.h * fh)), T(-c.x * fw, -c.y * fh), T(bb.x, bb.y), S(bb.w, bb.h), fragToDisp);
  }
  const m2 = Math.max(W, H);
  const pToCss = chain(inv(cssToDisp), inv(dispToSrc), S(m2 / W, m2 / H));
  const out: Layout = {
    rect,
    dispToSrc,
    cssToDisp,
    fragToSrc: mul(dispToSrc, fragToDisp),
    fragToOut,
    outPx: outSize(W, H, g),
    pToCss,
    cssToP: inv(pToCss),
    scale,
    fit,
  };
  if (cropping) {
    out.normToCss = (x, y) => [rect.x + ((x * fw - bb.x) / bb.w) * rect.w, rect.y + ((y * fh - bb.y) / bb.h) * rect.h];
    out.cssToNorm = (x, y) => [(((x - rect.x) / rect.w) * bb.w + bb.x) / fw, (((y - rect.y) / rect.h) * bb.h + bb.y) / fh];
  }
  return out;
}

/** Keep a zoomed photo from being dragged off the stage. */
export function clampPan(v: View, rect: { w: number; h: number }, stage: { w: number; h: number }): View {
  const mx = Math.max(0, (rect.w - stage.w) / 2 + stage.w * 0.3),
    my = Math.max(0, (rect.h - stage.h) / 2 + stage.h * 0.3);
  return { ...v, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
}
