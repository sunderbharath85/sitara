import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { openPicker, setFavorite, startShow, trash, where } from "../lib/actions";
import { fmtNum, plural } from "../lib/format";
import { clearSel, store, useStore, type View } from "../lib/store";
import { Icon } from "./Icon";
import { toast } from "./Toasts";

const HINTS = ["Search “2025”", "Try “videos”", "Try “march 2024”", "Try a camera, like “fujifilm”", "Try a folder name", "Try “favorites”"];

export function TopBar() {
  const st = useStore((s) => s.status);
  const n = useStore((s) => s.lib?.n ?? 0);
  const [hint, setHint] = useState(0);
  const [out, setOut] = useState(false);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const iv = setInterval(() => {
      setOut(true);
      setTimeout(() => {
        setHint((h) => (h + 1) % HINTS.length);
        setOut(false);
      }, 350);
    }, 3600);
    return () => clearInterval(iv);
  }, []);

  let text: string, k: number, busy: boolean;
  if (st.scanning) {
    busy = true;
    k = st.found ? st.indexed / Math.max(st.found, 1) : 0.08;
    text = st.indexed ? `Indexing · ${fmtNum(st.indexed)} / ${fmtNum(st.found)}` : `Scanning · ${fmtNum(st.found)} found`;
  } else if (st.warming && st.thumbsPending > 0) {
    busy = true;
    k = st.thumbsDone / Math.max(1, st.thumbsDone + st.thumbsPending);
    text = `Thumbnails · ${fmtNum(st.thumbsPending)} to go`;
  } else if (st.analyzing && st.analysisPending > 0) {
    busy = true;
    k = 0.5;
    text = `Analyzing · ${fmtNum(st.analysisPending)} to go`;
  } else {
    busy = false;
    k = 1;
    text = `Up to date · ${plural(n, "item")}`;
  }
  return (
    <header id="top" className="glass">
      <div className="logo">
        <i />
        Sitara
      </div>
      <button id="search" onClick={() => store.set({ palette: true })} aria-label="Search or run a command">
        <Icon n="search" />
        <span id="ph" className={out ? "out" : ""}>
          {HINTS[hint]}
        </span>
        <kbd>Ctrl K</kbd>
      </button>
      <button id="ingest" className={busy ? "" : "done"} onClick={() => store.set({ view: "folders", album: null })} title="Folders and indexing">
        <svg className="ring" viewBox="0 0 18 18">
          <circle cx="9" cy="9" r="7" />
          <circle className="pr" cx="9" cy="9" r="7" style={{ strokeDashoffset: (44 * (1 - Math.min(1, k))).toFixed(2) }} />
        </svg>
        <span id="ingest-t">{text}</span>
      </button>
    </header>
  );
}

const VIEWS: [View, string, string][] = [
  ["library", "grid", "Library"],
  ["albums", "layers", "Albums"],
  ["cleanup", "spark", "Cleanup"],
  ["folders", "folder", "Folders"],
];

export function Dock() {
  const view = useStore((s) => s.view);
  const nav = useRef<HTMLElement>(null);
  const [ind, setInd] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const place = () => {
      const b = nav.current?.querySelector<HTMLElement>(`button[data-view="${view}"]`);
      if (b) setInd({ x: b.offsetLeft - 6, w: b.offsetWidth });
    };
    place();
    document.fonts?.ready.then(place);
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [view]);
  return (
    <nav id="dock" className="glass" ref={nav}>
      <span className="ind" style={{ width: ind.w, transform: `translateX(${ind.x}px)` }} />
      {VIEWS.map(([v, ic, label], k) => (
        <button key={v} data-view={v} className={view === v ? "on" : ""} onClick={() => store.set({ view: v, album: v === "albums" ? store.get().album : null })} title={`${label} (${k + 1})`}>
          <Icon n={ic} />
          <em>{label}</em>
        </button>
      ))}
    </nav>
  );
}

