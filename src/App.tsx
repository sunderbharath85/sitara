import { useEffect, useMemo } from "react";
import { AlbumsView } from "./components/Albums";
import { AlbumPicker, Dock, TopBar, Tray } from "./components/Chrome";
import { CleanupView } from "./components/Cleanup";
import { Editor } from "./components/editor/Editor";
import { FoldersView, Welcome } from "./components/Folders";
import { activeGrid, Grid } from "./components/Grid";
import { Palette } from "./components/Palette";
import { PrivateModals, PrivateView } from "./components/Private";
import { Slideshow } from "./components/Slideshow";
import { Toasts } from "./components/Toasts";
import { Viewer } from "./components/Viewer";
import { api, type Lib } from "./lib/api";
import { addFolder, libraryIds, openPicker, reloadFolders, reloadLibrary, setFavorite, startShow, trash } from "./lib/actions";
import { fmtNum, plural } from "./lib/format";
import { lockNow, onPrivateChanged, reloadPrivateLibrary, reloadPrivateStatus, watchActivity } from "./lib/private";
import { clearSel, setSel, store, useStore } from "./lib/store";

function LibraryView({ lib, active }: { lib: Lib; active: boolean }) {
  const search = useStore((s) => (s.search?.private ? null : s.search));
  const st = useStore((s) => s.status);
  const order = useMemo(() => {
    if (search) return search.ids.map((id) => lib.pos.get(id)).filter((i): i is number => i != null);
    return Uint32Array.from({ length: lib.n }, (_, i) => i);
  }, [lib, search]);
  return (
    <Grid
      lib={lib}
      order={order}
      group
      rail
      active={active}
      label={search ? `“${search.q}”` : "Library"}
      scrollKey={search?.q ?? ""}
      header={<div className="grid-top" />}
      empty={
        search ? (
          <div className="empty">
            <b>Nothing matches “{search.q}”</b>
            <span>Search looks at file and folder names, camera models, years and months.</span>
          </div>
        ) : (
          <div className="empty scanning">
            <span className="pulse-dot" />
            <b>{st.scanning ? `Looking for photos · ${fmtNum(st.found)} found` : "No photos here yet"}</b>
            <span>{st.scanning ? "They'll appear here as soon as they're read." : "Add a folder in Folders, or drop one onto the window."}</span>
          </div>
        )
      }
    />
  );
}

function SearchBar() {
  const search = useStore((s) => s.search);
  const view = useStore((s) => s.view);
  return (
    <div id="searchbar" className={`glass${search && view === (search.private ? "private" : "library") ? " on" : ""}`}>
      <span className="st">✦</span>
      <b>“{search?.q}”</b>
      <span className="sn">
        {search ? plural(search.ids.length, "result") : ""}
        {search?.smart ? <em> · ✦ {search.smart} by meaning</em> : null}
      </span>
      <button onClick={() => store.set({ search: null })}>Clear ✕</button>
    </div>
  );
}

