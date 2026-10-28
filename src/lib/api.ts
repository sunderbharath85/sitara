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
  /** Lives in a Private folder. */
  private: boolean;
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
  learning: boolean;
  learnPending: number;
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

/** A folder marked Private (a library root or any subfolder of one). */
export interface PrivateDir {
  path: string;
  name: string;
  count: number;
  photos: number;
  videos: number;
  bytes: number;
  root: boolean;
}
export interface PrivateStatus {
  setUp: boolean;
  unlocked: boolean;
  /** Idle auto-lock, in seconds: 60 | 300 | 900 | 1800. */
  idleSecs: number;
  lockOnMinimize: boolean;
  /** Unix ms when the idle auto-lock fires; null while locked. */
  lockAt: number | null;
  /** Unix ms: unlock attempts are refused until then (after repeated wrong passwords). */
  waitUntil: number | null;
  /** Empty while locked. */
  dirs: PrivateDir[];
}
export const EMPTY_PRIVATE: PrivateStatus = { setUp: false, unlocked: false, idleSecs: 300, lockOnMinimize: false, lockAt: null, waitUntil: null, dirs: [] };

export const EMPTY_STATUS: Status = { scanning: false, folder: null, found: 0, indexed: 0, warming: false, thumbsPending: 0, thumbsDone: 0, analyzing: false, analysisPending: 0, learning: false, learnPending: 0 };

