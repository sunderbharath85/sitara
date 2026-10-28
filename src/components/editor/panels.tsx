// The editor's right-hand panels, one per tool.
import { useState } from "react";
import { LOOKS } from "../../lib/edit/looks";
import { BANDS, COLOR, defaults, EFFECTS, LIGHT, LOCAL, MAX_MASKS, type AdjKey, type Geo, type Pt, type Spec, type Stack } from "../../lib/edit/stack";
import { Icon } from "../Icon";
import { ColorWheel, CurveEditor, Group, okHue, Seg, Slider, type Channel } from "./controls";

export type Up = (mut: (s: Stack) => void, commit?: boolean) => void;

function AdjSliders({ s, up, specs }: { s: Stack; up: Up; specs: Spec[] }) {
  return (
    <>
      {specs.map((sp) => (
        <Slider
          key={sp.key}
          spec={sp}
          value={s.adj[sp.key]}
          onChange={(v) => up((x) => void (x.adj[sp.key] = v), false)}
          onCommit={(v) => up((x) => void (x.adj[sp.key] = v))}
        />
      ))}
    </>
  );
}

const resetAdj = (up: Up, specs: Spec[]) => () => up((x) => specs.forEach((sp) => (x.adj[sp.key as AdjKey] = 0)));

// ---------- looks ----------

export function LooksPanel({ s, up, thumbs }: { s: Stack; up: Up; thumbs: Record<string, string> }) {
  const cur = s.look?.id ?? "";
  return (
    <>
      <p className="ed-hint">Looks sit underneath your own sliders. Pick one, then dial its strength.</p>
      <div className="looks">
        {[{ id: "", name: "Original" }, ...LOOKS].map((l, i) => (
          <button
            key={l.id || "none"}
            className={`look${cur === l.id ? " on" : ""}`}
            style={{ "--i": i } as React.CSSProperties}
            onClick={() => up((x) => void (x.look = l.id ? { id: l.id, amt: x.look?.id === l.id ? x.look.amt : 100 } : null))}
          >
            <span className="look-img">{thumbs[l.id || "none"] && <img alt="" src={thumbs[l.id || "none"]} />}</span>
            <b>{l.name}</b>
          </button>
        ))}
      </div>
      {s.look && (
        <div className="look-amt">
          <Slider
            spec={{ label: `${LOOKS.find((l) => l.id === s.look!.id)?.name ?? "Look"} strength`, min: 0, max: 150 }}
            value={s.look.amt}
            def={100}
            onChange={(v) => up((x) => void (x.look!.amt = v), false)}
            onCommit={(v) => up((x) => void (x.look!.amt = v))}
          />
        </div>
      )}
    </>
  );
}

// ---------- adjust ----------

export function AdjustPanel({ s, up, onAuto }: { s: Stack; up: Up; onAuto: () => void }) {
  return (
    <>
      <button className="auto-btn" onClick={onAuto}>
        <Icon n="wand" s={16} />
        <span>
          <b>Auto</b>
          <small>Balance exposure, contrast and color</small>
        </span>
      </button>
      <Group title="Light" kicker="tone" onReset={resetAdj(up, LIGHT)}>
        <AdjSliders s={s} up={up} specs={LIGHT} />
      </Group>
      <Group title="Color" kicker="white balance · presence" onReset={resetAdj(up, COLOR)}>
        <AdjSliders s={s} up={up} specs={COLOR} />
      </Group>
      <Group title="Effects" kicker="detail · finish" onReset={resetAdj(up, EFFECTS)}>
        <AdjSliders s={s} up={up} specs={EFFECTS} />
      </Group>
    </>
  );
}

// ---------- color ----------

