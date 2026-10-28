// Built-in looks. A look is a set of offsets layered under your own sliders, blended by its amount,
// so choosing one never overwrites what you've dialed in.
import type { AdjKey, Grade, Pt } from "./stack";

export interface Look {
  id: string;
  name: string;
  adj?: Partial<Record<AdjKey, number>>;
  /** Color mixer offsets, per band: [hue, saturation, luminance]. */
  hsl?: Partial<Record<number, [number, number, number]>>;
  grade?: Partial<Pick<Grade, "sh" | "mid" | "hi">>;
  curve?: Pt[];
  mono?: number;
}

export const LOOKS: Look[] = [
  { id: "vivid", name: "Vivid", adj: { contrast: 16, vibrance: 32, saturation: 6, clarity: 8 } },
  { id: "luminous", name: "Luminous", adj: { exposure: 0.25, shadows: 32, highlights: -28, vibrance: 12, clarity: -6, contrast: -6 } },
  {
    id: "golden",
    name: "Golden hour",
    adj: { temp: 26, tint: 5, vibrance: 12, highlights: -12 },
    grade: { hi: { h: 48, s: 26 }, sh: { h: 24, s: 12 } },
  },
  {
    id: "teal",
    name: "Teal & orange",
    adj: { contrast: 12, vibrance: 10 },
    grade: { sh: { h: 205, s: 38 }, hi: { h: 40, s: 30 } },
    hsl: { 1: [0, 12, 4], 4: [-6, 10, 0], 5: [-10, -8, -6] },
  },
  {
    id: "cinema",
    name: "Cinema",
    adj: { contrast: 18, highlights: -30, shadows: 8, saturation: -10, vignette: -18, fade: 6 },
    grade: { sh: { h: 200, s: 22 }, hi: { h: 38, s: 16 } },
    curve: [
      [0, 0.04],
      [0.25, 0.2],
      [0.75, 0.8],
      [1, 0.96],
    ],
  },
  { id: "moody", name: "Moody", adj: { exposure: -0.3, contrast: 14, highlights: -36, saturation: -22, vibrance: 6, temp: -6, vignette: -32, clarity: 12 } },
  {
    id: "neon",
    name: "Neon nights",
    adj: { tint: 16, vibrance: 40, contrast: 14, clarity: 10, highlights: -10 },
    grade: { sh: { h: 265, s: 36 }, hi: { h: 320, s: 24 } },
  },
  {
    id: "chrome",
    name: "Chrome",
    adj: { contrast: 24, saturation: 10, clarity: 6 },
    hsl: { 0: [0, 14, -4], 5: [0, 12, -8], 3: [-8, -6, 0] },
    curve: [
      [0, 0],
      [0.25, 0.2],
      [0.75, 0.82],
      [1, 1],
    ],
  },
  { id: "lush", name: "Lush", adj: { vibrance: 44, saturation: 8, contrast: 10 }, hsl: { 3: [0, 20, 0], 5: [0, 14, -6], 2: [-6, 10, 0] } },
  { id: "nordic", name: "Nordic", adj: { temp: -22, saturation: -14, highlights: -14, shadows: 14, fade: 10 }, grade: { sh: { h: 215, s: 14 } } },
  {
    id: "matte",
    name: "Matte",
    adj: { contrast: -12, saturation: -10, fade: 30 },
    curve: [
      [0, 0.08],
      [0.5, 0.5],
      [1, 0.94],
    ],
  },
  {
    id: "film",
    name: "Faded film",
    adj: { temp: 8, saturation: -16, grain: 28, fade: 22, contrast: -6 },
    grade: { sh: { h: 220, s: 16 }, hi: { h: 52, s: 14 } },
  },
  { id: "noir", name: "Noir", mono: 1, adj: { contrast: 36, clarity: 22, vignette: -26, grain: 18 }, hsl: { 0: [0, 0, -18], 5: [0, 0, -24] } },
  { id: "silver", name: "Silver", mono: 1, adj: { contrast: -8, highlights: -20, shadows: 18, fade: 18 } },
];

export const lookById = (id: string | undefined | null) => LOOKS.find((l) => l.id === id) ?? null;
