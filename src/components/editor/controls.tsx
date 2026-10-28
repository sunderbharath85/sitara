import { useEffect, useRef, useState } from "react";
import { spline } from "../../lib/edit/curve";
import type { Pt, Spec, Wheel } from "../../lib/edit/stack";
import { Icon } from "../Icon";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** CSS color for an OKLab hue (degrees), matching how the shader turns grading and mixer hues. */
export function okHue(deg: number, L = 0.74, C = 0.14): string {
  const r = (deg * Math.PI) / 180,
    a = Math.cos(r) * C,
    b = Math.sin(r) * C;
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const g = lin.map((v) => Math.round(255 * clamp(v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055, 0, 1)));
  return `rgb(${g[0]},${g[1]},${g[2]})`;
}
const WHEEL_BG = `radial-gradient(closest-side, #3a3a40, rgba(58,58,64,0) 100%), conic-gradient(${Array.from({ length: 25 }, (_, k) => `${okHue(90 - k * 15)} ${k * 15}deg`).join(",")})`;

export const fmtVal = (v: number, step?: number, signed = true) => {
  const s = v.toFixed(!step || step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  return +s > 0 && signed ? `+${s}` : s.startsWith("-") && +s === 0 ? s.slice(1) : s;
};

/**
 * Center-zero slider: drag anywhere on the track (Shift for fine control), double-click to reset,
 * arrow keys to nudge. `onChange` previews; `onCommit` records history.
 */
export function Slider({
  spec,
  value,
  onChange,
  onCommit,
  def = 0,
  accent,
}: {
  spec: Pick<Spec<string>, "label" | "min" | "max" | "step" | "track">;
  value: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
  def?: number;
  accent?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; v: number } | null>(null);
  const [active, setActive] = useState(false);
  const step = spec.step ?? 1;
  const snap = (v: number) => clamp(Math.round(v / step) * step, spec.min, spec.max);
  const frac = (v: number) => (v - spec.min) / (spec.max - spec.min);
  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return spec.min + clamp((clientX - r.left) / r.width, 0, 1) * (spec.max - spec.min);
  };
  const zero = clamp(frac(spec.min < 0 ? 0 : spec.min), 0, 1);
  const f = clamp(frac(value), 0, 1);
  const changed = Math.abs(value - def) > step / 2;
  const nudge = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <div className={`sl${active ? " on" : ""}${changed ? " mod" : ""}`} style={accent ? ({ "--sl": accent } as React.CSSProperties) : undefined}>
      <div className="sl-h" onDoubleClick={() => onCommit(def)}>
        <span>{spec.label}</span>
        <b>{fmtVal(value, spec.step, spec.min < 0)}</b>
      </div>
      <div
        className="sl-t"
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={spec.label}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={value}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setActive(true);
          const v = e.shiftKey ? value : snap(at(e.clientX));
          drag.current = { x: e.clientX, v };
          onChange(v);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const r = track.current!.getBoundingClientRect();
          const v = e.shiftKey ? snap(d.v + ((e.clientX - d.x) / r.width) * (spec.max - spec.min) * 0.15) : snap(at(e.clientX));
          if (e.shiftKey) drag.current = { x: e.clientX, v };
          onChange(v);
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          const r = track.current!.getBoundingClientRect();
          const v = e.shiftKey ? drag.current.v : snap(spec.min + clamp((e.clientX - r.left) / r.width, 0, 1) * (spec.max - spec.min));
          drag.current = null;
          setActive(false);
          onCommit(v);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setActive(false);
        }}
        onDoubleClick={() => onCommit(def)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          e.stopPropagation();
          const k = (e.key === "ArrowRight" ? 1 : -1) * step * (e.shiftKey ? 10 : 1) * (step < 1 ? 5 : 1);
          const v = snap(value + k);
          onChange(v);
          if (nudge.current) clearTimeout(nudge.current);
          nudge.current = setTimeout(() => onCommit(v), 350);
        }}
      >
        <i className="sl-bg" style={spec.track ? { background: spec.track } : undefined} />
        <i className="sl-fill" style={{ left: `${Math.min(zero, f) * 100}%`, width: `${Math.abs(f - zero) * 100}%` }} />
        {spec.min < 0 && <i className="sl-zero" style={{ left: `${zero * 100}%` }} />}
        <i className="sl-k" style={{ left: `${f * 100}%` }} />
      </div>
    </div>
  );
}

