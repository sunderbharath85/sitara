import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type PrivateDir } from "../lib/api";
import { fmtNum, fmtSize, plural } from "../lib/format";
import { applyPrivateStatus, errText, lockNow, makePrivate, openPrivate, reloadPrivateStatus } from "../lib/private";
import { store, useStore } from "../lib/store";
import { AlbumsView, openDir } from "./Albums";
import { Grid } from "./Grid";
import { Icon } from "./Icon";
import { toast } from "./Toasts";

const NOTE = "Your files stay where they are on disk and can still be opened in File Explorer. Private hides them inside Sitara and encrypts Sitara's own thumbnails and previews of them.";
const IDLE: [number, string][] = [
  [60, "1 min"],
  [300, "5 min"],
  [900, "15 min"],
  [1800, "30 min"],
];

/** Seconds until a unix-ms time (0 when past or unset), ticking twice a second. */
function useCountdown(at: number | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (at == null) return;
    const iv = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(iv);
  }, [at]);
  return at == null ? 0 : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// ---- top bar ---------------------------------------------------------------------------------------------------

/** The Private button: opens the unlock sheet, the setup wizard, or the Private space. While unlocked, a live countdown. */
export function PrivateButton() {
  const unlocked = useStore((s) => s.priv.unlocked);
  const lockAt = useStore((s) => s.priv.lockAt);
  const view = useStore((s) => s.view);
  const left = useCountdown(unlocked ? lockAt : null);
  if (!unlocked)
    return (
      <button id="priv" onClick={openPrivate} title="Private · hidden photos and folders">
        <Icon n="lock" s={16} />
        <span>Private</span>
      </button>
    );
  return (
    <div id="priv-pill" className={view === "private" ? "here" : ""}>
      <button className="pp-main" onClick={openPrivate} title="Open the Private space">
        <Icon n="unlock" s={16} />
        <span>
          Private · <b>{mmss(left)}</b>
        </span>
      </button>
      <button className="pp-lock" onClick={lockNow} title="Lock now (Ctrl L)" aria-label="Lock Private now">
        <Icon n="lock" s={15} />
      </button>
    </div>
  );
}

// ---- shared bits -----------------------------------------------------------------------------------------------

