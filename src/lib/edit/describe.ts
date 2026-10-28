// "Describe an edit": plain words turned into edits, offline. Phrases map to slider changes and to the AI
// tools (faces, sky, background blur, denoise); whatever style is left over, CLIP matches against the looks.
import type { AdjKey, Stack } from "./stack";

export type Need = "blur" | "faces" | "sky" | "denoise";

export interface Plan {
  /** What was understood, in words, for the summary. */
  done: string[];
  apply: (s: Stack) => void;
  needs: Need[];
  /** Words that read like a style ("like an old film") are matched to a look. */
  style: boolean;
  /** For "sky" and "faces": how to adjust inside the mask. */
  sky: Partial<Record<"exposure" | "highlights" | "saturation" | "temp" | "dehaze" | "contrast", number>>;
  face: Partial<Record<"exposure" | "shadows" | "clarity" | "temp", number>>;
}

type Rule = { re: RegExp; label: string; adj?: Partial<Record<AdjKey, number>>; bw?: boolean };

const RULES: Rule[] = [
  { re: /\b(warm(er|th)?|cozy|toasty)\b/, label: "Warmer", adj: { temp: 22 } },
  { re: /\b(cool(er)?|cold(er)?|icy|wintry)\b/, label: "Cooler", adj: { temp: -22 } },
  { re: /\b(golden( hour)?|sunset)\b/, label: "Golden light", adj: { temp: 28, tint: 6, highlights: -12 } },
  { re: /\b(bright(er|en)?|lighter|lighten|airy)\b/, label: "Brighter", adj: { exposure: 0.35, shadows: 12 } },
  { re: /\b(dark(er|en)?|dimmer|deeper)\b/, label: "Darker", adj: { exposure: -0.3 } },
  { re: /\b(more contrast|contrast(y)?|punch(y|ier)?|pop)\b/, label: "More contrast", adj: { contrast: 20, clarity: 8 } },
  { re: /\b(soft(er)?|dreamy|gentle|less contrast|flat(ter)?)\b/, label: "Softer", adj: { contrast: -15, clarity: -12, highlights: -10 } },
  { re: /\b(vivid|vibrant|saturated|colou?rful|lively)\b/, label: "More vivid", adj: { vibrance: 30, saturation: 8 } },
  { re: /\b(muted|desaturat(ed|e)|washed( out)?|pastel|subtle colou?rs?)\b/, label: "Muted colors", adj: { saturation: -25, vibrance: -10 } },
  { re: /\b(black and white|black & white|b&w|b\/w|monochrome|gr[ae]yscale)\b/, label: "Black & white", bw: true, adj: { contrast: 12 } },
  { re: /\b(mood(y|ier)|dramatic|cinematic|brooding|stormy)\b/, label: "Moody", adj: { highlights: -30, shadows: -8, contrast: 16, vignette: -24, saturation: -10 } },
  { re: /\b(vintage|retro|analog(ue)?|70s|80s|90s|faded|nostalgic|old (film|photo|picture)|film look|kodak|polaroid)\b/, label: "Vintage", adj: { fade: 22, grain: 22, temp: 8, saturation: -12 } },
  { re: /\b(sharp(er|en)?|crisp(er)?|more detail)\b/, label: "Sharper", adj: { sharpen: 40, clarity: 12 } },
  { re: /\b(haz(e|y)|fog(gy)?|mist(y)?|clear(er)? up|less haze)\b/, label: "Less haze", adj: { dehaze: 30 } },
  { re: /\b(lift( the)? shadows|open( up)? the shadows|shadow detail)\b/, label: "Open shadows", adj: { shadows: 35 } },
  { re: /\b(recover|tame|blown)\b/, label: "Recover highlights", adj: { highlights: -45, whites: -10 } },
  { re: /\b(summer(y)?|sunny|sunshine|beachy|tropical)\b/, label: "Summery", adj: { temp: 16, vibrance: 22, exposure: 0.15, highlights: -10 } },
  { re: /\b(autumn(al)?|fall colou?rs?|fall)\b/, label: "Autumn tones", adj: { temp: 20, tint: 4, vibrance: 15, saturation: 6 } },
  { re: /\b(winter(y)?|snowy|frosty)\b/, label: "Wintry", adj: { temp: -20, saturation: -10, exposure: 0.1 } },
  { re: /\b(instagram|social|eye-catching|striking)\b/, label: "Punchy", adj: { contrast: 14, vibrance: 22, clarity: 10 } },
  { re: /\bvignette\b/, label: "Vignette", adj: { vignette: -30 } },
  { re: /\b(grain|grainy|film grain)\b/, label: "Grain", adj: { grain: 30 } },
];

