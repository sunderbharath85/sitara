import { toast } from "../components/Toasts";
import { api, forgetDetails, inTauri } from "./api";
import { plural } from "./format";
import { clearSel, libOf, store } from "./store";

export async function reloadLibrary() {
  try {
    const lib = await api.library();
    forgetDetails();
    store.set((s) => ({ lib, libVer: s.libVer + 1 }));
  } catch (e) {
    toast(`Couldn't load the library: ${e}`);
  }
}

export async function reloadFolders() {
  try {
    store.set({ folders: await api.folders() });
  } catch (e) {
    toast(String(e));
  }
}

export async function addFolder(path?: string | null) {
  const p = path ?? (await api.pickFolder());
  if (!p) return;
  try {
    store.set({ folders: await api.addFolder(p) });
    toast(`Indexing ${p.split(/[\\/]/).pop()} · photos appear as they're found`);
  } catch (e) {
    toast(String(e));
  }
}

export async function trash(ids: number[]) {
  if (!ids.length) return;
  try {
    const done = await api.trash(ids);
    clearSel();
    const v = store.get().viewer;
    if (v) {
      const left = v.ids.filter((id) => !done.includes(id));
      store.set({ viewer: left.length ? { ids: left, idx: Math.min(v.idx, left.length - 1) } : null });
    }
    const album = store.get().album;
    if (album) store.set({ album: { ...album, ids: album.ids.filter((id) => !done.includes(id)) } });
    const s = store.get().search;
    if (s) store.set({ search: { ...s, ids: s.ids.filter((id) => !done.includes(id)) } });
    const where = navigator.platform.startsWith("Mac") ? "Trash" : "Recycle Bin";
    toast(`${plural(done.length, "item")} moved to ${where}`, {
      label: "Undo",
      run: async () => {
        try {
          const back = await api.restore(done);
          toast(`Restored ${plural(back.length, "item")}`);
          if (album?.kind === "album" && album.id) await api.albumAdd(album.id, back).catch(() => {});
        } catch (e) {
          toast(String(e));
        }
      },
    });
  } catch (e) {
    toast(String(e));
  }
}

export async function setFavorite(ids: number[], value: boolean) {
  const lib = libOf(store.get());
  if (!lib || !ids.length) return;
  for (const id of ids) {
    const i = lib.pos.get(id);
    if (i != null) lib.fav[i] = value ? 1 : 0;
  }
  store.set((s) => ({ favVer: s.favVer + 1 }));
  try {
    await api.setFavorite(ids, value);
  } catch (e) {
    toast(String(e));
  }
}

export function openPicker(ids: number[]) {
  if (ids.length) store.set({ picker: ids });
}

export function startShow(ids: number[], label: string, extra: { start?: number; rect?: DOMRect; tempo?: "beat" } = {}) {
  if (!ids.length) return toast("Nothing to play yet");
  store.set({ show: { ids, label, ...extra } });
}

export function libraryIds(): number[] {
  const lib = libOf(store.get());
  return lib ? Array.from(lib.id) : [];
}

export const where = inTauri ? (navigator.platform.startsWith("Mac") ? "Finder" : navigator.platform.startsWith("Win") ? "Explorer" : "file manager") : "Explorer";
