// In-browser stand-in for the Rust backend so the UI can be developed and tested in a plain browser
// (`npm run dev`). Loaded only when not running inside Tauri; uses picsum.photos sample images.
import type { AlbumInfo, Albums, DirAlbum, FolderInfo, MediaDetail, Status } from "./api";

type Item = { id: number; ar: number; taken: number; kind: number; fav: number; dur: number; dir: string; cam: number };

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AR = [1.5, 1.5, 1.333, 0.667, 0.75, 1, 1.778, 0.5625, 1.5, 0.8, 1.333];
const CAMS: [string, string, string][] = [
  ["FUJIFILM", "X100VI", "23mm F2"],
  ["SONY", "ILCE-7M4", "FE 35mm F1.8"],
  ["Apple", "iPhone 17 Pro", "iPhone 17 Pro back camera 6.86mm f/1.78"],
  ["Google", "Pixel 10 Pro", ""],
];
const ROOT = "C:\\Users\\you\\Pictures";
const DIRS = ["2026-10 Kyoto", "2026-09 Lisbon", "Camera Roll", "2026-08 Iceland", "Family", "Screenshots", "2025-12 Mumbai"];

export function createMock() {
  const r = rng(20261027);
  const items: Item[] = [];
  let t = Date.UTC(2026, 9, 27, 18, 0) / 1000;
  for (let i = 0; i < 720; i++) {
    t -= Math.floor(r() * 3 * 86400 * (r() < 0.08 ? 10 : 1));
    const video = r() < 0.12;
    items.push({
      id: i + 1,
      ar: video ? (r() < 0.8 ? 1.778 : 0.5625) : AR[Math.floor(r() * AR.length)],
      taken: t,
      kind: video ? 1 : 0,
      fav: r() < 0.05 ? 1 : 0,
      dur: video ? 4 + Math.floor(r() * 90) : 0,
      dir: `${ROOT}\\${DIRS[Math.floor(r() * DIRS.length)]}`,
      cam: Math.floor(r() * CAMS.length),
    });
  }
  const albums: { id: number; name: string; ids: number[]; updatedAt: number }[] = [
    { id: 1, name: "Favorites of 2026", ids: items.filter((x) => x.fav).map((x) => x.id), updatedAt: Date.now() },
  ];
  const trashed = new Set<number>();
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = (ev: string, p?: unknown) => listeners.get(ev)?.forEach((f) => f(p));
  const status: Status = { scanning: false, folder: null, found: 0, indexed: 0, warming: false, thumbsPending: 0, thumbsDone: 0 };
  let folders: FolderInfo[] = [{ id: 1, path: ROOT, count: items.length, photos: 0, videos: 0, bytes: 9.4e9, lastScan: Date.now() }];
  const live = () => items.filter((x) => !trashed.has(x.id));
  const byId = new Map(items.map((x) => [x.id, x]));
  const W = (x: Item) => (x.ar >= 1 ? 6000 : Math.round(6000 * x.ar));
  const H = (x: Item) => (x.ar >= 1 ? Math.round(6000 / x.ar) : 6000);

  function pack(): ArrayBuffer {
    const list = live();
    const buf = new ArrayBuffer(8 + list.length * 24);
    const dv = new DataView(buf);
    dv.setUint32(4, list.length, true);
    list.forEach((x, i) => {
      const o = 8 + i * 24;
      dv.setUint32(o, x.id, true);
      dv.setUint32(o + 4, 1, true);
      dv.setFloat64(o + 8, x.taken, true);
      dv.setUint16(o + 16, Math.min(65535, W(x)), true);
      dv.setUint16(o + 18, Math.min(65535, H(x)), true);
      dv.setUint8(o + 20, x.kind);
      dv.setUint8(o + 21, x.fav);
      dv.setUint16(o + 22, x.dur, true);
    });
    return buf;
  }
  function detail(id: number): MediaDetail | null {
    const x = byId.get(id);
    if (!x) return null;
    const c = CAMS[x.cam];
    const name = x.kind ? `VID_${4100 + id}.MP4` : `IMG_${7100 + id}.JPG`;
    return {
      id, path: `${x.dir}\\${name}`, dir: x.dir, name, ext: x.kind ? "mp4" : "jpg", kind: x.kind,
      size: x.kind ? 4e7 + id * 1e5 : 3e6 + id * 1e4, mtime: x.taken * 1000, width: W(x), height: H(x), taken: x.taken,
      duration: x.kind ? x.dur : null, make: c[0], model: c[1], lens: c[2] || null, fnumber: [1.8, 2, 2.8, 4][id % 4],
      exposure: ["1/250", "1/60", "1/1000"][id % 3], iso: [100, 200, 800][id % 3], focal: [23, 35, 24][id % 3],
      lat: id % 3 ? 35.0116 + (id % 7) / 100 : null, lon: id % 3 ? 135.7681 : null, favorite: !!x.fav, folder: ROOT,
    };
  }
  function albumsResp(): Albums {
    const L = live();
    const manual: AlbumInfo[] = albums.map((a) => ({
      id: a.id, name: a.name, updatedAt: a.updatedAt,
      count: a.ids.filter((i) => !trashed.has(i)).length,
      covers: a.ids.filter((i) => !trashed.has(i)).slice(0, 3),
    }));
    const dirs = new Map<string, Item[]>();
    L.forEach((x) => dirs.set(x.dir, [...(dirs.get(x.dir) ?? []), x]));
    const fold: DirAlbum[] = [...dirs].map(([dir, xs]) => ({
      dir, name: dir.split("\\").pop()!, parent: ROOT, count: xs.length,
      covers: xs.filter((x) => !x.kind).slice(0, 3).map((x) => x.id), latest: xs[0].taken,
    }));
    return { manual, folders: fold };
  }
  const handlers: Record<string, (a: Record<string, any>) => unknown> = {
    library: () => pack(),
    media_detail: (a) => detail(a.id),
    folders: () => folders.map((f) => ({ ...f, count: live().length })),
    add_folder: (a) => {
      folders = [...folders, { id: folders.length + 1, path: a.path, count: 0, photos: 0, videos: 0, bytes: 0, lastScan: null }];
      return folders;
    },
    remove_folder: (a) => (folders = folders.filter((f) => f.id !== a.id)),
    rescan: () => {
      Object.assign(status, { scanning: true, found: 0, indexed: 0 });
      let k = 0;
      const iv = setInterval(() => {
        k += 60;
        Object.assign(status, { found: Math.min(k * 2, 720), indexed: Math.min(k, 720) });
        if (k >= 720) {
          clearInterval(iv);
          status.scanning = false;
        }
        emit("index-status", { ...status });
      }, 120);
    },
    index_status: () => ({ ...status }),
    suggest_folders: () => [{ path: "C:\\Users\\you\\Videos", label: "Videos" }],
    set_favorite: (a) => a.ids.forEach((id: number) => (byId.get(id)!.fav = a.value ? 1 : 0)),
    trash_items: (a) => {
      a.ids.forEach((id: number) => trashed.add(id));
      setTimeout(() => emit("library-changed"), 30);
      return a.ids;
    },
    restore_items: (a) => {
      a.ids.forEach((id: number) => trashed.delete(id));
      setTimeout(() => emit("library-changed"), 30);
      return a.ids;
    },
    albums: () => albumsResp(),
    album_items: (a) => (albums.find((x) => x.id === a.id)?.ids.filter((i) => !trashed.has(i)) ?? []).sort((x, y) => byId.get(y)!.taken - byId.get(x)!.taken),
    dir_items: (a) => live().filter((x) => x.dir === a.dir).map((x) => x.id),
    album_create: (a) => {
      const id = Math.max(0, ...albums.map((x) => x.id)) + 1;
      albums.unshift({ id, name: a.name || "Untitled album", ids: [...a.ids], updatedAt: Date.now() });
      return id;
    },
    album_add: (a) => {
      const al = albums.find((x) => x.id === a.id)!;
      al.ids = [...new Set([...al.ids, ...a.ids])];
    },
    album_remove: (a) => {
      const al = albums.find((x) => x.id === a.id)!;
      al.ids = al.ids.filter((i) => !a.ids.includes(i));
    },
    album_rename: (a) => void (albums.find((x) => x.id === a.id)!.name = a.name),
    album_delete: (a) => albums.splice(albums.findIndex((x) => x.id === a.id), 1),
    search: (a) => {
      const q = String(a.q).toLowerCase();
      return live()
        .filter((x) => (q.includes("video") ? x.kind === 1 : true) && (q.includes("video") || detail(x.id)!.path.toLowerCase().includes(q.split(" ")[0]) || CAMS[x.cam].join(" ").toLowerCase().includes(q)))
        .map((x) => x.id);
    },
    reveal: () => undefined,
    open_external: () => undefined,
  };
  return {
    async call(cmd: string, args: Record<string, unknown>) {
      const h = handlers[cmd];
      if (!h) throw new Error(`mock: no ${cmd}`);
      return h(args as Record<string, any>);
    },
    on(ev: string, cb: (p: unknown) => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return () => void listeners.get(ev)!.delete(cb);
    },
    async pickFolder() {
      return "D:\\Phone backup\\DCIM";
    },
    thumbUrl: (id: number) => {
      const x = byId.get(id);
      const ar = x?.ar ?? 1.5;
      return `https://picsum.photos/seed/s${id}/${Math.round(360 * ar)}/360`;
    },
    fullUrl: (id: number) => {
      const ar = byId.get(id)?.ar ?? 1.5;
      return ar >= 1 ? `https://picsum.photos/seed/s${id}/1800/${Math.round(1800 / ar)}` : `https://picsum.photos/seed/s${id}/${Math.round(1500 * ar)}/1500`;
    },
  };
}

export type MockBackend = ReturnType<typeof createMock>;
