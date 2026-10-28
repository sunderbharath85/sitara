// WebGL2 renderer for the edit stack. One context per editor session: the source lives on the GPU at full
// resolution (mipmapped), and every change re-runs only the passes it touches.
import { buildLut, LUT_N } from "./curve";
import { glMat, mul, type Mat } from "./geometry";
import { lookById } from "./looks";
import { BLUR, DAB, DAB_VERT, DEVELOP, HEAL, PREP, VERT } from "./shaders";
import { curveIsFlat, MAX_MASKS, MAX_SPOTS, type Stack, type Stroke } from "./stack";

/** Decoded source pixels, upright. `small` is a CPU copy (encoded RGB, 0..1) for heal search and auto tone. */
export interface Source {
  w: number;
  h: number;
  enc: 0 | 1;
  pixels: ImageBitmap | { fmt: 0 | 1; data: ArrayBufferView };
  small: Small;
}
export interface Small {
  w: number;
  h: number;
  px: Float32Array; // rgb
}

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}
interface Prog {
  p: WebGLProgram;
  u: Map<string, WebGLUniformLocation | null>;
}

export interface DrawOpts {
  split?: number; // fragment x left of this shows the original
  before?: boolean;
  clip?: boolean;
  showMask?: number;
  sharpStep?: number;
}

