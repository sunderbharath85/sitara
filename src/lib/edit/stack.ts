// The edit stack: everything the editor does to a photo, as data. It is saved as JSON per photo,
// rendered on the GPU, and never written into the original file.
//
// Coordinates: masks and heal spots live in "p-space", the upright source image scaled so its long edge is 1
// (p = uv * [W, H] / max(W, H)). That keeps circles round and keeps edits attached to the content when
// the photo is cropped or rotated.

export type AdjKey =
  | "exposure" | "contrast" | "highlights" | "shadows" | "whites" | "blacks"
  | "temp" | "tint" | "vibrance" | "saturation"
  | "clarity" | "dehaze" | "sharpen" | "vignette" | "grain" | "fade";

export type LocalKey = "exposure" | "contrast" | "highlights" | "shadows" | "temp" | "tint" | "saturation" | "clarity" | "dehaze" | "sharpen";

export interface Spec<K extends string = AdjKey> {
  key: K;
  label: string;
  min: number;
  max: number;
  step?: number;
  /** CSS gradient painted on the slider track. */
  track?: string;
}

const T_TEMP = "linear-gradient(90deg,#3f7bff,#d9d9d9 50%,#ffb02e)";
const T_TINT = "linear-gradient(90deg,#33d17a,#d9d9d9 50%,#e14bd8)";
const T_SAT = "linear-gradient(90deg,#8a8a8a,#ff4d4d 30%,#ffd23f 50%,#38d97a 70%,#3f8cff)";
const T_EXP = "linear-gradient(90deg,#050505,#f2f2f2)";

export const LIGHT: Spec[] = [
  { key: "exposure", label: "Exposure", min: -4, max: 4, step: 0.01, track: T_EXP },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "highlights", label: "Highlights", min: -100, max: 100 },
  { key: "shadows", label: "Shadows", min: -100, max: 100 },
  { key: "whites", label: "Whites", min: -100, max: 100 },
  { key: "blacks", label: "Blacks", min: -100, max: 100 },
];
export const COLOR: Spec[] = [
  { key: "temp", label: "Temperature", min: -100, max: 100, track: T_TEMP },
  { key: "tint", label: "Tint", min: -100, max: 100, track: T_TINT },
  { key: "vibrance", label: "Vibrance", min: -100, max: 100, track: T_SAT },
  { key: "saturation", label: "Saturation", min: -100, max: 100, track: T_SAT },
];
export const EFFECTS: Spec[] = [
  { key: "clarity", label: "Clarity", min: -100, max: 100 },
  { key: "dehaze", label: "Dehaze", min: -100, max: 100 },
  { key: "sharpen", label: "Sharpen", min: 0, max: 100 },
  { key: "vignette", label: "Vignette", min: -100, max: 100 },
  { key: "grain", label: "Grain", min: 0, max: 100 },
  { key: "fade", label: "Fade", min: 0, max: 100 },
];
export const LOCAL: Spec<LocalKey>[] = [
  { key: "exposure", label: "Exposure", min: -4, max: 4, step: 0.01, track: T_EXP },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "highlights", label: "Highlights", min: -100, max: 100 },
  { key: "shadows", label: "Shadows", min: -100, max: 100 },
  { key: "temp", label: "Temperature", min: -100, max: 100, track: T_TEMP },
  { key: "tint", label: "Tint", min: -100, max: 100, track: T_TINT },
  { key: "saturation", label: "Saturation", min: -100, max: 100, track: T_SAT },
  { key: "clarity", label: "Clarity", min: -100, max: 100 },
  { key: "dehaze", label: "Dehaze", min: -100, max: 100 },
  { key: "sharpen", label: "Sharpen", min: 0, max: 100 },
];

/** The color mixer's eight bands, centered on OKLab hues of the named colors. */
export const BANDS = [
  { name: "Red", hue: 29, css: "#ff4b4b" },
  { name: "Orange", hue: 60, css: "#ff9a3c" },
  { name: "Yellow", hue: 110, css: "#ffd93d" },
  { name: "Green", hue: 142, css: "#45d36b" },
  { name: "Aqua", hue: 195, css: "#2fd3d9" },
  { name: "Blue", hue: 264, css: "#4a7dff" },
  { name: "Purple", hue: 296, css: "#9b5cff" },
  { name: "Magenta", hue: 328, css: "#ff4fd0" },
];

export type Pt = [number, number];
export interface Curves {
  rgb: Pt[];
  r: Pt[];
  g: Pt[];
  b: Pt[];
}
export interface Hsl {
  h: number[];
  s: number[];
  l: number[];
}
export interface Wheel {
  h: number; // degrees
  s: number; // 0..100
}
export interface Grade {
  sh: Wheel;
  mid: Wheel;
  hi: Wheel;
  bal: number; // -100..100
}
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Geo {
  rot: 0 | 1 | 2 | 3; // quarter turns clockwise
  flip: boolean; // mirror horizontally (before rotating)
  angle: number; // straighten, degrees, clockwise
  crop: Crop; // in the rotated frame, normalized
  aspect: string; // "free" | "orig" | "w:h"
  auto: boolean; // crop follows the straighten angle at its largest size
}

