// Direct manipulation on the photo: the crop frame, mask handles, brush and heal spots.
import { useRef, useState } from "react";
import { aspectOf, ap, constrain, frame } from "../../lib/edit/geometry";
import type { Crop, Geo, Mask, Pt, Spot, Stroke } from "../../lib/edit/stack";
import type { Layout } from "../../lib/edit/view";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ---------- crop ----------

const HANDLES: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

export function CropOverlay({ L, geo, W, H, onChange }: { L: Layout; geo: Geo; W: number; H: number; onChange: (g: Geo, commit: boolean) => void }) {
  const drag = useRef<{ kind: "move" | "size" | "turn"; hx: number; hy: number; x: number; y: number; c0: Crop; a0: number; ang0: number; last: Geo } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const c = geo.crop;
  const [x0, y0] = L.normToCss!(c.x, c.y);
  const [x1, y1] = L.normToCss!(c.x + c.w, c.y + c.h);
  const [fw, fh] = frame(W, H, geo);
  const asp = aspectOf(geo.aspect, W, H, geo);

  const start = (e: React.PointerEvent, kind: "move" | "size" | "turn", hx = 0, hy = 0) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const cx = (x0 + x1) / 2,
      cy = (y0 + y1) / 2;
    drag.current = { kind, hx, hy, x: e.clientX, y: e.clientY, c0: { ...c }, a0: geo.angle, ang0: Math.atan2(e.clientY - cy, e.clientX - cx), last: geo };
    setDragging(kind);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const stage = (e.currentTarget as HTMLElement).closest(".ed-stage")!.getBoundingClientRect();
    if (d.kind === "turn") {
      const cx = stage.left + (x0 + x1) / 2,
        cy = stage.top + (y0 + y1) / 2;
      let da = Math.atan2(e.clientY - cy, e.clientX - cx) - d.ang0;
      if (da > Math.PI) da -= Math.PI * 2;
      if (da < -Math.PI) da += Math.PI * 2;
      const deg = clamp(d.a0 + (da * 180) / Math.PI, -45, 45);
      const g = { ...geo, angle: Math.round(deg * 10) / 10 };
      d.last = g;
      onChange(g, false);
      return;
    }
    const [ax, ay] = L.cssToNorm!(d.x - stage.left, d.y - stage.top);
    const [bx, by] = L.cssToNorm!(e.clientX - stage.left, e.clientY - stage.top);
    const dx = bx - ax,
      dy = by - ay;
    let want: Crop;
    if (d.kind === "move") want = { ...d.c0, x: d.c0.x + dx, y: d.c0.y + dy };
    else {
      let l = d.c0.x,
        t = d.c0.y,
        r = d.c0.x + d.c0.w,
        b = d.c0.y + d.c0.h;
      if (d.hx < 0) l = Math.min(r - 0.03, l + dx);
      if (d.hx > 0) r = Math.max(l + 0.03, r + dx);
      if (d.hy < 0) t = Math.min(b - 0.03, t + dy);
      if (d.hy > 0) b = Math.max(t + 0.03, b + dy);
      want = { x: l, y: t, w: r - l, h: b - t };
      if (asp) {
        // normalized w/h for this pixel aspect
        const na = (asp * fh) / fw;
        if (d.hx && d.hy) {
          if (want.w / want.h > na) want.w = want.h * na;
          else want.h = want.w / na;
          if (d.hx < 0) want.x = r - want.w;
          if (d.hy < 0) want.y = b - want.h;
        } else if (d.hx) {
          want.h = want.w / na;
          want.y = d.c0.y + d.c0.h / 2 - want.h / 2;
        } else {
          want.w = want.h * na;
          want.x = d.c0.x + d.c0.w / 2 - want.w / 2;
        }
      }
    }
    const g = { ...geo, auto: false, crop: constrain(W, H, geo, d.last.crop, want) };
    d.last = g;
    onChange(g, false);
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (d) onChange(d.last, true);
  };

  return (
    <div className="crop-ui" onPointerDown={(e) => start(e, "turn")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <div
        className={`crop-box${dragging ? " drag" : ""}`}
        style={{ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }}
        onPointerDown={(e) => start(e, "move")}
        onPointerMove={move}
        onPointerUp={end}
      >
        <i className="third v1" />
        <i className="third v2" />
        <i className="third h1" />
        <i className="third h2" />
        {dragging === "turn" && <i className="grid-fine" />}
        {HANDLES.map(([hx, hy]) => (
          <b
            key={`${hx}${hy}`}
            className={`crh ${hx && hy ? "corner" : hx ? "side-x" : "side-y"}`}
            style={{ left: `${(hx + 1) * 50}%`, top: `${(hy + 1) * 50}%`, cursor: hx && hy ? (hx * hy > 0 ? "nwse-resize" : "nesw-resize") : hx ? "ew-resize" : "ns-resize" }}
            onPointerDown={(e) => start(e, "size", hx, hy)}
            onPointerMove={move}
            onPointerUp={end}
          />
        ))}
        <span className="crop-dim mono">
          {Math.round(c.w * fw)} × {Math.round(c.h * fh)}
        </span>
      </div>
      {dragging === "turn" && <div className="turn-read mono">{geo.angle.toFixed(1)}°</div>}
    </div>
  );
}