function Sheet({ children, onClose, wide, label }: { children: ReactNode; onClose?: () => void; wide?: boolean; label: string }) {
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div
        className={`modal glass priv-sheet${wide ? " wide" : ""}`}
        role="dialog"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onClose) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, auto, type = "password", ph }: { label: string; value: string; onChange: (v: string) => void; auto?: boolean; type?: string; ph?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={value} autoFocus={auto} placeholder={ph} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

const pinHint = (pw: string) => /^\d+$/.test(pw) && pw.length > 0;

/** A new password typed twice, with the PIN hint. Returns an error text, or null when it's good. */
function checkNew(pw: string, again: string): string | null {
  if (pw.length < 6) return "Use at least 6 characters.";
  if (pw !== again) return "The two don't match.";
  return null;
}

/** The recovery key: shown big, copied or saved, and only dismissed once the last group is typed back. */
function KeyScreen({ keyText, cta, onDone }: { keyText: string; cta: string; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const last = keyText.split("-").pop() ?? "";
  const ok = typed.trim().toUpperCase() === last.toUpperCase();
  return (
    <>
      <p className="priv-p">If you forget your password, this key is the only way back in. Keep it somewhere safe, away from this computer.</p>
      <div className="key-box mono" aria-label="Recovery key">
        {keyText.split("-").map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <div className="key-acts">
        <button
          className="btn"
          onClick={() =>
            navigator.clipboard
              .writeText(keyText)
              .then(() => toast("Recovery key copied"))
              .catch(() => toast("Couldn't copy. Select the key and copy it by hand."))
          }
        >
          <Icon n="check" s={15} />
          Copy
        </button>
        <button
          className="btn"
          onClick={() =>
            api
              .saveRecoveryKey(keyText)
              .then((ok) => ok && toast("Recovery key saved"))
              .catch((e) => toast(errText(e)))
          }
        >
          <Icon n="share" s={15} />
          Save as text file…
        </button>
      </div>
      <Field label={`To continue, type the last group of the key (${last.length} characters)`} value={typed} onChange={setTyped} type="text" ph="XXXX" />
      <div className="modal-acts">
        <button className="btn-acc" disabled={!ok} onClick={onDone}>
          {cta}
        </button>
      </div>
    </>
  );
}

// ---- unlock ----------------------------------------------------------------------------------------------------

function UnlockSheet({ then, onClose }: { then?: () => void; onClose: () => void }) {
  const waitUntil = useStore((s) => s.priv.waitUntil);
  const wait = useCountdown(waitUntil);
  const [mode, setMode] = useState<"unlock" | "recover">("unlock");
  const [pw, setPw] = useState("");
  const [rk, setRk] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked = wait > 0;

  const done = async (p: Awaited<ReturnType<typeof api.privateUnlock>>) => {
    await applyPrivateStatus(p);
    onClose();
    then?.();
  };
  const submit = async () => {
    if (busy || blocked) return;
    setErr("");
    if (mode === "recover") {
      const bad = checkNew(pw, pw2);
      if (bad) return setErr(bad);
    }
    setBusy(true);
    try {
      await done(mode === "unlock" ? await api.privateUnlock(pw) : await api.privateRecover(rk, pw));
      if (mode === "recover") toast("New password set · your recovery key still works");
    } catch (e) {
      setErr(errText(e));
      setPw("");
      reloadPrivateStatus();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet onClose={onClose} label="Unlock Private">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="priv-ic">
          <Icon n="lock" s={22} />
        </div>
        {mode === "unlock" ? (
          <>
            <h3>Private is locked</h3>
            <Field label="Password or PIN" value={pw} onChange={setPw} auto />
          </>
        ) : (
          <>
            <h3>Reset your password</h3>
            <p className="priv-p">Enter the recovery key you saved when you set up Private, then choose a new password.</p>
            <Field label="Recovery key" value={rk} onChange={setRk} type="text" auto ph="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" />
            <Field label="New password or PIN" value={pw} onChange={setPw} />
            <Field label="New password again" value={pw2} onChange={setPw2} />
            {pinHint(pw) && <p className="priv-hint">A PIN is easier to guess than a password.</p>}
          </>
        )}
        {blocked ? <p className="priv-err">Too many tries. Try again in {wait} s.</p> : err && <p className="priv-err">{err}</p>}
        <div className="modal-acts">
          {mode === "unlock" ? (
            <button type="button" className="btn flat" onClick={() => (setMode("recover"), setErr(""), setPw(""))}>
              Forgot password?
            </button>
          ) : (
            <button type="button" className="btn flat" onClick={() => (setMode("unlock"), setErr(""), setPw(""))}>
              Back
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-acc" disabled={busy || blocked || !pw || (mode === "recover" && !rk.trim())}>
            {mode === "unlock" ? "Unlock" : "Set password"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

// ---- setup -----------------------------------------------------------------------------------------------------

function SetupWizard({ then, onClose }: { then?: () => void; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [idle, setIdle] = useState(300);

  const create = async () => {
    const bad = checkNew(pw, pw2);
    if (bad) return setErr(bad);
    setBusy(true);
    setErr("");
    try {
      setKey(await api.privateSetup(pw, 300));
      await reloadPrivateStatus();
      setStep(1);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    setBusy(true);
    try {
      await applyPrivateStatus(await api.privateSettings(idle, false));
      onClose();
      then?.();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  // once the vault exists the key must be seen: no way out of steps 2 and 3 except through them
  return (
    <Sheet wide label="Set up Private" onClose={step === 0 ? onClose : undefined}>
      <div className="steps" aria-label={`Step ${step + 1} of 3`}>
        {[0, 1, 2].map((i) => (
          <i key={i} className={i === step ? "on" : i < step ? "done" : ""} />
        ))}
      </div>
      {step === 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <div className="priv-ic">
            <Icon n="lock" s={22} />
          </div>
          <h3>Set up Private</h3>
          <p className="priv-p">
            Pick folders to hide. While Private is locked, their photos and videos appear nowhere in Sitara: not in the timeline, albums, search, people or slideshows. Unlock with a password to see them in their own space.
          </p>
          <p className="priv-note">
            <Icon n="info" s={15} />
            <span>{NOTE}</span>
          </p>
          <Field label="Password or PIN (6 or more characters)" value={pw} onChange={setPw} auto />
          <Field label="Again" value={pw2} onChange={setPw2} />
          {pinHint(pw) && <p className="priv-hint">A PIN is easier to guess than a password.</p>}
          {err && <p className="priv-err">{err}</p>}
          <div className="modal-acts">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-acc" disabled={busy || !pw || !pw2}>
              Continue
            </button>
          </div>
        </form>
      )}
      {step === 1 && (
        <>
          <h3>Your recovery key</h3>
          <KeyScreen keyText={key} cta="I've saved it" onDone={() => setStep(2)} />
        </>
      )}
      {step === 2 && (
        <>
          <h3>Lock automatically</h3>
          <p className="priv-p">Private locks itself after this long without activity. Playing a video or a slideshow counts as activity. You can change it any time.</p>
          <div className="chips idle">
            {IDLE.map(([s, label]) => (
              <button key={s} className={`chip${idle === s ? " on" : ""}`} onClick={() => setIdle(s)}>
                {label}
              </button>
            ))}
          </div>
          {err && <p className="priv-err">{err}</p>}
          <div className="modal-acts">
            <button className="btn-acc" disabled={busy} onClick={finish}>
              Finish
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Mounted once in the app: shows the unlock sheet or the setup wizard when something asks for Private. */
export function PrivateModals() {
  const ui = useStore((s) => s.privUi);
  if (!ui) return null;
  const close = () => store.set({ privUi: null });
  return ui.kind === "setup" ? <SetupWizard key="setup" then={ui.then} onClose={close} /> : <UnlockSheet key="unlock" then={ui.then} onClose={close} />;
}

// ---- Folders page card -----------------------------------------------------------------------------------------

export function PrivateCard() {
  const priv = useStore((s) => s.priv);
  return (
    <div className="priv-card glass">
      <span className="fic">
        <Icon n={priv.unlocked ? "unlock" : "lock"} s={20} />
      </span>
      <div className="fmain">
        <b>Private {priv.unlocked ? <em className="pill-acc">Unlocked</em> : priv.setUp ? <em className="pill-dim">Locked</em> : null}</b>
        <span className="sans">
          {priv.setUp
            ? priv.unlocked
              ? `${plural(priv.dirs.length, "private folder")} · locks itself after ${priv.idleSecs / 60} min without activity`
              : "Hidden folders stay out of Sitara until you unlock."
            : "Hide folders behind a password. They disappear from everything until you unlock."}
        </span>
      </div>
      <button className="btn" onClick={openPrivate}>
        <Icon n={priv.unlocked ? "unlock" : "lock"} s={15} />
        {priv.unlocked ? "Open Private" : priv.setUp ? "Unlock" : "Set up Private"}
      </button>
    </div>
  );
}

// ---- the Private space ------------------------------------------------------------------------------------------

type Tab = "timeline" | "albums" | "folders" | "settings";
const TABS: [Tab, string][] = [
  ["timeline", "Timeline"],
  ["albums", "Albums"],
  ["folders", "Folders"],
  ["settings", "Settings"],
];

export function PrivateView({ active }: { active: boolean }) {
  const plib = useStore((s) => s.plib);
  const dirs = useStore((s) => s.priv.dirs);
  const lockAt = useStore((s) => s.priv.lockAt);
  const search = useStore((s) => (s.search?.private ? s.search : null));
  const album = useStore((s) => s.album);
  const [tab, setTab] = useState<Tab>("timeline");
  const left = useCountdown(lockAt);

  // an album opened from a toast, a folder row or the palette lives under Albums
  useEffect(() => {
    if (album && active) setTab("albums");
  }, [album, active]);
  useEffect(() => {
    if (search && active) setTab("timeline");
  }, [search, active]);

  const order = useMemo(() => {
    if (!plib) return [] as number[];
    if (search) return search.ids.map((id) => plib.pos.get(id)).filter((i): i is number => i != null);
    return Array.from({ length: plib.n }, (_, i) => i);
  }, [plib, search]);

  if (!plib) return null;
  const head = (grid: boolean) => (
    <>
      <div className={`page-head${grid ? " album-head" : ""}`}>
        <div className="ghost" aria-hidden="true">
          PRIVATE
        </div>
        <div className="sec-title">
          <div className="kicker">
            <span className="pill-acc">Unlocked · {mmss(left)}</span>
            <span>
              {plural(plib.n, "item")} · {plural(dirs.length, "folder")}
            </span>
          </div>
          <h2>Private</h2>
          <div className="stats sans">Only visible while unlocked. None of this shows up in your library, search, people or slideshows.</div>
        </div>
        <div className="head-acts">
          <button className="btn" onClick={addFolder}>
            <Icon n="folderPlus" s={16} />
            Add private folder
          </button>
          <button className="btn-acc" onClick={lockNow}>
            <Icon n="lock" s={16} />
            Lock
          </button>
        </div>
      </div>
      <div className="chips" style={grid ? { margin: "0 24px 26px" } : undefined}>
        {TABS.map(([t, label]) => (
          <button
            key={t}
            className={`chip${tab === t ? " on" : ""}`}
            onClick={() => {
              if (t !== "albums") store.set({ album: null });
              setTab(t);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );

  if (tab === "timeline")
    return (
      <Grid
        lib={plib}
        order={order}
        group
        active={active}
        label={search ? `“${search.q}”` : "Private"}
        scrollKey={search?.q ?? ""}
        header={head(true)}
        empty={
          <div className="empty">
            <b>{search ? `Nothing private matches “${search.q}”` : "Nothing here yet"}</b>
            <span>{search ? "Search looks at file and folder names, camera models, years and months." : "Add a folder to Private, or use “Make private” in Folders."}</span>
            {!search && (
              <button className="btn" onClick={addFolder}>
                <Icon n="folderPlus" s={16} />
                Add private folder
              </button>
            )}
          </div>
        }
      />
    );
  if (tab === "albums") return <AlbumsView active={active} priv head={head(false)} />;
  return (
    <div className="scroller page" onScroll={(e) => document.body.classList.toggle("scrolled", e.currentTarget.scrollTop > 10)}>
      {head(false)}
      {tab === "folders" ? <PrivateFolders dirs={dirs} openDir={(d) => (setTab("albums"), openDir(d.path, d.name, true))} /> : <PrivateSettings />}
    </div>
  );
}

async function addFolder() {
  const p = await api.pickFolder("Choose a folder to make private");
  if (p) makePrivate(p);
}

function PrivateFolders({ dirs, openDir }: { dirs: PrivateDir[]; openDir: (d: PrivateDir) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  if (!dirs.length)
    return (
      <div className="empty">
        <b>No private folders</b>
        <span>Add a folder here, or choose “Make private” on any folder in Folders or on a folder album.</span>
        <button className="btn" onClick={addFolder}>
          <Icon n="folderPlus" s={16} />
          Add private folder
        </button>
      </div>
    );
  return (
    <div className="flist">
      {dirs.map((d) => (
        <div key={d.path} className="frow pf glass">
          <span className="fic">
            <Icon n="folder" s={20} />
          </span>
          <div className="fmain">
            <b>{d.name}</b>
            <span title={d.path}>{d.path}</span>
          </div>
          <div className="fnums">
            <b>{fmtNum(d.count)}</b>
            <span>
              {fmtNum(d.photos)} photos · {fmtNum(d.videos)} videos · {fmtSize(d.bytes)}
            </span>
          </div>
          <div className="fact">
            <button className="btn" onClick={() => openDir(d)}>
              Open
            </button>
            {confirm === d.path ? (
              <button
                className="btn danger"
                onClick={async () => {
                  setConfirm(null);
                  try {
                    await applyPrivateStatus(await api.privateRemove(d.path));
                    toast(`${d.name} is back in your library`);
                  } catch (e) {
                    toast(errText(e));
                  }
                }}
              >
                Show in library
              </button>
            ) : (
              <button className="btn" onClick={() => setConfirm(d.path)} title="Stop hiding this folder: its photos return to your library, search and slideshows">
                <Icon n="unlock" s={15} />
                Make public
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PrivateSettings() {
  const priv = useStore((s) => s.priv);
  const [modal, setModal] = useState<"pw" | "key" | "reset" | null>(null);
  const save = async (idleSecs: number, lockOnMinimize: boolean) => {
    try {
      await applyPrivateStatus(await api.privateSettings(idleSecs, lockOnMinimize));
    } catch (e) {
      toast(errText(e));
    }
  };
  return (
    <div className="psettings">
      <section className="glass">
        <h3>Auto-lock</h3>
        <p>Private locks itself after this long without activity. Playing a video or a slideshow counts as activity.</p>
        <div className="chips">
          {IDLE.map(([s, label]) => (
            <button key={s} className={`chip${priv.idleSecs === s ? " on" : ""}`} onClick={() => save(s, priv.lockOnMinimize)}>
              {label}
            </button>
          ))}
        </div>
        <button className={`chip${priv.lockOnMinimize ? " on" : ""}`} onClick={() => save(priv.idleSecs, !priv.lockOnMinimize)} role="switch" aria-checked={priv.lockOnMinimize}>
          <Icon n={priv.lockOnMinimize ? "check" : "x"} s={14} />
          Lock when Sitara is minimized
        </button>
      </section>
      <section className="glass">
        <h3>Password and recovery</h3>
        <p>Your recovery key is the only way back in if you forget the password. Making a new one retires the old one.</p>
        <div className="row">
          <button className="btn" onClick={() => setModal("pw")}>
            <Icon n="edit" s={15} />
            Change password
          </button>
          <button className="btn" onClick={() => setModal("key")}>
            <Icon n="refresh" s={15} />
            New recovery key
          </button>
        </div>
      </section>
      <section className="glass">
        <h3>Good to know</h3>
        <p>{NOTE}</p>
      </section>
      <section className="glass danger-zone">
        <h3>Reset Private</h3>
        <p>
          Last resort if you lost both the password and the recovery key. This removes the private folders from Sitara. Their files stay on disk, and they are never moved back into your library.
        </p>
        <div className="row">
          <button className="btn danger" onClick={() => setModal("reset")}>
            <Icon n="trash" s={15} />
            Reset Private…
          </button>
        </div>
      </section>
      {modal === "pw" && <ChangePassword onClose={() => setModal(null)} />}
      {modal === "key" && <NewKey onClose={() => setModal(null)} />}
      {modal === "reset" && <ResetPrivate onClose={() => setModal(null)} />}
    </div>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  return (
    <Sheet onClose={onClose} label="Change password">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const bad = checkNew(pw, pw2);
          if (bad) return setErr(bad);
          try {
            await api.privateChangePassword(cur, pw);
            toast("Password changed");
            onClose();
          } catch (x) {
            setErr(errText(x));
          }
        }}
      >
        <h3>Change password</h3>
        <Field label="Current password" value={cur} onChange={setCur} auto />
        <Field label="New password or PIN" value={pw} onChange={setPw} />
        <Field label="New password again" value={pw2} onChange={setPw2} />
        {pinHint(pw) && <p className="priv-hint">A PIN is easier to guess than a password.</p>}
        {err && <p className="priv-err">{err}</p>}
        <div className="modal-acts">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-acc" disabled={!cur || !pw}>
            Change
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function NewKey({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  return (
    <Sheet wide={!!key} onClose={key ? undefined : onClose} label="New recovery key">
      {key ? (
        <>
          <h3>Your new recovery key</h3>
          <KeyScreen keyText={key} cta="I've saved it" onDone={onClose} />
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              setKey(await api.privateNewRecoveryKey(pw));
            } catch (x) {
              setErr(errText(x));
            }
          }}
        >
          <h3>New recovery key</h3>
          <p className="priv-p">The old key stops working the moment you make a new one. Confirm your password to continue.</p>
          <Field label="Password" value={pw} onChange={setPw} auto />
          {err && <p className="priv-err">{err}</p>}
          <div className="modal-acts">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-acc" disabled={!pw}>
              Make new key
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

function ResetPrivate({ onClose }: { onClose: () => void }) {
  const [t, setT] = useState("");
  const [busy, setBusy] = useState(false);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => inp.current?.focus(), []);
  return (
    <Sheet onClose={onClose} label="Reset Private">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (t !== "RESET" || busy) return;
          setBusy(true);
          try {
            await applyPrivateStatus(await api.privateReset());
            onClose();
            toast("Private was reset · the folders were removed from Sitara, the files are still on disk");
          } catch (x) {
            toast(errText(x));
            setBusy(false);
          }
        }}
      >
        <h3>Reset Private?</h3>
        <p className="priv-p">
          Every private folder is removed from Sitara and Private goes back to not being set up. <b>Your files stay on disk and are not added back to your library.</b> To see them in Sitara again, add the folders again.
        </p>
        <label className="field">
          <span>Type RESET to confirm</span>
          <input ref={inp} value={t} onChange={(e) => setT(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <div className="modal-acts">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={t !== "RESET" || busy}>
            Reset Private
          </button>
        </div>
      </form>
    </Sheet>
  );
}