export function ColorPanel({ s, up }: { s: Stack; up: Up }) {
  const [mode, setMode] = useState<"h" | "s" | "l">("h");
  const m = s.bw ? "l" : mode;
  const track = (i: number) => {
    const hue = BANDS[i].hue;
    if (m === "h") return `linear-gradient(90deg,${okHue(hue - 30)},${okHue(hue)},${okHue(hue + 30)})`;
    if (m === "s") return `linear-gradient(90deg,#77777d,${okHue(hue, 0.72, 0.17)})`;
    return `linear-gradient(90deg,${okHue(hue, 0.35, 0.09)},${okHue(hue, 0.92, 0.07)})`;
  };
  return (
    <>
      <label className="switch bw-sw">
        <input type="checkbox" checked={s.bw} onChange={(e) => up((x) => void (x.bw = e.target.checked))} />
        <i />
        <span>
          Black &amp; white
          <small>The mixer below becomes a black-and-white mix</small>
        </span>
      </label>
      <Group title={s.bw ? "B&W mix" : "Color mixer"} kicker="eight hue bands" onReset={() => up((x) => void (x.hsl = defaults().hsl))}>
        {!s.bw && <Seg value={mode} onChange={setMode} options={[["h", "Hue"], ["s", "Saturation"], ["l", "Luminance"]]} />}
        <div className="mixer">
          {BANDS.map((b, i) => (
            <Slider
              key={`${m}${i}`}
              spec={{ label: b.name, min: -100, max: 100, track: track(i) }}
              accent={b.css}
              value={s.hsl[m][i]}
              onChange={(v) => up((x) => void (x.hsl[m][i] = v), false)}
              onCommit={(v) => up((x) => void (x.hsl[m][i] = v))}
            />
          ))}
        </div>
      </Group>
      <Group title="Color grading" kicker="split toning" onReset={() => up((x) => void (x.grade = defaults().grade))}>
        <div className="wheels">
          {(
            [
              ["sh", "Shadows"],
              ["mid", "Midtones"],
              ["hi", "Highlights"],
            ] as const
          ).map(([k, label]) => (
            <ColorWheel key={k} label={label} value={s.grade[k]} onChange={(w) => up((x) => void (x.grade[k] = w), false)} onCommit={(w) => up((x) => void (x.grade[k] = w))} />
          ))}
        </div>
        <Slider
          spec={{ label: "Balance", min: -100, max: 100 }}
          value={s.grade.bal}
          onChange={(v) => up((x) => void (x.grade.bal = v), false)}
          onCommit={(v) => up((x) => void (x.grade.bal = v))}
        />
      </Group>
    </>
  );
}

// ---------- curves ----------

const CURVE_PRESETS: [string, Pt[]][] = [
  ["Linear", [[0, 0], [1, 1]]],
  ["Soft", [[0, 0.02], [0.25, 0.22], [0.75, 0.78], [1, 0.98]]],
  ["Punch", [[0, 0], [0.25, 0.18], [0.75, 0.84], [1, 1]]],
  ["Matte", [[0, 0.1], [0.3, 0.3], [0.75, 0.76], [1, 0.95]]],
];

export function CurvesPanel({ s, up, hist }: { s: Stack; up: Up; hist: number[] | null }) {
  const [ch, setCh] = useState<Channel>("rgb");
  return (
    <>
      <div className="chans">
        {(
          [
            ["rgb", "RGB"],
            ["r", "Red"],
            ["g", "Green"],
            ["b", "Blue"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`chan c-${k}${ch === k ? " on" : ""}`} onClick={() => setCh(k)}>
            <i />
            {label}
          </button>
        ))}
      </div>
      <CurveEditor pts={s.curve[ch]} ch={ch} hist={hist} onChange={(p) => up((x) => void (x.curve[ch] = p), false)} onCommit={(p) => up((x) => void (x.curve[ch] = p))} />
      <p className="ed-hint">Click to add a point, drag to shape, double-click or drag a point off the graph to remove it.</p>
      <div className="presets">
        {CURVE_PRESETS.map(([name, pts]) => (
          <button key={name} className="chip" onClick={() => up((x) => void (x.curve[ch] = pts.map((p) => [...p] as Pt)))}>
            {name}
          </button>
        ))}
        <button className="chip" onClick={() => up((x) => void (x.curve = defaults().curve))}>
          Reset all
        </button>
      </div>
    </>
  );
}

// ---------- crop ----------

const ASPECTS: [string, string][] = [
  ["free", "Free"],
  ["orig", "Original"],
  ["1:1", "Square"],
  ["4:5", "4 : 5"],
  ["5:4", "5 : 4"],
  ["3:2", "3 : 2"],
  ["2:3", "2 : 3"],
  ["16:9", "16 : 9"],
  ["9:16", "9 : 16"],
];