// ---------- masks ----------

export function MaskOverlay({
  L,
  mask,
  index,
  masks,
  brush,
  onChange,
  onSelect,
  onStroke,
}: {
  L: Layout;
  mask: Mask | null;
  index: number;
  masks: Mask[];
  brush: { size: number; erase: boolean };
  onChange: (m: Mask, commit: boolean) => void;
  onSelect: (i: number) => void;
  onStroke: (phase: "start" | "move" | "end", p: Pt) => void;
}) {
  const drag = useRef<{ part: string; p0: Pt; m0: Mask } | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const toCss = (p: Pt) => ap(L.pToCss, p[0], p[1]);
  const toP = (e: React.PointerEvent): Pt => {
    const r = (e.currentTarget as HTMLElement).closest(".ed-stage")!.getBoundingClientRect();
    return ap(L.cssToP, e.clientX - r.left, e.clientY - r.top);
  };
  const cssPerP = Math.hypot(L.pToCss[0], L.pToCss[3]);

  const start = (e: React.PointerEvent, part: string) => {
    if (!mask || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { part, p0: toP(e), m0: structuredClone(mask) };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (mask?.kind === "brush") setCursor(ap(L.pToCss, ...toP(e)));
    if (!d || !mask) return;
    e.stopPropagation();
    const p = toP(e);
    if (d.part === "paint") return onStroke("move", p);
    const dx = p[0] - d.p0[0],
      dy = p[1] - d.p0[1];
    const m = structuredClone(d.m0);
    if (m.kind === "linear") {
      if (d.part === "a" || d.part === "mid") m.a = [m.a[0] + dx, m.a[1] + dy];
      if (d.part === "b" || d.part === "mid") m.b = [m.b[0] + dx, m.b[1] + dy];
    } else if (m.kind === "radial") {
      const cs = Math.cos(m.angle),
        sn = Math.sin(m.angle);
      if (d.part === "c") m.c = [m.c[0] + dx, m.c[1] + dy];
      else {
        const vx = p[0] - m.c[0],
          vy = p[1] - m.c[1];
        if (d.part === "rx") m.r = [Math.max(0.01, Math.abs(vx * cs + vy * sn)), m.r[1]];
        if (d.part === "ry") m.r = [m.r[0], Math.max(0.01, Math.abs(-vx * sn + vy * cs))];
        if (d.part === "rot") m.angle = Math.atan2(vy, vx);
      }
    }
    onChange(m, false);
  };
  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !mask) return;
    e.stopPropagation();
    if (d.part === "paint") return onStroke("end", toP(e));
    onChange(mask, true);
  };

  const pins = masks.map((m, i) => {
    const c = m.kind === "linear" ? [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2] : m.kind === "radial" ? m.c : null;
    if (!c || i === index) return null;
    const [x, y] = toCss(c as Pt);
    return <button key={m.id} className="mpin" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()} onClick={() => onSelect(i)} title={m.name} />;
  });

  let body: React.ReactNode = null;
  if (mask?.kind === "linear") {
    const A = toCss(mask.a),
      B = toCss(mask.b);
    const ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
    const nx = -Math.sin(ang) * 4000,
      ny = Math.cos(ang) * 4000;
    const line = (P: [number, number], cls: string) => <line className={cls} x1={P[0] - nx} y1={P[1] - ny} x2={P[0] + nx} y2={P[1] + ny} />;
    const M: [number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    body = (
      <>
        <svg className="mk-svg">
          {line(A, "mk-line strong")}
          {line(M, "mk-line mid")}
          {line(B, "mk-line")}
          <line className="mk-axis" x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} />
        </svg>
        <b className="mk-h" style={{ left: A[0], top: A[1] }} onPointerDown={(e) => start(e, "a")} onPointerMove={move} onPointerUp={end} />
        <b className="mk-h center" style={{ left: M[0], top: M[1] }} onPointerDown={(e) => start(e, "mid")} onPointerMove={move} onPointerUp={end} />
        <b className="mk-h ghost" style={{ left: B[0], top: B[1] }} onPointerDown={(e) => start(e, "b")} onPointerMove={move} onPointerUp={end} />
      </>
    );
  } else if (mask?.kind === "radial") {
    const cs = Math.cos(mask.angle),
      sn = Math.sin(mask.angle);
    const at = (k: number, rx: number, ry: number) => {
      const t = (k / 72) * Math.PI * 2;
      const ex = Math.cos(t) * rx,
        ey = Math.sin(t) * ry;
      return toCss([mask.c[0] + ex * cs - ey * sn, mask.c[1] + ex * sn + ey * cs]);
    };
    const ring = (f: number) =>
      Array.from({ length: 73 }, (_, k) => at(k, mask.r[0] * f, mask.r[1] * f))
        .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
        .join(" ");
    const C = toCss(mask.c);
    const RX = toCss([mask.c[0] + mask.r[0] * cs, mask.c[1] + mask.r[0] * sn]);
    const RY = toCss([mask.c[0] - mask.r[1] * sn, mask.c[1] + mask.r[1] * cs]);
    const ROT = toCss([mask.c[0] + mask.r[0] * 1.28 * cs, mask.c[1] + mask.r[0] * 1.28 * sn]);
    body = (
      <>
        <svg className="mk-svg">
          <polyline className="mk-line strong" points={ring(1)} />
          <polyline className="mk-line" points={ring(Math.max(0.02, 1 - mask.feather / 100))} />
          <line className="mk-axis" x1={RX[0]} y1={RX[1]} x2={ROT[0]} y2={ROT[1]} />
        </svg>
        <b className="mk-h center" style={{ left: C[0], top: C[1] }} onPointerDown={(e) => start(e, "c")} onPointerMove={move} onPointerUp={end} />
        <b className="mk-h" style={{ left: RX[0], top: RX[1] }} onPointerDown={(e) => start(e, "rx")} onPointerMove={move} onPointerUp={end} />
        <b className="mk-h" style={{ left: RY[0], top: RY[1] }} onPointerDown={(e) => start(e, "ry")} onPointerMove={move} onPointerUp={end} />
        <b className="mk-h rot" title="Rotate" style={{ left: ROT[0], top: ROT[1] }} onPointerDown={(e) => start(e, "rot")} onPointerMove={move} onPointerUp={end} />
      </>
    );
  }

  const painting = mask?.kind === "brush";
  return (
    <div
      className={`mask-ui${painting ? " paint" : ""}`}
      onPointerDown={(e) => {
        if (!painting || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { part: "paint", p0: toP(e), m0: mask! };
        onStroke("start", toP(e));
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerLeave={() => setCursor(null)}
    >
      {body}
      {pins}
      {painting && cursor && (
        <i className={`brush-cur${brush.erase ? " erase" : ""}`} style={{ left: cursor[0], top: cursor[1], width: brush.size * 2 * cssPerP, height: brush.size * 2 * cssPerP }} />
      )}
    </div>
  );
}

// ---------- heal ----------

export function HealOverlay({
  L,
  spots,
  sel,
  size,
  onAdd,
  onMove,
  onSelect,
}: {
  L: Layout;
  spots: Spot[];
  sel: number;
  size: number;
  onAdd: (p: Pt) => void;
  onMove: (i: number, part: "dst" | "src", p: Pt, commit: boolean) => void;
  onSelect: (i: number) => void;
}) {
  const drag = useRef<{ i: number; part: "dst" | "src"; off: Pt } | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const cssPerP = Math.hypot(L.pToCss[0], L.pToCss[3]);
  const toP = (e: React.PointerEvent): Pt => {
    const r = (e.currentTarget as HTMLElement).closest(".ed-stage")!.getBoundingClientRect();
    return ap(L.cssToP, e.clientX - r.left, e.clientY - r.top);
  };
  const grab = (e: React.PointerEvent, i: number, part: "dst" | "src") => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = toP(e),
      s = spots[i];
    drag.current = { i, part, off: part === "dst" ? [s.x - p[0], s.y - p[1]] : [s.sx - p[0], s.sy - p[1]] };
    onSelect(i);
  };
  const mv = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toP(e);
    onMove(d.i, d.part, [p[0] + d.off[0], p[1] + d.off[1]], false);
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const p = toP(e);
    onMove(d.i, d.part, [p[0] + d.off[0], p[1] + d.off[1]], true);
  };
  return (
    <div
      className="heal-ui"
      onPointerDown={(e) => e.button === 0 && onAdd(toP(e))}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setCursor([e.clientX - r.left, e.clientY - r.top]);
      }}
      onPointerLeave={() => setCursor(null)}
    >
      <svg className="mk-svg">
        {spots.map((s, i) => {
          if (i !== sel) return null;
          const a = ap(L.pToCss, s.x, s.y),
            b = ap(L.pToCss, s.sx, s.sy);
          return <line key={i} className="heal-link" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
        })}
      </svg>
      {spots.map((s, i) => {
        const [x, y] = ap(L.pToCss, s.x, s.y);
        const r = Math.max(6, s.r * cssPerP);
        return (
          <i
            key={`d${i}`}
            className={`spot${i === sel ? " on" : ""}`}
            style={{ left: x, top: y, width: r * 2, height: r * 2 }}
            onPointerDown={(e) => grab(e, i, "dst")}
            onPointerMove={mv}
            onPointerUp={up}
          />
        );
      })}
      {sel >= 0 && spots[sel] && (() => {
        const s = spots[sel];
        const [x, y] = ap(L.pToCss, s.sx, s.sy);
        const r = Math.max(6, s.r * cssPerP);
        return <i className="spot src" style={{ left: x, top: y, width: r * 2, height: r * 2 }} onPointerDown={(e) => grab(e, sel, "src")} onPointerMove={mv} onPointerUp={up} />;
      })()}
      {cursor && !drag.current && <i className="brush-cur heal" style={{ left: cursor[0], top: cursor[1], width: size * 2 * cssPerP, height: size * 2 * cssPerP }} />}
    </div>
  );
}