const BLUR_LONG = 320;
const ATLAS_LONG = 1024;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly maxTex: number;
  W = 0;
  H = 0;
  enc: 0 | 1 = 0;
  private progs: Record<"heal" | "prep" | "blur" | "dab" | "dev", Prog>;
  private vao: WebGLVertexArrayObject;
  private dabVao: WebGLVertexArrayObject;
  private dabBuf: WebGLBuffer;
  private src: WebGLTexture | null = null;
  private healed: RT | null = null;
  private blurA: RT | null = null;
  private blurB: RT | null = null;
  private atlas: [RT, RT] | null = null;
  private dummy: WebGLTexture;
  private lut: WebGLTexture;
  private healKey = "";
  private maskKey = "";
  private blurOk = false;
  private lutOn = false;
  private lutKey = "";
  private U = {
    g: new Float32Array(20),
    hh: new Float32Array(8),
    hs: new Float32Array(8),
    hl: new Float32Array(8),
    grade: new Float32Array(8),
    mn: 0,
    mk: new Float32Array(32),
    ma: new Float32Array(32),
    mb: new Float32Array(32),
    l0: new Float32Array(32),
    l1: new Float32Array(32),
    l2: new Float32Array(32),
    knee: 1,
  };

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("This system's graphics don't support WebGL2, which the editor needs.");
    this.gl = gl;
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, 16384);
    this.progs = {
      heal: this.prog(VERT, HEAL),
      prep: this.prog(VERT, PREP),
      blur: this.prog(VERT, BLUR),
      dab: this.prog(DAB_VERT, DAB),
      dev: this.prog(VERT, DEVELOP),
    };
    this.vao = gl.createVertexArray()!;
    this.dabVao = gl.createVertexArray()!;
    this.dabBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.dummy = this.tex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.lut = this.tex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_N, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(LUT_N * 4));
  }

  // ---------- setup ----------

  private prog(vs: string, fs: string): Prog {
    const gl = this.gl;
    const sh = (type: number, code: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, code);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
    return { p, u: new Map() };
  }

  private loc(pr: Prog, name: string) {
    if (!pr.u.has(name)) pr.u.set(name, this.gl.getUniformLocation(pr.p, name));
    return pr.u.get(name)!;
  }

  private tex(mip = false): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private rt(w: number, h: number, fmt: number = this.gl.RGBA8, mip = false): RT {
    const gl = this.gl;
    const tex = this.tex(mip);
    gl.texStorage2D(gl.TEXTURE_2D, mip ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1, fmt, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  private drop(r: RT | null) {
    if (!r) return;
    this.gl.deleteTexture(r.tex);
    this.gl.deleteFramebuffer(r.fbo);
  }

  /** Upload the source. Everything derived from it is rebuilt on the next `setStack`. */
  load(s: Source) {
    const gl = this.gl;
    if (this.src) gl.deleteTexture(this.src);
    [this.healed, this.blurA, this.blurB].forEach((r) => this.drop(r));
    this.atlas?.forEach((r) => this.drop(r));
    this.healed = this.atlas = null;
    this.W = s.w;
    this.H = s.h;
    this.enc = s.enc;
    this.src = this.tex(true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (s.pixels instanceof ImageBitmap) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, s.pixels);
    else if (s.pixels.fmt === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, s.w, s.h, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, s.pixels.data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, s.w, s.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, s.pixels.data);
    gl.generateMipmap(gl.TEXTURE_2D);
    const sc = BLUR_LONG / Math.max(s.w, s.h);
    const bw = Math.max(8, Math.round(s.w * sc)),
      bh = Math.max(8, Math.round(s.h * sc));
    this.blurA = this.rt(bw, bh);
    this.blurB = this.rt(bw, bh);
    this.healKey = this.maskKey = this.lutKey = "";
    this.blurOk = false;
  }

  get asp(): [number, number] {
    const m = Math.max(this.W, this.H) || 1;
    return [this.W / m, this.H / m];
  }

  // ---------- stack → GPU ----------

  setStack(s: Stack) {
    if (!this.src) return;
    this.uniforms(s);
    this.heal(s);
    if (!this.blurOk) this.blur();
    this.masks(s);
  }

  private uniforms(s: Stack) {
    const U = this.U;
    const look = s.look ? lookById(s.look.id) : null;
    const amt = look && s.look ? s.look.amt / 100 : 0;
    const A = (k: keyof Stack["adj"]) => s.adj[k] + (look?.adj?.[k] ?? 0) * amt;
    const raw = this.enc === 1;
    const g = U.g;
    g[0] = A("exposure");
    g[1] = A("contrast") / 100 + (raw ? 0.12 : 0);
    g[2] = A("highlights") / 100;
    g[3] = A("shadows") / 100;
    g[4] = A("whites") / 100;
    g[5] = A("blacks") / 100;
    g[6] = A("temp") / 100;
    g[7] = A("tint") / 100;
    g[8] = A("vibrance") / 100;
    g[9] = A("saturation") / 100;
    g[10] = A("clarity") / 100;
    g[11] = A("dehaze") / 100;
    g[12] = A("sharpen") / 100;
    g[13] = A("vignette") / 100;
    g[14] = A("grain") / 100;
    g[15] = A("fade") / 100;
    g[16] = Math.min(1, Math.max(s.bw ? 1 : 0, (look?.mono ?? 0) * amt));
    for (let i = 0; i < 8; i++) {
      const lh = look?.hsl?.[i];
      U.hh[i] = (s.hsl.h[i] + (lh?.[0] ?? 0) * amt) / 100;
      U.hs[i] = (s.hsl.s[i] + (lh?.[1] ?? 0) * amt) / 100;
      U.hl[i] = (s.hsl.l[i] + (lh?.[2] ?? 0) * amt) / 100;
    }
    const ab = (k: "sh" | "mid" | "hi"): [number, number] => {
      let x = 0,
        y = 0;
      for (const [w, f] of [
        [s.grade[k], 1],
        [look?.grade?.[k], amt],
      ] as const) {
        if (!w || !f) continue;
        const r = (w.h * Math.PI) / 180;
        x += Math.cos(r) * (w.s / 100) * 0.07 * f;
        y += Math.sin(r) * (w.s / 100) * 0.07 * f;
      }
      return [x, y];
    };
    U.grade.set([...ab("sh"), ...ab("mid"), ...ab("hi"), s.grade.bal / 100, 0]);
    U.knee = raw ? 0.8 : g[0] > 0 ? 1 - Math.min(0.3, g[0] * 0.12) : 1;

    const lk = look?.curve && amt ? look.curve : null;
    this.lutOn = !curveIsFlat(s.curve) || !!lk;
    const key = this.lutOn ? JSON.stringify([s.curve, lk, amt]) : "";
    if (this.lutOn && key !== this.lutKey) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.lut);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_N, 1, gl.RGBA, gl.FLOAT, buildLut(s.curve, lk, amt));
    }
    this.lutKey = key;

    U.mn = Math.min(s.masks.length, MAX_MASKS);
    for (let i = 0; i < U.mn; i++) {
      const m = s.masks[i];
      const o = i * 4;
      U.mk.set([m.kind === "linear" ? 0 : m.kind === "radial" ? 1 : 2, m.invert ? 1 : 0, m.amount / 100, i], o);
      if (m.kind === "linear") U.ma.set([m.a[0], m.a[1], m.b[0], m.b[1]], o);
      else if (m.kind === "radial") {
        U.ma.set([m.c[0], m.c[1], m.r[0], m.r[1]], o);
        U.mb.set([m.angle, m.feather / 100, 0, 0], o);
      }
      const a = m.adj;
      U.l0.set([a.exposure ?? 0, (a.contrast ?? 0) / 100, (a.highlights ?? 0) / 100, (a.shadows ?? 0) / 100], o);
      U.l1.set([(a.temp ?? 0) / 100, (a.tint ?? 0) / 100, (a.saturation ?? 0) / 100, (a.clarity ?? 0) / 100], o);
      U.l2.set([(a.dehaze ?? 0) / 100, (a.sharpen ?? 0) / 100, 0, 0], o);
    }
  }

  private heal(s: Stack) {
    const spots = s.heal.slice(0, MAX_SPOTS);
    const key = JSON.stringify(spots);
    if (key === this.healKey) return;
    this.healKey = key;
    this.blurOk = false;
    const gl = this.gl;
    if (!spots.length) {
      this.drop(this.healed);
      this.healed = null;
      return;
    }
    if (!this.healed) this.healed = this.rt(this.W, this.H, this.enc === 1 ? gl.RGB10_A2 : gl.RGBA8, true);
    const [ax, ay] = this.asp;
    const A = new Float32Array(MAX_SPOTS * 4),
      B = new Float32Array(MAX_SPOTS * 4),
      C = new Float32Array(MAX_SPOTS * 4);
    spots.forEach((p, i) => {
      A.set([p.x / ax, p.y / ay, p.sx / ax, p.sy / ay], i * 4);
      B.set([p.r, p.feather, p.opacity, 0], i * 4);
      if (p.mode === "heal") C.set([p.off[0], p.off[1], p.off[2], 0], i * 4);
    });
    const pr = this.progs.heal;
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.healed.fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.uniform1i(this.loc(pr, "uImg"), 0);
    gl.uniform2f(this.loc(pr, "uSize"), this.W, this.H);
    gl.uniform2f(this.loc(pr, "uAsp"), ax, ay);
    gl.uniform1i(this.loc(pr, "uN"), spots.length);
    gl.uniform4fv(this.loc(pr, "uA"), A);
    gl.uniform4fv(this.loc(pr, "uB"), B);
    gl.uniform4fv(this.loc(pr, "uC"), C);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, this.healed.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private blur() {
    const gl = this.gl;
    const a = this.blurA!,
      b = this.blurB!;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    let pr = this.progs.prep;
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo);
    gl.viewport(0, 0, a.w, a.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.healed?.tex ?? this.src);
    gl.uniform1i(this.loc(pr, "uImg"), 0);
    gl.uniform1i(this.loc(pr, "uEnc"), this.enc);
    gl.uniform2f(this.loc(pr, "uSize"), a.w, a.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    pr = this.progs.blur;
    gl.useProgram(pr.p);
    gl.uniform1i(this.loc(pr, "uImg"), 0);
    gl.uniform2f(this.loc(pr, "uSize"), a.w, a.h);
    for (const [from, to, dir] of [
      [a, b, [1, 0]],
      [b, a, [0, 1]],
    ] as const) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
      gl.bindTexture(gl.TEXTURE_2D, from.tex);
      gl.uniform2f(this.loc(pr, "uDir"), dir[0], dir[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.blurOk = true;
  }

  private masks(s: Stack) {
    const brushes = s.masks.slice(0, MAX_MASKS).map((m, i) => [m, i] as const).filter(([m]) => m.kind === "brush");
    let key = "";
    for (const [m, i] of brushes) {
      if (m.kind !== "brush") continue;
      let sum = 0;
      for (const st of m.strokes) {
        sum += st.r * 7 + st.feather * 3 + st.flow * 5 + (st.erase ? 11 : 0) + st.pts.length;
        for (let k = 0; k < st.pts.length; k++) sum += st.pts[k] * (k % 7 + 1);
      }
      key += `${i}:${m.strokes.length}:${sum.toFixed(6)};`;
    }
    if (key === this.maskKey) return;
    this.maskKey = key;
    if (!brushes.length) return;
    const gl = this.gl;
    const [ax, ay] = this.asp;
    if (!this.atlas) {
      const w = Math.max(8, Math.round(ax * ATLAS_LONG)),
        h = Math.max(8, Math.round(ay * ATLAS_LONG));
      this.atlas = [this.rt(w, h, gl.RGBA8, true), this.rt(w, h, gl.RGBA8, true)];
    }
    const pr = this.progs.dab;
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuf);
    gl.enable(gl.BLEND);
    for (let side = 0; side < 2; side++) {
      const at = this.atlas[side];
      gl.bindFramebuffer(gl.FRAMEBUFFER, at.fbo);
      gl.viewport(0, 0, at.w, at.h);
      gl.colorMask(true, true, true, true);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (const [m, i] of brushes) {
        if (m.kind !== "brush" || (i < 4 ? 0 : 1) !== side) continue;
        const ch = i & 3;
        gl.colorMask(ch === 0, ch === 1, ch === 2, ch === 3);
        for (const st of m.strokes) {
          const d = dabs(st, ax, ay);
          if (!d.length) continue;
          if (st.erase) {
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_COLOR);
          } else {
            gl.blendEquation(gl.MAX);
            gl.blendFunc(gl.ONE, gl.ONE);
          }
          gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, d.length / 6);
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, at.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    gl.colorMask(true, true, true, true);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---------- drawing ----------

  /** Run the develop pass. `map` takes fragment pixels to source uv, `outMap` to output uv. */
  draw(target: RT | null, w: number, h: number, map: Mat, outMap: Mat, outPx: [number, number], o: DrawOpts = {}) {
    const gl = this.gl;
    if (!this.src) return;
    const pr = this.progs.dev;
    const U = this.U;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(pr.p);
    const texs: [string, WebGLTexture][] = [
      ["uImg", this.healed?.tex ?? this.src],
      ["uOrig", this.src],
      ["uBlur", this.blurA!.tex],
      ["uLut", this.lut],
      ["uMaskA", this.atlas?.[0].tex ?? this.dummy],
      ["uMaskB", this.atlas?.[1].tex ?? this.dummy],
    ];
    texs.forEach(([name, t], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(this.loc(pr, name), i);
    });
    gl.activeTexture(gl.TEXTURE0);
    const L = (n: string) => this.loc(pr, n);
    gl.uniform1i(L("uEnc"), this.enc);
    gl.uniformMatrix3fv(L("uMap"), false, glMat(map));
    gl.uniformMatrix3fv(L("uOutMap"), false, glMat(outMap));
    gl.uniform2f(L("uOutPx"), outPx[0], outPx[1]);
    gl.uniform2f(L("uAsp"), ...this.asp);
    gl.uniform2f(L("uTexel"), 1 / this.W, 1 / this.H);
    gl.uniform1f(L("uSharpStep"), o.sharpStep ?? 1);
    gl.uniform4fv(L("uG"), U.g);
    gl.uniform1fv(L("uHslH"), U.hh);
    gl.uniform1fv(L("uHslS"), U.hs);
    gl.uniform1fv(L("uHslL"), U.hl);
    gl.uniform4fv(L("uGrade"), U.grade);
    gl.uniform1i(L("uMN"), U.mn);
    gl.uniform4fv(L("uMK"), U.mk);
    gl.uniform4fv(L("uMA"), U.ma);
    gl.uniform4fv(L("uMB"), U.mb);
    gl.uniform4fv(L("uML0"), U.l0);
    gl.uniform4fv(L("uML1"), U.l1);
    gl.uniform4fv(L("uML2"), U.l2);
    gl.uniform1f(L("uSplit"), o.split ?? -1);
    gl.uniform1i(L("uMode"), (o.before ? 1 : 0) | (o.clip ? 2 : 0) | (this.lutOn ? 4 : 0));
    gl.uniform1i(L("uShowMask"), o.showMask ?? -1);
    gl.uniform1f(L("uRaw"), this.enc === 1 ? 1 : 0);
    gl.uniform1f(L("uKnee"), U.knee);
    gl.uniform1f(L("uGrainScale"), Math.max(1, Math.max(this.W, this.H) / 2200));
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Render the output at (ow, oh) and read it back top-down as RGBA, in tiles so any size the GPU can address
   * works. `outToSrc` maps output uv to source uv.
   */
  async pixels(ow: number, oh: number, outToSrc: Mat, o: DrawOpts = {}, progress?: (f: number) => void): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const gl = this.gl;
    const tile = Math.min(2048, this.maxTex);
    const rt = this.rt(Math.min(tile, ow), Math.min(tile, oh));
    const out = new Uint8ClampedArray(ow * oh * 4);
    const buf = new Uint8Array(rt.w * rt.h * 4);
    const n = Math.ceil(ow / rt.w) * Math.ceil(oh / rt.h);
    let k = 0;
    for (let ty = 0; ty < oh; ty += rt.h)
      for (let tx = 0; tx < ow; tx += rt.w) {
        const tw = Math.min(rt.w, ow - tx),
          th = Math.min(rt.h, oh - ty);
        const outMap: Mat = [1 / ow, 0, tx / ow, 0, 1 / oh, ty / oh];
        this.draw(rt, tw, th, mul(outToSrc, outMap), outMap, [ow, oh], o);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        for (let y = 0; y < th; y++) out.set(buf.subarray(y * tw * 4, (y + 1) * tw * 4), ((ty + y) * ow + tx) * 4);
        progress?.(++k / n);
        if (n > 1) await new Promise((r) => setTimeout(r, 0));
      }
    this.drop(rt);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Encode the output with the browser's encoder. */
  async encode(ow: number, oh: number, outToSrc: Mat, type: string, quality: number, o: DrawOpts = {}, progress?: (f: number) => void): Promise<Blob> {
    const px = await this.pixels(ow, oh, outToSrc, o, progress);
    const c = document.createElement("canvas");
    c.width = ow;
    c.height = oh;
    c.getContext("2d")!.putImageData(new ImageData(px, ow, oh), 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("The image couldn't be encoded"))), type, quality));
  }

  dispose() {
    const gl = this.gl;
    if (this.src) gl.deleteTexture(this.src);
    [this.healed, this.blurA, this.blurB].forEach((r) => this.drop(r));
    this.atlas?.forEach((r) => this.drop(r));
    this.src = this.healed = this.atlas = null;
    // free the context once the canvas is really gone (a remount reuses it)
    setTimeout(() => {
      if (!this.canvas.isConnected) gl.getExtension("WEBGL_lose_context")?.loseContext();
    }, 0);
  }
}

/** Dabs along a stroke: u, v, radius u, radius v, flow, feather per dab. */
export function dabs(st: Stroke, ax: number, ay: number): Float32Array {
  const out: number[] = [];
  const step = Math.max(st.r * 0.14, 0.0004);
  const push = (x: number, y: number) => out.push(x / ax, y / ay, st.r / ax, st.r / ay, st.flow, st.feather);
  const p = st.pts;
  if (p.length < 2) return new Float32Array(0);
  push(p[0], p[1]);
  let carry = 0;
  for (let i = 2; i + 1 < p.length; i += 2) {
    const x0 = p[i - 2],
      y0 = p[i - 1],
      dx = p[i] - x0,
      dy = p[i + 1] - y0;
    const len = Math.hypot(dx, dy);
    let t = step - carry;
    while (t <= len) {
      push(x0 + (dx * t) / len, y0 + (dy * t) / len);
      t += step;
    }
    carry = len - (t - step);
  }
  return new Float32Array(out);
}
