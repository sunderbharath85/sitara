// Fullscreen slideshow. The player is imperative DOM + Web Animations (ported from the design
// prototype) because transitions clone and clip whole slides; React only renders the shell.
import { useEffect, useRef } from "react";
import { detailCached, mediaSrc, thumbUrl, type Lib, type MediaDetail } from "../lib/api";
import { basename, camera, dayPart, fmtDur, fmtMonth, fmtShortDay, hourOf, weekday } from "../lib/format";
import { aspect } from "../lib/layout";
import { beatPulse, M, musicStart, musicStop, PHR } from "../lib/soundtrack";
import { libOf, store, useStore, type ShowRequest } from "../lib/store";
import { activeGrid } from "./Grid";
import { iconHtml } from "./Icon";
import { toast } from "./Toasts";

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const EZ = "cubic-bezier(.2,.8,.2,1)";
const FXN: Record<string, string> = { auto: "Auto", dissolve: "Dissolve", kenburns: "Ken Burns", push: "Push", iris: "Iris", zoom: "Zoom", mosaic: "Mosaic", blinds: "Blinds", rise: "Fade in", flip: "Expand" };
const FXS = ["auto", "dissolve", "kenburns", "push", "iris", "zoom", "mosaic", "blinds"];
const TEMPOS: [number | "beat", string, string][] = [
  [2500, "Brisk", "2.5 s"],
  [4500, "Easy", "4.5 s"],
  [7000, "Calm", "7 s"],
  ["beat", "Beat", "♪ synced"],
];
const FRAMES = [
  ["fill", "Fill", "edge to edge"],
  ["fit", "Fit", "whole photo"],
  ["pairs", "Smart pairs", "portraits pair up"],
];
const GENERIC = /^(dcim|camera|camera roll|pictures|photos|images|\d{3}[a-z_]+|\d+|download(s)?|desktop|screenshots?|whatsapp.*|img)$/i;
const RING = 2 * Math.PI * 28;
const MONTH_GHOST = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

interface Item {
  id: number;
  ar: number;
  taken: number;
  kind: number;
  ver: number;
  dur: number;
}
type Slide = Item[];
type Opt = { fx: string; tempo: number | "beat"; frame: string; shuffle: boolean; loop: boolean; caps: boolean; chapters: boolean; videos: boolean };

const DEFAULT_OPT: Opt = { fx: "auto", tempo: 4500, frame: "fill", shuffle: false, loop: true, caps: true, chapters: true, videos: false };
function loadOpt(): Opt {
  try {
    return { ...DEFAULT_OPT, ...JSON.parse(localStorage.getItem("sitara.show") ?? "{}"), shuffle: false };
  } catch {
    return { ...DEFAULT_OPT };
  }
}

