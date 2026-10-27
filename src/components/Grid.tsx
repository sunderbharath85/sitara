import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { thumbUrl, type Lib } from "../lib/api";
import { startShow } from "../lib/actions";
import { fmtDur, fmtNum, plural } from "../lib/format";
import { firstVisible, layoutGrid, type Layout, type Section, type Tile } from "../lib/layout";
import { setSel, store, useStore } from "../lib/store";
import { Icon } from "./Icon";

/** The grid currently on screen, so the viewer, slideshow and keyboard can talk to it. */
export const activeGrid: {
  ids: () => number[];
  rectOf: (id: number) => DOMRect | null;
  reveal: (id: number, flash?: boolean) => void;
} = { ids: () => [], rectOf: () => null, reveal: () => {} };

const loaded = new Set<string>();
const OVERSCAN = 900;

interface Props {
  lib: Lib;
  order: ArrayLike<number>;
  group: boolean;
  rail?: boolean;
  active: boolean;
  label: string;
  header?: ReactNode;
  empty?: ReactNode;
  scrollKey?: string;
}

const TileView = memo(function TileView({ t, id, ver, kind, dur, fav, sel }: { t: Tile; id: number; ver: number; kind: number; dur: number; fav: number; sel: boolean }) {
  const src = thumbUrl(id, ver);
  return (
    <figure
      className={`tile${sel ? " sel" : ""}`}
      data-id={id}
      style={{ transform: `translate3d(${t.x}px,${t.y}px,0)`, width: t.w, height: t.h }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        decoding="async"
        className={loaded.has(src) ? "in" : ""}
        onLoad={(e) => {
          loaded.add(src);
          e.currentTarget.classList.add("in");
        }}
        onError={(e) => e.currentTarget.classList.add("err")}
      />
      <span className="sheen" />
      <button className="check" aria-label="Select" tabIndex={-1}>
        <Icon n="check" s={13} />
      </button>
      {kind === 1 && <span className="vbadge">▶ {fmtDur(dur)}</span>}
      {fav ? (
        <span className="favb">
          <Icon n="heart" s={11} />
        </span>
      ) : null}
    </figure>
  );
});

function SectionHead({ s, rel, onSelect, label }: { s: Section; rel: number; onSelect: () => void; label: string }) {
  const lib = store.get().lib!;
  return (
    <div className="sec-head" style={{ transform: `translateY(${s.y}px)` }}>
      <div
        className="ghost"
        aria-hidden="true"
        style={{ transform: `translate3d(${Math.max(-40, Math.min(40, rel * 0.05)).toFixed(1)}px,${Math.max(-70, Math.min(70, rel * -0.14)).toFixed(1)}px,0)` }}
      >
        {s.ghost}
      </div>
      <div className="sec-title">
        <div className="kicker">
          <span>{s.year}</span>
        </div>
        <h2>{s.title}</h2>
        <div className="stats">
          {plural(s.photos, "photo")}
          {s.videos ? ` · ${plural(s.videos, "video")}` : ""}
        </div>
      </div>
      <div className="head-acts">
        <button className="play-btn alt" onClick={onSelect} title="Select this month">
          <span>
            <Icon n="check" s={12} />
          </span>
          <span>Select</span>
        </button>
        <button className="play-btn" onClick={() => startShow(s.items.map((i) => lib.id[i]), `${label} · ${s.title}`)} title="Slideshow of this month">
          <span>
            <Icon n="slides" s={12} />
          </span>
          <span>Slideshow</span>
        </button>
      </div>
    </div>
  );
}

function Rail({ layout, top, onJump }: { layout: Layout; top: number; onJump: (y: number) => void }) {
  const cur = useMemo(() => {
    let c = layout.sections[0];
    for (const s of layout.sections) if (s.y <= top + 160) c = s;
    return c;
  }, [layout, top]);
  const years = useMemo(() => {
    const m = new Map<number, Section[]>();
    layout.sections.forEach((s) => m.set(s.year, [...(m.get(s.year) ?? []), s]));
    return [...m];
  }, [layout]);
  if (layout.sections.length < 2) return null;
  const max = Math.max(...layout.sections.map((s) => s.items.length));
  return (
    <nav id="rail" className="glass" aria-label="Timeline">
      {years.map(([y, secs]) => (
        <div key={y} className="rail-yg">
          <button className={`rail-y${cur?.year === y ? " on" : ""}`} onClick={() => onJump(secs[0].y)}>
            {y}
          </button>
          {cur?.year === y &&
            secs.map((s) => (
              <button key={s.key} className={`rail-i${s === cur ? " on" : ""}`} onClick={() => onJump(s.y)} title={`${s.title} · ${fmtNum(s.items.length)}`}>
                <span>{s.ghost}</span>
                <b style={{ width: 6 + Math.round((s.items.length / max) * 22) }} />
              </button>
            ))}
        </div>
      ))}
    </nav>
  );
}

export function Grid({ lib, order, group, rail, active, label, header, empty, scrollKey }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [vh, setVh] = useState(800);
  const [top, setTop] = useState(0);
  const [canvasTop, setCanvasTop] = useState(0);
  const sel = useStore((s) => s.sel);
  useStore((s) => s.favVer);
  const libVer = useStore((s) => s.libVer);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setVh(el.clientHeight);
      setCanvasTop(canvas.current?.offsetTop ?? 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [scrollKey]);

  const wide = rail && width > 900;
  const layout = useMemo(() => {
    if (!width) return null;
    const rowH = width < 700 ? 150 : width < 1100 ? 190 : 224;
    const pad = width < 700 ? 12 : 24;
    return layoutGrid(lib, order, width, {
      rowH,
      gap: 4,
      padL: pad,
      padR: wide ? 104 : pad,
      headH: group ? 176 : 0,
      sectionGap: 48,
      group,
      top: 0,
    });
    // libVer: favorites/trash mutate lib in place
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, order, width, group, wide, libVer]);

  const ticking = useRef(false);
  const onScroll = () => {
    if (ticking.current) return;
    ticking.current = true;
    requestAnimationFrame(() => {
      ticking.current = false;
      const el = scroller.current;
      if (!el) return;
      setTop(el.scrollTop - canvasTop);
      document.body.classList.toggle("scrolled", el.scrollTop > 10);
    });
  };
  useEffect(() => {
    if (active) document.body.classList.toggle("scrolled", (scroller.current?.scrollTop ?? 0) > 10);
  }, [active]);

  const posInOrder = useMemo(() => {
    const m = new Map<number, number>();
    for (let k = 0; k < order.length; k++) m.set(lib.id[order[k]], k);
    return m;
  }, [lib, order]);
  const tileOf = useMemo(() => {
    const m = new Map<number, Tile>();
    layout?.tiles.forEach((t) => m.set(lib.id[t.i], t));
    return m;
  }, [layout, lib]);

  const ids = useCallback(() => Array.from(order, (i) => lib.id[i]), [order, lib]);
  useEffect(() => {
    if (!active) return;
    activeGrid.ids = ids;
    activeGrid.rectOf = (id) => {
      const t = tileOf.get(id);
      const el = scroller.current;
      if (!t || !el) return null;
      const r = el.getBoundingClientRect();
      const y = r.top + canvasTop + t.y - el.scrollTop;
      if (y + t.h < r.top || y > r.bottom) return null;
      return new DOMRect(r.left + t.x, y, t.w, t.h);
    };
    activeGrid.reveal = (id, flash) => {
      const t = tileOf.get(id);
      const el = scroller.current;
      if (!t || !el) return;
      const y = canvasTop + t.y;
      if (y < el.scrollTop + 80 || y + t.h > el.scrollTop + el.clientHeight - 100)
        el.scrollTo({ top: Math.max(0, y - el.clientHeight / 2 + t.h / 2) });
      if (flash)
        requestAnimationFrame(() => {
          const f = el.querySelector<HTMLElement>(`.tile[data-id="${id}"]`);
          if (!f) return;
          f.classList.remove("flash");
          void f.offsetWidth;
          f.classList.add("flash");
          setTimeout(() => f.classList.remove("flash"), 1800);
        });
    };
  }, [active, ids, tileOf, canvasTop]);

  // ---------- selection: click, ctrl/shift-click, lasso ----------
  const anchor = useRef<number | null>(null);
  const onClick = (e: React.MouseEvent) => {
    const fig = (e.target as HTMLElement).closest<HTMLElement>(".tile");
    if (!fig) return;
    const id = +fig.dataset.id!;
    const s = store.get().sel;
    if ((e.target as HTMLElement).closest(".check") || e.ctrlKey || e.metaKey || e.shiftKey || s.size) {
      const next = new Set(e.shiftKey || e.ctrlKey || e.metaKey || s.size ? s : []);
      if (e.shiftKey && anchor.current != null) {
        const a = posInOrder.get(anchor.current) ?? 0,
          b = posInOrder.get(id) ?? 0;
        for (let k = Math.min(a, b); k <= Math.max(a, b); k++) next.add(lib.id[order[k]]);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
      setSel(next);
      return;
    }
    store.set({ viewer: { ids: ids(), idx: posInOrder.get(id) ?? 0, from: fig.getBoundingClientRect() } });
  };

  const lasso = useRef<{ x: number; y: number; base: Set<number>; moved: boolean } | null>(null);
  const [marq, setMarq] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const toCanvas = (cx: number, cy: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".tile,button,a,input,.sec-head .head-acts") || !canvas.current) return;
    if (!canvas.current.contains(e.target as Node) && e.target !== scroller.current) return;
    const p = toCanvas(e.clientX, e.clientY);
    lasso.current = { ...p, base: new Set(e.ctrlKey || e.shiftKey || e.metaKey ? store.get().sel : []), moved: false };
    scroller.current!.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const fig = (e.target as HTMLElement).closest<HTMLElement>(".tile");
    if (fig) {
      const r = fig.getBoundingClientRect();
      fig.style.setProperty("--mx", `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
      fig.style.setProperty("--my", `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
    }
    const L = lasso.current;
    if (!L || !layout) return;
    const p = toCanvas(e.clientX, e.clientY);
    const x1 = Math.min(L.x, p.x),
      y1 = Math.min(L.y, p.y),
      x2 = Math.max(L.x, p.x),
      y2 = Math.max(L.y, p.y);
    if (!L.moved && x2 - x1 + (y2 - y1) < 8) return;
    L.moved = true;
    document.body.classList.add("dragging");
    setMarq({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    const next = new Set(L.base);
    for (let k = firstVisible(layout.tiles, y1); k < layout.tiles.length; k++) {
      const t = layout.tiles[k];
      if (t.y > y2) break;
      if (t.x + t.w > x1 && t.x < x2 && t.y + t.h > y1) next.add(lib.id[t.i]);
    }
    setSel(next);
  };
  const onPointerUp = () => {
    if (!lasso.current) return;
    if (!lasso.current.moved && !lasso.current.base.size) setSel([]);
    lasso.current = null;
    setMarq(null);
    document.body.classList.remove("dragging");
  };

  if (!layout) return <div className="scroller" ref={scroller} />;

  const t0 = firstVisible(layout.tiles, top - OVERSCAN);
  const visible: Tile[] = [];
  for (let k = t0; k < layout.tiles.length; k++) {
    const t = layout.tiles[k];
    if (t.y > top + vh + OVERSCAN) break;
    visible.push(t);
  }
  const heads = layout.sections.filter((s, k) => {
    const next = layout.sections[k + 1]?.y ?? layout.height;
    return s.y < top + vh + OVERSCAN && next > top - OVERSCAN;
  });

  return (
    <div
      className="scroller"
      ref={scroller}
      onScroll={onScroll}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {header}
      {order.length === 0 ? (
        empty
      ) : (
        <div className="canvas" ref={canvas} style={{ height: layout.height }}>
          {heads.map((s) => (
            <SectionHead
              key={s.key}
              s={s}
              rel={s.y - top}
              label={label}
              onSelect={() => setSel(new Set([...store.get().sel, ...s.items.map((i) => lib.id[i])]))}
            />
          ))}
          {visible.map((t) => {
            const id = lib.id[t.i];
            return <TileView key={id} t={t} id={id} ver={lib.ver[t.i]} kind={lib.kind[t.i]} dur={lib.dur[t.i]} fav={lib.fav[t.i]} sel={sel.has(id)} />;
          })}
          {marq && <div className="marquee" style={{ left: marq.x, top: marq.y, width: marq.w, height: marq.h }} />}
        </div>
      )}
      {rail && wide && active && group && <Rail layout={layout} top={top} onJump={(y) => scroller.current?.scrollTo({ top: canvasTop + y - 20, behavior: "smooth" })} />}
    </div>
  );
}