const FACE = /\b(face|faces|skin|portrait|her|him|his|their|person|people|subject)\b/;
const SKY = /\b(sky|skies|clouds?)\b/;
const BLUR = /\b(blur|bokeh|portrait mode|shallow depth|defocus|background soft)\b/;
const NOISE = /\b(noise|noisy|denoise|grainless|clean( it)? up|smooth(er)? noise)\b/;
const LESS = /\b(a (little|bit|touch)|slightly|subtly|gently|a tad)\b/;
const MORE = /\b(very|much|lots?|really|super|way|extremely|strongly)\b/;
const STYLE = /\b(like|look|style|vibe|feel|aesthetic|mood|polaroid|kodak|fuji|film|movie|editorial|magazine|instagram|summer|autumn|fall|winter|spring|neon|night|tropical|desert|ocean|noir)\b/;

export function plan(text: string): Plan {
  const t = ` ${text.toLowerCase()} `;
  const k = LESS.test(t) ? 0.5 : MORE.test(t) ? 1.6 : 1;
  // words about the sky or faces adjust only that region, so take them out before the global rules
  const global = t
    .replace(/\b((a bit |slightly |much )?(blue|bluer|darker|deeper|brighter|moodier|dramatic|stormy|clearer|and)\s+)*(sky|skies|clouds?)\b/g, " ")
    .replace(/\b(make |the )?(sky|skies|clouds?)\s+(blue|bluer|darker|deeper|brighter|dramatic|moodier)\b/g, " ")
    .replace(/\b(brighten|lighten|lift|light up|warm( up)?)\s+(her|his|their|the|my|our)?\s*(face|faces|skin)\b/g, " ");
  const hits = RULES.filter((r) => r.re.test(global));
  const done = hits.map((r) => r.label);
  const needs: Need[] = [];
  const sky: Plan["sky"] = {};
  const face: Plan["face"] = {};
  if (SKY.test(t)) {
    needs.push("sky");
    const darker = /\b(dark(er|en)?|deep(er)?|dramatic|moody|stormy)\b/.test(t);
    Object.assign(sky, /\bblue(r)?\b/.test(t) || !darker ? { temp: -18, saturation: 22, highlights: -20 } : {}, darker ? { exposure: -0.35, highlights: -40, contrast: 18, dehaze: 15 } : {});
    done.push(darker ? "Deeper sky" : "Bluer sky");
  }
  if (FACE.test(t) && /\b(bright(er|en)?|light(er|en)?|lift|glow|illuminate|warm(er)?)\b/.test(t)) {
    needs.push("faces");
    Object.assign(face, { exposure: 0.3 * k, shadows: 18 }, /\bwarm/.test(t) ? { temp: 12 } : {});
    done.push("Brighter faces");
  }
  if (BLUR.test(t)) {
    needs.push("blur");
    done.push("Background blur");
  }
  if (NOISE.test(t)) {
    needs.push("denoise");
    done.push("Denoise");
  }
  const used = hits.length + needs.length;
  return {
    done,
    needs,
    sky,
    face,
    style: STYLE.test(t) || used === 0,
    apply: (s) => {
      for (const r of hits) {
        if (r.bw) s.bw = true;
        for (const [key, v] of Object.entries(r.adj ?? {}) as [AdjKey, number][]) {
          const lim = key === "exposure" ? 4 : 100;
          s.adj[key] = Math.max(-lim, Math.min(lim, s.adj[key] + v * k));
        }
      }
    },
  };
}
