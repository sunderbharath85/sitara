import { useSyncExternalStore } from "react";
import { EMPTY_STATUS, type FolderInfo, type Lib, type Status } from "./api";

export type View = "library" | "albums" | "folders";

/** An album page: a manual album, or a folder shown as an album. */
export interface AlbumPage {
  kind: "album" | "dir";
  id?: number;
  dir?: string;
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
  search: { q: string; ids: number[] } | null;
  album: AlbumPage | null;
  viewer: { ids: number[]; idx: number; from?: DOMRect } | null;
  show: ShowRequest | null;
  palette: boolean;
  picker: number[] | null;
  favVer: number;
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
  show: null,
  palette: false,
  picker: null,
  favVer: 0,
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
