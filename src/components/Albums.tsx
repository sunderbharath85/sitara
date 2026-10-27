import { useEffect, useMemo, useState } from "react";
import { api, thumbUrl, type Albums as AlbumsData, type Lib } from "../lib/api";
import { startShow } from "../lib/actions";
import { fmtNum, plural } from "../lib/format";
import { setSel, store, useStore, type AlbumPage as Page } from "../lib/store";
import { Prompt } from "./Chrome";
import { Grid } from "./Grid";
import { Icon } from "./Icon";
import { toast } from "./Toasts";

type Filter = "all" | "albums" | "folders";

function Stack({ lib, covers }: { lib: Lib; covers: number[] }) {
  const imgs = covers.slice(0, 3).filter((id) => lib.pos.has(id));
  return (
    <div className="stack">
      {[2, 1, 0].map((k) => {
        const id = imgs[k];
        const i = id != null ? lib.pos.get(id)! : -1;
        return id != null ? <img key={k} className={`s${k + 1}`} alt="" loading="lazy" src={thumbUrl(id, lib.ver[i])} /> : <span key={k} className={`s${k + 1} blank`} />;
      })}
    </div>
  );
}

export function AlbumsView({ active }: { active: boolean }) {
  const lib = useStore((s) => s.lib);
  const libVer = useStore((s) => s.libVer);
  const page = useStore((s) => s.album);
  const [data, setData] = useState<AlbumsData | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [naming, setNaming] = useState(false);
  const load = () => api.albums().then(setData).catch((e) => toast(String(e)));
  useEffect(() => {
    if (active && !page) load();
  }, [active, page, libVer]);

  if (!lib) return null;
  if (page) return <AlbumPage lib={lib} page={page} active={active} onChanged={load} />;

  const cards = [
    ...(filter !== "folders" ? (data?.manual ?? []).map((a) => ({ key: `a${a.id}`, title: a.name, sub: "Album", count: a.count, covers: a.covers, open: () => openAlbum(a.id, a.name), manual: true })) : []),
    ...(filter !== "albums" ? (data?.folders ?? []).map((f) => ({ key: `d${f.dir}`, title: f.name, sub: f.parent, count: f.count, covers: f.covers, open: () => openDir(f.dir, f.name), manual: false })) : []),
  ];
  return (
    <div className="scroller page" onScroll={(e) => document.body.classList.toggle("scrolled", e.currentTarget.scrollTop > 10)}>
      <div className="page-head">
        <div className="ghost" aria-hidden="true">
          ALBUMS
        </div>
        <div className="sec-title">
          <div className="kicker">
            <span className="pill-acc">{plural(data?.folders.length ?? 0, "folder")} auto-sorted</span>
            <span>{plural(data?.manual.length ?? 0, "album")}</span>
          </div>
          <h2>Albums</h2>
          <div className="stats sans">Every folder becomes an album automatically. Make your own from any selection.</div>
        </div>
        <div className="head-acts">
          <button className="btn-acc" onClick={() => setNaming(true)}>
            <Icon n="plus" s={16} />
            New album
          </button>
        </div>
      </div>
      <div className="chips">
        {(["all", "albums", "folders"] as Filter[]).map((f) => (
          <button key={f} className={`chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "albums" ? "Your albums" : "Folders"}
          </button>
        ))}
      </div>
      {data && cards.length === 0 && (
        <div className="empty">
          <b>No albums yet</b>
          <span>Select photos in the Library, then choose “Add to album”.</span>
        </div>
      )}
      <div className="albums">
        {cards.map((c, k) => (
          <article key={c.key} className="album" style={{ "--i": Math.min(k, 12), "--len": Math.max(...c.title.split(/\s+/).map((w) => w.length)) } as React.CSSProperties} onClick={c.open}>
            <Stack lib={lib} covers={c.covers} />
            <span className={`badge glass${c.manual ? "" : " auto"}`}>{c.manual ? "Album" : "Folder"}</span>
            <h3>{c.title}</h3>
            <button
              className="al-play"
              title="Slideshow"
              aria-label={`Play ${c.title} as a slideshow`}
              onClick={async (e) => {
                e.stopPropagation();
                const ids = c.manual ? await api.albumItems(+c.key.slice(1)) : await api.dirItems(c.key.slice(1));
                startShow(ids, c.title);
              }}
            >
              <Icon n="play" s={16} />
            </button>
            <p>
              <b>{fmtNum(c.count)}</b> items · <span title={c.sub}>{c.sub}</span>
            </p>
          </article>
        ))}
      </div>
      {naming && (
        <Prompt
          title="New album"
          initial="Untitled album"
          cta="Create"
          onDone={async (name) => {
            setNaming(false);
            if (!name) return;
            const id = await api.albumCreate(name, []);
            toast(`“${name}” created · select photos and choose “Add to album”`);
            openAlbum(id, name);
          }}
        />
      )}
    </div>
  );
}

export async function openAlbum(id: number, title: string) {
  const ids = await api.albumItems(id);
  store.set({ view: "albums", album: { kind: "album", id, title, ids } });
}
export async function openDir(dir: string, title: string) {
  const ids = await api.dirItems(dir);
  store.set({ view: "albums", album: { kind: "dir", dir, title, ids } });
}

function AlbumPage({ lib, page, active, onChanged }: { lib: Lib; page: Page; active: boolean; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const order = useMemo(() => page.ids.map((id) => lib.pos.get(id)).filter((i): i is number => i != null), [page.ids, lib]);
  const back = () => store.set({ album: null });
  const header = (
    <div className="page-head album-head">
      <div className="ghost" aria-hidden="true">
        {page.title.slice(0, 10).toUpperCase()}
      </div>
      <div className="sec-title">
        <button className="back" onClick={back}>
          <Icon n="left" s={16} />
          Albums
        </button>
        <h2>{page.title}</h2>
        <div className="stats">
          {plural(order.length, "item")}
          {page.kind === "dir" ? ` · ${page.dir}` : ""}
        </div>
      </div>
      <div className="head-acts">
        <button className="btn" onClick={() => setSel(page.ids)} disabled={!order.length}>
          <Icon n="check" s={16} />
          Select all
        </button>
        {page.kind === "album" && (
          <>
            <button className="btn" onClick={() => setRenaming(true)}>
              <Icon n="edit" s={16} />
              Rename
            </button>
            {confirm ? (
              <button
                className="btn danger"
                onClick={async () => {
                  await api.albumDelete(page.id!);
                  toast(`Album “${page.title}” deleted · your photos are untouched`);
                  back();
                  onChanged();
                }}
              >
                Confirm delete
              </button>
            ) : (
              <button className="btn" onClick={() => setConfirm(true)}>
                <Icon n="trash" s={16} />
                Delete album
              </button>
            )}
          </>
        )}
        <button className="btn-acc" onClick={() => startShow(page.ids, page.title)} disabled={!order.length}>
          <Icon n="slides" s={16} />
          Slideshow
        </button>
      </div>
    </div>
  );
  return (
    <>
      <Grid
        lib={lib}
        order={order}
        group
        active={active}
        label={page.title}
        header={header}
        scrollKey={`${page.kind}:${page.id ?? page.dir}`}
        empty={
          <div className="empty">
            <b>This album is empty</b>
            <span>Select photos in the Library and choose “Add to album”.</span>
            <button className="btn" onClick={() => store.set({ view: "library", album: null })}>
              Go to Library
            </button>
          </div>
        }
      />
      {renaming && (
        <Prompt
          title="Rename album"
          initial={page.title}
          cta="Rename"
          onDone={async (name) => {
            setRenaming(false);
            if (!name || name === page.title) return;
            await api.albumRename(page.id!, name);
            store.set({ album: { ...page, title: name } });
          }}
        />
      )}
    </>
  );
}
