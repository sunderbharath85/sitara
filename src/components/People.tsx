// People: faces grouped on this device. Name someone once and every photo of them is one click away.
import { useState } from "react";
import { api, faceUrl, type Person } from "../lib/api";
import { fmtNum, plural } from "../lib/format";
import { clearSel, store, useStore, type AlbumPage } from "../lib/store";
import { Prompt } from "./Chrome";
import { Icon } from "./Icon";
import { toast } from "./Toasts";

export const personName = (p: Pick<Person, "name">) => p.name ?? "Add a name";

export async function openPerson(p: Person) {
  const ids = await api.personItems(p.id);
  store.set({ view: "albums", album: { kind: "person", id: p.id, title: p.name ?? "", ids, face: p.cover } });
}

function Face({ p, size, i }: { p: Person; size: "s" | "l"; i: number }) {
  return (
    <button className={`face ${size}${p.name ? "" : " unnamed"}`} style={{ "--i": Math.min(i, 14) } as React.CSSProperties} onClick={() => openPerson(p)} title={p.name ?? "Name this person"}>
      <span className="face-img">
        <img alt="" loading="lazy" src={faceUrl(p.cover)} />
      </span>
      <b>{personName(p)}</b>
      <small>{plural(p.count, "photo")}</small>
    </button>
  );
}

/** A row of faces at the top of Albums. */
export function PeopleStrip({ people, onAll }: { people: Person[]; onAll: () => void }) {
  const shown = people.filter((p) => !p.hidden);
  if (!shown.length) return null;
  return (
    <section className="people-strip">
      <header>
        <h3>People</h3>
        <span>{plural(shown.length, "person", "people")} · grouped on this device</span>
        <button className="chip" onClick={onAll}>
          See all <Icon n="right" s={13} />
        </button>
      </header>
      <div className="faces-row">
        {shown.slice(0, 14).map((p, i) => (
          <Face key={p.id} p={p} size="s" i={i} />
        ))}
      </div>
    </section>
  );
}

export function PeopleGrid({ people }: { people: Person[] }) {
  const ai = useStore((s) => s.ai);
  const [showHidden, setShowHidden] = useState(false);
  if (!ai?.people)
    return (
      <div className="empty">
        <b>People is off</b>
        <span>Turn it on in Folders → On-device AI. Faces are found and grouped on this computer; nothing is uploaded.</span>
        <button className="btn" onClick={() => store.set({ view: "folders", album: null })}>
          Open On-device AI
        </button>
      </div>
    );
  const shown = people.filter((p) => !p.hidden),
    hidden = people.filter((p) => p.hidden);
  if (!people.length)
    return (
      <div className="empty">
        <b>No people yet</b>
        <span>{ai.faces ? "Faces are found, but nobody appears in two photos yet." : "Sitara is still looking for faces. People appear here as they're found."}</span>
      </div>
    );
  return (
    <>
      <div className="faces-grid">
        {shown.map((p, i) => (
          <Face key={p.id} p={p} size="l" i={i} />
        ))}
      </div>
      {hidden.length > 0 && (
        <div className="hidden-people">
          <button className="chip" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "Hide" : "Show"} {plural(hidden.length, "hidden person", "hidden people")}
          </button>
          {showHidden && (
            <div className="faces-grid dim">
              {hidden.map((p, i) => (
                <Face key={p.id} p={p} size="l" i={i} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Header actions on a person's page. */
export function PersonActions({ page, onChanged }: { page: AlbumPage; onChanged: () => void }) {
  const sel = useStore((s) => s.sel);
  const [naming, setNaming] = useState(false);
  const [merging, setMerging] = useState<Person[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const id = page.id!;
  const back = () => store.set({ album: null });
  return (
    <>
      <button className="btn" onClick={() => setNaming(true)}>
        <Icon n="edit" s={16} />
        {page.title ? "Rename" : "Add a name"}
      </button>
      <button className="btn" onClick={async () => setMerging((await api.people()).filter((p) => p.id !== id))}>
        <Icon n="people" s={16} />
        Same person as…
      </button>
      {sel.size > 0 && (
        <button
          className="btn"
          onClick={async () => {
            const ids = [...sel];
            await api.personRemove(id, ids);
            clearSel();
            store.set({ album: { ...page, ids: page.ids.filter((x) => !ids.includes(x)) } });
            toast(`Removed from ${page.title || "this person"} · ${plural(ids.length, "photo")}`);
            onChanged();
          }}
        >
          <Icon n="x" s={16} />
          Not {page.title || "this person"} · {sel.size}
        </button>
      )}
      <button
        className="btn"
        title="Hide from People (photos stay in your library)"
        onClick={async () => {
          await api.personHide(id, !hidden);
          setHidden(!hidden);
          toast(hidden ? "Shown in People again" : "Hidden from People · your photos are untouched");
          if (!hidden) back();
        }}
      >
        <Icon n="eye" s={16} />
        {hidden ? "Show" : "Hide"}
      </button>
      {naming && (
        <Prompt
          title={page.title ? "Rename" : "Who is this?"}
          initial={page.title}
          cta="Save"
          onDone={async (name) => {
            setNaming(false);
            if (name == null || name === page.title) return;
            await api.personRename(id, name);
            store.set({ album: { ...page, title: name } });
            onChanged();
          }}
        />
      )}
      {merging && (
        <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && setMerging(null)}>
          <div className="modal glass merge">
            <h3>Same person as…</h3>
            <p className="ed-hint">Their photos join together under one name.</p>
            {merging.length ? (
              <div className="faces-grid mini">
                {merging.map((p) => (
                  <button
                    key={p.id}
                    className={`face s${p.name ? "" : " unnamed"}`}
                    onClick={async () => {
                      setMerging(null);
                      await api.personMerge(id, p.id);
                      toast(`Merged into ${p.name ?? "one person"} · ${fmtNum(p.count + page.ids.length)} photos`);
                      await openPerson({ ...p, name: p.name ?? (page.title || null) });
                      onChanged();
                    }}
                  >
                    <span className="face-img">
                      <img alt="" src={faceUrl(p.cover)} />
                    </span>
                    <b>{personName(p)}</b>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">Nobody else yet.</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