export function CropPanel({ g, setGeo }: { g: Geo; setGeo: (mut: (g: Geo) => void, commit?: boolean, refit?: "auto" | "keep") => void }) {
  return (
    <>
      <div className="aspects">
        {ASPECTS.map(([k, label]) => (
          <button key={k} className={`asp${g.aspect === k ? " on" : ""}`} onClick={() => setGeo((x) => ((x.aspect = k), (x.auto = true)), true, "auto")}>
            <i style={aspectBox(k)} />
            {label}
          </button>
        ))}
      </div>
      <Slider
        spec={{ label: "Straighten", min: -45, max: 45, step: 0.1 }}
        value={g.angle}
        onChange={(v) => setGeo((x) => void (x.angle = v), false)}
        onCommit={(v) => setGeo((x) => void (x.angle = v))}
      />
      <div className="turns">
        <button className="btn" onClick={() => setGeo((x) => ((x.rot = ((x.rot + 3) % 4) as Geo["rot"]), (x.auto = true)), true, "auto")} title="Rotate left">
          <Icon n="rotl" s={16} /> Left
        </button>
        <button className="btn" onClick={() => setGeo((x) => ((x.rot = ((x.rot + 1) % 4) as Geo["rot"]), (x.auto = true)), true, "auto")} title="Rotate right">
          <Icon n="rotr" s={16} /> Right
        </button>
        <button className="btn" onClick={() => setGeo((x) => void (x.flip = !x.flip), true, "keep")} title="Flip horizontally">
          <Icon n="flip" s={16} />
        </button>
        <button className="btn" onClick={() => setGeo((x) => ((x.flip = !x.flip), (x.rot = ((x.rot + 2) % 4) as Geo["rot"])), true, "keep")} title="Flip vertically">
          <Icon n="flipv" s={16} />
        </button>
      </div>
      <button className="btn wide" onClick={() => setGeo((x) => Object.assign(x, defaults().geo), true, "auto")}>
        <Icon n="reset" s={15} /> Reset crop &amp; rotation
      </button>
      <p className="ed-hint">
        Drag the corners to crop, inside to move, and <b>outside the frame to straighten</b>. <kbd>Esc</kbd> or <kbd>Enter</kbd> to finish.
      </p>
    </>
  );
}

function aspectBox(k: string): React.CSSProperties {
  if (k === "free") return { width: 16, height: 12, borderStyle: "dashed" };
  if (k === "orig") return { width: 16, height: 11 };
  const [a, b] = k.split(":").map(Number);
  const s = 16 / Math.max(a, b);
  return { width: a * s, height: b * s };
}

// ---------- masks ----------

const KIND_ICON = { linear: "linear", radial: "radial", brush: "brush", ai: "spark" } as const;
const KIND_NAME = { linear: "Linear gradient", radial: "Radial", brush: "Brush" } as const;