export default function App() {
  const lib = useStore((s) => s.lib);
  const view = useStore((s) => s.view);
  const folders = useStore((s) => s.folders);
  const selCount = useStore((s) => s.sel.size);
  const viewing = useStore((s) => !!s.viewer || !!s.editor);
  const unlocked = useStore((s) => s.priv.unlocked);

  useEffect(() => {
    reloadLibrary();
    reloadFolders();
    api.status().then((status) => store.set({ status })).catch(() => {});
    const loadAi = () => api.aiStatus().then((ai) => store.set({ ai })).catch(() => {});
    loadAi();
    reloadPrivateStatus().then((p) => void (p?.unlocked && reloadPrivateLibrary()));
    let pending: ReturnType<typeof setTimeout> | null = null;
    const offs = [
      api.onStatus((status) => {
        const was = store.get().status;
        store.set({ status });
        if (was.scanning && !status.scanning) reloadFolders();
      }),
      api.onLibraryChanged(() => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          reloadLibrary();
          reloadPrivateLibrary();
        }, 150);
      }),
      api.onPrivateChanged(onPrivateChanged),
      api.onDropFolders((paths) => paths.forEach((p) => addFolder(p))),
      api.onAiProgress(loadAi),
      api.onAiChanged(loadAi),
    ];
    offs.push(watchActivity());
    return () => offs.forEach((f) => f());
  }, []);

  useEffect(() => {
    document.body.classList.toggle("selecting", selCount > 0);
  }, [selCount]);
  useEffect(() => {
    document.body.dataset.view = view;
    clearSel();
    if (view !== "private" && store.get().search?.private) store.set({ search: null });
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = store.get();
      const k = e.key;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k.toLowerCase() === "k") {
        e.preventDefault();
        store.set({ palette: !s.palette });
        return;
      }
      if (mod && k.toLowerCase() === "l" && s.priv.unlocked) {
        e.preventDefault();
        lockNow();
        return;
      }
      if (s.palette || s.viewer || s.show || s.picker || s.editor) return;
      if ((e.target as HTMLElement).matches?.("input,textarea,select")) return;
      if (document.querySelector(".modal-wrap")) return;
      if (k === "/") {
        e.preventDefault();
        store.set({ palette: true });
      } else if (k === "Escape") {
        if (s.sel.size) clearSel();
        else if (s.search && s.view === (s.search.private ? "private" : "library")) store.set({ search: null });
        else if (s.album) store.set({ album: null });
      } else if (!mod && (k === "1" || k === "2" || k === "3" || k === "4")) {
        store.set({ view: (["library", "albums", "cleanup", "folders"] as const)[+k - 1], album: k === "2" && s.view !== "private" ? s.album : null });
      } else if (mod && k.toLowerCase() === "a") {
        e.preventDefault();
        setSel(activeGrid.ids());
      } else if (k === "Delete" && s.sel.size) {
        trash([...s.sel]);
      } else if (k === "p" || k === "P") {
        const ids = s.sel.size ? activeGrid.ids().filter((id) => s.sel.has(id)) : activeGrid.ids();
        startShow(ids.length ? ids : libraryIds(), s.sel.size ? "Selection" : s.album?.title ?? "Library");
      } else if ((k === "f" || k === "F") && s.sel.size && s.lib) {
        const ids = [...s.sel];
        setFavorite(ids, !ids.every((id) => s.lib!.fav[s.lib!.pos.get(id) ?? -1] === 1));
      } else if ((k === "a" || k === "A") && s.sel.size) {
        openPicker([...s.sel]);
      } else if ((k === "e" || k === "E") && s.sel.size === 1 && s.lib) {
        const id = [...s.sel][0];
        if (s.lib.kind[s.lib.pos.get(id) ?? -1] === 0) store.set({ editor: { id } });
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const firstRun = folders !== null && folders.length === 0 && (!lib || lib.n === 0);
  if (firstRun)
    return (
      <>
        <Welcome />
        <Toasts />
      </>
    );

  return (
    <>
      <TopBar />
      <SearchBar />
      <main id="views" aria-hidden={viewing}>
        <section className={`view${view === "library" ? " on" : ""}`}>{lib && <LibraryView lib={lib} active={view === "library"} />}</section>
        <section className={`view${view === "albums" ? " on" : ""}`}>
          <AlbumsView active={view === "albums"} />
        </section>
        <section className={`view${view === "cleanup" ? " on" : ""}`}>
          <CleanupView active={view === "cleanup"} />
        </section>
        <section className={`view${view === "folders" ? " on" : ""}`}>
          <FoldersView />
        </section>
        <section className={`view${view === "private" ? " on" : ""}`}>{unlocked && <PrivateView active={view === "private"} />}</section>
      </main>
      <Dock />
      <Tray />
      <Viewer />
      <Editor />
      <Slideshow />
      <Palette />
      <AlbumPicker />
      <PrivateModals />
      <Toasts />
    </>
  );
}