export function Group({ title, kicker, children, open: start = true, onReset }: { title: string; kicker?: string; children: React.ReactNode; open?: boolean; onReset?: () => void }) {
  const [open, setOpen] = useState(start);
  return (
    <section className={`eg${open ? " open" : ""}`}>
      <header>
        <button className="eg-t" onClick={() => setOpen(!open)}>
          <Icon n="right" s={12} />
          <b>{title}</b>
          {kicker && <span>{kicker}</span>}
        </button>
        {onReset && (
          <button className="eg-r" title="Reset this group" onClick={onReset}>
            <Icon n="reset" s={13} />
          </button>
        )}
      </header>
      <div className="eg-b">{children}</div>
    </section>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, React.ReactNode][]; onChange: (v: T) => void }) {
  return (
    <div className="seg ed-seg">
      {options.map(([k, label]) => (
        <button key={k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Hue/strength wheel for color grading. */
export function ColorWheel({ label, value, onChange, onCommit }: { label: string; value: Wheel; onChange: (w: Wheel) => void; onCommit: (w: Wheel) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef<Wheel>(value);
  const pick = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5,
      y = (e.clientY - r.top) / r.height - 0.5;
    let h = (Math.atan2(-y, x) * 180) / Math.PI;
    if (h < 0) h += 360;
    const w = { h: Math.round(h), s: Math.round(clamp(Math.hypot(x, y) / 0.5, 0, 1) * 100) };
    live.current = w;
    onChange(w);
  };
  const rad = (value.h * Math.PI) / 180;
  const px = 50 + Math.cos(rad) * (value.s / 2),
    py = 50 - Math.sin(rad) * (value.s / 2);
  return (
    <div className="wheel">
      <div
        className="wh-disc"
        ref={ref}
        style={{ background: WHEEL_BG }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pick(e);
        }}
        onPointerMove={(e) => e.buttons & 1 && pick(e)}
        onPointerUp={() => onCommit(live.current)}
        onDoubleClick={() => onCommit({ ...value, s: 0 })}
      >
        <i className="wh-puck" style={{ left: `${px}%`, top: `${py}%`, background: value.s ? okHue(value.h, 0.8, 0.16) : "#fff" }} />
      </div>
      <span>{label}</span>
      <small>{value.s ? `${value.h}° · ${value.s}` : "—"}</small>
    </div>
  );
}

const CH = { rgb: "#f4f4f5", r: "#ff5c5c", g: "#4ade80", b: "#5b8cff" } as const;
export type Channel = keyof typeof CH;

/** Point curve: click to add, drag to move, double-click (or drag off the box) to remove. */
export function CurveEditor({
  pts,
  ch,
  hist,
  onChange,
  onCommit,
}: {
  pts: Pt[];
  ch: Channel;
  hist: number[] | null;
  onChange: (p: Pt[]) => void;
  onCommit: (p: Pt[]) => void;
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ i: number; list: Pt[] } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const S = 264;

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = devicePixelRatio || 1;
    c.width = S * dpr;
    c.height = S * dpr;
    const x = c.getContext("2d")!;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, S, S);
    if (hist) {
      const mx = Math.max(1, ...hist.slice(1, -1));
      x.fillStyle = "rgba(255,255,255,.07)";
      x.beginPath();
      x.moveTo(0, S);
      hist.forEach((v, i) => x.lineTo((i / (hist.length - 1)) * S, S - Math.min(1, v / mx) * S * 0.9));
      x.lineTo(S, S);
      x.fill();
    }
    x.strokeStyle = "rgba(255,255,255,.07)";
    x.lineWidth = 1;
    for (let q = 1; q < 4; q++) {
      x.beginPath();
      x.moveTo((S * q) / 4 + 0.5, 0);
      x.lineTo((S * q) / 4 + 0.5, S);
      x.moveTo(0, (S * q) / 4 + 0.5);
      x.lineTo(S, (S * q) / 4 + 0.5);
      x.stroke();
    }
    x.strokeStyle = "rgba(255,255,255,.16)";
    x.setLineDash([3, 4]);
    x.beginPath();
    x.moveTo(0, S);
    x.lineTo(S, 0);
    x.stroke();
    x.setLineDash([]);
    const f = spline(pts);
    x.strokeStyle = CH[ch];
    x.lineWidth = 2;
    x.shadowColor = CH[ch];
    x.shadowBlur = 8;
    x.beginPath();
    for (let i = 0; i <= S; i++) {
      const y = clamp(f(i / S), 0, 1);
      if (i) x.lineTo(i, S - y * S);
      else x.moveTo(0, S - y * S);
    }
    x.stroke();
    x.shadowBlur = 0;
  }, [pts, ch, hist]);

  const toPt = (e: React.PointerEvent): Pt => {
    const r = cv.current!.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)];
  };
  const near = (p: Pt) => {
    let best = -1,
      d = 0.05;
    pts.forEach((q, i) => {
      const dd = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (dd < d) {
        d = dd;
        best = i;
      }
    });
    return best;
  };
  const sorted = (l: Pt[]) => [...l].sort((a, b) => a[0] - b[0]);

  return (
    <div className="curve" style={{ "--cc": CH[ch] } as React.CSSProperties}>
      <canvas
        ref={cv}
        style={{ width: S, height: S }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = toPt(e);
          let i = near(p);
          let list = pts.map((q) => [...q] as Pt);
          if (i < 0) {
            list = sorted([...list, p]);
            i = list.findIndex((q) => q[0] === p[0] && q[1] === p[1]);
            onChange(list);
          }
          drag.current = { i, list };
        }}
        onPointerMove={(e) => {
          const p = toPt(e);
          const g = drag.current;
          if (!g) return setHover(near(p) >= 0 ? near(p) : null);
          const list = g.list.map((q) => [...q] as Pt);
          const lo = g.i > 0 ? list[g.i - 1][0] + 0.01 : 0,
            hi = g.i < list.length - 1 ? list[g.i + 1][0] - 0.01 : 1;
          const ends = g.i === 0 || g.i === list.length - 1;
          const r = cv.current!.getBoundingClientRect();
          const off = e.clientY < r.top - 24 || e.clientY > r.bottom + 24;
          if (off && !ends) {
            onChange(list.filter((_, k) => k !== g.i));
            return;
          }
          list[g.i] = [ends ? list[g.i][0] : clamp(p[0], lo, hi), p[1]];
          g.list = list;
          onChange(list);
        }}
        onPointerUp={(e) => {
          const g = drag.current;
          drag.current = null;
          if (!g) return;
          const r = cv.current!.getBoundingClientRect();
          const ends = g.i === 0 || g.i === g.list.length - 1;
          if (!ends && (e.clientY < r.top - 24 || e.clientY > r.bottom + 24)) onCommit(g.list.filter((_, k) => k !== g.i));
          else onCommit(g.list);
        }}
        onDoubleClick={(e) => {
          const i = near(toPt(e as unknown as React.PointerEvent));
          if (i > 0 && i < pts.length - 1) onCommit(pts.filter((_, k) => k !== i));
        }}
      />
      <svg className="curve-pts" viewBox={`0 0 ${S} ${S}`} style={{ width: S, height: S }}>
        {pts.map(([px, py], i) => (
          <circle key={i} cx={px * S} cy={S - py * S} r={hover === i ? 6 : 4.5} />
        ))}
      </svg>
    </div>
  );
}