function createPlayer(root: HTMLElement, lib: Lib, req: ShowRequest, onClose: (lastId: number | null) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T;
  const stage = $("#ss-stage"),
    panel = $("#ss-panel"),
    ring = $("#ss-ring") as unknown as SVGCircleElement;
  const opt = loadOpt();
  const restoreTempo = req.tempo ? opt.tempo : null;
  if (req.tempo) opt.tempo = req.tempo;
  const save = () => {
    const o = { ...opt, tempo: restoreTempo ?? opt.tempo };
    localStorage.setItem("sitara.show", JSON.stringify(o));
  };
  const src: Item[] = req.ids
    .map((id) => lib.pos.get(id))
    .filter((i): i is number => i != null)
    .map((i) => ({ id: lib.id[i], ar: aspect(lib, i), taken: lib.taken[i], kind: lib.kind[i], ver: lib.ver[i], dur: lib.dur[i] }));
  const clips = req.ids.length <= 400 && req.label.startsWith("Selection");
  let slides: Slide[] = [];
  let tks: HTMLElement[] = [];
  let curTk: HTMLElement | null = null;
  let i = -1,
    t = 0,
    dur = 1e9,
    playing = true,
    last = performance.now(),
    raf = 0,
    tok = 0,
    idleT = 0,
    chapT = 0,
    wh = 0,
    overUI = false,
    fsMine = false,
    dead = false;
  let curEl: (HTMLElement & { _drift?: Animation[] }) | null = null;
  let curSl: Slide | null = null;
  let anims: Animation[] = [];
  const pre = new Map<string, HTMLImageElement>();
  const details = new Map<number, MediaDetail>();

  const preImg = (u: string) => {
    let im = pre.get(u);
    if (!im) {
      im = new Image();
      im.decoding = "async";
      im.src = u;
      pre.set(u, im);
    }
    return im;
  };
  async function detailsFor(sl: Slide) {
    await Promise.all(
      sl.map(async (p) => {
        if (!details.has(p.id)) {
          const d = await detailCached(p.id);
          if (d) details.set(p.id, d);
        }
      }),
    );
  }
  const fullOf = (p: Item) => {
    const d = details.get(p.id);
    return d && p.kind === 0 ? mediaSrc(d) : thumbUrl(p.id, p.ver);
  };
  async function ready(sl: Slide, ms: number) {
    await Promise.race([detailsFor(sl), new Promise((r) => setTimeout(r, 400))]);
    const all = Promise.all(
      sl.map((p) => {
        const im = preImg(fullOf(p));
        return im.complete ? 0 : new Promise((r) => {
          im.addEventListener("load", r, { once: true });
          im.addEventListener("error", r, { once: true });
        });
      }),
    );
    return Promise.race([all, new Promise((r) => setTimeout(r, ms))]);
  }
  const preload = (sl?: Slide) => sl && detailsFor(sl).then(() => sl.forEach((p) => preImg(fullOf(p))));

  function build() {
    let it = src.filter((p) => opt.videos || clips || !p.kind);
    if (!it.length) it = src.slice();
    if (opt.shuffle) {
      it = it.slice();
      for (let k = it.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [it[k], it[j]] = [it[j], it[k]];
      }
    }
    const out: Slide[] = [];
    for (let k = 0; k < it.length; k++) {
      const p = it[k],
        q = it[k + 1];
      if (opt.frame === "pairs" && p.ar < 1 && q && q.ar < 1 && Math.abs(q.taken - p.taken) < 86400 * 3) {
        out.push([p, q]);
        k++;
      } else out.push([p]);
    }
    slides = out;
  }
  const monthKey = (p: Item) => {
    const d = new Date(p.taken * 1000);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };
  function renderTicks() {
    let pk = -1;
    $("#ss-ticks").innerHTML = slides
      .map((sl, n) => {
        const k = monthKey(sl[0]);
        const ch = n && !opt.shuffle && k !== pk;
        pk = k;
        return `<button class="tk${ch ? " ch" : ""}" data-n="${n}" aria-label="Slide ${n + 1}"><i></i></button>`;
      })
      .join("");
    tks = [...root.querySelectorAll<HTMLElement>("#ss-ticks .tk")];
    curTk = null;
    $("#ss-label").textContent = `${req.label} · ${slides.length} slides`;
  }
  function updTicks() {
    curTk?.style.removeProperty("--p");
    tks.forEach((el, k) => {
      el.classList.toggle("done", k < i);
      el.classList.toggle("cur", k === i);
    });
    curTk = tks[i] ?? null;
  }
  function rebuild() {
    const cur = curSl?.[0];
    build();
    let n = cur ? slides.findIndex((sl) => sl.includes(cur)) : 0;
    if (n < 0) n = Math.max(0, cur ? slides.findIndex((sl) => sl[0].taken < cur.taken) : 0);
    renderTicks();
    const s = slides[n],
      same = curSl && s.length === curSl.length && s.every((p, k) => p === curSl![k]) && curEl?.dataset.frame === opt.frame;
    if (same) {
      i = n;
      updTicks();
      $("#ss-n").textContent = `${n + 1} / ${slides.length}`;
    } else goSlide(n, 1, { fx: "dissolve", force: true });
  }
  function slideEl(sl: Slide) {
    const el = document.createElement("div") as HTMLElement & { _drift?: Animation[] };
    const fit = opt.frame === "fit" && sl.length === 1;
    el.className = "ss-slide" + (fit ? " fit" : "") + (sl.length > 1 ? " pair" : "");
    el.dataset.frame = opt.frame;
    el.innerHTML = sl
      .map((p) => {
        const full = fullOf(p),
          im = pre.get(full),
          ok = im && im.complete && im.naturalWidth;
        const th = thumbUrl(p.id, p.ver);
        return `<div class="ss-ph">${fit ? `<img class="amb" alt="" src="${th}">` : ""}<img class="main" alt="" src="${ok ? full : th}" data-full="${full}">${p.kind ? `<span class="ss-vid">▶ Clip · ${fmtDur(p.dur)}</span>` : ""}</div>`;
      })
      .join("");
    el.querySelectorAll<HTMLImageElement>("img.main").forEach((im) => {
      const f = im.dataset.full!;
      if (!im.src.endsWith(f) && im.src !== f) preImg(f).addEventListener("load", () => (im.src = f), { once: true });
    });
    return el;
  }
  const ani = (el: Element, kf: Keyframe[], d: number, e = EZ, delay = 0) => {
    const a = el.animate(kf, { duration: reduce ? 1 : d, delay: reduce ? 0 : delay, easing: e, fill: "both" });
    anims.push(a);
    return a;
  };
  function pieces(inc: HTMLElement, junk: Element[], cells: (W: number, H: number) => number[][]) {
    const W = stage.clientWidth,
      H = stage.clientHeight,
      box = document.createElement("div");
    box.className = "ss-pieces";
    const list = cells(W, H).map(([x, y, w, h]) => {
      const pc = document.createElement("div");
      pc.className = "ss-pc";
      pc.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
      const cl = inc.cloneNode(true) as HTMLElement;
      cl.style.cssText = `inset:auto;left:${-x}px;top:${-y}px;width:${W}px;height:${H}px`;
      pc.append(cl);
      box.append(pc);
      return pc;
    });
    stage.append(box);
    junk.push(box);
    return list;
  }
  const hold = (inc: Element, total: number) => ani(inc, [{ opacity: 0 }, { opacity: 0, offset: 0.999 }, { opacity: 1 }], total, "linear");
  const FX: Record<string, (inc: HTMLElement, out: HTMLElement | null, d: number, junk: Element[]) => (Animation | null)[]> = {
    rise: (inc) => [ani(inc, [{ opacity: 0, transform: "scale(1.08)" }, { opacity: 1, transform: "none" }], 1000)],
    flip: (inc) => {
      const r = req.rect!,
        W = innerWidth,
        H = innerHeight;
      return [ani(inc, [{ clipPath: `inset(${r.top}px ${W - r.right}px ${H - r.bottom}px ${r.left}px round 10px)` }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], 760)];
    },
    dissolve: (inc, out) => [ani(inc, [{ opacity: 0, transform: "scale(1.03)" }, { opacity: 1, transform: "none" }], 1100, "ease"), out && ani(out, [{ opacity: 1 }, { opacity: 0 }], 1100, "ease")],
    kenburns: (inc, out) => [ani(inc, [{ opacity: 0 }, { opacity: 1 }], 1600, "ease"), out && ani(out, [{ opacity: 1 }, { opacity: 0 }], 1600, "ease")],
    push: (inc, out, d) => [
      ani(inc, [{ transform: `translateX(${d * 100}%)` }, { transform: "none" }], 950, "cubic-bezier(.7,0,.2,1)"),
      out && ani(out, [{ transform: "none", filter: "brightness(1)" }, { transform: `translateX(${-d * 30}%)`, filter: "brightness(.3)" }], 950, "cubic-bezier(.7,0,.2,1)"),
    ],
    iris: (inc, out) => {
      const x = (25 + Math.random() * 50).toFixed(0),
        y = (30 + Math.random() * 40).toFixed(0);
      return [
        ani(inc, [{ clipPath: `circle(0% at ${x}% ${y}%)` }, { clipPath: `circle(150% at ${x}% ${y}%)` }], 1300, "cubic-bezier(.65,0,.25,1)"),
        out && ani(out, [{ transform: "none", filter: "brightness(1)" }, { transform: "scale(.94)", filter: "brightness(.35)" }], 1300),
      ];
    },
    zoom: (inc, out) => [
      ani(inc, [{ opacity: 0, transform: "scale(.8)", filter: "blur(14px)" }, { opacity: 1, transform: "none", filter: "blur(0px)" }], 950),
      out && ani(out, [{ opacity: 1, transform: "none", filter: "blur(0px)" }, { opacity: 0, transform: "scale(1.45)", filter: "blur(20px)" }], 800, "cubic-bezier(.5,0,.75,0)"),
    ],
    mosaic: (inc, out, _d, junk) => {
      const C = 10;
      let R = 6;
      const list = pieces(inc, junk, (W, H) => {
        R = Math.max(3, Math.round((C * H) / W));
        const w = W / C,
          h = H / R,
          a: number[][] = [];
        for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) a.push([Math.floor(c * w), Math.floor(r * h), Math.ceil(w) + 1, Math.ceil(h) + 1]);
        return a;
      });
      const ox = Math.random() * C,
        oy = Math.random() * R,
        total = 620 + Math.hypot(C, R) * 55;
      const an: (Animation | null)[] = list.map((pc, k) =>
        ani(pc, [{ opacity: 0, transform: "scale(.3) rotate(12deg)" }, { opacity: 1, transform: "none" }], 620, "cubic-bezier(.34,1.4,.64,1)", Math.hypot((k % C) - ox, Math.floor(k / C) - oy) * 55),
      );
      an.push(hold(inc, total));
      if (out) an.push(ani(out, [{ filter: "brightness(1)" }, { filter: "brightness(.35)" }], total, "ease"));
      return an;
    },
    blinds: (inc, out, d, junk) => {
      const N = 12,
        list = pieces(inc, junk, (W, H) => Array.from({ length: N }, (_, k) => [Math.floor((k * W) / N), 0, Math.ceil(W / N) + 1, H])),
        total = 700 + N * 55;
      const an: (Animation | null)[] = list.map((pc, k) =>
        ani(pc, [{ clipPath: d > 0 ? "inset(0 100% 0 0)" : "inset(0 0 0 100%)" }, { clipPath: "inset(0 0 0 0)" }], 700, "cubic-bezier(.7,0,.2,1)", (d > 0 ? k : N - 1 - k) * 55),
      );
      an.push(hold(inc, total));
      if (out) an.push(ani(out, [{ transform: "none", filter: "brightness(1)" }, { transform: `translateX(${-d * 6}%)`, filter: "brightness(.4)" }], total));
      return an;
    },
  };
  const autoFx = (prev: Slide | null, sl: Slide, n: number) => {
    if (prev && monthKey(prev[0]) !== monthKey(sl[0])) return "iris";
    if (sl.length > 1) return "blinds";
    return ["kenburns", "push", "dissolve", "mosaic", "zoom", "push"][n % 6];
  };
  const tempoDur = () => {
    if (opt.tempo !== "beat") return opt.tempo;
    if (!M.on || !M.ctx) return PHR * 1000;
    const pos = Math.max(0, M.ctx.currentTime - M.t0);
    let rem = PHR - (pos % PHR);
    if (rem < PHR * 0.5) rem += PHR;
    return rem * 1000;
  };
  function drift(el: HTMLElement & { _drift?: Animation[] }, fx: string) {
    if (reduce) return;
    const strong = fx === "kenburns",
      D = dur + 2000;
    el._drift = [];
    el.querySelectorAll("img.main").forEach((im) => {
      const x = ((Math.random() - 0.5) * (strong ? 7 : 2.4)).toFixed(2),
        y = ((Math.random() - 0.5) * (strong ? 5 : 1.6)).toFixed(2);
      el._drift!.push(
        im.animate(
          strong ? [{ transform: `scale(1.18) translate(${x}%,${y}%)` }, { transform: "scale(1.03)" }] : [{ transform: "scale(1)" }, { transform: `scale(1.05) translate(${x}%,${y}%)` }],
          { duration: D, easing: "cubic-bezier(.3,.1,.3,1)", fill: "both" },
        ),
      );
    });
  }
  const placeOf = (p: Item) => {
    const d = details.get(p.id);
    // "2026-09 Lisbon" → "Lisbon"; generic camera folders don't count as places
    const name = d ? basename(d.dir).replace(/^\d{4}([-_. ]\d{1,2}){0,2}[-_. ]+/, "").trim() : "";
    return name && !GENERIC.test(name) ? name : "";
  };
  function caption(sl: Slide) {
    const p = sl[0],
      d = details.get(p.id),
      c = $("#ss-cap");
    const place = placeOf(p);
    const cam = d ? [camera(d.make, d.model), d.fnumber ? `ƒ/${+d.fnumber.toFixed(1)}` : "", d.exposure ?? "", d.iso ? `ISO ${d.iso}` : ""].filter(Boolean).join(" · ") : "";
    c.innerHTML = `<small>${place ? esc(place) + " · " : ""}${fmtShortDay(p.taken)}</small><b>${weekday(p.taken)}, ${dayPart(hourOf(p.taken))}</b><span>${esc(cam)}${sl.length > 1 ? " &nbsp;+&nbsp; 1 more" : ""}</span>`;
    c.classList.remove("in");
    void c.offsetWidth;
    c.classList.add("in");
  }
  function chapter(p: Item) {
    const c = $("#ss-chap"),
      month = fmtMonth(p.taken),
      place = placeOf(p) || month;
    c.innerHTML = `<div class="cg">${MONTH_GHOST[new Date(p.taken * 1000).getUTCMonth()]}</div><div class="cm"><small>Chapter · ${month}</small><h2>${[...place].map((ch, k) => `<span style="--i:${k}">${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("")}</h2></div>`;
    c.className = "";
    void c.offsetWidth;
    c.className = "on";
    clearTimeout(chapT);
    chapT = window.setTimeout(() => {
      c.classList.add("out");
      chapT = window.setTimeout(() => (c.className = ""), 700);
    }, 2300);
  }
  async function goSlide(n: number, dir = 1, o: { fx?: string; force?: boolean; auto?: boolean } = {}) {
    const N = slides.length;
    if (!N) return;
    if (n >= N) {
      if (o.auto && !opt.loop) {
        setPlay(false);
        t = 0;
        dur = tempoDur();
        toast("End of slideshow · → starts over");
        return;
      }
      n = 0;
    }
    if (n < 0) n = N - 1;
    if (n === i && curEl && !o.force) return;
    anims.slice().forEach((a) => a.finish());
    const my = ++tok;
    i = n;
    t = 0;
    dur = 1e9;
    updTicks();
    $("#ss-n").textContent = `${n + 1} / ${N}`;
    const sl = slides[n];
    await ready(sl, curEl ? 1400 : 300);
    if (my !== tok || dead) return;
    const out = curEl,
      prev = curSl,
      inc = slideEl(sl),
      junk: Element[] = [];
    stage.append(inc);
    const chap = opt.chapters && (!prev || monthKey(prev[0]) !== monthKey(sl[0]));
    let fx = o.fx ?? (opt.fx === "auto" ? autoFx(prev, sl, n) : opt.fx);
    if (reduce) fx = "dissolve";
    const an = FX[fx](inc, out, dir, junk).filter((a): a is Animation => !!a);
    curEl = inc;
    curSl = sl;
    t = 0;
    dur = tempoDur() + (chap ? (opt.tempo === "beat" ? PHR * 1000 : 1500) : 0);
    drift(inc, fx);
    if (!playing) inc._drift?.forEach((a) => a.pause());
    caption(sl);
    if (chap) chapter(sl[0]);
    $("#ss-where").textContent = `${fmtMonth(sl[0].taken)}${sl.length > 1 ? " · pair" : ""}`;
    $("#ss-fxl").textContent = opt.fx === "auto" ? `Auto · ${FXN[fx]}` : FXN[fx];
    preload(slides[(n + 1) % N]);
    Promise.all(an.map((a) => a.finished))
      .catch(() => {})
      .then(() => {
        an.forEach((a) => a.cancel());
        anims = anims.filter((a) => !an.includes(a));
        if (out && out !== curEl) out.remove();
        junk.forEach((j) => j.remove());
      });
  }
  function setPlay(on: boolean) {
    playing = on;
    $("#ss-ppi").innerHTML = iconHtml(on ? "pause" : "play", 20);
    root.classList.toggle("paused", !on);
    curEl?._drift?.forEach((a) => {
      if (on) {
        if (a.playState === "paused" && (a.currentTime as number) < (a.effect!.getComputedTiming().endTime as number)) a.play();
      } else if (a.playState === "running") a.pause();
    });
    if (M.on && M.ctx) on ? M.ctx.resume() : M.ctx.suspend();
    wake();
  }
  function flash(name: string) {
    const f = $("#ss-flash");
    f.innerHTML = iconHtml(name, 34);
    f.classList.remove("go");
    void f.offsetWidth;
    f.classList.add("go");
  }
  function wake() {
    root.classList.remove("idle");
    clearTimeout(idleT);
    idleT = window.setTimeout(() => {
      if (playing && !overUI && !panel.classList.contains("on")) root.classList.add("idle");
    }, 2600);
  }
  function loop(now: number) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(80, now - last);
    last = now;
    if (playing) {
      t += dt;
      if (t >= dur) {
        t = 0;
        dur = 1e9;
        goSlide(i + 1, 1, { auto: true });
      }
    }
    const k = dur > 1e8 ? 0 : Math.min(1, t / dur);
    ring.style.strokeDashoffset = (RING * (1 - k)).toFixed(1);
    curTk?.style.setProperty("--p", `${(k * 100).toFixed(1)}%`);
    root.style.setProperty("--beat", playing ? beatPulse().toFixed(3) : "0");
  }
  function music(on: boolean) {
    if (on) {
      if (!musicStart()) return toast("Audio is unavailable here");
      if (!localStorage.getItem("sitara.music.told")) {
        localStorage.setItem("sitara.music.told", "1");
        toast("Soundtrack · composed live on this device · Tempo “Beat” cuts on the downbeat");
      }
      if (!playing) setPlay(true);
    } else musicStop();
    syncBar();
  }
  function syncBar() {
    $("#ss-music").classList.toggle("on", M.on);
    $("#ss-shuf").classList.toggle("on", opt.shuffle);
    $("#ss-style").classList.toggle("on", panel.classList.contains("on"));
    root.classList.toggle("nocap", !opt.caps);
  }
  const mini = (k: string) => {
    const n = k === "mosaic" ? 8 : k === "blinds" ? 5 : 0;
    return `<span class="mini m-${k}"><i class="b">${Array.from({ length: n }, (_, j) => `<s style="--k:${j}"></s>`).join("")}</i></span>`;
  };
  function renderPanel() {
    const tog = (k: keyof Opt, l: string, d: string) =>
      `<label class="switch"><input type="checkbox" data-opt="${k}"${opt[k] ? " checked" : ""}><i></i><span>${l}<small>${d}</small></span></label>`;
    panel.innerHTML = `<div class="sp-h"><b>Slideshow style</b><span>applies live</span></div>
      <div class="sp-l">Transition</div>
      <div class="fxg">${FXS.map((k) => `<button class="fxo${opt.fx === k ? " on" : ""}" data-fx="${k}">${mini(k)}<em>${FXN[k]}</em></button>`).join("")}</div>
      <div class="sp-l">Tempo</div>
      <div class="seg">${TEMPOS.map(([v, l, d]) => `<button data-tempo="${v}" class="${opt.tempo === v ? "on" : ""}">${l}<small>${d}</small></button>`).join("")}</div>
      <div class="sp-l">Framing</div>
      <div class="seg">${FRAMES.map(([v, l, d]) => `<button data-frame="${v}" class="${opt.frame === v ? "on" : ""}">${l}<small>${d}</small></button>`).join("")}</div>
      <div class="sp-tg">${tog("caps", "Captions", "date, time of day, camera")}${tog("chapters", "Chapter cards", "title card when the month changes")}${tog("shuffle", "Shuffle", "random order")}${tog("loop", "Loop", "start over at the end")}${tog("videos", "Include clips", "shown as stills for now")}</div>`;
  }
  function togglePanel(on?: boolean) {
    on = on ?? !panel.classList.contains("on");
    if (on) renderPanel();
    panel.classList.toggle("on", on);
    syncBar();
    wake();
  }
  function act(a: string) {
    const fns: Record<string, () => void> = {
      prev: () => goSlide(i - 1, -1),
      next: () => goSlide(i + 1, 1),
      pp: () => setPlay(!playing),
      fx: () => {
        opt.fx = FXS[(FXS.indexOf(opt.fx) + 1) % FXS.length];
        save();
        if (panel.classList.contains("on")) renderPanel();
        $("#ss-fxl").textContent = FXN[opt.fx];
        if (opt.fx !== "auto") goSlide(i + 1, 1);
      },
      music: () => music(!M.on),
      shuffle: () => {
        opt.shuffle = !opt.shuffle;
        rebuild();
        if (panel.classList.contains("on")) renderPanel();
        syncBar();
        toast(opt.shuffle ? "Shuffle on" : "Shuffle off · back in order");
      },
      style: () => togglePanel(),
      fs: () => {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.().then(() => (fsMine = true)).catch(() => {});
      },
      close: () => close(),
    };
    fns[a]?.();
  }
  function close() {
    if (dead) return;
    dead = true;
    tok++;
    cancelAnimationFrame(raf);
    anims.slice().forEach((a) => a.finish());
    clearTimeout(chapT);
    clearTimeout(idleT);
    if (M.on) musicStop();
    if (fsMine && document.fullscreenElement) document.exitFullscreen?.();
    root.classList.remove("open", "idle", "paused");
    removeEventListener("keydown", onKey, true);
    setTimeout(() => onClose(curSl?.[0].id ?? null), 420);
  }

  const onClick = (e: MouseEvent) => {
    const tg = e.target as HTMLElement;
    tg.closest("button")?.blur();
    if (panel.contains(tg)) {
      const f = tg.closest<HTMLElement>("[data-fx]");
      if (f) {
        opt.fx = f.dataset.fx!;
        save();
        renderPanel();
        $("#ss-fxl").textContent = FXN[opt.fx];
        if (opt.fx !== "auto") goSlide(i + 1, 1);
        return;
      }
      const tp = tg.closest<HTMLElement>("[data-tempo]");
      if (tp) {
        const v = tp.dataset.tempo!;
        opt.tempo = v === "beat" ? "beat" : +v;
        save();
        if (v === "beat" && !M.on) music(true);
        dur = Math.max(t + 300, tempoDur());
        renderPanel();
        return;
      }
      const fr = tg.closest<HTMLElement>("[data-frame]");
      if (fr) {
        opt.frame = fr.dataset.frame!;
        save();
        renderPanel();
        rebuild();
      }
      return;
    }
    const tk = tg.closest<HTMLElement>(".tk");
    if (tk) {
      const n = +tk.dataset.n!;
      goSlide(n, n >= i ? 1 : -1);
      return;
    }
    const b = tg.closest<HTMLElement>("[data-ss]");
    if (b) return act(b.dataset.ss!);
    if (tg.closest("#ss-bar,.ss-top")) return;
    if (panel.classList.contains("on")) return togglePanel(false);
    setPlay(!playing);
    flash(playing ? "play" : "pause");
  };
  const onChange = (e: Event) => {
    const el = e.target as HTMLInputElement,
      k = el.dataset.opt as keyof Opt | undefined;
    if (!k) return;
    (opt as Record<string, unknown>)[k] = el.checked;
    save();
    if (k === "shuffle" || k === "videos") rebuild();
    syncBar();
  };
  const onKey = (e: KeyboardEvent) => {
    if (store.get().palette) return;
    const k = e.key;
    wake();
    if (k === "Escape") panel.classList.contains("on") ? togglePanel(false) : close();
    else if (k === " " || k === "p" || k === "P" || k === "k" || k === "K") {
      setPlay(!playing);
      flash(playing ? "play" : "pause");
    } else if (k === "ArrowRight") goSlide(i + 1, 1);
    else if (k === "ArrowLeft") goSlide(i - 1, -1);
    else if (k === "t" || k === "T") act("fx");
    else if (k === "m" || k === "M") act("music");
    else if (k === "f" || k === "F") act("fs");
    else if (k === "s" || k === "S") act("style");
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onWheel = (e: WheelEvent) => {
    if (panel.contains(e.target as Node)) return;
    e.preventDefault();
    const now = performance.now();
    if (now - wh < 650) return;
    wh = now;
    e.deltaY > 0 ? goSlide(i + 1, 1) : goSlide(i - 1, -1);
  };
  const onPeek = (e: PointerEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".tk");
    if (!el) return;
    const n = +el.dataset.n!,
      sl = slides[n],
      p = sl[0],
      pk = $("#ss-peek"),
      r = el.getBoundingClientRect();
    pk.querySelector("img")!.src = thumbUrl(p.id, p.ver);
    pk.querySelector("span")!.textContent = `${n + 1} · ${fmtShortDay(p.taken)}${sl.length > 1 ? " · pair" : ""}`;
    pk.style.left = `${Math.max(96, Math.min(innerWidth - 96, r.left + r.width / 2))}px`;
    pk.classList.add("on");
  };
  const bar = $("#ss-bar");
  const onEnter = () => (overUI = true);
  const onLeave = () => {
    overUI = false;
    $("#ss-peek").classList.remove("on");
  };

  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("pointermove", wake);
  root.addEventListener("wheel", onWheel, { passive: false });
  $("#ss-ticks").addEventListener("pointerover", onPeek);
  bar.addEventListener("pointerenter", onEnter);
  bar.addEventListener("pointerleave", onLeave);
  addEventListener("keydown", onKey, true);

  // open
  build();
  let n = 0;
  if (req.start != null) {
    n = slides.findIndex((sl) => sl.some((p) => p.id === req.start));
    if (n < 0) n = 0;
  }
  renderTicks();
  requestAnimationFrame(() => root.classList.add("open"));
  setPlay(true);
  syncBar();
  if (opt.tempo === "beat" && !M.on) music(true);
  raf = requestAnimationFrame(loop);
  goSlide(n, 1, { fx: req.rect && !reduce ? "flip" : "rise", force: true });

  return () => {
    close();
    root.removeEventListener("click", onClick);
    root.removeEventListener("change", onChange);
    root.removeEventListener("pointermove", wake);
    root.removeEventListener("wheel", onWheel);
    bar.removeEventListener("pointerenter", onEnter);
    bar.removeEventListener("pointerleave", onLeave);
    stage.innerHTML = "";
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function Slideshow() {
  const req = useStore((s) => s.show);
  const lib = useStore(libOf);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!req || !lib || !root.current) return;
    document.body.classList.add("showing");
    const dispose = createPlayer(root.current, lib, req, (lastId) => {
      store.set({ show: null });
      if (lastId == null) return;
      const v = store.get().viewer;
      if (v) {
        const k = v.ids.indexOf(lastId);
        if (k >= 0) store.set({ viewer: { ids: v.ids, idx: k } });
      } else activeGrid.reveal(lastId, true);
    });
    return () => {
      dispose();
      document.body.classList.remove("showing");
    };
    // the player owns its lifecycle; restart only for a new request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);
  if (!req) return null;
  return (
    <div id="show" ref={root} aria-label="Slideshow">
      <div id="ss-stage" />
      <div className="ss-vig" />
      <div id="ss-chap" aria-hidden="true" />
      <div id="ss-cap" />
      <div id="ss-flash" className="glass" />
      <div className="ss-top ss-ui">
        <div className="ss-tag glass">
          <i />
          <b>Slideshow</b>
          <span id="ss-label" />
        </div>
        <div className="ss-tr">
          <button className="vbtn glass" data-ss="fs" title="Fullscreen (F)" dangerouslySetInnerHTML={{ __html: iconHtml("expand") }} />
          <button className="vbtn glass" data-ss="close" title="Close (Esc)" dangerouslySetInnerHTML={{ __html: iconHtml("x") }} />
        </div>
      </div>
      <div id="ss-panel" className="glass" />
      <div id="ss-peek" className="glass">
        <img alt="" />
        <span />
      </div>
      <div id="ss-bar" className="glass ss-ui">
        <div id="ss-ticks" />
        <div className="ss-row">
          <button className="vbtn" data-ss="prev" title="Previous (←)" dangerouslySetInnerHTML={{ __html: iconHtml("left") }} />
          <button id="ss-pp" data-ss="pp" title="Play / pause (Space)">
            <svg viewBox="0 0 60 60">
              <circle cx="30" cy="30" r="28" />
              <circle className="pr" id="ss-ring" cx="30" cy="30" r="28" />
            </svg>
            <span id="ss-ppi" />
          </button>
          <button className="vbtn" data-ss="next" title="Next (→)" dangerouslySetInnerHTML={{ __html: iconHtml("right") }} />
          <div className="ss-count">
            <b id="ss-n" />
            <span id="ss-where" />
          </div>
          <button className="ss-fx" data-ss="fx" title="Change transition (T)">
            <i />
            <span id="ss-fxl" />
          </button>
          <div className="ss-sp" />
          <button className="vbtn" data-ss="music" id="ss-music" title="Soundtrack, composed on device (M)">
            <span className="eq">
              <i />
              <i />
              <i />
              <i />
            </span>
            <span>Soundtrack</span>
          </button>
          <button className="vbtn" data-ss="shuffle" id="ss-shuf" title="Shuffle" dangerouslySetInnerHTML={{ __html: iconHtml("shuffle") }} />
          <button className="vbtn" data-ss="style" id="ss-style" title="Style (S)">
            <span dangerouslySetInnerHTML={{ __html: iconHtml("sliders") }} />
            <span>Style</span>
          </button>
        </div>
      </div>
    </div>
  );
}
