// Sitara's photo editor: non-destructive, GPU-rendered. The edit stack is data (lib/edit/stack.ts); the
// renderer turns it into pixels; saving stores the stack plus a thumbnail and preview of the result.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { drawHist } from "../../lib/analyze";
import { api, detailCached, forgetDetail, thumbUrl, type Lib, type MediaDetail } from "../../lib/api";
import { basename, fmtSize } from "../../lib/format";
import { mul, outSize, outToSrc, refit, type Mat } from "../../lib/edit/geometry";
import { autoSource, autoTone, colorOffset } from "../../lib/edit/heal";
import { LOOKS } from "../../lib/edit/looks";
import { Renderer } from "../../lib/edit/renderer";
import { loadSource } from "../../lib/edit/source";
import { clone, defaults, isIdentity, MAX_MASKS, MAX_SPOTS, newId, normalize, summary, type Geo, type Mask, type Pt, type Stack } from "../../lib/edit/stack";
import { clampPan, layout, type View } from "../../lib/edit/view";
import { store, useStore } from "../../lib/store";
import { Icon } from "../Icon";
import { toast } from "../Toasts";
import { CropOverlay, HealOverlay, MaskOverlay } from "./overlays";
import { AdjustPanel, ColorPanel, CropPanel, CurvesPanel, HealPanel, LooksPanel, MasksPanel, type HealOpts } from "./panels";

type Tool = "looks" | "adjust" | "color" | "curves" | "crop" | "masks" | "heal";
const TOOLS: { k: Tool; label: string; icon: string; hint: string }[] = [
  { k: "looks", label: "Looks", icon: "spark", hint: "1" },
  { k: "adjust", label: "Adjust", icon: "sliders", hint: "2" },
  { k: "color", label: "Color", icon: "drop", hint: "3" },
  { k: "curves", label: "Curves", icon: "curve", hint: "4" },
  { k: "crop", label: "Crop", icon: "crop", hint: "R" },
  { k: "masks", label: "Masks", icon: "mask", hint: "M" },
  { k: "heal", label: "Heal", icon: "heal", hint: "H" },
];
const TITLES: Record<Tool, [string, string]> = {
  looks: ["Looks", "one-tap styles, layered under your sliders"],
  adjust: ["Adjust", "light · color · effects"],
  color: ["Color", "mixer · grading · black & white"],
  curves: ["Curves", "tone, per channel"],
  crop: ["Crop", "frame · straighten · rotate"],
  masks: ["Masks", "local adjustments"],
  heal: ["Heal", "remove spots and specks"],
};

/** Copied settings (Ctrl Shift C), shared between editor sessions. */
let copied: Pick<Stack, "adj" | "curve" | "hsl" | "grade" | "bw" | "look"> | null = null;

export function Editor() {
  const ed = useStore((s) => s.editor);
  const lib = useStore((s) => s.lib);
  if (!ed || !lib) return null;
  return <EditorInner key={ed.id} id={ed.id} lib={lib} />;
}

type Hist = { R: number[]; G: number[]; B: number[]; L: number[]; hi: number; lo: number };

