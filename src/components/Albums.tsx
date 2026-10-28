import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, faceUrl, thumbUrl, type Albums as AlbumsData, type Lib, type Person, type SmartAlbum } from "../lib/api";
import { startShow } from "../lib/actions";
import { fmtNum, plural } from "../lib/format";
import { makePrivate } from "../lib/private";
import { setSel, store, useStore, type AlbumPage as Page } from "../lib/store";
import { Prompt } from "./Chrome";
import { Grid } from "./Grid";
import { Icon } from "./Icon";
import { PeopleGrid, PeopleStrip, PersonActions } from "./People";
import { toast } from "./Toasts";

type Filter = "all" | "people" | "trips" | "places" | "smart" | "albums" | "folders";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["people", "People"],
  ["trips", "Trips"],
  ["places", "Places"],
  ["smart", "Smart"],
  ["albums", "Your albums"],
  ["folders", "Folders"],
];
const BADGE: Record<SmartAlbum["kind"], string> = { trip: "Auto · Trip", place: "Place", smart: "Smart" };

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

/** `priv`: the Private space's albums (its own manual albums and folders), under `head` instead of the usual title. */
export function AlbumsView({ active, priv, head }: { active: boolean; priv?: boolean; head?: ReactNode }) {
  const lib = useStore((s) => (priv ? s.plib : s.lib));
  const libVer = useStore((s) => (priv ? s.plibVer : s.libVer));
  const page = useStore((s) => (s.album && (s.view === "private") === !!priv ? s.album : null));
  const [data, setData] = useState<AlbumsData | null>(null);
  const [smart, setSmart] = useState<SmartAlbum[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const peopleOn = useStore((s) => !!s.ai?.people);
  const [filter, setFilter] = useState<Filter>("all");
  const [naming, setNaming] = useState(false);
  const load = () => {
    api.albums(priv).then(setData).catch((e) => toast(String(e)));
    if (priv) return;
    api.smartAlbums().then(setSmart).catch(() => {});
    if (store.get().ai?.people) api.people().then(setPeople).catch(() => {});
    else setPeople([]);
  };
  useEffect(() => {
    if (active && !page) load();
  }, [active, page, libVer]);
  useEffect(() => (priv ? undefined : api.onAnalysisChanged(() => active && !store.get().album && api.smartAlbums().then(setSmart).catch(() => {}))), [active, priv]);
  useEffect(() => (priv ? undefined : api.onAiChanged(() => active && api.people().then(setPeople).catch(() => {}))), [active, priv]);
  useEffect(() => {
    if (active && peopleOn && !priv) api.people().then(setPeople).catch(() => {});
  }, [active, peopleOn]);

  if (!lib) return null;
  if (page) return <AlbumPage lib={lib} page={page} active={active} onChanged={load} priv={priv} />;

  type Card = { key: string; title: string; sub: string; count: number; covers: number[]; badge: string; auto: boolean; open: () => void; ids: () => Promise<number[]> };
  const smartCard = (a: SmartAlbum): Card => ({
    key: a.key, title: a.title, sub: a.sub, count: a.ids.length, covers: a.covers, badge: BADGE[a.kind], auto: a.kind !== "smart",
    open: () => store.set({ view: "albums", album: { kind: "smart", title: a.title, ids: a.ids } }),
    ids: async () => a.ids,
  });
  const show = (f: Filter) => filter === "all" || filter === f;
  const isPeople = filter === "people";
  const cards: Card[] = [
    ...(show("trips") ? smart.filter((a) => a.kind === "trip").map(smartCard) : []),
    ...(show("albums")
      ? (data?.manual ?? []).map((a) => ({
          key: `a${a.id}`, title: a.name, sub: "Album", count: a.count, covers: a.covers, badge: "Album", auto: false,
          open: () => openAlbum(a.id, a.name, priv), ids: () => api.albumItems(a.id),
        }))
      : []),
    ...(show("smart") ? smart.filter((a) => a.kind === "smart").map(smartCard) : []),
    ...(show("places") ? smart.filter((a) => a.kind === "place").map(smartCard) : []),
    ...(show("folders")
      ? (data?.folders ?? []).map((f) => ({
          key: `d${f.dir}`, title: f.name, sub: f.parent, count: f.count, covers: f.covers, badge: "Folder", auto: true,
          open: () => openDir(f.dir, f.name, priv), ids: () => api.dirItems(f.dir),
        }))
      : []),
  ];
  const nTrips = smart.filter((a) => a.kind === "trip").length;
  const nPlaces = smart.filter((a) => a.kind === "place").length;
  const filters = priv ? FILTERS.filter(([f]) => f === "all" || f === "albums" || f === "folders") : FILTERS;
  return (
    <div className="scroller page" onScroll={(e) => document.body.classList.toggle("scrolled", e.currentTarget.scrollTop > 10)}>
      {head ?? (
      <div className="page-head">
        <div className="ghost" aria-hidden="true">
          ALBUMS
        </div>
        <div className="sec-title">
          <div className="kicker">
            <span className="pill-acc">{fmtNum(smart.length + (data?.folders.length ?? 0))} built for you</span>
            <span>
              {plural(nTrips, "trip")} · {plural(nPlaces, "place")} · {plural(data?.manual.length ?? 0, "album")}
            </span>
          </div>
          <h2>Albums</h2>
          <div className="stats sans">Trips, places and folders sort themselves as photos arrive. Place names come from an offline map, nothing is looked up online.</div>
        </div>
        <div className="head-acts">
          <button className="btn-acc" onClick={() => setNaming(true)}>
            <Icon n="plus" s={16} />
            New album
          </button>
        </div>
      </div>
      )}
      <div className="chips">
        {filters.map(([f, label]) => (
          <button key={f} className={`chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
            {label}
          </button>
        ))}
        {priv && (
          <button className="chip" style={{ marginLeft: "auto" }} onClick={() => setNaming(true)}>
            <Icon n="plus" s={14} /> New album
          </button>
        )}
      </div>
      {filter === "all" && !priv && <PeopleStrip people={people} onAll={() => setFilter("people")} />}
      {isPeople && <PeopleGrid people={people} />}
      {data && !isPeople && cards.length === 0 && (
        <div className="empty">
          <b>{filter === "trips" ? "No trips found yet" : filter === "places" ? "No places yet" : "No albums yet"}</b>
          <span>
            {filter === "trips" || filter === "places"
              ? "Trips and places need photos with GPS. Phones add it when location is on for the camera."
              : `Select photos in the ${priv ? "Private timeline" : "Library"}, then choose “Add to album”.`}
          </span>
        </div>
      )}
      <div className="albums">
        {cards.map((c, k) => (
          <article key={c.key} className="album" style={{ "--i": Math.min(k, 12), "--len": Math.max(...c.title.split(/\s+/).map((w) => w.length)) } as React.CSSProperties} onClick={c.open}>
            <Stack lib={lib} covers={c.covers} />
            <span className={`badge glass${c.auto ? " auto" : ""}`}>{c.badge}</span>
            <h3>{c.title}</h3>
            <button
              className="al-play"
              title="Slideshow"
              aria-label={`Play ${c.title} as a slideshow`}
              onClick={async (e) => {
                e.stopPropagation();
                startShow(await c.ids(), c.title);
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
      {nPlaces + nTrips > 0 && (
        <p className="hint credit">
          Place names from <button onClick={() => api.openUrl("https://www.geonames.org")}>GeoNames</button>, CC BY 4.0. Matched offline on this device.
        </p>
      )}
      {naming && (
        <Prompt
          title="New album"
          initial="Untitled album"
          cta="Create"
          onDone={async (name) => {
            setNaming(false);
            if (!name) return;
            const id = await api.albumCreate(name, [], priv);
            toast(`“${name}” created · select photos and choose “Add to album”`);
            openAlbum(id, name, priv);
          }}
        />
      )}
    </div>
  );
}

export async function openAlbum(id: number, title: string, priv?: boolean) {
  const ids = await api.albumItems(id);
  store.set({ view: priv ? "private" : "albums", album: { kind: "album", id, title, ids } });
}
export async function openDir(dir: string, title: string, priv?: boolean) {
  const ids = await api.dirItems(dir);
  store.set({ view: priv ? "private" : "albums", album: { kind: "dir", dir, title, ids } });
}

function AlbumPage({ lib, page, active, onChanged, priv }: { lib: Lib; page: Page; active: boolean; onChanged: () => void; priv?: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const order = useMemo(() => page.ids.map((id) => lib.pos.get(id)).filter((i): i is number => i != null), [page.ids, lib]);
  const back = () => store.set({ album: null });
  const header = (
    <div className="page-head album-head">
      <div className="ghost" aria-hidden="true">
        {(page.title || (page.kind === "person" ? "PEOPLE" : "")).slice(0, 10).toUpperCase()}
      </div>
      <div className="sec-title">
        <button className="back" onClick={back}>
          <Icon n="left" s={16} />
          Albums
        </button>
        {page.kind === "person" ? (
          <div className="person-title">
            {page.face != null && <img className="person-face" alt="" src={faceUrl(page.face)} />}
            <h2 className={page.title ? "" : "unnamed"}>{page.title || "Who is this?"}</h2>
          </div>
        ) : (
          <h2>{page.title}</h2>
        )}
        <div className="stats">
          {plural(order.length, "item")}
          {page.kind === "dir" ? ` · ${page.dir}` : page.kind === "smart" ? " · smart album" : page.kind === "person" ? " · found by face on this device" : ""}
        </div>
      </div>
      <div className="head-acts">
        <button className="btn" onClick={() => setSel(page.ids)} disabled={!order.length}>
          <Icon n="check" s={16} />
          Select all
        </button>
        {page.kind === "dir" && !priv && page.dir && (
          <button className="btn" onClick={() => makePrivate(page.dir!, back)} title="Hide this folder in the Private space">
            <Icon n="lock" s={16} />
            Move to Private
          </button>
        )}
        {page.kind === "person" && <PersonActions page={page} onChanged={onChanged} />}
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
            <span>Select photos in the {priv ? "Private timeline" : "Library"} and choose “Add to album”.</span>
            {!priv && (
              <button className="btn" onClick={() => store.set({ view: "library", album: null })}>
                Go to Library
              </button>
            )}
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