interface MaskBase {
  id: string;
  name: string;
  invert: boolean;
  amount: number; // 0..100
  adj: Partial<Record<LocalKey, number>>;
}
export interface LinearMask extends MaskBase {
  kind: "linear";
  a: Pt; // full effect here
  b: Pt; // fades to nothing here
}
export interface RadialMask extends MaskBase {
  kind: "radial";
  c: Pt;
  r: Pt; // radii
  angle: number; // radians
  feather: number; // 0..100
}
export interface Stroke {
  r: number; // p-space radius
  feather: number; // 0..1
  flow: number; // 0..1
  erase: boolean;
  pts: number[]; // x, y pairs in p-space
}
export interface BrushMask extends MaskBase {
  kind: "brush";
  strokes: Stroke[];
}
export type Mask = LinearMask | RadialMask | BrushMask;
export const MAX_MASKS = 8;

export interface Spot {
  x: number; // destination (p-space)
  y: number;
  sx: number; // source
  sy: number;
  r: number;
  feather: number; // 0..1
  opacity: number; // 0..1
  mode: "heal" | "clone";
  off: [number, number, number]; // color offset matching the source patch to its new surroundings
}
export const MAX_SPOTS = 48;

export interface Stack {
  v: 1;
  adj: Record<AdjKey, number>;
  curve: Curves;
  hsl: Hsl;
  grade: Grade;
  bw: boolean;
  look: { id: string; amt: number } | null;
  geo: Geo;
  masks: Mask[];
  heal: Spot[];
}

const LINE = (): Pt[] => [
  [0, 0],
  [1, 1],
];

export function defaults(): Stack {
  return {
    v: 1,
    adj: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temp: 0, tint: 0, vibrance: 0, saturation: 0, clarity: 0, dehaze: 0, sharpen: 0, vignette: 0, grain: 0, fade: 0 },
    curve: { rgb: LINE(), r: LINE(), g: LINE(), b: LINE() },
    hsl: { h: Array(8).fill(0), s: Array(8).fill(0), l: Array(8).fill(0) },
    grade: { sh: { h: 220, s: 0 }, mid: { h: 40, s: 0 }, hi: { h: 45, s: 0 }, bal: 0 },
    bw: false,
    look: null,
    geo: { rot: 0, flip: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: "free", auto: true },
    masks: [],
    heal: [],
  };
}

/** Saved JSON from any version, merged over today's defaults. */
export function normalize(raw: unknown): Stack {
  const d = defaults();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<Stack>;
  return {
    v: 1,
    adj: { ...d.adj, ...(r.adj ?? {}) },
    curve: { ...d.curve, ...(r.curve ?? {}) },
    hsl: { ...d.hsl, ...(r.hsl ?? {}) },
    grade: { ...d.grade, ...(r.grade ?? {}) },
    bw: !!r.bw,
    look: r.look ?? null,
    geo: { ...d.geo, ...(r.geo ?? {}), crop: { ...d.geo.crop, ...(r.geo?.crop ?? {}) } },
    masks: Array.isArray(r.masks) ? r.masks.slice(0, MAX_MASKS) : [],
    heal: Array.isArray(r.heal) ? r.heal.slice(0, MAX_SPOTS) : [],
  };
}

export const clone = (s: Stack): Stack => structuredClone(s);
export const same = (a: Stack, b: Stack) => JSON.stringify(a) === JSON.stringify(b);

const flat = (p: Pt[]) => p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1;
export const curveIsFlat = (c: Curves) => flat(c.rgb) && flat(c.r) && flat(c.g) && flat(c.b);
export const geoIsIdentity = (g: Geo) => g.rot === 0 && !g.flip && g.angle === 0 && g.crop.x === 0 && g.crop.y === 0 && g.crop.w === 1 && g.crop.h === 1;

/** A short list of what changed, for the editor's header ("Exposure, Crop, 2 masks"). */
export function summary(s: Stack): string[] {
  const out: string[] = [];
  const d = defaults();
  for (const sp of [...LIGHT, ...COLOR, ...EFFECTS]) if (s.adj[sp.key] !== d.adj[sp.key]) out.push(sp.label);
  if (s.look) out.push("Look");
  if (s.bw) out.push("Black & white");
  if (!curveIsFlat(s.curve)) out.push("Curves");
  if ([...s.hsl.h, ...s.hsl.s, ...s.hsl.l].some((v) => v !== 0)) out.push("Color mixer");
  if (s.grade.sh.s || s.grade.mid.s || s.grade.hi.s) out.push("Grading");
  if (!geoIsIdentity(s.geo)) out.push("Crop");
  if (s.masks.length) out.push(s.masks.length === 1 ? "1 mask" : `${s.masks.length} masks`);
  if (s.heal.length) out.push(s.heal.length === 1 ? "1 fix" : `${s.heal.length} fixes`);
  return out;
}

export const isIdentity = (s: Stack) => summary(s).length === 0;

let seq = 0;
export const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;