function EditorInner({ id, lib }: { id: number; lib: Lib }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stageEl = useRef<HTMLDivElement>(null);
  const histCv = useRef<HTMLCanvasElement>(null);
  const R = useRef<Renderer | null>(null);
  const small = useRef<import("../../lib/edit/renderer").Small | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  const [d, setD] = useState<MediaDetail | null>(null);
  const [stack, setStackS] = useState<Stack>(defaults);
  const stackRef = useRef(stack);
  const saved = useRef(JSON.stringify(defaults()));
  const hadEdits = useRef(false);
  const hist = useRef<{ list: string[]; at: number }>({ list: [JSON.stringify(defaults())], at: 0 });
  const [, setHistVer] = useState(0);
  const [tool, setToolS] = useState<Tool>("adjust");
  const [stage, setStage] = useState({ w: 900, h: 600 });
  const [view, setView] = useState<View>({ z: 1, x: 0, y: 0 });
  const [before, setBefore] = useState(false);
  const [split, setSplit] = useState<number | null>(null);
  const [clip, setClip] = useState(false);
  const [maskSel, setMaskSel] = useState(-1);
  const [overlay, setOverlay] = useState(false);
  const [spotSel, setSpotSel] = useState(-1);
  const [brush, setBrush] = useState({ size: 0.04, feather: 0.6, flow: 0.8, erase: false });
  const [healOpts, setHealOpts] = useState<HealOpts>({ size: 0.02, feather: 0.5, opacity: 1, mode: "heal" });
  const [histo, setHisto] = useState<Hist | null>(null);
  const [lookThumbs, setLookThumbs] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState(false);
  const alt = useRef(false);
  const space = useRef(false);
  const dpr = devicePixelRatio || 1;
  const i = lib.pos.get(id);
  const thumb = i != null ? thumbUrl(id, lib.ver[i]) : "";

  // ---------- history ----------

  const push = useCallback((s: Stack) => {
    const j = JSON.stringify(s);
    const h = hist.current;
    if (h.list[h.at] === j) return;
    h.list = h.list.slice(0, h.at + 1);
    h.list.push(j);
    if (h.list.length > 250) h.list.shift();
    h.at = h.list.length - 1;
    setHistVer((v) => v + 1);
  }, []);
  const replace = useCallback((s: Stack) => {
    stackRef.current = s;
    setStackS(s);
  }, []);
  const up = useCallback(
    (mut: (s: Stack) => void, commit = true) => {
      const next = clone(stackRef.current);
      mut(next);
      replace(next);
      if (commit) push(next);
    },
    [push, replace],
  );
  const setGeo = useCallback(
    (mut: (g: Geo) => void, commit = true, mode: "auto" | "keep" = "keep") => {
      const r = R.current;
      if (!r) return;
      up((s) => {
        const before = { ...s.geo };
        mut(s.geo);
        if (mode === "auto") s.geo.auto = true;
        if (mode === "auto" || s.geo.angle !== before.angle || s.geo.rot !== before.rot) s.geo.crop = refit(r.W, r.H, s.geo);
      }, commit);
    },
    [up],
  );
  const undo = useCallback(() => {
    const h = hist.current;
    if (h.at <= 0) return;
    h.at--;
    replace(normalize(JSON.parse(h.list[h.at])));
    setHistVer((v) => v + 1);
  }, [replace]);
  const redo = useCallback(() => {
    const h = hist.current;
    if (h.at >= h.list.length - 1) return;
    h.at++;
    replace(normalize(JSON.parse(h.list[h.at])));
    setHistVer((v) => v + 1);
  }, [replace]);

  // ---------- load ----------

  useEffect(() => {
    const ac = new AbortController();
    let r: Renderer | null = null;
    try {
      r = new Renderer(canvas.current!);
      R.current = r;
    } catch (e) {
      setErr((e as Error).message);
      setPhase("error");
      return;
    }
    (async () => {
      const det = await detailCached(id);
      if (!det) throw new Error("This photo is no longer in the library.");
      setD(det);
      const [src, json] = await Promise.all([loadSource(det, r.maxTex, ac.signal), api.editLoad(id).catch(() => null)]);
      if (ac.signal.aborted) return;
      const st = json ? normalize(JSON.parse(json)) : defaults();
      hadEdits.current = !!json;
      r.load(src);
      if (src.pixels instanceof ImageBitmap) src.pixels.close();
      small.current = src.small;
      saved.current = JSON.stringify(st);
      hist.current = { list: [saved.current], at: 0 };
      replace(st);
      setPhase("ready");
    })().catch((e) => {
      if (ac.signal.aborted) return;
      console.error(e);
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    });
    return () => {
      ac.abort();
      r?.dispose();
      R.current = null;
    };
  }, [id, replace]);

  useLayoutEffect(() => {
    document.body.classList.add("editing");
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => {
      cancelAnimationFrame(raf);
      document.body.classList.remove("editing");
    };
  }, []);

  useLayoutEffect(() => {
    const el = stageEl.current!;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---------- view ----------

  const cropping = tool === "crop";
  const L = useMemo(() => {
    if (phase !== "ready" || !R.current) return null;
    return layout(R.current.W, R.current.H, stack.geo, stage, dpr, view, cropping);
  }, [phase, stack.geo, stage, dpr, view, cropping]);

  const draw = useCallback(() => {
    const r = R.current,
      cv = canvas.current;
    if (!r || !cv || !L) return;
    const bw = Math.round(stage.w * dpr),
      bh = Math.round(stage.h * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }
    r.setStack(stackRef.current);
    r.draw(null, bw, bh, L.fragToSrc, L.fragToOut, L.outPx, {
      split: split != null && !cropping ? split * dpr : -1,
      before,
      clip,
      showMask: tool === "masks" && overlay ? maskSel : -1,
      sharpStep: Math.max(1, (0.75 / L.scale) / dpr),
    });
  }, [L, stage, dpr, split, cropping, before, clip, tool, overlay, maskSel]);
  const frameReq = useRef(0);
  const requestDraw = useCallback(() => {
    cancelAnimationFrame(frameReq.current);
    frameReq.current = requestAnimationFrame(draw);
  }, [draw]);
  useEffect(() => {
    requestDraw();
  }, [requestDraw, stack]);

  // live histogram of the result, a beat after changes settle
  useEffect(() => {
    if (phase !== "ready") return;
    const t = setTimeout(async () => {
      const r = R.current;
      if (!r) return;
      const s = stackRef.current;
      const [ow, oh] = outSize(r.W, r.H, s.geo);
      const k = Math.min(1, 220 / Math.max(ow, oh));
      const w = Math.max(1, Math.round(ow * k)),
        h = Math.max(1, Math.round(oh * k));
      r.setStack(s);
      const px = await r.pixels(w, h, outToSrc(r.W, r.H, s.geo));
      const hR = new Array(64).fill(0),
        hG = new Array(64).fill(0),
        hB = new Array(64).fill(0),
        hL = new Array(64).fill(0);
      let hi = 0,
        lo = 0;
      for (let p = 0; p < px.length; p += 4) {
        const a = px[p],
          b = px[p + 1],
          c = px[p + 2];
        hR[a >> 2]++;
        hG[b >> 2]++;
        hB[c >> 2]++;
        hL[Math.min(63, Math.round(0.2126 * a + 0.7152 * b + 0.0722 * c) >> 2)]++;
        if (Math.max(a, b, c) >= 254) hi++;
        if (Math.max(a, b, c) <= 1) lo++;
      }
      const n = px.length / 4;
      setHisto({ R: hR, G: hG, B: hB, L: hL, hi: hi / n, lo: lo / n });
      requestDraw();
    }, 140);
    return () => clearTimeout(t);
  }, [stack, phase, requestDraw]);
  useEffect(() => {
    if (histo && histCv.current) drawHist(histCv.current, histo);
  }, [histo]);

  // looks: render each look on this photo
  const lookBase = JSON.stringify({ ...stack, look: null });
  useEffect(() => {
    if (tool !== "looks" || phase !== "ready") return;
    const t = setTimeout(async () => {
      const r = R.current;
      if (!r) return;
      const base = clone(stackRef.current);
      const [ow, oh] = outSize(r.W, r.H, base.geo);
      const tw = 132,
        th = 100;
      const A = ow / oh,
        tA = tw / th;
      const tileToOut: Mat = A > tA ? [tA / A, 0, (1 - tA / A) / 2, 0, 1, 0] : [1, 0, 0, 0, A / tA, (1 - A / tA) / 2];
      const map = mul(outToSrc(r.W, r.H, base.geo), tileToOut);
      const c = document.createElement("canvas");
      c.width = tw;
      c.height = th;
      const x = c.getContext("2d")!;
      const out: Record<string, string> = {};
      for (const l of [{ id: "" }, ...LOOKS]) {
        const s = clone(base);
        s.look = l.id ? { id: l.id, amt: 100 } : null;
        r.setStack(s);
        const px = await r.pixels(tw, th, map);
        x.putImageData(new ImageData(px, tw, th), 0, 0);
        out[l.id || "none"] = c.toDataURL("image/jpeg", 0.82);
      }
      r.setStack(stackRef.current);
      setLookThumbs(out);
      requestDraw();
    }, 260);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, phase, lookBase]);

  // ---------- actions ----------

  const dirty = phase === "ready" && JSON.stringify(stack) !== saved.current;
  const close = useCallback(() => store.set({ editor: null }), []);
  const requestClose = () => (dirty ? setConfirm(true) : close());

  const save = async (andClose = true) => {
    const r = R.current;
    if (!r || busy) return;
    const s = stackRef.current;
    setBusy("Saving");
    try {
      if (isIdentity(s)) {
        if (hadEdits.current) await api.editRevert(id);
        hadEdits.current = false;
      } else {
        r.setStack(s);
        const [ow, oh] = outSize(r.W, r.H, s.geo);
        const map = outToSrc(r.W, r.H, s.geo);
        const th = Math.min(360, oh),
          tw = Math.min(1440, Math.max(1, Math.round((ow * th) / oh)));
        const k = Math.min(1, 2560 / Math.max(ow, oh));
        const pw = Math.max(1, Math.round(ow * k)),
          ph = Math.max(1, Math.round(oh * k));
        const thumbB = await r.encode(tw, th, map, "image/jpeg", 0.86, { sharpStep: Math.max(1, (0.75 * ow) / tw) });
        const prevB = await r.encode(pw, ph, map, "image/jpeg", 0.9, { sharpStep: Math.max(1, (0.75 * ow) / pw) });
        await api.editSave(id, ow, oh, s, thumbB, prevB);
        hadEdits.current = true;
      }
      forgetDetail(id);
      saved.current = JSON.stringify(s);
      toast(isIdentity(s) ? "Back to the original" : "Edits saved · the original file is untouched");
      if (andClose) close();
    } catch (e) {
      toast(`Couldn't save: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
      requestDraw();
    }
  };

  const auto = () => {
    if (!small.current || !R.current) return;
    const a = autoTone(small.current, R.current.enc);
    up((s) => Object.assign(s.adj, a));
    toast("Auto tone applied · tweak anything you like");
  };

  const addMask = (kind: Mask["kind"]) => {
    const r = R.current;
    if (!r || stackRef.current.masks.length >= MAX_MASKS) return;
    const [ax, ay] = r.asp;
    const n = stackRef.current.masks.filter((m) => m.kind === kind).length + 1;
    const base = { id: newId(), invert: false, amount: 100, adj: {} };
    const name = `${kind === "linear" ? "Gradient" : kind === "radial" ? "Radial" : "Brush"} ${n}`;
    const m: Mask =
      kind === "linear"
        ? { ...base, kind, name, a: [ax / 2, ay * 0.08], b: [ax / 2, ay * 0.5] }
        : kind === "radial"
          ? { ...base, kind, name, c: [ax / 2, ay / 2], r: [ax * 0.22, ay * 0.22], angle: 0, feather: 50 }
          : { ...base, kind, name, strokes: [] };
    if (kind === "radial") (m as { r: Pt }).r = [Math.min(ax, ay) * 0.28, Math.min(ax, ay) * 0.28];
    up((s) => void s.masks.push(m));
    setMaskSel(stackRef.current.masks.length - 1);
    if (kind === "brush") toast("Paint over the area to adjust · Alt erases");
  };

  // brush strokes mutate a draft in place while painting (no React churn), then commit
  const draft = useRef<Stack | null>(null);
  const onStroke = (ph: "start" | "move" | "end", p: Pt) => {
    if (ph === "start") {
      const s = clone(stackRef.current);
      const m = s.masks[maskSel];
      if (m?.kind !== "brush") return;
      m.strokes.push({ r: brush.size, feather: brush.feather, flow: brush.flow, erase: brush.erase || alt.current, pts: [p[0], p[1]] });
      draft.current = s;
      stackRef.current = s;
      requestDraw();
    } else if (ph === "move" && draft.current) {
      const m = draft.current.masks[maskSel];
      if (m?.kind !== "brush") return;
      const st = m.strokes[m.strokes.length - 1];
      const lx = st.pts[st.pts.length - 2],
        ly = st.pts[st.pts.length - 1];
      if (Math.hypot(p[0] - lx, p[1] - ly) < st.r * 0.08) return;
      st.pts.push(p[0], p[1]);
      requestDraw();
    } else if (ph === "end" && draft.current) {
      const s = draft.current;
      draft.current = null;
      replace(s);
      push(s);
    }
  };

  const addSpot = (p: Pt) => {
    const r = R.current,
      sm = small.current;
    if (!r || !sm) return;
    if (stackRef.current.heal.length >= MAX_SPOTS) return toast(`Up to ${MAX_SPOTS} fixes per photo`);
    const [ax, ay] = r.asp;
    if (p[0] < 0 || p[1] < 0 || p[0] > ax || p[1] > ay) return;
    const rr = healOpts.size;
    const [sx, sy] = autoSource(sm, r.asp, p[0], p[1], rr);
    const spot = { x: p[0], y: p[1], sx, sy, r: rr, feather: healOpts.feather, opacity: healOpts.opacity, mode: healOpts.mode, off: [0, 0, 0] as [number, number, number] };
    spot.off = colorOffset(sm, r.asp, spot);
    up((s) => void s.heal.push(spot));
    setSpotSel(stackRef.current.heal.length - 1);
  };
  const moveSpot = (k: number, part: "dst" | "src", p: Pt, commit: boolean) => {
    const r = R.current,
      sm = small.current;
    if (!r || !sm) return;
    up((s) => {
      const sp = s.heal[k];
      if (part === "dst") {
        const dx = p[0] - sp.x,
          dy = p[1] - sp.y;
        sp.x = p[0];
        sp.y = p[1];
        sp.sx += dx;
        sp.sy += dy;
      } else {
        sp.sx = p[0];
        sp.sy = p[1];
      }
      if (commit) sp.off = colorOffset(sm, r.asp, sp);
    }, commit);
  };

  const zoomTo = (z: number, cx = stage.w / 2, cy = stage.h / 2) => {
    if (!L) return;
    const nz = Math.min(Math.max(z, 1), Math.max(2, 8 / L.fit / dpr));
    if (nz === 1) return setView({ z: 1, x: 0, y: 0 });
    const k = nz / view.z;
    const ox = cx - stage.w / 2 - view.x,
      oy = cy - stage.h / 2 - view.y;
    const nv = { z: nz, x: view.x - ox * (k - 1), y: view.y - oy * (k - 1) };
    setView(clampPan(nv, { w: L.rect.w * k, h: L.rect.h * k }, stage));
  };
  const oneToOne = L ? 1 / dpr / L.fit : 1;

  const copySettings = () => {
    const s = stackRef.current;
    copied = structuredClone({ adj: s.adj, curve: s.curve, hsl: s.hsl, grade: s.grade, bw: s.bw, look: s.look });
    toast("Copied settings · Ctrl Shift V pastes them onto another photo");
  };
  const pasteSettings = () => {
    if (!copied) return toast("Copy settings from another photo first (Ctrl Shift C)");
    const c = structuredClone(copied);
    up((s) => Object.assign(s, c));
    toast("Pasted settings");
  };

  // ---------- keyboard ----------

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!store.get().editor) return;
      if ((e.target as HTMLElement).matches?.("input,textarea,select")) return;
      e.stopImmediatePropagation();
      if (e.key === "Alt") {
        alt.current = true;
        e.preventDefault();
        return;
      }
      if (e.key === " ") {
        space.current = true;
        e.preventDefault();
        return;
      }
      if (phase !== "ready" || busy) return;
      const k = e.key,
        mod = e.ctrlKey || e.metaKey,
        lk = k.toLowerCase();
      let used = true;
      if (k === "Escape") {
        if (exporting) setExporting(false);
        else if (confirm) setConfirm(false);
        else if (tool === "crop") setToolS("adjust");
        else requestClose();
      } else if (mod && lk === "z") e.shiftKey ? redo() : undo();
      else if (mod && lk === "y") redo();
      else if (mod && lk === "s") save();
      else if (mod && k === "Enter") save();
      else if (mod && lk === "e") setExporting(true);
      else if (mod && e.shiftKey && lk === "c") copySettings();
      else if (mod && e.shiftKey && lk === "v") pasteSettings();
      else if (mod) used = false;
      else if (k === "Enter" && tool === "crop") setToolS("adjust");
      else if (k === "\\") setBefore(true);
      else if (lk === "y") setSplit((v) => (v == null ? stage.w / 2 : null));
      else if (lk === "j") setClip((v) => !v);
      else if (lk === "o") setOverlay((v) => !v);
      else if (lk === "z") zoomTo(view.z > 1.01 ? 1 : oneToOne);
      else if (lk === "r") setToolS("crop");
      else if (lk === "m") setToolS("masks");
      else if (lk === "h") setToolS("heal");
      else if (/^[1-4]$/.test(k)) setToolS(TOOLS[+k - 1].k);
      else if ((k === "Delete" || k === "Backspace") && tool === "masks" && maskSel >= 0) {
        up((s) => void s.masks.splice(maskSel, 1));
        setMaskSel(-1);
      } else if ((k === "Delete" || k === "Backspace") && tool === "heal" && spotSel >= 0) {
        up((s) => void s.heal.splice(spotSel, 1));
        setSpotSel(-1);
      } else if (k === "[" || k === "]") {
        const f = k === "]" ? 1.2 : 1 / 1.2;
        if (tool === "heal") setHealOpts((o) => ({ ...o, size: Math.min(0.15, Math.max(0.003, o.size * f)) }));
        else setBrush((b) => ({ ...b, size: Math.min(0.25, Math.max(0.005, b.size * f)) }));
      } else used = false;
      if (used) e.preventDefault();
    };
    const upk = (e: KeyboardEvent) => {
      if (e.key === "\\") setBefore(false);
      if (e.key === "Alt") alt.current = false;
      if (e.key === " ") space.current = false;
    };
    addEventListener("keydown", down, true);
    addEventListener("keyup", upk, true);
    return () => {
      removeEventListener("keydown", down, true);
      removeEventListener("keyup", upk, true);
    };
  });

  // ---------- stage pointer: pan, zoom, split handle ----------

  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const stageDown = (e: React.PointerEvent) => {
    if (cropping || e.button !== 0) return;
    if (view.z <= 1 && !space.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const stageMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p || !L) return;
    setView((v) => clampPan({ ...v, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y }, L.rect, stage));
  };
  const wheel = (e: React.WheelEvent) => {
    if (cropping || !L) return;
    const r = stageEl.current!.getBoundingClientRect();
    zoomTo(view.z * Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
  };

  const setTool = (t: Tool) => {
    setToolS(t);
    if (t === "crop") setView({ z: 1, x: 0, y: 0 });
  };

  const changes = summary(stack);
  const showOverlays = phase === "ready" && L && !before;
  const ow = R.current ? outSize(R.current.W, R.current.H, stack.geo) : [0, 0];
  const zoomPct = L ? Math.round(L.scale * dpr * 100) : 100;

  return (
    <div id="editor" className={`${open ? "open" : ""} t-${tool}`}>
      <div className="ed-top glass">
        <button className="vbtn" onClick={requestClose} title="Back (Esc)">
          <Icon n="left" />
          <span>Back</span>
        </button>
        <div className="ed-name">
          <b>{d?.name ?? " "}</b>
          <span>{changes.length ? changes.slice(0, 4).join(" · ") + (changes.length > 4 ? ` +${changes.length - 4}` : "") : "No edits yet"}</span>
        </div>
        <div className="ed-mid">
          <button className="vbtn" onClick={undo} disabled={hist.current.at <= 0} title="Undo (Ctrl Z)">
            <Icon n="undo" />
          </button>
          <button className="vbtn" onClick={redo} disabled={hist.current.at >= hist.current.list.length - 1} title="Redo (Ctrl Shift Z)">
            <Icon n="redo" />
          </button>
          <i className="sep" />
          <button className={`vbtn${split != null ? " on" : ""}`} onClick={() => setSplit(split == null ? stage.w / 2 : null)} title="Before / after split (Y)">
            <Icon n="compare" />
          </button>
          <button
            className={`vbtn${before ? " on" : ""}`}
            onPointerDown={() => setBefore(true)}
            onPointerUp={() => setBefore(false)}
            onPointerLeave={() => setBefore(false)}
            title="Hold to see the original (\)"
          >
            <Icon n="eye" />
            <span>Original</span>
          </button>
          <button className={`vbtn${clip ? " on" : ""}`} onClick={() => setClip(!clip)} title="Show clipping (J)">
            <Icon n="bolt" />
          </button>
        </div>
        <div className="ed-acts">
          {(!isIdentity(stack) || hadEdits.current) && (
            <button className="vbtn" onClick={() => up((s) => Object.assign(s, defaults()))} disabled={isIdentity(stack)} title="Reset to the original">
              <Icon n="reset" />
              <span>Revert</span>
            </button>
          )}
          <button className="vbtn" onClick={() => setExporting(true)} disabled={phase !== "ready"} title="Export a copy (Ctrl E)">
            <Icon n="share" />
            <span>Export</span>
          </button>
          <button className="btn-acc" onClick={() => save()} disabled={phase !== "ready" || !!busy}>
            {busy ? `${busy}…` : "Done"}
          </button>
        </div>
      </div>

      <nav className="ed-rail glass">
        {TOOLS.map((t, k) => (
          <button key={t.k} className={tool === t.k ? "on" : ""} style={{ "--i": k } as React.CSSProperties} onClick={() => setTool(t.k)} title={`${t.label} (${t.hint})`}>
            <Icon n={t.icon} s={20} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      <div
        className={`ed-stage${view.z > 1 ? " zoomed" : ""}${pan.current ? " panning" : ""}`}
        ref={stageEl}
        onPointerDown={stageDown}
        onPointerMove={stageMove}
        onPointerUp={() => (pan.current = null)}
        onWheel={wheel}
        onDoubleClick={(e) => {
          if (cropping || tool === "heal" || (tool === "masks" && maskSel >= 0)) return;
          const r = stageEl.current!.getBoundingClientRect();
          zoomTo(view.z > 1.01 ? 1 : oneToOne, e.clientX - r.left, e.clientY - r.top);
        }}
      >
        {phase !== "ready" && thumb && <img className="ed-ph" alt="" src={thumb} />}
        <canvas ref={canvas} className={phase === "ready" ? "in" : ""} />
        {phase === "loading" && (
          <div className="ed-load">
            <span className="pulse-dot" />
            Developing {d ? `${d.ext.toUpperCase()} · ${fmtSize(d.size)}` : "photo"}…
          </div>
        )}
        {phase === "error" && (
          <div className="ed-err glass">
            <b>The editor couldn't open this photo</b>
            <span>{err}</span>
            <button className="btn" onClick={close}>
              Close
            </button>
          </div>
        )}
        {showOverlays && cropping && R.current && <CropOverlay L={L} geo={stack.geo} W={R.current.W} H={R.current.H} onChange={(g, commit) => setGeo((x) => Object.assign(x, g), commit)} />}
        {showOverlays && tool === "masks" && (
          <MaskOverlay
            L={L}
            mask={stack.masks[maskSel] ?? null}
            index={maskSel}
            masks={stack.masks}
            brush={{ size: brush.size, erase: brush.erase }}
            onChange={(m, commit) => up((s) => void (s.masks[maskSel] = m), commit)}
            onSelect={setMaskSel}
            onStroke={onStroke}
          />
        )}
        {showOverlays && tool === "heal" && <HealOverlay L={L} spots={stack.heal} sel={spotSel} size={healOpts.size} onAdd={addSpot} onMove={moveSpot} onSelect={setSpotSel} />}
        {split != null && !cropping && phase === "ready" && (
          <div
            className="split"
            style={{ left: split }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!(e.buttons & 1)) return;
              const r = stageEl.current!.getBoundingClientRect();
              setSplit(Math.min(r.width - 8, Math.max(8, e.clientX - r.left)));
            }}
          >
            <span className="sp-l">Before</span>
            <b />
            <span className="sp-r">After</span>
          </div>
        )}
        {phase === "ready" && !cropping && (
          <div className="ed-zoom glass">
            <button className={view.z <= 1.01 ? "on" : ""} onClick={() => zoomTo(1)}>
              Fit
            </button>
            <button className={Math.abs(view.z - oneToOne) < 0.01 ? "on" : ""} onClick={() => zoomTo(oneToOne)}>
              100%
            </button>
            <span className="mono">{zoomPct}%</span>
          </div>
        )}
        {busy && <div className="ed-busy">{busy}…</div>}
      </div>

      <aside className="ed-panel glass">
        <div className="ed-hist">
          <canvas ref={histCv} className="hist" />
          <div className="ed-hist-meta mono">
            <span className={histo && histo.lo > 0.01 ? "warn lo" : ""}>◣ {histo ? `${(histo.lo * 100).toFixed(1)}%` : "—"}</span>
            <span>
              {ow[0]} × {ow[1]}
            </span>
            <span className={histo && histo.hi > 0.01 ? "warn hi" : ""}>{histo ? `${(histo.hi * 100).toFixed(1)}%` : "—"} ◥</span>
          </div>
        </div>
        <div className="ed-head">
          <h3>{TITLES[tool][0]}</h3>
          <span>{TITLES[tool][1]}</span>
        </div>
        <div className="ed-scroll" key={tool}>
          {phase === "ready" && R.current && (
            <>
              {tool === "looks" && <LooksPanel s={stack} up={up} thumbs={lookThumbs} />}
              {tool === "adjust" && <AdjustPanel s={stack} up={up} onAuto={auto} />}
              {tool === "color" && <ColorPanel s={stack} up={up} />}
              {tool === "curves" && <CurvesPanel s={stack} up={up} hist={histo?.L ?? null} />}
              {tool === "crop" && <CropPanel g={stack.geo} setGeo={setGeo} />}
              {tool === "masks" && (
                <MasksPanel s={stack} up={up} sel={maskSel} setSel={setMaskSel} add={addMask} overlay={overlay} setOverlay={setOverlay} brush={brush} setBrush={setBrush} />
              )}
              {tool === "heal" && <HealPanel s={stack} up={up} sel={spotSel} setSel={setSpotSel} opts={healOpts} setOpts={setHealOpts} />}
            </>
          )}
        </div>
        <div className="ed-foot">
          <button className="btn sm" onClick={copySettings} title="Ctrl Shift C">
            Copy settings
          </button>
          <button className="btn sm" onClick={pasteSettings} title="Ctrl Shift V" disabled={!copied}>
            Paste
          </button>
        </div>
      </aside>

      {confirm && (
        <div className="ed-confirm glass">
          <b>Keep your edits?</b>
          <span>Saving is non-destructive: the original file is never changed.</span>
          <div>
            <button className="btn" onClick={close}>
              Discard
            </button>
            <button className="btn" onClick={() => setConfirm(false)}>
              Keep editing
            </button>
            <button className="btn-acc" onClick={() => save()}>
              Save
            </button>
          </div>
        </div>
      )}
      {exporting && R.current && d && <ExportSheet r={R.current} d={d} stack={stack} onClose={() => setExporting(false)} />}
    </div>
  );
}

// ---------- export ----------

type Fmt = "jpg" | "png" | "webp";

function ExportSheet({ r, d, stack, onClose }: { r: Renderer; d: MediaDetail; stack: Stack; onClose: () => void }) {
  const [fmt, setFmt] = useState<Fmt>(() => (localStorage.getItem("sitara.exfmt") as Fmt) || "jpg");
  const [q, setQ] = useState(92);
  const [size, setSize] = useState<number>(0);
  const [exif, setExif] = useState(true);
  const [gps, setGps] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [ow, oh] = outSize(r.W, r.H, stack.geo);
  const k = size ? Math.min(1, size / Math.max(ow, oh)) : 1;
  const tw = Math.max(1, Math.round(ow * k)),
    th = Math.max(1, Math.round(oh * k));
  const webp = useMemo(() => document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp"), []);

  const go = async () => {
    const stem = d.name.replace(/\.[^.]+$/, "");
    const sep = d.dir.includes("\\") ? "\\" : "/";
    const path = await api.pickSavePath(`${d.dir}${sep}${stem}-edit.${fmt}`, fmt);
    if (!path) return;
    localStorage.setItem("sitara.exfmt", fmt);
    setProgress(0);
    try {
      r.setStack(stack);
      const type = fmt === "png" ? "image/png" : fmt === "webp" ? "image/webp" : "image/jpeg";
      const blob = await r.encode(tw, th, outToSrc(r.W, r.H, stack.geo), type, q / 100, { sharpStep: Math.max(1, (0.75 * ow) / tw) }, (f) => setProgress(f));
      const out = await api.exportSave({ id: d.id, path, w: tw, h: th, exif: exif && fmt === "jpg", gps }, blob);
      toast(`Exported ${basename(out)} · ${fmtSize(blob.size)}`, { label: "Show", run: () => api.revealPath(out).catch((e) => toast(String(e))) });
      onClose();
    } catch (e) {
      toast(`Export failed: ${e instanceof Error ? e.message : e}`);
      setProgress(null);
    }
  };

  const sizes: [number, string][] = [
    [0, "Full"],
    [4096, "4096"],
    [2048, "2048"],
    [1080, "1080"],
  ];
  return (
    <div className="ex-wrap" onPointerDown={(e) => e.target === e.currentTarget && progress == null && onClose()}>
      <div className="ex glass">
        <h3>Export a copy</h3>
        <p className="ed-hint">Your original stays exactly as it is. The copy is saved wherever you choose.</p>
        <div className="ex-row">
          <span>Format</span>
          <div className="seg ed-seg">
            {(["jpg", "png", ...(webp ? ["webp"] : [])] as Fmt[]).map((f) => (
              <button key={f} className={fmt === f ? "on" : ""} onClick={() => setFmt(f)}>
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        {fmt !== "png" && (
          <div className="ex-row">
            <span>Quality</span>
            <input type="range" min={60} max={100} value={q} onChange={(e) => setQ(+e.target.value)} />
            <b className="mono">{q}</b>
          </div>
        )}
        <div className="ex-row">
          <span>Long edge</span>
          <div className="seg ed-seg">
            {sizes.map(([v, label]) => (
              <button key={v} className={size === v ? "on" : ""} onClick={() => setSize(v)} disabled={v > 0 && v >= Math.max(ow, oh)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="ex-dims mono">
          {tw} × {th} px · {((tw * th) / 1e6).toFixed(1)} MP
        </div>
        {fmt === "jpg" && (
          <div className="ex-sw">
            <label className="switch">
              <input type="checkbox" checked={exif} onChange={(e) => setExif(e.target.checked)} />
              <i />
              <span>Keep camera details (EXIF)</span>
            </label>
            <label className={`switch${exif ? "" : " off"}`}>
              <input type="checkbox" checked={gps && exif} disabled={!exif} onChange={(e) => setGps(e.target.checked)} />
              <i />
              <span>Keep location</span>
            </label>
          </div>
        )}
        {progress != null ? (
          <div className="ex-prog">
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
            <span>Rendering {Math.round(progress * 100)}%</span>
          </div>
        ) : (
          <div className="ex-acts">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-acc" onClick={go}>
              Export…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
