// Turning on-device AI on and off: one card, two features, downloaded once and then fully offline.
import { useState } from "react";
import { api, type AiStatus } from "../lib/api";
import { fmtNum, fmtSize } from "../lib/format";
import { useStore } from "../lib/store";
import { Icon } from "./Icon";
import { toast } from "./Toasts";

type Feature = "search" | "people";

const FEATURES: { k: Feature; icon: string; title: string; desc: string; eg: string[] }[] = [
  {
    k: "search",
    icon: "search",
    title: "Search by meaning",
    desc: "Describe a photo and Sitara finds it, no tags needed.",
    eg: ["sunset over water", "dog in the snow", "birthday cake", "red car"],
  },
  {
    k: "people",
    icon: "people",
    title: "People",
    desc: "Finds faces and groups them by person, so you can name the people you love.",
    eg: ["name once", "merge look-alikes", "private by design"],
  },
];

export function AiCard() {
  const ai = useStore((s) => s.ai);
  const st = useStore((s) => s.status);
  const [confirm, setConfirm] = useState<Feature | null>(null);
  if (!ai) return null;
  const dl = ai.download;
  const busy = !!dl && !dl.error;
  const install = async (f: Feature) => {
    try {
      await api.aiInstall(f);
    } catch (e) {
      toast(String(e));
    }
  };
  const mb = (f: Feature) => (f === "search" ? ai.searchMb : ai.peopleMb) + ai.runtimeMb;
  return (
    <section className="ai-card glass">
      <div className="ai-head">
        <span className="ai-orb">
          <Icon n="spark" s={22} />
        </span>
        <div className="ai-title">
          <h3>On-device AI</h3>
          <p>Runs entirely on this computer. Models download once, from their public sources, and are checked before use. Your photos are never uploaded.</p>
        </div>
        <Learn ai={ai} learning={st.learning} pending={st.learnPending} />
      </div>
      {!ai.supported && <p className="ai-note">On-device AI isn't available for this kind of computer yet.</p>}
      <div className="ai-feats">
        {FEATURES.map((f) => {
          const on = ai[f.k];
          return (
            <div key={f.k} className={`ai-feat${on ? " on" : ""}`}>
              <div className="ai-fh">
                <Icon n={f.icon} s={18} />
                <b>{f.title}</b>
                {on && <span className="pill-acc">On</span>}
              </div>
              <p>{f.desc}</p>
              <div className="ai-eg">
                {f.eg.map((e) => (
                  <span key={e}>{f.k === "search" ? `“${e}”` : e}</span>
                ))}
              </div>
              <div className="ai-fa">
                {on ? (
                  confirm === f.k ? (
                    <button
                      className="btn danger sm"
                      onClick={async () => {
                        setConfirm(null);
                        await api.aiRemove(f.k);
                        toast(`${f.title} turned off · models and what was learned are deleted`);
                      }}
                    >
                      Delete models &amp; data
                    </button>
                  ) : (
                    <button className="btn sm" onClick={() => setConfirm(f.k)}>
                      Turn off
                    </button>
                  )
                ) : (
                  <button className="btn-acc" disabled={busy || !ai.supported} onClick={() => install(f.k)}>
                    <Icon n="share" s={15} />
                    Download &amp; turn on · {mb(f.k)} MB
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <EditingPacks />
      <Device ai={ai} />
      {dl && (
        <div className={`ai-dl${dl.error ? " err" : ""}`}>
          {dl.error ? (
            <>
              <b>Download stopped</b>
              <span>{dl.error}</span>
            </>
          ) : (
            <>
              <i style={{ width: `${dl.total ? (100 * dl.done) / dl.total : 3}%` }} />
              <span>
                {dl.label} · {fmtSize(dl.done)} of {fmtSize(dl.total)}
              </span>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Learn({ ai, learning, pending }: { ai: AiStatus; learning: boolean; pending: number }) {
  if (!ai.search && !ai.people) return null;
  return (
    <div className={`ai-learn${learning ? " acc" : ""}`}>
      <b>{learning ? fmtNum(pending) : fmtNum(ai.indexed)}</b>
      <span>{learning ? "photos to learn" : ai.people ? `photos understood · ${fmtNum(ai.faces)} faces` : "photos understood"}</span>
    </div>
  );
}

/** Where the models run: the graphics card when there is one (the user can keep AI on the processor). */
function Device({ ai }: { ai: AiStatus }) {
  if (!ai.supported) return null;
  const gpu = !!ai.gpu && ai.useGpu;
  return (
    <div className="ai-device">
      <Icon n="bolt" s={16} />
      <span>
        <b>{gpu ? ai.gpu : "Processor"}</b>
        <small>
          {gpu
            ? "AI runs on the graphics card, often 10 to 20 times faster. Anything it can't run stays on the processor."
            : ai.gpu
              ? "AI runs on the processor. The graphics card is much faster."
              : "AI runs on the processor. No supported graphics card was found."}
        </small>
      </span>
      {ai.gpu && (
        <label className="switch">
          <input
            type="checkbox"
            checked={ai.useGpu}
            onChange={async (e) => {
              try {
                await api.aiSetGpu(e.target.checked);
              } catch (err) {
                toast(String(err));
              }
            }}
          />
          <i />
          <span>Use the graphics card</span>
        </label>
      )}
    </div>
  );
}

const EDITING: [string, string][] = [
  ["erase", "Remove objects"],
  ["subject", "Select subject"],
  ["sky", "Select sky"],
  ["depth", "Background blur (depth)"],
  ["denoise", "Denoise"],
  ["upscale", "Upscale"],
  ["colorize", "Colorize"],
  ["restore", "Restore faces"],
];

/** Editing models are downloaded from the editor's AI tool; here you can see and delete them. */
function EditingPacks() {
  const ai = useStore((s) => s.ai);
  if (!ai) return null;
  const on = ai.packs.filter((p) => p.on && EDITING.some(([k]) => k === p.key));
  return (
    <div className="ai-edit-packs">
      <b>AI editing</b>
      <span>
        {on.length
          ? "Downloaded for the editor's AI tool:"
          : "Restore old photos, remove objects, subject and sky selection, background blur, denoise and upscale download from the editor's AI tool, one at a time, only when you use them."}
      </span>
      {on.length > 0 && (
        <div className="ai-eg">
          {on.map((p) => (
            <button
              key={p.key}
              className="pack"
              title="Delete this model"
              onClick={async () => {
                await api.aiRemove(p.key);
                toast(`${EDITING.find(([k]) => k === p.key)?.[1]} model deleted`);
              }}
            >
              {EDITING.find(([k]) => k === p.key)?.[1]} · {p.mb} MB <Icon n="x" s={11} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
