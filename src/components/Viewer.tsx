import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { analyze, drawHist, type Analysis } from "../lib/analyze";
import { api, detailCached, inTauri, mediaSrc, thumbUrl, type Lib, type MediaDetail } from "../lib/api";
import { openPicker, setFavorite, startShow, trash, where } from "../lib/actions";
import { aspect } from "../lib/layout";
import { basename, camera, fmtDay, fmtDur, fmtMonth, fmtNum, fmtSize, fmtTime } from "../lib/format";
import { store, useStore } from "../lib/store";
import { activeGrid } from "./Grid";
import { Icon } from "./Icon";
import { toast } from "./Toasts";

const EASE = "cubic-bezier(.2,.8,.2,1)";
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

function fit(ar: number, hud: boolean) {
  const side = hud && innerWidth > 1100 ? 306 : 28,
    top = 84,
    bottom = 104;
  const aw = innerWidth - side * 2,
    ah = innerHeight - top - bottom;
  let w = aw,
    h = w / ar;
  if (h > ah) {
    h = ah;
    w = h * ar;
  }
  return { left: (innerWidth - w) / 2, top: top + (ah - h) / 2, width: w, height: h };
}

const flipFrom = (from: DOMRect, to: { left: number; top: number; width: number; height: number }) =>
  `translate(${from.left - to.left}px,${from.top - to.top}px) scale(${from.width / to.width},${from.height / to.height})`;

export function Viewer() {
  const v = useStore((s) => s.viewer);
  const lib = useStore((s) => s.lib);
  if (!v || !lib) return null;
  return <ViewerInner v={v} lib={lib} />;
}