export function MasksPanel({
  s,
  up,
  sel,
  setSel,
  add,
  overlay,
  setOverlay,
  brush,
  setBrush,
}: {
  s: Stack;
  up: Up;
  sel: number;
  setSel: (i: number) => void;
  add: (k: "linear" | "radial" | "brush") => void;
  overlay: boolean;
  setOverlay: (v: boolean) => void;
  brush: { size: number; feather: number; flow: number; erase: boolean };
  setBrush: (b: { size: number; feather: number; flow: number; erase: boolean }) => void;
}) {
  const m = s.masks[sel] ?? null;
  const full = s.masks.length >= MAX_MASKS;
  return (
    <>
      <div className="mask-add">
        {(["linear", "radial", "brush"] as const).map((k) => (
          <button key={k} disabled={full} onClick={() => add(k)}>
            <Icon n={KIND_ICON[k]} s={20} />
            <span>{KIND_NAME[k]}</span>
          </button>
        ))}
      </div>
      {s.masks.length > 0 && (
        <div className="mask-list">
          {s.masks.map((mk, i) => (
            <div key={mk.id} className={`mrow${i === sel ? " on" : ""}`} onClick={() => setSel(i)}>
              <Icon n={KIND_ICON[mk.kind]} s={15} />
              <b>{mk.name}</b>
              <button className={mk.invert ? "on" : ""} title="Invert" onClick={(e) => (e.stopPropagation(), up((x) => void (x.masks[i].invert = !x.masks[i].invert)))}>
                <Icon n="invert" s={14} />
              </button>
              <button
                title="Delete mask"
                onClick={(e) => {
                  e.stopPropagation();
                  up((x) => void x.masks.splice(i, 1));
                  setSel(Math.min(i, s.masks.length - 2));
                }}
              >
                <Icon n="trash" s={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <label className="switch ov-sw">
        <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
        <i />
        <span>
          Show mask <kbd>O</kbd>
        </span>
      </label>
      {!m && <p className="ed-hint">Masks apply their own sliders to part of the photo: a sky with a linear gradient, a face with a radial, anything with the brush.</p>}
      {m?.kind === "brush" && (
        <Group title="Brush" kicker={brush.erase ? "erasing" : "painting"}>
          <Seg value={brush.erase ? "e" : "p"} onChange={(v) => setBrush({ ...brush, erase: v === "e" })} options={[["p", "Paint"], ["e", "Erase"]]} />
          <Slider spec={{ label: "Size", min: 0.5, max: 25, step: 0.1 }} value={+(brush.size * 100).toFixed(1)} def={4} onChange={(v) => setBrush({ ...brush, size: v / 100 })} onCommit={(v) => setBrush({ ...brush, size: v / 100 })} />
          <Slider spec={{ label: "Feather", min: 0, max: 100 }} value={Math.round(brush.feather * 100)} def={60} onChange={(v) => setBrush({ ...brush, feather: v / 100 })} onCommit={(v) => setBrush({ ...brush, feather: v / 100 })} />
          <Slider spec={{ label: "Density", min: 5, max: 100 }} value={Math.round(brush.flow * 100)} def={80} onChange={(v) => setBrush({ ...brush, flow: v / 100 })} onCommit={(v) => setBrush({ ...brush, flow: v / 100 })} />
          <p className="ed-hint">
            <kbd>[</kbd> <kbd>]</kbd> change the size. Hold <kbd>Alt</kbd> to erase.
          </p>
        </Group>
      )}
      {m && (
        <Group title={`${m.name} adjustments`} kicker="local" onReset={() => up((x) => void (x.masks[sel].adj = {}))}>
          <Slider
            spec={{ label: "Mask strength", min: 0, max: 100 }}
            value={m.amount}
            def={100}
            onChange={(v) => up((x) => void (x.masks[sel].amount = v), false)}
            onCommit={(v) => up((x) => void (x.masks[sel].amount = v))}
          />
          {m.kind === "radial" && (
            <Slider
              spec={{ label: "Feather", min: 0, max: 100 }}
              value={m.feather}
              def={50}
              onChange={(v) => up((x) => void ((x.masks[sel] as typeof m).feather = v), false)}
              onCommit={(v) => up((x) => void ((x.masks[sel] as typeof m).feather = v))}
            />
          )}
          {LOCAL.map((sp) => (
            <Slider
              key={sp.key}
              spec={sp}
              value={m.adj[sp.key] ?? 0}
              onChange={(v) => up((x) => void (x.masks[sel].adj[sp.key] = v), false)}
              onCommit={(v) => up((x) => void (x.masks[sel].adj[sp.key] = v))}
            />
          ))}
        </Group>
      )}
    </>
  );
}

// ---------- heal ----------

export interface HealOpts {
  size: number;
  feather: number;
  opacity: number;
  mode: "heal" | "clone";
}

export function HealPanel({ s, up, sel, setSel, opts, setOpts }: { s: Stack; up: Up; sel: number; setSel: (i: number) => void; opts: HealOpts; setOpts: (o: HealOpts) => void }) {
  const spot = s.heal[sel];
  // edits apply to the selected spot, and become the default for new ones
  const set = (patch: Partial<HealOpts>, commit: boolean) => {
    setOpts({ ...opts, ...patch });
    if (spot)
      up((x) => {
        const p = x.heal[sel];
        if (patch.size != null) p.r = patch.size;
        if (patch.feather != null) p.feather = patch.feather;
        if (patch.opacity != null) p.opacity = patch.opacity;
        if (patch.mode) p.mode = patch.mode;
      }, commit);
  };
  const cur = spot ? { size: spot.r, feather: spot.feather, opacity: spot.opacity, mode: spot.mode } : opts;
  return (
    <>
      <Seg value={cur.mode} onChange={(v) => set({ mode: v }, true)} options={[["heal", "Heal"], ["clone", "Clone"]]} />
      <Slider spec={{ label: "Size", min: 0.3, max: 15, step: 0.1 }} value={+(cur.size * 100).toFixed(1)} def={2} onChange={(v) => set({ size: v / 100 }, false)} onCommit={(v) => set({ size: v / 100 }, true)} />
      <Slider spec={{ label: "Feather", min: 0, max: 100 }} value={Math.round(cur.feather * 100)} def={50} onChange={(v) => set({ feather: v / 100 }, false)} onCommit={(v) => set({ feather: v / 100 }, true)} />
      <Slider spec={{ label: "Opacity", min: 0, max: 100 }} value={Math.round(cur.opacity * 100)} def={100} onChange={(v) => set({ opacity: v / 100 }, false)} onCommit={(v) => set({ opacity: v / 100 }, true)} />
      <div className="heal-count">
        <b>{s.heal.length}</b>
        <span>{s.heal.length === 1 ? "fix" : "fixes"}</span>
        {s.heal.length > 0 && (
          <button
            className="btn sm"
            onClick={() => {
              up((x) => void (x.heal = []));
              setSel(-1);
            }}
          >
            Clear all
          </button>
        )}
      </div>
      <p className="ed-hint">
        Click a blemish or a speck of dust. Sitara picks a matching patch nearby; drag the dashed circle to choose another. <kbd>Del</kbd> removes the selected fix.
      </p>
    </>
  );
}
