import { useSyncExternalStore } from "react";
import { EMPTY_PRIVATE, EMPTY_STATUS, type AiStatus, type FolderInfo, type Lib, type PrivateStatus, type Status } from "./api";

export type View = "library" | "albums" | "cleanup" | "folders" | "private";

/** An album page: a manual album, a folder shown as an album, or a smart album. */
export interface AlbumPage {
  kind: "album" | "dir" | "smart" | "person";
  id?: number;
  dir?: string;
  /** Person pages: the face shown in the header. */
  face?: number;
  title: string;
  ids: number[];
}

export interface ShowRequest {
  ids: number[];
  start?: number;
  label: string;
  rect?: DOMRect;
  tempo?: "beat";
}

export interface State {
  lib: Lib | null;
  libVer: number;
  view: View;
  sel: Set<number>;
  selVer: number;
  status: Status;
  folders: FolderInfo[] | null;
  /** `private` results belong to the Private space and show only there. */
  search: { q: string; ids: number[]; smart: number; private?: boolean } | null;
  album: AlbumPage | null;
  viewer: { ids: number[]; idx: number; from?: DOMRect } | null;
  editor: { id: number; from?: DOMRect } | null;
  show: ShowRequest | null;
  palette: boolean;
  picker: number[] | null;
  favVer: number;
  ai: AiStatus | null;
  /** The Private space's own library; null while Private is locked. */
  plib: Lib | null;
  plibVer: number;
  priv: PrivateStatus;
  /** The unlock sheet or setup wizard, with what to do once it succeeds. */
  privUi: { kind: "unlock" | "setup"; then?: () => void } | null;
}

let state: State = {
  lib: null,
  libVer: 0,
  view: "library",
  sel: new Set(),
  selVer: 0,
  status: EMPTY_STATUS,
  folders: null,
  search: null,
  album: null,
  viewer: null,
  editor: null,
  show: null,
  palette: false,
  picker: null,
  favVer: 0,
  ai: null,
  plib: null,
  plibVer: 0,
  priv: EMPTY_PRIVATE,
  privUi: null,
};
const subs = new Set<() => void>();

export const store = {
  get: () => state,
  set(patch: Partial<State> | ((s: State) => Partial<State>)) {
    const p = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...p };
    subs.forEach((f) => f());
  },
  sub(f: () => void) {
    subs.add(f);
    return () => void subs.delete(f);
  },
};

/** Subscribe to a slice. Selectors must return primitives or stable references. */
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(store.sub, () => sel(state));
}

export function setSel(ids: Iterable<number>) {
  store.set((s) => ({ sel: new Set(ids), selVer: s.selVer + 1 }));
}
export function clearSel() {
  if (state.sel.size) setSel([]);
}

/** The library the screen is showing: the Private space's while it is open, the main one otherwise. */
export const libOf = (s: State) => (s.view === "private" ? s.plib : s.lib);
