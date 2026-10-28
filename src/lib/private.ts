// Private mode: keeps the vault's status and the Private space's own library in the store, and routes
// everything that has to happen when it locks (close what's showing private items, drop its data).
import { toast } from "../components/Toasts";
import { api, forgetDetails, isPrivate, setPrivateIds, type PrivateStatus } from "./api";
import { reloadFolders } from "./actions";
import { clearSel, store } from "./store";

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function reloadPrivateStatus(): Promise<PrivateStatus | null> {
  try {
    const priv = await api.privateStatus();
    store.set({ priv });
    return priv;
  } catch {
    return null;
  }
}

/** The private library, only while unlocked. Ids are registered first so their URLs take the private form. */
export async function reloadPrivateLibrary() {
  if (!store.get().priv.unlocked) return;
  try {
    const plib = await api.library(true);
    if (!store.get().priv.unlocked) return;
    setPrivateIds(plib);
    forgetDetails();
    store.set((s) => ({ plib, plibVer: s.plibVer + 1 }));
  } catch {
    // locked between the status check and the call
  }
}

/** Forget everything private and close whatever is showing it. */
function dropPrivate() {
  const s = store.get();
  const touches = (ids: number[]) => ids.some(isPrivate);
  const patch: Partial<typeof s> = { plib: null, plibVer: s.plibVer + 1 };
  if (s.viewer && (s.view === "private" || touches(s.viewer.ids))) patch.viewer = null;
  if (s.editor && (s.view === "private" || isPrivate(s.editor.id))) patch.editor = null;
  if (s.show && (s.view === "private" || touches(s.show.ids))) patch.show = null;
  if (s.picker && touches(s.picker)) patch.picker = null;
  if (s.search?.private) patch.search = null;
  if (s.view === "private") Object.assign(patch, { view: "library", album: null });
  setPrivateIds(null);
  forgetDetails();
  store.set(patch);
  clearSel();
}

/** `private-changed`: lock, unlock, setup, reset, add, remove, settings, idle auto-lock. */
export async function onPrivateChanged() {
  const was = store.get().priv;
  const priv = await reloadPrivateStatus();
  if (!priv) return;
  reloadFolders();
  if (priv.unlocked) await reloadPrivateLibrary();
  else if (was.unlocked || store.get().plib) {
    dropPrivate();
    toast("Private locked");
  }
}

/** Bring a fresh status (from unlock, recover, add, ...) into the store and load what it unlocks. */
export async function applyPrivateStatus(priv: PrivateStatus) {
  store.set({ priv });
  if (priv.unlocked) await reloadPrivateLibrary();
}

/** Run `then` once Private is unlocked: now, or after the unlock sheet / setup wizard succeeds. */
export function withPrivate(then: () => void) {
  const { priv } = store.get();
  if (priv.unlocked) then();
  else store.set({ privUi: { kind: priv.setUp ? "unlock" : "setup", then } });
}

export function openPrivate() {
  withPrivate(() => store.set({ view: "private", album: null, search: null }));
}

export function lockNow() {
  if (!store.get().priv.unlocked) return;
  api.privateLock().catch((e) => toast(errText(e)));
}

/** Mark a folder private. Works locked or unlocked once Private is set up; sets it up first otherwise. */
export function makePrivate(path: string, after?: () => void) {
  const run = async () => {
    try {
      await applyPrivateStatus(await api.privateAdd(path));
      after?.();
      toast("Moved to Private", store.get().priv.unlocked ? { label: "Open", run: openPrivate } : undefined);
    } catch (e) {
      toast(errText(e));
    }
  };
  if (store.get().priv.setUp) run();
  else store.set({ privUi: { kind: "setup", then: run } });
}

// ---- activity ------------------------------------------------------------------------------------------------

const TOUCH_EVERY = 20_000;
const WARN_AT = 30_000;
let lastTouch = 0;
let warned = false;

/** User activity: pushes the idle auto-lock back. Throttled so the backend hears at most once per 20 s. */
export function activity(force = false) {
  const { priv } = store.get();
  if (!priv.unlocked) return;
  const now = Date.now();
  if (!force && now - lastTouch < TOUCH_EVERY) return;
  lastTouch = now;
  api
    .privateTouch()
    .then((lockAt) => {
      if (lockAt != null) store.set((s) => ({ priv: { ...s.priv, lockAt } }));
    })
    .catch(() => {});
}

/** Wire activity tracking and the 30 s warning. Returns the cleanup. */
export function watchActivity() {
  const mark = () => activity();
  let lastMove = 0;
  const move = () => {
    const now = Date.now();
    if (now - lastMove > 1000) {
      lastMove = now;
      activity();
    }
  };
  const evs: [string, () => void][] = [["pointerdown", mark], ["pointermove", move], ["keydown", mark], ["wheel", mark]];
  evs.forEach(([e, f]) => addEventListener(e, f, { passive: true, capture: true }));
  const iv = setInterval(() => {
    const { priv, show } = store.get();
    if (!priv.unlocked || priv.lockAt == null) {
      warned = false;
      return;
    }
    // a playing video or a running slideshow is activity even without input
    if (show || [...document.querySelectorAll("video")].some((v) => !v.paused && !v.ended)) activity();
    const left = priv.lockAt - Date.now();
    if (left > WARN_AT) warned = false;
    else if (!warned && left > 0) {
      warned = true;
      toast("Private locks in 30 s");
    }
  }, 1000);
  return () => {
    evs.forEach(([e, f]) => removeEventListener(e, f, { capture: true }));
    clearInterval(iv);
  };
}
