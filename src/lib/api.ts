import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MockBackend } from "./mock";

export const inTauri = isTauri();

/** The whole library, columnar. Index `i` is the position in the newest-first timeline. */
export interface Lib {
  n: number;
  id: Uint32Array;
  ver: Uint32Array;
  taken: Float64Array; // wall-clock seconds stored as UTC; format with timeZone "UTC"
  w: Uint16Array;
  h: Uint16Array;
  kind: Uint8Array; // 0 photo, 1 video
  fav: Uint8Array;
  edited: Uint8Array;
  dur: Uint16Array;
  pos: Map<number, number>; // id -> index
}

export interface MediaDetail {
  id: number;
  path: string;
  dir: string;
  name: string;
  ext: string;
  kind: number;
  size: number;
  mtime: number;
  width: number;
  height: number;
  taken: number;
  duration: number | null;
  make: string | null;
  model: string | null;
  lens: string | null;
  fnumber: number | null;
  exposure: string | null;
  iso: number | null;
  focal: number | null;
  lat: number | null;
  lon: number | null;
  favorite: boolean;
  folder: string;
  /** Edit revision; 0 when unedited. */
  edited: number;
}

export interface FolderInfo {
  id: number;
  path: string;
  count: number;
  photos: number;
  videos: number;
  bytes: number;
  lastScan: number | null;
}

export interface Status {
  scanning: boolean;
  folder: string | null;
  found: number;
  indexed: number;
  warming: boolean;
  thumbsPending: number;
  thumbsDone: number;
  analyzing: boolean;
  analysisPending: number;
}

export interface AlbumInfo {
  id: number;
  name: string;
  count: number;
  covers: number[];
  updatedAt: number;
}
export interface DirAlbum {
  dir: string;
  name: string;
  parent: string;
  count: number;
  covers: number[];
  latest: number;
}
export interface Albums {
  manual: AlbumInfo[];
  folders: DirAlbum[];
}
export interface Suggestion {
  path: string;
  label: string;
}

export const EMPTY_STATUS: Status = { scanning: false, folder: null, found: 0, indexed: 0, warming: false, thumbsPending: 0, thumbsDone: 0, analyzing: false, analysisPending: 0 };

export interface SmartAlbum {
  key: string;
  kind: "trip" | "place" | "smart";
  title: string;
  sub: string;
  ids: number[];
  covers: number[];
}

export interface CItem {
  id: number;
  name: string;
  dir: string;
  size: number;
  w: number;
  h: number;
  taken: number;
  fav: boolean;
  sharp: number;
  luma: number;
  clip: number;
}
export interface CGroup {
  kind: "exact" | "similar";
  items: CItem[];
  best: number;
}
export interface CleanupReport {
  exact: CGroup[];
  similar: CGroup[];
  blurry: CItem[];
  shots: CItem[];
  stats: {
    exactGroups: number;
    exactExtra: number;
    exactBytes: number;
    similarGroups: number;
    similarExtra: number;
    similarBytes: number;
    blurry: number;
    blurryBytes: number;
    shots: number;
    shotsBytes: number;
    analyzed: number;
    pending: number;
  };
}

export function decodeLibrary(buf: ArrayBuffer): Lib {
  const dv = new DataView(buf);
  const n = buf.byteLength >= 8 ? dv.getUint32(4, true) : 0;
  const lib: Lib = {
    n,
    id: new Uint32Array(n),
    ver: new Uint32Array(n),
    taken: new Float64Array(n),
    w: new Uint16Array(n),
    h: new Uint16Array(n),
    kind: new Uint8Array(n),
    fav: new Uint8Array(n),
    edited: new Uint8Array(n),
    dur: new Uint16Array(n),
    pos: new Map(),
  };
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 24;
    lib.id[i] = dv.getUint32(o, true);
    lib.ver[i] = dv.getUint32(o + 4, true);
    lib.taken[i] = dv.getFloat64(o + 8, true);
    lib.w[i] = dv.getUint16(o + 16, true);
    lib.h[i] = dv.getUint16(o + 18, true);
    lib.kind[i] = dv.getUint8(o + 20);
    const flags = dv.getUint8(o + 21);
    lib.fav[i] = flags & 1;
    lib.edited[i] = (flags >> 1) & 1;
    lib.dur[i] = dv.getUint16(o + 22, true);
    lib.pos.set(lib.id[i], i);
  }
  return lib;
}

