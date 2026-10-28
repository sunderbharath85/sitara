import { useEffect, useState } from "react";
import { api, type Suggestion } from "../lib/api";
import { addFolder, reloadFolders } from "../lib/actions";
import { ago, fmtNum, fmtSize, plural } from "../lib/format";
import { makePrivate } from "../lib/private";
import { store, useStore } from "../lib/store";
import { AiCard } from "./AiCard";
import { Icon } from "./Icon";
import { PrivateCard } from "./Private";
import { toast } from "./Toasts";

function useSuggestions() {
  const folders = useStore((s) => s.folders);
  const [sug, setSug] = useState<Suggestion[]>([]);
  useEffect(() => {
    api.suggestFolders().then(setSug).catch(() => setSug([]));
  }, [folders]);
  return sug;
}

export function FoldersView() {
  const folders = useStore((s) => s.folders);
  const st = useStore((s) => s.status);
  const sug = useSuggestions();
  const [confirm, setConfirm] = useState<number | null>(null);
  const total = (folders ?? []).reduce((a, f) => a + f.count, 0);
  const bytes = (folders ?? []).reduce((a, f) => a + f.bytes, 0);
  return (
    <div className="scroller page" onScroll={(e) => document.body.classList.toggle("scrolled", e.currentTarget.scrollTop > 10)}>
      <div className="page-head">
        <div className="ghost" aria-hidden="true">
          FOLDERS
        </div>
        <div className="sec-title">
          <div className="kicker">
            <span className="pill-acc">Live-watched</span>
            <span>
              {plural(folders?.length ?? 0, "folder")} · {fmtSize(bytes)}
            </span>
          </div>
          <h2>Folders</h2>
          <div className="stats sans">Sitara reads these folders and never changes your files. New photos show up on their own.</div>
        </div>
        <div className="head-acts">
          <button className="btn" onClick={() => api.rescan().then(() => toast("Rescanning every folder"))}>
            <Icon n="refresh" s={16} />
            Rescan
          </button>
          <button className="btn-acc" onClick={() => addFolder()}>
            <Icon n="folderPlus" s={16} />
            Add folder
          </button>
        </div>
      </div>

      <div className="fstats">
        <div className="cstat glass">
          <b>{fmtNum(total)}</b>
          <span>Items indexed</span>
        </div>
        <div className="cstat glass">
          <b>{fmtNum((folders ?? []).reduce((a, f) => a + f.photos, 0))}</b>
          <span>Photos</span>
        </div>
        <div className="cstat glass">
          <b>{fmtNum((folders ?? []).reduce((a, f) => a + f.videos, 0))}</b>
          <span>Videos</span>
        </div>
        <div className={`cstat glass${st.scanning || st.warming ? " acc" : ""}`}>
          <b>{st.scanning ? fmtNum(st.indexed) : st.warming ? fmtNum(st.thumbsPending) : "✓"}</b>
          <span>{st.scanning ? `indexing ${st.folder?.split(/[\\/]/).pop() ?? ""}` : st.warming ? "thumbnails to render" : "Everything up to date"}</span>
        </div>
      </div>

      <AiCard />
      <PrivateCard />

      <div className="flist">
        {folders?.map((f) => (
          <div key={f.id} className="frow glass">
            <span className="fic">
              <Icon n="folder" s={20} />
            </span>
            <div className="fmain">
              <b>{f.path.split(/[\\/]/).filter(Boolean).pop() ?? f.path}</b>
              <span title={f.path}>{f.path}</span>
            </div>
            <div className="fnums">
              <b>{fmtNum(f.count)}</b>
              <span>
                {fmtNum(f.photos)} photos · {fmtNum(f.videos)} videos · {fmtSize(f.bytes)}
              </span>
            </div>
            <div className="fscan">scanned {ago(f.lastScan)}</div>
            <div className="fact">
              <button className="btn" onClick={() => makePrivate(f.path)} title="Hide this folder in the Private space">
                <Icon n="lock" s={15} />
                Make private
              </button>
              {confirm === f.id ? (
                <button
                  className="btn danger"
                  onClick={async () => {
                    setConfirm(null);
                    store.set({ folders: await api.removeFolder(f.id) });
                    toast(`Removed ${f.path} from Sitara · files on disk are untouched`);
                  }}
                >
                  Remove from library
                </button>
              ) : (
                <button className="btn" onClick={() => setConfirm(f.id)} title="Stop showing this folder (files stay on disk)">
                  <Icon n="x" s={15} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {sug.length > 0 && (
        <div className="sugs">
          <span>Suggested</span>
          {sug.map((s) => (
            <button key={s.path} className="chip" onClick={() => addFolder(s.path)} title={s.path}>
              <Icon n="plus" s={14} /> {s.label}
            </button>
          ))}
        </div>
      )}
      <p className="hint">Tip: drop a folder anywhere on the window to add it.</p>
    </div>
  );
}

export function Welcome() {
  const sug = useSuggestions();
  useEffect(() => {
    reloadFolders();
  }, []);
  return (
    <div className="welcome">
      <div className="w-ghost" aria-hidden="true">
        SITARA
      </div>
      <div className="w-body">
        <div className="logo big">
          <i />
          Sitara
        </div>
        <h1>
          Every photo you own.
          <br />
          <em>One fast, private timeline.</em>
        </h1>
        <p>Pick the folders where your photos and videos live. Sitara indexes them on this computer and keeps watching for new ones. Nothing is uploaded.</p>
        <div className="w-acts">
          <button className="btn-acc lg" onClick={() => addFolder()}>
            <Icon n="folderPlus" s={18} />
            Add a folder
          </button>
          {sug.map((s) => (
            <button key={s.path} className="btn lg" onClick={() => addFolder(s.path)} title={s.path}>
              <Icon n="plus" s={16} />
              {s.label}
            </button>
          ))}
        </div>
        <ul className="w-points">
          <li>
            <Icon n="shield" s={16} />
            Stays on your device
          </li>
          <li>
            <Icon n="bolt" s={16} />
            Built in Rust for 100k+ photos
          </li>
          <li>
            <Icon n="spark" s={16} />
            Originals are never modified
          </li>
        </ul>
        <p className="hint">Or drop a folder onto this window.</p>
      </div>
    </div>
  );
}