export function Tray() {
  const sel = useStore((s) => s.sel);
  const album = useStore((s) => s.album);
  const view = useStore((s) => s.view);
  const lib = useStore((s) => s.lib);
  useStore((s) => s.favVer);
  const ids = [...sel];
  const allFav = !!lib && ids.length > 0 && ids.every((id) => lib.fav[lib.pos.get(id) ?? -1] === 1);
  const inAlbum = view === "albums" && album?.kind === "album" && album.id != null;
  return (
    <div id="tray" className="glass">
      <button id="tray-x" onClick={clearSel} aria-label="Clear selection" title="Clear (Esc)">
        <Icon n="x" />
      </button>
      <div className="tray-info">
        <b>{fmtNum(sel.size)} selected</b>
        <span>Esc to clear · Ctrl A for all</span>
      </div>
      <div className="tray-sep" />
      <button onClick={() => openPicker(ids)}>
        <Icon n="plus" />
        Add to album
      </button>
      <button onClick={() => setFavorite(ids, !allFav)}>
        <Icon n="heart" />
        {allFav ? "Unfavorite" : "Favorite"}
      </button>
      <button onClick={() => startShow(ids.sort((a, b) => (lib?.pos.get(a) ?? 0) - (lib?.pos.get(b) ?? 0)), "Selection")}>
        <Icon n="slides" />
        Slideshow
      </button>
      {sel.size === 1 && (
        <button onClick={() => api.reveal(ids[0]).catch((e) => toast(String(e)))}>
          <Icon n="reveal" />
          Show in {where}
        </button>
      )}
      {inAlbum && (
        <button
          onClick={async () => {
            await api.albumRemove(album!.id!, ids);
            store.set({ album: { ...album!, ids: album!.ids.filter((x) => !sel.has(x)) } });
            clearSel();
            toast(`Removed ${plural(ids.length, "item")} from ${album!.title}`);
          }}
        >
          Remove from album
        </button>
      )}
      <button className="danger" onClick={() => trash(ids)} aria-label="Move to Recycle Bin" title="Move to Recycle Bin (Del)">
        <Icon n="trash" />
      </button>
    </div>
  );
}

export function Prompt({ title, initial, cta, onDone }: { title: string; initial: string; cta: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inp.current?.focus();
    inp.current?.select();
  }, []);
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}>
      <form
        className="modal glass"
        onSubmit={(e) => {
          e.preventDefault();
          onDone(v.trim() || initial);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone(null);
          }
        }}
      >
        <h3>{title}</h3>
        <input ref={inp} value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} />
        <div className="modal-acts">
          <button type="button" className="btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="submit" className="btn-acc">
            {cta}
          </button>
        </div>
      </form>
    </div>
  );
}

export function AlbumPicker() {
  const ids = useStore((s) => s.picker);
  const [albums, setAlbums] = useState<{ id: number; name: string; count: number }[] | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!ids) return;
    setName("");
    api.albums().then((a) => setAlbums(a.manual)).catch(() => setAlbums([]));
  }, [ids]);
  useEffect(() => {
    if (!ids) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        store.set({ picker: null });
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [ids]);
  if (!ids) return null;
  const done = (albumId: number, title: string) => {
    store.set({ picker: null });
    clearSel();
    toast(`Added ${plural(ids.length, "item")} to ${title}`, {
      label: "Open",
      run: async () => {
        const items = await api.albumItems(albumId);
        store.set({ viewer: null, view: "albums", album: { kind: "album", id: albumId, title, ids: items } });
      },
    });
  };
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && store.set({ picker: null })}>
      <div className="modal glass picker">
        <h3>Add {plural(ids.length, "item")} to…</h3>
        <form
          className="new-album"
          onSubmit={async (e) => {
            e.preventDefault();
            const n = name.trim() || "Untitled album";
            const id = await api.albumCreate(n, ids);
            done(id, n);
          }}
        >
          <input autoFocus placeholder="New album name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-acc" type="submit">
            <Icon n="plus" s={16} />
            Create
          </button>
        </form>
        <div className="pick-list">
          {albums === null && <div className="muted">Loading…</div>}
          {albums?.length === 0 && <div className="muted">No albums yet. Name one above.</div>}
          {albums?.map((a) => (
            <button
              key={a.id}
              onClick={async () => {
                await api.albumAdd(a.id, ids);
                done(a.id, a.name);
              }}
            >
              <Icon n="layers" s={16} />
              <span>{a.name}</span>
              <em>{fmtNum(a.count)}</em>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
