// The editor's AI tool: every feature runs on this computer, and each model downloads only when asked for.
import { useState } from "react";
import { api, type AiPack } from "../../lib/api";
import type { Stack } from "../../lib/edit/stack";
import { fmtSize } from "../../lib/format";
import { useStore } from "../../lib/store";
import { Icon } from "../Icon";
import { toast } from "../Toasts";
import { Group, Slider } from "./controls";
import type { Up } from "./panels";

export type AiAction = "describe" | "enhance" | "remove" | "subject" | "sky" | "background" | "blur" | "denoise" | "upscale";

/** Shows the action when its models are present, otherwise a one-click download. */
function Needs({ keys, children }: { keys: AiPack["key"][]; children: React.ReactNode }) {
  const ai = useStore((s) => s.ai);
  if (!ai) return null;
  const missing = keys.map((k) => ai.packs.find((p) => p.key === k)).filter((p): p is AiPack => !!p && !p.on);
  if (!missing.length) return <>{children}</>;
  const dl = ai.download;
  const busy = !!dl && !dl.error;
  const mb = missing.reduce((a, p) => a + p.mb, 0) + ai.runtimeMb;
  return (
    <div className="ai-need">
      {busy ? (
        <div className="ai-dl mini">
          <i style={{ width: `${dl!.total ? (100 * dl!.done) / dl!.total : 3}%` }} />
          <span>
            {dl!.label} · {fmtSize(dl!.done)} of {fmtSize(dl!.total)}
          </span>
        </div>
      ) : (
        <button
          className="btn sm"
          disabled={!ai.supported}
          onClick={async () => {
            try {
              for (const p of missing) {
                await api.aiInstall(p.key);
                // installs run one at a time; wait for this one before the next
                while (true) {
                  await new Promise((r) => setTimeout(r, 400));
                  const s = await api.aiStatus();
                  if (!s.download || s.download.error) {
                    if (s.download?.error) throw new Error(s.download.error);
                    break;
                  }
                }
              }
            } catch (e) {
              toast(`Download failed: ${e instanceof Error ? e.message : e}`);
            }
          }}
        >
          <Icon n="share" s={14} />
          Download · {mb} MB
        </button>
      )}
      <small>Runs on this computer · downloaded once</small>
    </div>
  );
}