function ViewerInner({ v, lib }: { v: NonNullable<ReturnType<typeof store.get>["viewer"]>; lib: Lib }) {
  useStore((s) => s.favVer);
  const id = v.ids[v.idx];
  const i = lib.pos.get(id);
  const ar = i != null ? aspect(lib, i) : 1.5;
  const [hud, setHud] = useState(() => localStorage.getItem("sitara.hud") !== "0");
  const [, setSize] = useState(0);
  const [d, setD] = useState<MediaDetail | null>(null);
  const [full, setFull] = useState<string | null>(null);
  const [videoErr, setVideoErr] = useState(false);
  const [an, setAn] = useState<Analysis | null>(null);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const hist = useRef<HTMLCanvasElement>(null);
  const prevIdx = useRef(v.idx);
  const r = fit(ar, hud);
  const thumb = i != null ? thumbUrl(id, lib.ver[i]) : "";
  const isVideo = i != null && lib.kind[i] === 1;

  // open: zoom out of the tile
  useLayoutEffect(() => {
    setOpen(true);
    document.body.classList.add("viewing");
    if (v.from && stage.current && !reduce)
      stage.current.animate([{ transform: flipFrom(v.from, r), borderRadius: "6px" }, { transform: "none", borderRadius: "10px" }], { duration: 540, easing: EASE });
    return () => document.body.classList.remove("viewing");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const f = () => setSize((n) => n + 1);
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);

  // per item: details, full-res swap, neighbours prefetch, pixel analysis
  useEffect(() => {
    let live = true;
    setFull(null);
    setD(null);
    setAn(null);
    setVideoErr(false);
    setZ({ s: 1, x: 0, y: 0 });
    if (prevIdx.current !== v.idx && stage.current && !reduce) {
      const dir = v.idx > prevIdx.current ? 1 : -1;
      stage.current.animate([{ opacity: 0, transform: `translateX(${dir * 46}px) scale(.98)` }, { opacity: 1, transform: "none" }], { duration: 340, easing: EASE });
    }
    prevIdx.current = v.idx;
    activeGrid.reveal(id);
    detailCached(id).then((det) => {
      if (!live || !det) return;
      setD(det);
      if (det.kind === 0) {
        const src = mediaSrc(det);
        const im = new Image();
        im.decoding = "async";
        im.onload = () => live && setFull(src);
        im.src = src;
      }
    });
    if (thumb) analyze(thumb).then((a) => live && setAn(a));
    for (const k of [v.idx + 1, v.idx - 1, v.idx + 2]) {
      const nid = v.ids[k];
      if (nid == null) continue;
      detailCached(nid).then((det) => {
        if (det && det.kind === 0) new Image().src = mediaSrc(det);
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (an && hist.current) drawHist(hist.current, an.hist);
  }, [an, hud]);

  const go = useCallback(
    (n: number) => {
      if (n < 0 || n >= v.ids.length) return;
      store.set({ viewer: { ...v, idx: n, from: undefined } });
    },
    [v],
  );

  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    const to = activeGrid.rectOf(id);
    const el = stage.current;
    const done = () => store.set({ viewer: null });
    if (to && el && !reduce && z.s === 1) {
      const cur = el.getBoundingClientRect();
      el.animate([{ transform: "none" }, { transform: flipFrom(to, cur), borderRadius: "6px" }], { duration: 420, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }).onfinish = done;
      if (to) activeGrid.reveal(id, true);
    } else setTimeout(done, reduce ? 0 : 220);
  }, [closing, id, z.s]);

  const toggleHud = () => {
    const before = stage.current?.getBoundingClientRect();
    const next = !hud;
    setHud(next);
    localStorage.setItem("sitara.hud", next ? "1" : "0");
    if (before && stage.current && !reduce) {
      const after = fit(ar, next);
      stage.current.animate([{ transform: flipFrom(before, after) }, { transform: "none" }], { duration: 480, easing: EASE });
    }
  };
  const fav = i != null && lib.fav[i] === 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (store.get().show || store.get().palette || store.get().picker) return;
      const k = e.key;
      if (k === "Escape") close();
      else if (k === "ArrowRight") go(v.idx + 1);
      else if (k === "ArrowLeft") go(v.idx - 1);
      else if (k === "i" || k === "I") toggleHud();
      else if (k === "f" || k === "F") setFavorite([id], !fav);
      else if (k === "p" || k === "P") startShow(v.ids, "Viewer", { start: id, rect: stage.current?.getBoundingClientRect() });
      else if (k === "Delete") trash([id]);
      else if (k === "a" || k === "A") openPicker([id]);
      else if (k === "0") setZ({ s: 1, x: 0, y: 0 });
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  });

  // ---------- zoom & pan ----------
  const drag = useRef<{ x: number; y: number; zx: number; zy: number } | null>(null);
  const zoomAt = (cx: number, cy: number, s: number) => {
    s = Math.min(Math.max(s, 1), Math.max(4, (d?.width ?? 0) / r.width * 2));
    if (s === 1) return setZ({ s: 1, x: 0, y: 0 });
    const px = cx - r.left,
      py = cy - r.top;
    setZ((o) => ({ s, x: px - ((px - o.x) * s) / o.s, y: py - ((py - o.y) * s) / o.s }));
  };
  const onWheel = (e: React.WheelEvent) => {
    if (isVideo) return;
    zoomAt(e.clientX, e.clientY, z.s * Math.exp(-e.deltaY * 0.0018));
  };
  const onDouble = (e: React.MouseEvent) => {
    if (isVideo) return;
    if (z.s > 1) setZ({ s: 1, x: 0, y: 0 });
    else zoomAt(e.clientX, e.clientY, Math.max(2, (d?.width ?? r.width * 2) / r.width));
  };

  const src = full ?? thumb;
  const strip = v.ids.slice(Math.max(0, Math.min(v.idx - 7, v.ids.length - 15)), Math.max(0, Math.min(v.idx - 7, v.ids.length - 15)) + 15);

  const openDir = async () => {
    if (!d) return;
    const ids = await api.dirItems(d.dir);
    store.set({ viewer: null, view: "albums", album: { kind: "dir", dir: d.dir, title: basename(d.dir), ids } });
  };

  return (
    <div id="viewer" className={`${open ? "open" : ""}${closing ? " closing" : ""}${hud ? "" : " hud-off"}`} style={an ? ({ "--amb": an.pal[0] } as React.CSSProperties) : undefined}>
      <div id="v-bg" onClick={close} />
      {thumb && <img id="v-amb" alt="" src={thumb} />}
      <div
        className={`v-stage${z.s > 1 ? " zoomed" : ""}`}
        ref={stage}
        style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
        onWheel={onWheel}
        onDoubleClick={onDouble}
        onPointerDown={(e) => {
          if (z.s <= 1 || e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, zx: z.x, zy: z.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (g) setZ((o) => ({ ...o, x: g.zx + e.clientX - g.x, y: g.zy + e.clientY - g.y }));
        }}
        onPointerUp={() => (drag.current = null)}
      >
        {isVideo && d && inTauri && !videoErr ? (
          <video key={id} src={mediaSrc(d)} poster={thumb} controls autoPlay playsInline onError={() => setVideoErr(true)} />
        ) : (
          <img alt={d?.name ?? ""} src={src} draggable={false} style={{ transform: `translate(${z.x}px,${z.y}px) scale(${z.s})` }} />
        )}
        {isVideo && (videoErr || !inTauri) && (
          <div className="v-novideo glass">
            <b>{inTauri ? "This format can't play inside Sitara yet" : "Video plays in the desktop app"}</b>
            {inTauri && (
              <button className="btn" onClick={() => api.openExternal(id)}>
                Open in default player
              </button>
            )}
          </div>
        )}
      </div>

      <div className="v-top glass v-chrome">
        <button className="vbtn" onClick={close}>
          <Icon n="left" />
          <span>Back</span>
        </button>
        <div className="v-name">
          <b>{d?.name ?? " "}</b>
          <span>
            {fmtNum(v.idx + 1)} / {fmtNum(v.ids.length)}
            {i != null ? ` · ${fmtMonth(lib.taken[i])}` : ""}
          </span>
        </div>
        <div className="v-acts">
          <button className={`vbtn${fav ? " fav-on" : ""}`} onClick={() => setFavorite([id], !fav)} title="Favorite (F)">
            <Icon n="heart" />
          </button>
          <button className={`vbtn${hud ? " on" : ""}`} onClick={toggleHud} title="Info (I)">
            <Icon n="info" />
          </button>
          <button className="vbtn" onClick={() => openPicker([id])} title="Add to album (A)">
            <Icon n="plus" />
          </button>
          <button className="vbtn" onClick={() => startShow(v.ids, "Viewer", { start: id, rect: stage.current?.getBoundingClientRect() })} title="Slideshow from here (P)">
            <Icon n="slides" />
            <span>Slideshow</span>
          </button>
          <button className="vbtn" onClick={() => api.reveal(id).catch((e) => toast(String(e)))} title={`Show in ${where}`}>
            <Icon n="reveal" />
          </button>
          <button className="vbtn" onClick={() => trash([id])} title="Move to Recycle Bin (Del)">
            <Icon n="trash" />
          </button>
          <button className="vbtn" onClick={close} title="Close (Esc)">
            <Icon n="x" />
          </button>
        </div>
      </div>

      <aside className="hud l">
        <div className="hud-card glass" style={{ "--d": 0 } as React.CSSProperties}>
          <div className="h-label">Moment</div>
          {i != null && (
            <>
              <div className="h-big">{fmtDay(lib.taken[i])}</div>
              <div className="h-sub">{fmtTime(lib.taken[i])}</div>
            </>
          )}
          {d && (
            <button className="h-link" onClick={openDir}>
              In <b>{basename(d.dir)}</b> →
            </button>
          )}
        </div>
        {d && (
          <div className="hud-card glass" style={{ "--d": 1 } as React.CSSProperties}>
            <div className="h-label">
              Capture {d.kind === 1 && d.duration ? <span>video · {fmtDur(d.duration)}</span> : null}
            </div>
            <div className="h-big">{camera(d.make, d.model) || (d.kind === 1 ? "Video clip" : "Unknown camera")}</div>
            {d.lens && <div className="h-sub">{d.lens}</div>}
            {(d.fnumber || d.exposure || d.iso || d.focal) && (
              <div className="metrics">
                <div>
                  <b>{d.fnumber ? `ƒ/${+d.fnumber.toFixed(1)}` : "—"}</b>
                  <span>Aperture</span>
                </div>
                <div>
                  <b>{d.exposure ?? "—"}</b>
                  <span>Shutter</span>
                </div>
                <div>
                  <b>{d.iso ?? "—"}</b>
                  <span>ISO</span>
                </div>
                <div>
                  <b>{d.focal ? `${Math.round(d.focal)}mm` : "—"}</b>
                  <span>Focal</span>
                </div>
              </div>
            )}
          </div>
        )}
        {d && (
          <div className="hud-card glass" style={{ "--d": 2 } as React.CSSProperties}>
            <div className="h-label">
              File <span>{d.ext.toUpperCase()}</span>
            </div>
            <div className="h-file">
              {d.name}
              <br />
              {fmtSize(d.size)}
              {d.width ? ` · ${d.width}×${d.height}` : ""}
            </div>
            <div className="h-path" title={d.path}>
              {d.dir}
            </div>
            <div className="h-btns">
              <button className="btn sm" onClick={() => api.reveal(id).catch((e) => toast(String(e)))}>
                <Icon n="reveal" s={14} />
                Show in {where}
              </button>
              <button className="btn sm" onClick={() => api.openExternal(id).catch((e) => toast(String(e)))}>
                Open
              </button>
            </div>
          </div>
        )}
        {d?.lat != null && d.lon != null && (
          <div className="hud-card glass" style={{ "--d": 3 } as React.CSSProperties}>
            <div className="h-label">Place</div>
            <div className="h-big mono">
              {d.lat.toFixed(4)}°, {d.lon.toFixed(4)}°
            </div>
            <button className="h-link" onClick={() => api.openUrl(`https://www.openstreetmap.org/?mlat=${d.lat}&mlon=${d.lon}#map=15/${d.lat}/${d.lon}`)}>
              Open in <b>OpenStreetMap</b> ↗
            </button>
          </div>
        )}
      </aside>

      <aside className="hud r">
        <div className="hud-card glass" style={{ "--d": 1 } as React.CSSProperties}>
          <div className="h-label">
            Histogram <span>RGB</span>
          </div>
          <canvas ref={hist} className="hist" />
          <div className="h-sub mono hexp">{an?.expo ?? "reading pixels…"}</div>
        </div>
        <div className="hud-card glass" style={{ "--d": 2 } as React.CSSProperties}>
          <div className="h-label">
            Palette <span>click to copy</span>
          </div>
          <div className="swatches">
            {an?.pal.map((h, k) => (
              <button
                key={k}
                style={{ "--c": h } as React.CSSProperties}
                title={`Copy ${h}`}
                onClick={() => {
                  navigator.clipboard?.writeText(h).catch(() => {});
                  toast(`Copied ${h}`);
                }}
              >
                <i />
                <span>{h}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="hud-card glass" style={{ "--d": 3 } as React.CSSProperties}>
          <div className="h-label">
            Mood <span>computed locally</span>
          </div>
          <div className="tags">{an?.tags.map((t) => <span key={t}>{t}</span>)}</div>
        </div>
      </aside>

      <div className="filmstrip glass v-chrome">
        <button className="vbtn" onClick={() => go(v.idx - 1)} aria-label="Previous">
          <Icon n="left" />
        </button>
        <div className="film-in">
          {strip.map((sid) => {
            const k = lib.pos.get(sid);
            if (k == null) return null;
            return (
              <img
                key={sid}
                alt=""
                src={thumbUrl(sid, lib.ver[k])}
                className={sid === id ? "on" : ""}
                style={{ width: Math.round(58 * aspect(lib, k)) }}
                onClick={() => go(v.ids.indexOf(sid))}
              />
            );
          })}
        </div>
        <button className="vbtn" onClick={() => go(v.idx + 1)} aria-label="Next">
          <Icon n="right" />
        </button>
      </div>
    </div>
  );
}
