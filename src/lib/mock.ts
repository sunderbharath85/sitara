// In-browser stand-in for the Rust backend so the UI can be developed and tested in a plain browser
// (`npm run dev`). Loaded only when not running inside Tauri; uses picsum.photos sample images.
import type { AiStatus, AlbumInfo, Albums, CGroup, CItem, CleanupReport, DirAlbum, FolderInfo, MediaDetail, Person, SmartAlbum, Status } from "./api";

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
  const edits = new Map<number, { stack: string; w: number; h: number; rev: number; thumb: string; preview: string }>();
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = (ev: string, p?: unknown) => listeners.get(ev)?.forEach((f) => f(p));
  const status: Status = { scanning: false, folder: null, found: 0, indexed: 0, warming: false, thumbsPending: 0, thumbsDone: 0, analyzing: false, analysisPending: 0, learning: false, learnPending: 0 };
  const ai: AiStatus = {
    supported: true, search: false, people: false, searchMb: 154, peopleMb: 38, runtimeMb: 17, download: null, indexed: 0, pending: 0, faces: 0, working: false,
    packs: (
      [["search", 155], ["people", 38], ["erase", 208], ["subject", 114], ["sky", 175], ["denoise", 58], ["upscale", 4], ["depth", 99]] as const
    ).map(([key, mb]) => ({ key, on: false, mb })),
  };
  const layers = new Map<string, string>();
  // people are faked from photo ids: a "face id" is the photo it was found in
  const people: (Person & { ids: number[] })[] = [];
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
      const ed = edits.get(x.id);
      dv.setUint32(o + 4, 1 + (ed?.rev ?? 0), true);
      dv.setFloat64(o + 8, x.taken, true);
      dv.setUint16(o + 16, Math.min(65535, ed?.w ?? W(x)), true);
      dv.setUint16(o + 18, Math.min(65535, ed?.h ?? H(x)), true);
      dv.setUint8(o + 20, x.kind);
      dv.setUint8(o + 21, x.fav | (ed ? 2 : 0));
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
      edited: edits.get(id)?.rev ?? 0,
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
    ai_status: () => ({ ...ai }),
    ai_install: (a) => {
      const pack = ai.packs.find((p) => p.key === a.feature)!;
      const total = pack.mb + ai.runtimeMb;
      let done = 0;
      const iv = setInterval(() => {
        done = Math.min(total, done + total / 14);
        ai.download = { label: done < ai.runtimeMb ? "AI runtime" : a.feature === "people" ? "Face models" : "Search model", done: done * 1e6, total: total * 1e6, error: null };
        emit("ai-progress");
        if (done >= total) {
          clearInterval(iv);
          ai.download = null;
          ai.runtimeMb = 0;
          pack.on = true;
          if (a.feature !== "search" && a.feature !== "people") {
            emit("ai-progress");
            return;
          }
          if (a.feature === "people") {
            ai.people = true;
            const L = live().filter((x) => !x.kind);
            for (const [k, name] of [[0, "Asha"], [1, null], [2, "Ravi"], [3, null], [4, null]] as const) {
              const ids = L.filter((_, i) => i % (k + 5) === k).map((x) => x.id).slice(0, 40 - k * 6);
              people.push({ id: k + 1, name, count: ids.length, cover: ids[0], hidden: false, ids });
            }
            ai.faces = people.reduce((n, p) => n + p.count, 0);
          } else ai.search = true;
          ai.indexed = live().length;
          emit("ai-progress");
          emit("ai-changed");
        }
      }, 160);
    },
    ai_remove: (a) => {
      ai.packs.find((p) => p.key === a.feature)!.on = false;
      if (a.feature === "people") {
        ai.people = false;
        people.length = 0;
      } else ai.search = false;
      emit("ai-changed");
    },
    ai_search: (a) => {
      // stand-in for meaning: a stable pseudo-random pick per query
      let h = 0;
      for (const ch of String(a.q)) h = (h * 31 + ch.charCodeAt(0)) | 0;
      return live().filter((x) => !x.kind && ((x.id * 2654435761) ^ h) % 9 === 0).slice(0, 60).map((x) => x.id);
    },
    people: () => people.map(({ ids, ...p }) => ({ ...p, count: ids.filter((i) => !trashed.has(i)).length })),
    person_items: (a) => people.find((p) => p.id === a.id)?.ids.filter((i) => !trashed.has(i)) ?? [],
    person_rename: (a) => {
      people.find((p) => p.id === a.id)!.name = a.name || null;
      emit("ai-changed");
    },
    person_merge: (a) => {
      const from = people.find((p) => p.id === a.from)!,
        into = people.find((p) => p.id === a.into)!;
      into.ids = [...new Set([...into.ids, ...from.ids])];
      into.name ??= from.name;
      people.splice(people.indexOf(from), 1);
      emit("ai-changed");
    },
    person_hide: (a) => {
      people.find((p) => p.id === a.id)!.hidden = a.hidden;
      emit("ai-changed");
    },
    person_remove: (a) => {
      const p = people.find((x) => x.id === a.id)!;
      p.ids = p.ids.filter((i) => !a.ids.includes(i));
      emit("ai-changed");
    },
    edit_load: (a) => edits.get(a.id)?.stack ?? null,
    edit_revert: (a) => {
      const had = edits.delete(a.id);
      setTimeout(() => emit("library-changed"), 30);
      return had;
    },
    smart_albums: (): SmartAlbum[] => {
      const L = live();
      const pick = (f: (x: Item) => boolean) => L.filter(f).map((x) => x.id);
      const mk = (key: string, kind: SmartAlbum["kind"], title: string, sub: string, ids: number[]): SmartAlbum => ({
        key, kind, title, sub, ids, covers: ids.filter((id) => !byId.get(id)!.kind).slice(0, 3),
      });
      return [
        mk("trip:kyoto", "trip", "Kyoto", "Oct 3–9, 2026 · Japan", pick((x) => x.dir.includes("Kyoto"))),
        mk("trip:lisbon", "trip", "Lisbon", "Sep 12–15, 2026 · Portugal", pick((x) => x.dir.includes("Lisbon"))),
        mk("trip:reykjavik", "trip", "Reykjavík", "Aug 2–8, 2026 · Iceland", pick((x) => x.dir.includes("Iceland"))),
        mk("smart:favorites", "smart", "Favorites", "Everything you've hearted", pick((x) => !!x.fav)),
        mk("smart:videos", "smart", "Videos", "Every clip, newest first", pick((x) => x.kind === 1)),
        mk("smart:panoramas", "smart", "Panoramas", "Extra-wide shots", pick((x) => x.ar > 1.7 && !x.kind)),
        mk("smart:recent", "smart", "Recently added", "The last 200 files Sitara found", L.slice(0, 200).map((x) => x.id)),
        mk("place:bengaluru", "place", "Bengaluru", "India · home", pick((x) => x.dir.includes("Family"))),
        mk("place:mumbai", "place", "Mumbai", "India", pick((x) => x.dir.includes("Mumbai"))),
      ].filter((a) => a.ids.length);
    },
    cleanup_scan: (): CleanupReport => {
      const L = live().filter((x) => !x.kind);
      const ci = (x: Item, k: number): CItem => ({
        id: x.id, name: `IMG_${7100 + x.id}${k ? ` (${k})` : ""}.JPG`, dir: x.dir, size: 2.4e6 + (x.id % 9) * 4e5,
        w: W(x), h: H(x), taken: x.taken, fav: !!x.fav, sharp: 40 + ((x.id * 37) % 400), luma: 70 + ((x.id * 13) % 110), clip: (x.id % 5) / 100,
      });
      const similar: CGroup[] = [];
      for (let k = 0; k + 3 < Math.min(L.length, 90); k += 6) {
        const items = L.slice(k, k + 3).map((x) => ci(x, 0));
        similar.push({ kind: "similar", items, best: items.reduce((b, c, i) => (c.sharp > items[b].sharp ? i : b), 0) });
      }
      const exact: CGroup[] = [100, 103, 106, 109].map((k) => ({ kind: "exact", items: [ci(L[k], 0), { ...ci(L[k + 1], 1), size: ci(L[k], 0).size }], best: 0 }));
      const blurry = L.slice(120, 138).map((x) => ({ ...ci(x, 0), sharp: 4 + (x.id % 15) }));
      const shots = L.slice(140, 152).map((x) => ci(x, 0));
      const extra = (g: CGroup[]) => g.reduce((a, x) => a + x.items.length - 1, 0);
      const bytes = (g: CGroup[]) => g.reduce((a, x) => a + x.items.filter((_, i) => i !== x.best).reduce((b, c) => b + c.size, 0), 0);
      return {
        exact, similar, blurry, shots,
        stats: {
          exactGroups: exact.length, exactExtra: extra(exact), exactBytes: bytes(exact),
          similarGroups: similar.length, similarExtra: extra(similar), similarBytes: bytes(similar),
          blurry: blurry.length, blurryBytes: blurry.reduce((a, c) => a + c.size, 0),
          shots: shots.length, shotsBytes: shots.reduce((a, c) => a + c.size, 0),
          analyzed: L.length, pending: 0,
        },
      };
    },
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
    async editSave(id: number, w: number, h: number, stack: unknown, thumb: Blob, preview: Blob) {
      const old = edits.get(id);
      if (old) [old.thumb, old.preview].forEach((u) => URL.revokeObjectURL(u));
      const rev = (old?.rev ?? 0) + 1;
      edits.set(id, { stack: JSON.stringify(stack), w, h, rev, thumb: URL.createObjectURL(thumb), preview: URL.createObjectURL(preview) });
      setTimeout(() => emit("library-changed"), 30);
      return rev;
    },
    async exportSave(path: string, file: Blob) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = path.split(/[\\/]/).pop() ?? "export.jpg";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return path;
    },
    thumbUrl: (id: number) => {
      const ed = edits.get(id);
      if (ed) return ed.thumb;
      const x = byId.get(id);
      const ar = x?.ar ?? 1.5;
      return `https://picsum.photos/seed/s${id}/${Math.round(360 * ar)}/360`;
    },
    // stand-ins for the AI editing models, so the editor's AI tools can be exercised in a browser
    async aiOp(head: { op: string; w: number; h: number; q?: string; n?: number }, parts: Uint8Array[]): Promise<ArrayBuffer> {
      const { w, h } = head;
      await new Promise((r) => setTimeout(r, 300));
      const px = parts[0];
      const gray = (f: (x: number, y: number) => number) => {
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.round(255 * Math.min(1, Math.max(0, f(x / w, y / h))));
        return out.buffer;
      };
      const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer;
      switch (head.op) {
        case "inpaint": {
          const m = parts[1];
          const out = new Uint8Array(px);
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < w * h; i++) if (!m[i]) (r += px[i * 4], g += px[i * 4 + 1], b += px[i * 4 + 2], n++);
          for (let i = 0; i < w * h; i++) if (m[i] > 127) out.set([r / n, g / n, b / n, 255], i * 4);
          return out.buffer;
        }
        case "subject": return gray((x, y) => 1 - Math.hypot((x - 0.5) / 0.3, (y - 0.55) / 0.42) ** 4);
        case "sky": return gray((_, y) => 1 - y / 0.35);
        case "depth": return gray((_, y) => y);
        case "denoise": return new Uint8Array(px).buffer;
        case "upscale": {
          const out = new Uint8Array(w * h * 64);
          for (let y = 0; y < h * 4; y++) for (let x = 0; x < w * 4; x++) out.set(px.subarray(((y >> 2) * w + (x >> 2)) * 4, ((y >> 2) * w + (x >> 2)) * 4 + 4), (y * w * 4 + x) * 4);
          return out.buffer;
        }
        case "faces": return json([[0.42, 0.22, 0.16, 0.2]]);
        case "rank": return json(Array.from({ length: head.n ?? 1 }, (_, i) => 0.2 + ((i * 7919 + (head.q?.length ?? 0) * 31) % 97) / 2000));
      }
      throw new Error(`mock: no AI op ${head.op}`);
    },
    async layerPut(png: Blob) {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await png.arrayBuffer())), (b) => b.toString(16).padStart(2, "0")).join("");
      if (!layers.has(hash)) layers.set(hash, URL.createObjectURL(png));
      return hash;
    },
    layerUrl: (hash: string) => layers.get(hash) ?? "",
    faceUrl: (faceId: number) => `https://picsum.photos/seed/s${faceId}/240/240`,
    fullUrl: (id: number) => edits.get(id)?.preview ?? original(id),
    originalUrl: (id: number) => original(id),
  };
  function original(id: number) {
    const ar = byId.get(id)?.ar ?? 1.5;
    return ar >= 1 ? `https://picsum.photos/seed/s${id}/1800/${Math.round(1800 / ar)}` : `https://picsum.photos/seed/s${id}/${Math.round(1500 * ar)}/1500`;
  }
}

export type MockBackend = ReturnType<typeof createMock>;
