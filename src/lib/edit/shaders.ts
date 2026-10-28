// GLSL for the edit pipeline (WebGL2). Passes: heal → blur (local tone base) → brush masks → develop.
// Textures keep the image's first row at v = 0; render targets follow the same convention.

const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;

/** Full-screen triangle, no attributes. */
export const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `
const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
uniform int uEnc; // 0: sRGB 8-bit, 1: RAW linear log code
vec3 s2l(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 l2s(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// keep in sync with raw.rs: ln(1 + 64 * 8)
vec3 dec(vec3 e) { return uEnc == 1 ? (exp(e * 6.2402758) - 1.0) / 64.0 : s2l(e); }
float perc(float y) { return pow(max(y, 0.0), 1.0 / 2.2); }
float lin(float p) { return pow(max(p, 0.0), 2.2); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

/** Spot healing and cloning: copies a source patch onto each spot, color-matched, with a soft edge. */
export const HEAL = `${HEAD}
uniform sampler2D uImg;
uniform vec2 uSize;
uniform vec2 uAsp;
uniform int uN;
uniform vec4 uA[48]; // dst.xy, src.xy in uv
uniform vec4 uB[48]; // radius (p-space), feather, opacity
uniform vec4 uC[48]; // color offset (encoded)
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec4 c = texture(uImg, uv);
  for (int i = 0; i < 48; i++) {
    if (i >= uN) break;
    float r = uB[i].x;
    float d = length((uv - uA[i].xy) * uAsp);
    if (d < r) {
      float a = 1.0 - smoothstep(r * (1.0 - max(uB[i].y, 0.02)), r, d);
      vec4 s = texture(uImg, uv + uA[i].zw - uA[i].xy);
      s.rgb = clamp(s.rgb + uC[i].rgb, 0.0, 1.0);
      c = mix(c, s, a * uB[i].z);
    }
  }
  o = c;
}`;

/** Small luminance + dark-channel image, the base for clarity, shadows/highlights and dehaze. */
export const PREP = `${HEAD}${COMMON}
uniform sampler2D uImg;
uniform vec2 uSize;
out vec4 o;
void main() {
  vec3 c = dec(texture(uImg, gl_FragCoord.xy / uSize).rgb);
  o = vec4(perc(dot(c, LW)), perc(min(c.r, min(c.g, c.b))), 0.0, 1.0);
}`;

export const BLUR = `${HEAD}
uniform sampler2D uImg;
uniform vec2 uSize;
uniform vec2 uDir;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = -14; i <= 14; i++) {
    float w = exp(-float(i * i) / 50.0);
    acc += texture(uImg, uv + uDir * float(i) / uSize) * w;
    ws += w;
  }
  o = acc / ws;
}`;

/** Brush dabs, instanced quads into a mask atlas (one mask per color channel). */
export const DAB_VERT = `#version 300 es
layout(location = 0) in vec4 aD; // u, v, radius u, radius v
layout(location = 1) in vec2 aF; // flow, feather
out vec2 vL;
out vec2 vF;
void main() {
  vec2 k = vec2((gl_VertexID & 1) == 0 ? -1.0 : 1.0, (gl_VertexID & 2) == 0 ? -1.0 : 1.0);
  vL = k;
  vF = aF;
  gl_Position = vec4((aD.xy + k * aD.zw) * 2.0 - 1.0, 0.0, 1.0);
}`;
export const DAB = `${HEAD}
in vec2 vL;
in vec2 vF;
out vec4 o;
void main() {
  float a = vF.x * (1.0 - smoothstep(1.0 - max(vF.y, 0.02), 1.0, length(vL)));
  o = vec4(a);
}`;

/** The develop pass: every adjustment, per pixel, in one shader. */
export const DEVELOP = `${HEAD}${COMMON}
uniform sampler2D uImg;   // healed source
uniform sampler2D uOrig;  // untouched source, for "before"
uniform sampler2D uBlur;
uniform sampler2D uLut;
uniform sampler2D uMaskA;
uniform sampler2D uMaskB;
uniform mat3 uMap;        // fragment px -> source uv
uniform mat3 uOutMap;     // fragment px -> output uv
uniform vec2 uOutPx;
uniform vec2 uAsp;
uniform vec2 uTexel;
uniform float uSharpStep;
uniform vec4 uG[5];
uniform float uHslH[8];
uniform float uHslS[8];
uniform float uHslL[8];
uniform vec4 uGrade[2];   // shadows ab, midtones ab | highlights ab, balance
uniform int uMN;
uniform vec4 uMK[8];      // kind, invert, amount, channel
uniform vec4 uMA[8];
uniform vec4 uMB[8];
uniform vec4 uML0[8];
uniform vec4 uML1[8];
uniform vec4 uML2[8];
uniform float uSplit;
uniform int uMode;        // 1: before, 2: clipping warning, 4: curves on
uniform int uShowMask;
uniform float uRaw;
uniform float uKnee;
uniform float uGrainScale;
out vec4 o;