export function AiPanel({
  s,
  up,
  run,
  busy,
  erase,
  setErase,
}: {
  s: Stack;
  up: Up;
  run: (a: AiAction, text?: string) => void;
  busy: boolean;
  erase: { on: boolean; size: number; strokes: number };
  setErase: (e: { on: boolean; size: number }) => void;
}) {
  const [text, setText] = useState("");
  const examples = ["warmer and brighter", "moody, bluer sky", "brighten her face", "blur the background", "like an old film photo", "clean up the noise"];
  const base = s.ai.base;
  return (
    <>
      <section className="ai-describe">
        <label>
          <Icon n="spark" s={15} /> Describe an edit
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) run("describe", text.trim());
          }}
        >
          <textarea
            value={text}
            rows={2}
            placeholder="e.g. warmer, a bit moodier, bluer sky"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (text.trim()) run("describe", text.trim());
              }
            }}
          />
          <button className="btn-acc" disabled={busy || !text.trim()}>
            Apply
          </button>
        </form>
        <div className="ai-eg">
          {examples.map((x) => (
            <button key={x} onClick={() => setText(x)}>
              {x}
            </button>
          ))}
        </div>
        <p className="ed-hint">Understood offline. Styles are matched to a look when Search by meaning is on; faces, sky and blur use their own models.</p>
      </section>

      <button className="auto-btn" disabled={busy} onClick={() => run("enhance")}>
        <Icon n="wand" s={16} />
        <span>
          <b>Smart enhance</b>
          <small>Tone, plus faces and sky when those models are here</small>
        </span>
      </button>

      <Group title="Remove objects" kicker="paint, then remove">
        <Needs keys={["erase"]}>
          <div className="ai-row">
            <button className={`btn${erase.on ? " on-acc" : ""}`} onClick={() => setErase({ ...erase, on: !erase.on })}>
              <Icon n="brush" s={15} />
              {erase.on ? "Painting…" : "Paint over it"}
            </button>
            <button className="btn-acc" disabled={busy || !erase.strokes} onClick={() => run("remove")}>
              Remove
            </button>
          </div>
          <Slider spec={{ label: "Brush size", min: 0.5, max: 12, step: 0.1 }} value={+(erase.size * 100).toFixed(1)} def={3} onChange={(v) => setErase({ ...erase, size: v / 100 })} onCommit={(v) => setErase({ ...erase, size: v / 100 })} />
          {s.ai.patches.length > 0 && (
            <p className="ed-hint">
              {s.ai.patches.length} removed ·{" "}
              <button className="link" onClick={() => up((x) => void x.ai.patches.pop())}>
                undo the last one
              </button>
            </p>
          )}
        </Needs>
      </Group>

      <Group title="Select" kicker="masks drawn by AI">
        <div className="ai-picks">
          <Needs keys={["subject"]}>
            <button className="btn" disabled={busy} onClick={() => run("subject")}>
              <Icon n="people" s={15} /> Subject
            </button>
            <button className="btn" disabled={busy} onClick={() => run("background")}>
              <Icon n="invert" s={15} /> Background
            </button>
          </Needs>
          <Needs keys={["sky"]}>
            <button className="btn" disabled={busy} onClick={() => run("sky")}>
              <Icon n="drop" s={15} /> Sky
            </button>
          </Needs>
        </div>
        <p className="ed-hint">Each becomes a mask with its own sliders, in Masks.</p>
      </Group>

      <Group title="Background blur" kicker="depth-aware">
        <Needs keys={["depth", "subject"]}>
          {s.ai.blur ? (
            <>
              <Slider
                spec={{ label: "Blur", min: 0, max: 100 }}
                value={s.ai.blur.amount}
                def={60}
                onChange={(v) => up((x) => void (x.ai.blur!.amount = v), false)}
                onCommit={(v) => up((x) => void (x.ai.blur!.amount = v))}
              />
              <Slider
                spec={{ label: "Focus distance", min: 0, max: 100 }}
                value={Math.round(s.ai.blur.focus * 100)}
                def={Math.round(s.ai.blur.focus * 100)}
                onChange={(v) => up((x) => void (x.ai.blur!.focus = v / 100), false)}
                onCommit={(v) => up((x) => void (x.ai.blur!.focus = v / 100))}
              />
              <button className="btn sm" onClick={() => up((x) => void (x.ai.blur = null))}>
                Remove blur
              </button>
            </>
          ) : (
            <button className="btn" disabled={busy} onClick={() => run("blur")}>
              <Icon n="radial" s={15} /> Blur the background
            </button>
          )}
        </Needs>
      </Group>

      <Group title="Denoise" kicker="real camera noise">
        <Needs keys={["denoise"]}>
          {base?.kind === "denoise" ? (
            <>
              <Slider
                spec={{ label: "Strength", min: 0, max: 100 }}
                value={base.amount}
                def={100}
                onChange={(v) => up((x) => void (x.ai.base!.amount = v), false)}
                onCommit={(v) => up((x) => void (x.ai.base!.amount = v))}
              />
              <button className="btn sm" onClick={() => up((x) => void (x.ai.base = null))}>
                Remove denoise
              </button>
            </>
          ) : (
            <button className="btn" disabled={busy || base?.kind === "upscale"} onClick={() => run("denoise")}>
              <Icon n="spark" s={15} /> Denoise
            </button>
          )}
        </Needs>
      </Group>

      <Group title="Upscale" kicker="×4 resolution">
        <Needs keys={["upscale"]}>
          {base?.kind === "upscale" ? (
            <button className="btn sm" onClick={() => up((x) => void (x.ai.base = null))}>
              Back to the original size
            </button>
          ) : (
            <button className="btn" disabled={busy || base?.kind === "denoise"} onClick={() => run("upscale")}>
              <Icon n="expand" s={15} /> Upscale ×4
            </button>
          )}
          <p className="ed-hint">For small or old photos, up to 1600 px on the long side.</p>
        </Needs>
      </Group>
    </>
  );
}
