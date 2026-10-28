import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { addFolder, libraryIds, startShow } from "../lib/actions";
import { fmtMonth, fmtNum, plural } from "../lib/format";
import { store, useStore } from "../lib/store";
import { activeGrid } from "./Grid";
import { Icon } from "./Icon";
import { toast } from "./Toasts";

interface Cmd {
  g: string;
  t: string;
  ic: string;
  hint?: string;
  run: () => void;
  ask?: boolean;
}

// words the text search understands on its own; a query made only of these skips search by meaning
const STRUCTURAL = /^(videos?|clips|photos?|pictures|favou?rites?|loved|\d{4}|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;

export async function runSearch(q: string) {
  try {
    const ai = store.get().ai;
    const structural = q.split(/\s+/).filter(Boolean).every((t) => STRUCTURAL.test(t.replace(/[",“”]/g, "")));
    const [text, meaning] = await Promise.all([
      api.search(q),
      ai?.search && !structural ? api.aiSearch(q).catch(() => [] as number[]) : Promise.resolve([] as number[]),
    ]);
    // exact name, folder and camera matches first, then photos that match by meaning
    const seen = new Set(text);
    const ids = [...text, ...meaning.filter((id) => !seen.has(id))];
    store.set({ search: { q, ids, smart: ids.length - text.length }, view: "library", album: null, viewer: null });
    if (!ids.length) toast(`Nothing matches “${q}”`);
  } catch (e) {
    toast(String(e));
  }
}

function jumpTo(id: number) {
  store.set({ view: "library", album: null, search: null });
  setTimeout(() => activeGrid.reveal(id, true), 120);
}

export function Palette() {
  const open = useStore((s) => s.palette);
  const lib = useStore((s) => s.lib);
  const smartSearch = useStore((s) => !!s.ai?.search);
  const [q, setQ] = useState("");
  const [cur, setCur] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setCur(0);
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [open]);

  const months = useMemo(() => {
    const out: { t: number; id: number; n: number }[] = [];
    if (!lib) return out;
    let key = -1;
    for (let i = 0; i < lib.n; i++) {
      const d = new Date(lib.taken[i] * 1000),
        k = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (k !== key) {
        key = k;
        out.push({ t: lib.taken[i], id: lib.id[i], n: 0 });
      }
      out[out.length - 1].n++;
    }
    return out;
  }, [lib]);

  const close = () => store.set({ palette: false });
  const raw = q.trim(),
    ql = raw.toLowerCase();
  const base: Cmd[] = [
    { g: "Actions", t: "Add folder…", ic: "folderPlus", run: () => addFolder() },
    { g: "Actions", t: "Slideshow · whole library", ic: "slides", hint: "P", run: () => startShow(libraryIds(), "Library") },
    { g: "Actions", t: "Slideshow · cut to the beat", ic: "slides", hint: "♪ soundtrack", run: () => startShow(libraryIds(), "Library", { tempo: "beat" }) },
    { g: "Actions", t: "Rescan all folders", ic: "refresh", run: () => api.rescan().then(() => toast("Rescanning every folder")) },
    { g: "Show", t: "Favorites", ic: "heart", run: () => runSearch("favorites") },
    { g: "Show", t: "Videos", ic: "video", run: () => runSearch("videos") },
    { g: "Go to", t: "Library", ic: "grid", hint: "1", run: () => store.set({ view: "library", album: null }) },
    { g: "Go to", t: "Albums", ic: "layers", hint: "2", run: () => store.set({ view: "albums", album: null }) },
    { g: "Go to", t: "Cleanup · duplicates, similar, blurry", ic: "spark", hint: "3", run: () => store.set({ view: "cleanup", album: null }) },
    { g: "Go to", t: "Folders", ic: "folder", hint: "4", run: () => store.set({ view: "folders", album: null }) },
  ];
  const monthCmds: Cmd[] = months.map((m) => ({ g: "Jump to", t: fmtMonth(m.t), ic: "pin", hint: plural(m.n, "item"), run: () => jumpTo(m.id) }));
  let items = base.filter((c) => !ql || `${c.t} ${c.g}`.toLowerCase().includes(ql));
  items = items.concat(ql ? monthCmds.filter((c) => c.t.toLowerCase().includes(ql)).slice(0, 8) : monthCmds.slice(0, 4));
  if (raw) items.unshift({ g: "Search", t: `“${raw}”`, ic: "search", hint: smartSearch ? "by meaning, names, dates" : "names, folders, cameras, dates", ask: true, run: () => runSearch(raw) });

  const runAt = (k: number) => {
    const c = items[k];
    if (!c) return;
    close();
    setTimeout(c.run, 120);
  };
  const move = (k: number) => {
    const n = Math.max(0, Math.min(items.length - 1, k));
    setCur(n);
    requestAnimationFrame(() => list.current?.querySelector(".pal-i.on")?.scrollIntoView({ block: "nearest" }));
  };

  let g = "";
  return (
    <div id="pal-wrap" className={open ? "open" : ""} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div id="pal" className="glass" role="dialog" aria-label="Command palette">
        <div className="pal-in">
          <Icon n="search" />
          <input
            ref={input}
            id="pal-input"
            value={q}
            placeholder="Search your library, jump to a month, or run a command…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQ(e.target.value);
              setCur(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") move(cur + 1);
              else if (e.key === "ArrowUp") move(cur - 1);
              else if (e.key === "Enter") runAt(cur);
              else return;
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        </div>
        <div id="pal-list" ref={list}>
          {items.length === 0 && <div className="pal-g">No matches</div>}
          {items.map((c, k) => {
            const head = c.g !== g ? <div className="pal-g">{(g = c.g)}</div> : null;
            return (
              <div key={`${c.g}${c.t}`}>
                {head}
                <div className={`pal-i${k === cur ? " on" : ""}${c.ask ? " ask" : ""}`} onPointerMove={() => k !== cur && setCur(k)} onClick={() => runAt(k)}>
                  <Icon n={c.ic} s={16} />
                  <span className="t">{c.t}</span>
                  {c.hint && <span className="hint">{c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="pal-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
          <span style={{ marginLeft: "auto" }}>{lib ? `${fmtNum(lib.n)} items` : ""}</span>
        </div>
      </div>
    </div>
  );
}