// ---------- remove objects (AI) ----------

export function EraseOverlay({ L, strokes, size, onStroke }: { L: Layout; strokes: Stroke[]; size: number; onStroke: (ph: "start" | "move" | "end", p: Pt) => void }) {
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const down = useRef(false);
  const cssPerP = Math.hypot(L.pToCss[0], L.pToCss[3]);
  const toP = (e: React.PointerEvent): Pt => {
    const r = (e.currentTarget as HTMLElement).closest(".ed-stage")!.getBoundingClientRect();
    return ap(L.cssToP, e.clientX - r.left, e.clientY - r.top);
  };
  return (
    <div
      className="erase-ui"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        down.current = true;
        onStroke("start", toP(e));
      }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setCursor([e.clientX - r.left, e.clientY - r.top]);
        if (down.current) onStroke("move", toP(e));
      }}
      onPointerUp={(e) => {
        if (!down.current) return;
        down.current = false;
        onStroke("end", toP(e));
      }}
      onPointerLeave={() => setCursor(null)}
    >
      <svg className="mk-svg">
        {strokes.map((s, i) => {
          const pts: string[] = [];
          for (let k = 0; k + 1 < s.pts.length; k += 2) {
            const [x, y] = ap(L.pToCss, s.pts[k], s.pts[k + 1]);
            pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
          }
          if (pts.length === 1) pts.push(pts[0]);
          return <polyline key={i} className="erase-path" points={pts.join(" ")} style={{ strokeWidth: s.r * 2 * cssPerP }} />;
        })}
      </svg>
      {cursor && <i className="brush-cur erase-cur" style={{ left: cursor[0], top: cursor[1], width: size * 2 * cssPerP, height: size * 2 * cssPerP }} />}
    </div>
  );
}