/** [u32 LE header length][JSON header][blobs...], for commands that take a binary body. */
async function rawBody(head: unknown, blobs: Blob[]): Promise<Uint8Array> {
  const h = new TextEncoder().encode(JSON.stringify(head));
  const parts = await Promise.all(blobs.map((b) => b.arrayBuffer()));
  const out = new Uint8Array(4 + h.length + parts.reduce((a, p) => a + p.byteLength, 0));
  new DataView(out.buffer).setUint32(0, h.length, true);
  out.set(h, 4);
  let o = 4 + h.length;
  for (const p of parts) {
    out.set(new Uint8Array(p), o);
    o += p.byteLength;
  }
  return out;
}

let mock: MockBackend | null = null;
export async function initBackend() {
  if (!inTauri) mock = (await import("./mock")).createMock();
}

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (mock) return mock.call(cmd, args ?? {}) as Promise<T>;
  return invoke<T>(cmd, args);
}

/** Formats the system webview renders directly; everything else goes through the preview renderer. */
const WEB_SAFE = new Set(["jpg", "jpeg", "jpe", "jfif", "png", "gif", "webp", "avif", "bmp", "svg"]);
const MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export const api = {
  library: async () => decodeLibrary(await call<ArrayBuffer>("library")),
  detail: (id: number) => call<MediaDetail | null>("media_detail", { id }),
  folders: () => call<FolderInfo[]>("folders"),
  addFolder: (path: string) => call<FolderInfo[]>("add_folder", { path }),
  removeFolder: (id: number) => call<FolderInfo[]>("remove_folder", { id }),
  rescan: () => call<void>("rescan"),
  status: () => call<Status>("index_status"),
  suggestFolders: () => call<Suggestion[]>("suggest_folders"),
  setFavorite: (ids: number[], value: boolean) => call<void>("set_favorite", { ids, value }),
  trash: (ids: number[]) => call<number[]>("trash_items", { ids }),
  restore: (ids: number[]) => call<number[]>("restore_items", { ids }),
  albums: () => call<Albums>("albums"),
  albumItems: (id: number) => call<number[]>("album_items", { id }),
  dirItems: (dir: string) => call<number[]>("dir_items", { dir }),
  albumCreate: (name: string, ids: number[]) => call<number>("album_create", { name, ids }),
  albumAdd: (id: number, ids: number[]) => call<void>("album_add", { id, ids }),
  albumRemove: (id: number, ids: number[]) => call<void>("album_remove", { id, ids }),
  albumRename: (id: number, name: string) => call<void>("album_rename", { id, name }),
  albumDelete: (id: number) => call<void>("album_delete", { id }),
  search: (q: string) => call<number[]>("search", { q }),
  reveal: (id: number) => call<void>("reveal", { id }),
  openExternal: (id: number) => call<void>("open_external", { id }),
  smartAlbums: () => call<SmartAlbum[]>("smart_albums"),
  cleanupScan: () => call<CleanupReport>("cleanup_scan"),
  editLoad: (id: number) => call<string | null>("edit_load", { id }),
  editRevert: (id: number) => call<boolean>("edit_revert", { id }),
  /** Save an edit stack plus the editor's renders (grid thumbnail, large preview). Returns the revision. */
  async editSave(id: number, w: number, h: number, stack: unknown, thumb: Blob, preview: Blob): Promise<number> {
    if (mock) return mock.editSave(id, w, h, stack, thumb, preview);
    const body = await rawBody({ id, w, h, stack, thumb: thumb.size }, [thumb, preview]);
    return invoke<number>("edit_save", body);
  },
  /** Write an exported copy to `path`. Returns the written path. */
  async exportSave(head: { id: number; path: string; w: number; h: number; exif: boolean; gps: boolean }, file: Blob): Promise<string> {
    if (mock) return mock.exportSave(head.path, file);
    return invoke<string>("export_save", await rawBody(head, [file]));
  },
  async pickSavePath(defaultPath: string, ext: string): Promise<string | null> {
    if (mock) return defaultPath;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const name = ext === "png" ? "PNG image" : ext === "webp" ? "WebP image" : "JPEG image";
    return save({ defaultPath, title: "Export edited copy", filters: [{ name, extensions: ext === "jpg" ? ["jpg", "jpeg"] : [ext] }] });
  },
  async revealPath(path: string) {
    if (mock) return;
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  },

  async pickFolder(): Promise<string | null> {
    if (mock) return mock.pickFolder();
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: true, multiple: false, title: "Add a folder to Sitara" });
    return typeof r === "string" ? r : null;
  },
  async openUrl(url: string) {
    if (mock) return void window.open(url, "_blank");
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  },
  onStatus(cb: (s: Status) => void) {
    if (mock) return mock.on("index-status", cb as (p: unknown) => void);
    const un = listen<Status>("index-status", (e) => cb(e.payload));
    return () => void un.then((f) => f());
  },
  onLibraryChanged(cb: () => void) {
    if (mock) return mock.on("library-changed", cb);
    const un = listen("library-changed", () => cb());
    return () => void un.then((f) => f());
  },
  onAnalysisChanged(cb: () => void) {
    if (mock) return mock.on("analysis-changed", cb);
    const un = listen("analysis-changed", () => cb());
    return () => void un.then((f) => f());
  },
  onDropFolders(cb: (paths: string[]) => void) {
    if (mock) return () => {};
    let off: (() => void) | null = null;
    let dead = false;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((e) => {
          if (e.payload.type === "drop") cb(e.payload.paths);
        })
        .then((f) => (dead ? f() : (off = f))),
    );
    return () => {
      dead = true;
      off?.();
    };
  },
};