export interface AiPack {
  key: "search" | "people" | "erase" | "subject" | "sky" | "denoise" | "upscale" | "depth" | "colorize" | "restore";
  on: boolean;
  mb: number;
}
export interface AiStatus {
  supported: boolean;
  search: boolean;
  people: boolean;
  searchMb: number;
  peopleMb: number;
  runtimeMb: number;
  download: { label: string; done: number; total: number; error: string | null } | null;
  indexed: number;
  pending: number;
  faces: number;
  working: boolean;
  /** The graphics card AI can run on, if there is one. */
  gpu: string | null;
  useGpu: boolean;
  packs: AiPack[];
}
export interface Person {
  id: number;
  name: string | null;
  count: number;
  cover: number; // face id
  hidden: boolean;
}

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
  library: async (inPrivate = false) => decodeLibrary(await call<ArrayBuffer>("library", inPrivate ? { private: true } : undefined)),
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
  albums: (inPrivate = false) => call<Albums>("albums", inPrivate ? { private: true } : undefined),
  albumItems: (id: number) => call<number[]>("album_items", { id }),
  dirItems: (dir: string) => call<number[]>("dir_items", { dir }),
  albumCreate: (name: string, ids: number[], inPrivate = false) => call<number>("album_create", inPrivate ? { name, ids, private: true } : { name, ids }),
  albumAdd: (id: number, ids: number[]) => call<void>("album_add", { id, ids }),
  albumRemove: (id: number, ids: number[]) => call<void>("album_remove", { id, ids }),
  albumRename: (id: number, name: string) => call<void>("album_rename", { id, name }),
  albumDelete: (id: number) => call<void>("album_delete", { id }),
  search: (q: string, inPrivate = false) => call<number[]>("search", inPrivate ? { q, private: true } : { q }),
  reveal: (id: number) => call<void>("reveal", { id }),
  openExternal: (id: number) => call<void>("open_external", { id }),
  smartAlbums: () => call<SmartAlbum[]>("smart_albums"),
  cleanupScan: () => call<CleanupReport>("cleanup_scan"),
  aiStatus: () => call<AiStatus>("ai_status"),
  aiInstall: (feature: AiPack["key"]) => call<void>("ai_install", { feature }),
  aiRemove: (feature: AiPack["key"]) => call<void>("ai_remove", { feature }),
  aiSetGpu: (on: boolean) => call<void>("ai_set_gpu", { on }),
  aiSearch: (q: string) => call<number[]>("ai_search", { q }),
  people: () => call<Person[]>("people"),
  personItems: (id: number) => call<number[]>("person_items", { id }),
  personRename: (id: number, name: string) => call<void>("person_rename", { id, name }),
  personMerge: (from: number, into: number) => call<void>("person_merge", { from, into }),
  personHide: (id: number, hidden: boolean) => call<void>("person_hide", { id, hidden }),
  personRemove: (id: number, ids: number[]) => call<void>("person_remove", { id, ids }),
  onAiProgress(cb: () => void) {
    if (mock) return mock.on("ai-progress", cb);
    const un = listen("ai-progress", () => cb());
    return () => void un.then((f) => f());
  },
  onAiChanged(cb: () => void) {
    if (mock) return mock.on("ai-changed", cb);
    const un = listen("ai-changed", () => cb());
    return () => void un.then((f) => f());
  },
  /** Run an AI editing model on pixels (RGBA); returns RGBA, a mask, or JSON bytes. */
  async aiOp(head: { op: string; w: number; h: number; q?: string; n?: number }, parts: Uint8Array[]): Promise<ArrayBuffer> {
    if (mock) return mock.aiOp(head, parts);
    const body = await rawBody(head, parts.map((p) => new Blob([p as BlobPart])));
    return invoke<ArrayBuffer>("ai_op", body);
  },
  /** Keep an AI edit's pixels (PNG); returns its hash. Edits of a private photo say so, so the layer is kept encrypted. */
  async layerPut(png: Blob): Promise<string> {
    if (mock) return mock.layerPut(png);
    return invoke<string>("ai_layer_put", new Uint8Array(await png.arrayBuffer()), layerPrivate ? { headers: { "x-sitara-private": "1" } } : undefined);
  },
  aiRelease: () => (mock ? Promise.resolve() : call<void>("ai_release")),
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

  privateStatus: () => call<PrivateStatus>("private_status"),
  privateSetup: (password: string, idleSecs: number) => call<string>("private_setup", { password, idleSecs }),
  privateUnlock: (password: string) => call<PrivateStatus>("private_unlock", { password }),
  privateRecover: (recoveryKey: string, password: string) => call<PrivateStatus>("private_recover", { recoveryKey, password }),
  privateChangePassword: (current: string, password: string) => call<void>("private_change_password", { current, password }),
  privateNewRecoveryKey: (password: string) => call<string>("private_new_recovery_key", { password }),
  privateLock: () => call<void>("private_lock"),
  privateTouch: () => call<number | null>("private_touch"),
  privateSettings: (idleSecs: number, lockOnMinimize: boolean) => call<PrivateStatus>("private_settings", { idleSecs, lockOnMinimize }),
  privateReset: () => call<PrivateStatus>("private_reset", { confirm: "RESET" }),
  privateAdd: (path: string) => call<PrivateStatus>("private_add", { path }),
  privateRemove: (path: string) => call<PrivateStatus>("private_remove", { path }),
  /** Let the user keep the recovery key in a text file. Resolves false if they cancelled. */
  async saveRecoveryKey(key: string): Promise<boolean> {
    if (mock) return mock.saveKey(key);
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: "Sitara recovery key.txt", title: "Save your recovery key", filters: [{ name: "Text file", extensions: ["txt"] }] });
    if (!path) return false;
    await call<void>("private_save_key", { path, key });
    return true;
  },
  async pickFolder(title = "Add a folder to Sitara"): Promise<string | null> {
    if (mock) return mock.pickFolder();
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: true, multiple: false, title });
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
  onPrivateChanged(cb: () => void) {
    if (mock) return mock.on("private-changed", cb);
    const un = listen("private-changed", () => cb());
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

/**
 * Ids of the items in the Private space (filled from the private library while it is unlocked). Their URLs carry
 * `p=1`, so they never match a cached public response and the backend serves them uncached and decrypted.
 */
let privateIds = new Set<number>();
export const setPrivateIds = (lib: Lib | null) => void (privateIds = new Set(lib ? lib.id : []));
export const isPrivate = (id: number) => privateIds.has(id);
const pv = (url: string, id: number) => (privateIds.has(id) ? `${url}${url.includes("?") ? "&" : "?"}p=1` : url);

/** True while the editor works on a private photo, so AI layers are stored encrypted. */
let layerPrivate = false;
export const setLayerPrivate = (on: boolean) => void (layerPrivate = on);

export const thumbUrl = (id: number, ver: number) => (mock ? mock.thumbUrl(id) : pv(`${convertFileSrc(String(id), "thumb")}?v=${ver}`, id));

/** Pixels an AI edit made, by hash. */
export const layerUrl = (hash: string) => (mock ? mock.layerUrl(hash) : `${convertFileSrc("layer", "thumb")}/${hash}`);

/** Square portrait of a detected face. Never asked for private photos. */
export const faceUrl = (faceId: number) => (mock ? mock.faceUrl(faceId) : `${convertFileSrc("face", "thumb")}/${faceId}`);

/**
 * Full-resolution source for the viewer and slideshow. Edited photos show the editor's render. Private originals
 * are not reachable through the asset protocol, so they come through the preview scheme (`orig=1` supports Range).
 */
export function mediaSrc(d: MediaDetail): string {
  if (mock) return mock.fullUrl(d.id);
  const p = d.private || privateIds.has(d.id) ? "&p=1" : "";
  const pre = convertFileSrc(String(d.id), "preview");
  const v = Math.floor(d.mtime / 1000);
  if (d.kind === 0 && d.edited) return `${pre}?v=${v}&e=${d.edited}${p}`;
  if (d.kind === 1 || WEB_SAFE.has(d.ext) || (MAC && (d.ext === "heic" || d.ext === "heif" || d.ext === "tif" || d.ext === "tiff")))
    return p ? `${pre}?orig=1&p=1` : convertFileSrc(d.path);
  return `${pre}?v=${v}${p}`;
}

/**
 * The editor's original pixels: the webview decodes web formats itself; RAW, HEIC and TIFF come from Rust
 * (`fallback` covers a web format the webview can't read after all).
 */
export function editSource(d: MediaDetail): { url: string; binary: boolean; fallback?: string } {
  if (mock) return { url: mock.originalUrl(d.id), binary: false };
  const p = d.private || privateIds.has(d.id) ? "&p=1" : "";
  const full = `${convertFileSrc(String(d.id), "preview")}?full=1&v=${Math.floor(d.mtime / 1000)}${p}`;
  if (p) return { url: full, binary: true };
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
