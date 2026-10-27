import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, thumbUrl, type CGroup, type CItem, type CleanupReport, type Lib } from "../lib/api";
import { trash } from "../lib/actions";
import { basename, fmtNum, fmtShortDay, fmtSize, plural } from "../lib/format";
import { store, useStore } from "../lib/store";
import { Icon } from "./Icon";
import { toast } from "./Toasts";

type Tab = "exact" | "similar" | "blurry" | "shots";
const TABS: { k: Tab; label: string }[] = [
  { k: "exact", label: "Exact duplicates" },
  { k: "similar", label: "Similar shots" },
  { k: "blurry", label: "Possibly blurry" },
  { k: "shots", label: "Old screenshots" },
];

function CountUp({ to, fmt }: { to: number; fmt: (n: number) => string }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setV(to);
    const t0 = performance.now(),
      D = 1200;
    let raf = 0;
    const f = (t: number) => {
      const k = Math.min(1, (t - t0) / D);
      setV(to * (1 - Math.pow(1 - k, 4)));
      if (k < 1) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{fmt(v)}</>;
}

function Thumb({ lib, id }: { lib: Lib; id: number }) {
  const i = lib.pos.get(id);
  return i == null ? <div className="dimg" /> : <img alt="" src={thumbUrl(id, lib.ver[i])} draggable={false} />;
}

function Bar({ label, v, text, warn, best }: { label: string; v: number; text: string; warn?: boolean; best?: boolean }) {
  return (
    <div className="bar">
      {label}
      <i style={{ "--v": Math.max(0.02, Math.min(1, v)).toFixed(2), "--bc": warn ? "#ef4444" : best ? "#ff6b3d" : "#d4d4d8" } as React.CSSProperties} />
      <em>{text}</em>
    </div>
  );
}

export function CleanupView({ active }: { active: boolean }) {
  const lib = useStore((s) => s.lib);
  const st = useStore((s) => s.status);
  const [rep, setRep] = useState<CleanupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("exact");
  const [gi, setGi] = useState(0);
  const [marks, setMarks] = useState<Set<number>>(new Set());
  const [freed, setFreed] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.cleanupScan();
      setRep(r);
      setGi(0);
      if (!loaded.current) {
        loaded.current = true;
        const first = (["exact", "similar", "blurry", "shots"] as Tab[]).find((k) => (k === "exact" ? r.exact : k === "similar" ? r.similar : k === "blurry" ? r.blurry : r.shots).length);
        if (first) setTab(first);
      }
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (active && !rep && !busy) load();
  }, [active, rep, busy, load]);
  useEffect(() => api.onAnalysisChanged(() => active && load()), [active, load]);

  const groups: CGroup[] = rep ? (tab === "exact" ? rep.exact : tab === "similar" ? rep.similar : []) : [];
  const list: CItem[] = rep ? (tab === "blurry" ? rep.blurry : tab === "shots" ? rep.shots : []) : [];
  const g = groups[gi];

  // default marks: every copy except the best pick; lists start unmarked
  useEffect(() => {
    if (g) setMarks(new Set(g.items.filter((_, k) => k !== g.best).filter((c) => !c.fav).map((c) => c.id)));
    else setMarks(new Set());
  }, [g, tab]);

  const markedBytes = useMemo(() => {
    const pool = g ? g.items : list;
    return pool.filter((c) => marks.has(c.id)).reduce((a, c) => a + c.size, 0);
  }, [g, list, marks]);

  const removeFromReport = (ids: number[], bytes = 0) => {
    const gone = new Set(ids);
    const n = ids.length;
    setRep((r) =>
      r && {
        ...r,
        // the cards count down as you clear things
        stats: {
          ...r.stats,
          exactExtra: tab === "exact" ? Math.max(0, r.stats.exactExtra - n) : r.stats.exactExtra,
          exactBytes: tab === "exact" ? Math.max(0, r.stats.exactBytes - bytes) : r.stats.exactBytes,
          similarExtra: tab === "similar" ? Math.max(0, r.stats.similarExtra - n) : r.stats.similarExtra,
          similarBytes: tab === "similar" ? Math.max(0, r.stats.similarBytes - bytes) : r.stats.similarBytes,
          blurry: tab === "blurry" ? Math.max(0, r.stats.blurry - n) : r.stats.blurry,
          blurryBytes: tab === "blurry" ? Math.max(0, r.stats.blurryBytes - bytes) : r.stats.blurryBytes,
          shots: tab === "shots" ? Math.max(0, r.stats.shots - n) : r.stats.shots,
          shotsBytes: tab === "shots" ? Math.max(0, r.stats.shotsBytes - bytes) : r.stats.shotsBytes,
        },
        exact: tab === "exact" ? r.exact.filter((_, k) => k !== gi) : r.exact,
        similar: tab === "similar" ? r.similar.filter((_, k) => k !== gi) : r.similar,
        blurry: r.blurry.filter((c) => !gone.has(c.id)),
        shots: r.shots.filter((c) => !gone.has(c.id)),
      },
    );
  };

  const apply = async () => {
    const ids = [...marks];
    if (!ids.length) return next();
    const bytes = markedBytes;
    setLeaving(true);
    await trash(ids);
    setFreed((f) => f + bytes);
    setTimeout(() => {
      setLeaving(false);
      removeFromReport(ids, bytes);
      if (g) setGi((k) => Math.min(k, Math.max(0, groups.length - 2)));
      setMarks(new Set());
    }, 420);
  };
  const next = () => setGi((k) => (k + 1 < groups.length ? k + 1 : k));
  const keepAll = () => {
    removeFromReport([]);
    setGi((k) => Math.min(k, Math.max(0, groups.length - 2)));
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const s = store.get();
      if (s.viewer || s.show || s.palette || s.picker || (e.target as HTMLElement).matches?.("input,textarea")) return;
      if (e.key === "Enter") apply();
      else if ((e.key === "s" || e.key === "S") && g) next();
      else if ((e.key === "a" || e.key === "A") && g && !s.sel.size) keepAll();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  });

  if (!lib) return null;
  const S = rep?.stats;
  const reclaim = S ? S.exactBytes + S.similarBytes + S.blurryBytes + S.shotsBytes : 0;
  const counts: Record<Tab, number> = { exact: S?.exactExtra ?? 0, similar: S?.similarExtra ?? 0, blurry: S?.blurry ?? 0, shots: S?.shots ?? 0 };
  const total = (S?.analyzed ?? 0) + (S?.pending ?? 0);
  const open = (id: number) => {
    const ids = g ? g.items.map((c) => c.id) : list.map((c) => c.id);
    store.set({ viewer: { ids, idx: Math.max(0, ids.indexOf(id)) } });
  };

  return (
    <div className="scroller page" onScroll={(e) => document.body.classList.toggle("scrolled", e.currentTarget.scrollTop > 10)}>
      <div className="page-head">
        <div className="ghost" aria-hidden="true">
          CLEAN
        </div>
        <div className="sec-title">
          <div className="kicker">
            <span className="pill-acc">Perceptual hash + sharpness</span>
            <span>{rep ? `Checked ${fmtNum(total)} photos` : "Checking…"}</span>
          </div>
          <h2>Cleanup</h2>
          <div className="stats sans">Nothing is deleted outright. Rejects go to the Recycle Bin, and Undo brings them back.</div>
        </div>
        <div className="freed">
          <span>Freed this session</span>
          <b>{fmtSize(freed)}</b>
        </div>
      </div>

      {(st.analyzing || (S && S.pending > 0)) && (
        <div className="analyzing glass">
          <span className="pulse-dot" />
          Analyzing {fmtNum(st.analysisPending || S?.pending || 0)} photos · suggestions improve as it finishes
          <button className="btn sm" onClick={load} disabled={busy}>
            <Icon n="refresh" s={14} />
            Refresh
          </button>
        </div>
      )}

      <div className="cstats">
        {TABS.map((t) => (
          <button key={t.k} className={`cstat glass${tab === t.k ? " on" : ""}`} onClick={() => (setTab(t.k), setGi(0))}>
            <b>{S ? <CountUp to={counts[t.k]} fmt={(n) => fmtNum(Math.round(n))} /> : "–"}</b>
            <span>{t.label}</span>
            <i style={{ "--w": `${Math.min(100, (counts[t.k] / Math.max(1, ...Object.values(counts))) * 100)}%` } as React.CSSProperties} />
          </button>
        ))}
        <div className="cstat glass acc">
          <b>{S ? <CountUp to={reclaim} fmt={(n) => fmtSize(n)} /> : "–"}</b>
          <span>Reclaimable</span>
          <i style={{ "--w": "100%" } as React.CSSProperties} />
        </div>
      </div>

      {!rep && (
        <div className="empty scanning">
          <span className="pulse-dot" />
          <b>Comparing your photos…</b>
          <span>Same-size files are hashed byte for byte; every photo gets a visual fingerprint.</span>
        </div>
      )}

      {rep && (tab === "exact" || tab === "similar") && (
        <>
          {g ? (
            <>
              <div className="ghead">
                <div>
                  <b>
                    Group {fmtNum(gi + 1)} of {fmtNum(groups.length)}
                  </b>
                  <span className="gsub">
                    {plural(g.items.length, tab === "exact" ? "identical file" : "similar shot")} · {fmtShortDay(g.items[0].taken)} · {basename(g.items[g.best].dir)}
                  </span>
                </div>
                <div className="gacts">
                  <button className="btn" onClick={keepAll}>
                    Keep all <kbd>A</kbd>
                  </button>
                  <button className="btn" onClick={next} disabled={gi + 1 >= groups.length}>
                    Skip <kbd>S</kbd>
                  </button>
                  <button className="btn-acc" onClick={apply}>
                    {marks.size ? `Recycle ${marks.size} · free ${fmtSize(markedBytes)}` : "Keep all"} <kbd>↵</kbd>
                  </button>
                </div>
              </div>
              <div className={`deck${g.items.length > 3 ? " many" : ""}`}>
                {g.items.map((c, k) => {
                  const max = Math.max(...g.items.map((x) => x.sharp), 1);
                  const trashMe = marks.has(c.id);
                  return (
                    <div
                      key={c.id}
                      className={`dcard${k === g.best ? " best" : ""}${trashMe ? " trash" : ""}${leaving && trashMe ? " gone" : ""}`}
                      style={{ "--i": k, "--rot": `${(k - 1) * 6}deg` } as React.CSSProperties}
                      onClick={() =>
                        setMarks((m) => {
                          const n = new Set(m);
                          n.has(c.id) ? n.delete(c.id) : n.add(c.id);
                          return n;
                        })
                      }
                      onDoubleClick={() => open(c.id)}
                      title="Click to keep or recycle · double-click to view"
                    >
                      <div className="dimg">
                        <Thumb lib={lib} id={c.id} />
                      </div>
                      {k === g.best && <span className="bestb">★ Best pick</span>}
                      {c.fav && <span className="favtag">♥ Favorite</span>}
                      <span className="mark">✕ Recycle</span>
                      <div className="dmeta">
                        <span className="dname" title={`${c.dir}\\${c.name}`}>
                          {c.name}
                        </span>
                        <span>{fmtSize(c.size)}</span>
                      </div>
                      <div className="bars">
                        {tab === "similar" && <Bar label="Sharpness" v={c.sharp / max} text={String(Math.round((c.sharp / max) * 100))} warn={c.sharp / max < 0.45} best={k === g.best} />}
                        {tab === "similar" && <Bar label="Exposure" v={1 - Math.abs(c.luma - 118) / 118} text={String(Math.round((1 - Math.abs(c.luma - 118) / 118) * 100))} />}
                        <Bar label="Resolution" v={(c.w * c.h) / Math.max(...g.items.map((x) => x.w * x.h), 1)} text={c.w ? `${((c.w * c.h) / 1e6).toFixed(1)} MP` : "—"} />
                        <div className="dpath" title={c.dir}>
                          {c.dir}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="empty">
              <b>{tab === "exact" ? "No duplicate files" : "No similar shots"} ✓</b>
              <span>{tab === "exact" ? "Every file in your library is unique." : "Nothing here looks like a near-copy of something else."}</span>
            </div>
          )}
        </>
      )}

      {rep && (tab === "blurry" || tab === "shots") && (
        <>
          <div className="ghead">
            <div>
              <b>{tab === "blurry" ? "Possibly blurry" : "Screenshots older than a month"}</b>
              <span className="gsub">
                {tab === "blurry" ? "Lowest detail first. Dark or misty scenes can land here too, so look before you recycle." : "Found by file and folder name. Favorites are never suggested."}
              </span>
            </div>
            <div className="gacts">
              <button className="btn" onClick={() => setMarks(marks.size === list.length ? new Set() : new Set(list.map((c) => c.id)))} disabled={!list.length}>
                {marks.size === list.length && list.length ? "Clear" : "Select all"}
              </button>
              <button className="btn-acc" onClick={apply} disabled={!marks.size}>
                Recycle {fmtNum(marks.size)} · free {fmtSize(markedBytes)} <kbd>↵</kbd>
              </button>
            </div>
          </div>
          {list.length ? (
            <div className="pickgrid">
              {list.map((c) => (
                <button
                  key={c.id}
                  className={`pick${marks.has(c.id) ? " on" : ""}${leaving && marks.has(c.id) ? " gone" : ""}`}
                  onClick={() =>
                    setMarks((m) => {
                      const n = new Set(m);
                      n.has(c.id) ? n.delete(c.id) : n.add(c.id);
                      return n;
                    })
                  }
                  onDoubleClick={() => open(c.id)}
                  title={`${c.name} · ${fmtSize(c.size)} · double-click to view`}
                >
                  <Thumb lib={lib} id={c.id} />
                  <span className="check">
                    <Icon n="check" s={13} />
                  </span>
                  {tab === "blurry" && <em>detail {Math.round(c.sharp)}</em>}
                </button>
              ))}
            </div>
          ) : (
            <div className="empty">
              <b>{tab === "blurry" ? "Nothing looks blurry" : "No old screenshots"} ✓</b>
            </div>
          )}
        </>
      )}
    </div>
  );
}