export const thumbUrl = (id: number, ver: number) =>
  mock ? mock.thumbUrl(id) : `${convertFileSrc(String(id), "thumb")}?v=${ver}`;

/** Full-resolution source for the viewer and slideshow. Edited photos show the editor's render. */
export function mediaSrc(d: MediaDetail): string {
  if (mock) return mock.fullUrl(d.id);
  if (d.kind === 0 && d.edited) return `${convertFileSrc(String(d.id), "preview")}?v=${Math.floor(d.mtime / 1000)}&e=${d.edited}`;
  if (d.kind === 1 || WEB_SAFE.has(d.ext) || (MAC && (d.ext === "heic" || d.ext === "heif" || d.ext === "tif" || d.ext === "tiff")))
    return convertFileSrc(d.path);
  return `${convertFileSrc(String(d.id), "preview")}?v=${Math.floor(d.mtime / 1000)}`;
}

/**
 * The editor's original pixels: the webview decodes web formats itself; RAW, HEIC and TIFF come from Rust
 * (`fallback` covers a web format the webview can't read after all).
 */
export function editSource(d: MediaDetail): { url: string; binary: boolean; fallback?: string } {
  if (mock) return { url: mock.originalUrl(d.id), binary: false };
  const full = `${convertFileSrc(String(d.id), "preview")}?full=1&v=${Math.floor(d.mtime / 1000)}`;
  if (WEB_SAFE.has(d.ext) && d.ext !== "svg") return { url: convertFileSrc(d.path), binary: false, fallback: full };
  return { url: full, binary: true };
}

const details = new Map<number, Promise<MediaDetail | null>>();
/** Details are small and immutable per version; cache the promise so prefetch and render share it. */
export function detailCached(id: number) {
  let p = details.get(id);
  if (!p) {
    p = api.detail(id).catch(() => null);
    details.set(id, p);
    if (details.size > 4000) details.delete(details.keys().next().value!);
  }
  return p;
}
export const forgetDetails = () => details.clear();
export const forgetDetail = (id: number) => details.delete(id);