const float HC[9] = float[9](29.0, 60.0, 110.0, 142.0, 195.0, 264.0, 296.0, 328.0, 389.0);

float cbrt(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }
vec3 toOk(vec3 c) {
  float l = cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  float m = cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  float s = cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 fromOk(vec3 k) {
  float l = k.x + 0.3963377774 * k.y + 0.2158037573 * k.z;
  float m = k.x - 0.1055613458 * k.y - 0.0638541728 * k.z;
  float s = k.x - 0.0894841775 * k.y - 1.2914855480 * k.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
             -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
             -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float contrastCurve(float x, float k) {
  if (abs(k) < 1e-4) return x;
  float p = 0.46;
  float e = k >= 0.0 ? 1.0 + k * 1.1 : 1.0 / (1.0 - k * 0.75);
  float xc = clamp(x, 0.0, 1.0);
  float y = xc < p ? p * pow(xc / p, e) : 1.0 - (1.0 - p) * pow((1.0 - xc) / (1.0 - p), e);
  return y + (x - xc);
}
float maskW(int i, vec2 p, vec2 uv, vec2 dx, vec2 dy) {
  vec4 k = uMK[i];
  float m;
  if (k.x < 0.5) {
    vec2 a = uMA[i].xy, ab = uMA[i].zw - a;
    m = 1.0 - smoothstep(0.0, 1.0, dot(p - a, ab) / max(dot(ab, ab), 1e-8));
  } else if (k.x < 1.5) {
    vec2 d = p - uMA[i].xy;
    float cs = cos(uMB[i].x), sn = sin(uMB[i].x);
    d = vec2(cs * d.x + sn * d.y, -sn * d.x + cs * d.y) / max(uMA[i].zw, vec2(1e-5));
    m = 1.0 - smoothstep(1.0 - max(uMB[i].y, 0.01), 1.0, length(d));
  } else {
    int ch = int(k.w + 0.5);
    vec4 s = ch < 4 ? textureGrad(uMaskA, uv, dx, dy) : textureGrad(uMaskB, uv, dx, dy);
    m = s[ch & 3];
  }
  if (k.y > 0.5) m = 1.0 - m;
  return m * k.z;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = (uMap * vec3(fc, 1.0)).xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(0.0); return; }
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  bool before = (uMode & 1) != 0 || fc.x < uSplit;
  vec4 src = before ? textureGrad(uOrig, uv, dx, dy) : textureGrad(uImg, uv, dx, dy);
  vec3 c = dec(src.rgb);
  vec2 p = uv * uAsp;

  if (before) {
    if (uRaw > 0.5) {
      float Y = dot(c, LW), L = perc(Y);
      float L2 = L > 0.8 ? 0.8 + 0.2 * tanh((L - 0.8) / 0.2) : L;
      c = Y > 1e-6 ? c * lin(L2) / Y : c;
    }
    o = vec4(clamp(l2s(c) + (hash(fc) - 0.5) / 255.0, 0.0, 1.0), src.a);
    return;
  }

  // local adjustments add to the global ones, weighted by each mask
  vec4 l0 = vec4(0.0), l1 = vec4(0.0), l2 = vec4(0.0);
  float shown = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uMN) break;
    float w = maskW(i, p, uv, dx, dy);
    l0 += w * uML0[i];
    l1 += w * uML1[i];
    l2 += w * uML2[i];
    if (i == uShowMask) shown = w;
  }
  vec4 g0 = uG[0] + l0;                                  // exposure, contrast, highlights, shadows
  vec4 g1 = uG[1] + vec4(0.0, 0.0, l1.x, l1.y);          // whites, blacks, temperature, tint
  vec4 g2 = uG[2] + vec4(0.0, l1.z, l1.w, l2.x);         // vibrance, saturation, clarity, dehaze
  vec4 g3 = uG[3] + vec4(l2.y, 0.0, 0.0, 0.0);           // sharpen, vignette, grain, fade
  vec4 g4 = uG[4];                                       // mono

  // white balance, normalized to keep brightness
  vec3 wb = vec3(exp2(g1.z * 0.5), 1.0, exp2(-g1.z * 0.5)) * vec3(exp2(g1.w * 0.15), exp2(-g1.w * 0.3), exp2(g1.w * 0.15));
  c *= wb / dot(wb, LW);

  float gain = exp2(g0.x);
  float pg = pow(gain, 1.0 / 2.2);
  c *= gain;

  vec4 bl = textureLod(uBlur, uv, 0.0);
  float Lblur = bl.r * pg;

  // dehaze: remove (or add) a veil proportional to the local dark channel
  if (g2.w > 0.0) {
    float veil = clamp(lin(bl.g) * gain * g2.w * 0.95, 0.0, 0.9);
    c = max(c - veil, 0.0) / (1.0 - veil);
  } else if (g2.w < 0.0) {
    c = mix(c, vec3(dot(c, LW) * 0.55 + 0.4), -g2.w * 0.45);
  }

  // tone, on perceptual luminance
  float Y = max(dot(c, LW), 0.0);
  float L = perc(Y);
  float base = mix(L, Lblur, 0.5);
  L += g2.z * 0.6 * (L - Lblur) * clamp(4.0 * L * (1.0 - L), 0.0, 1.0);
  if (g3.x > 0.001) {
    vec2 st = uTexel * uSharpStep;
    float n = perc(dot(dec(texture(uImg, uv + vec2(st.x, 0.0)).rgb), LW)) + perc(dot(dec(texture(uImg, uv - vec2(st.x, 0.0)).rgb), LW))
            + perc(dot(dec(texture(uImg, uv + vec2(0.0, st.y)).rgb), LW)) + perc(dot(dec(texture(uImg, uv - vec2(0.0, st.y)).rgb), LW));
    float lap = perc(dot(dec(src.rgb), LW)) - n * 0.25;
    lap *= smoothstep(0.002, 0.01, abs(lap));
    L += g3.x * 1.8 * lap * pg;
  }
  // shadows and highlights scale luminance (rather than add to it) so texture survives
  float ws = 1.0 - smoothstep(0.06, 0.62, base);
  float wh = smoothstep(0.4, 1.0, base);
  L *= g0.w >= 0.0 ? 1.0 + g0.w * 2.1 * ws : 1.0 / (1.0 - g0.w * 1.2 * ws);
  L = g0.z < 0.0 ? L * (1.0 + g0.z * 0.5 * wh) : L + g0.z * 0.3 * wh * (1.0 - min(L, 1.0));
  L += g1.x * 0.22 * smoothstep(0.45, 1.0, L);
  L += g1.y * 0.12 * (1.0 - smoothstep(0.0, 0.4, L));
  L = contrastCurve(max(L, 0.0), g0.y);
  if (L > uKnee) L = uKnee + (1.0 - uKnee) * tanh((L - uKnee) / max(1.0 - uKnee, 1e-3));
  float Y2 = lin(L);
  c = Y > 1e-6 ? c * (Y2 / Y) : vec3(Y2);

  // color, in OKLab
  vec3 k = toOk(max(c, 0.0));
  float C = length(k.yz);
  float h = atan(k.z, k.y);
  float hd = degrees(h);
  if (hd < 0.0) hd += 360.0;
  float cw = smoothstep(0.004, 0.06, C);
  float hh = hd < HC[0] ? hd + 360.0 : hd;
  int bi = 0;
  for (int i = 0; i < 8; i++) if (hh >= HC[i]) bi = i;
  float t = smoothstep(0.0, 1.0, (hh - HC[bi]) / (HC[bi + 1] - HC[bi]));
  int bj = (bi + 1) % 8;
  float hs = mix(uHslH[bi], uHslH[bj], t), ss = mix(uHslS[bi], uHslS[bj], t), ls = mix(uHslL[bi], uHslL[bj], t);
  h += radians(hs * 30.0) * cw;
  float skin = 1.0 - 0.6 * (1.0 - smoothstep(0.0, 28.0, abs(hd - 62.0)));
  float vib = g2.x > 0.0 ? 1.0 + g2.x * 1.2 * (1.0 - smoothstep(0.02, 0.22, C)) * skin : 1.0 + g2.x * 0.85;
  C *= max(0.0, (1.0 + g2.y) * vib * (1.0 + ss * cw));
  k.x += ls * 0.22 * cw * (0.5 + 2.0 * C);
  C *= 1.0 - g4.x;
  float bal = uGrade[1].z;
  float wsh = 1.0 - smoothstep(0.0, 0.55 + bal * 0.25, k.x);
  float whi = smoothstep(0.42 + bal * 0.25, 1.0, k.x);
  float wmid = max(0.0, 1.0 - wsh - whi);
  k.yz = vec2(cos(h), sin(h)) * C + uGrade[0].xy * wsh + uGrade[0].zw * wmid + uGrade[1].xy * whi;
  c = fromOk(k);

  // back into gamut, keeping luminance
  float Yc = dot(c, LW);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  if (mx > 1.0) c = Yc >= 1.0 ? vec3(1.0) : Yc + (c - Yc) * (1.0 - Yc) / (mx - Yc);
  if (mn < 0.0) c = Yc <= 0.0 ? vec3(0.0) : Yc + (c - Yc) * Yc / (Yc - mn);

  // vignette, relative to the crop
  if (abs(g3.y) > 1e-4) {
    vec2 q = ((uOutMap * vec3(fc, 1.0)).xy - 0.5) * 2.0;
    q.x *= mix(1.0, uOutPx.x / uOutPx.y, 0.5);
    q.y *= mix(1.0, uOutPx.y / uOutPx.x, 0.5);
    float vw = pow(smoothstep(0.3, 1.45, length(q)), 1.3);
    c *= max(0.0, 1.0 + g3.y * vw * 0.95);
  }

  vec3 g = l2s(c);
  if ((uMode & 4) != 0) {
    vec3 tc = g * (1023.0 / 1024.0) + 0.5 / 1024.0;
    g = vec3(texture(uLut, vec2(tc.r, 0.5)).r, texture(uLut, vec2(tc.g, 0.5)).g, texture(uLut, vec2(tc.b, 0.5)).b);
  }
  g = g * (1.0 - g3.w * 0.16) + g3.w * 0.13;
  if (g3.z > 0.0) {
    vec2 gp = uv / uTexel / uGrainScale;
    float n = vnoise(gp) + 0.5 * vnoise(gp * 2.07 + 17.3) - 0.75;
    g += n * g3.z * 0.17 * (1.0 - abs(dot(g, LW) - 0.5) * 1.1);
  }
  g = clamp(g + (hash(fc) - 0.5) / 255.0, 0.0, 1.0);
  if ((uMode & 2) != 0) {
    if (max(g.r, max(g.g, g.b)) >= 0.996) g = vec3(1.0, 0.16, 0.1);
    else if (max(g.r, max(g.g, g.b)) <= 0.004) g = vec3(0.1, 0.35, 1.0);
  }
  if (uShowMask >= 0) g = mix(g, vec3(1.0, 0.36, 0.2), shown * 0.62);
  o = vec4(g, src.a);
}`;
