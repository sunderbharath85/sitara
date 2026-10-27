import { useEffect, useState } from "react";

interface T {
  id: number;
  msg: string;
  action?: { label: string; run: () => void };
  in: boolean;
}

let items: T[] = [];
let seq = 0;
const subs = new Set<(t: T[]) => void>();
const push = () => subs.forEach((f) => f([...items]));

export function toast(msg: string, action?: { label: string; run: () => void }) {
  const t: T = { id: ++seq, msg, action, in: false };
  items = [...items.slice(-3), t];
  push();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      t.in = true;
      push();
    }),
  );
  setTimeout(() => dismiss(t.id), action ? 6000 : 3000);
}

function dismiss(id: number) {
  const t = items.find((x) => x.id === id);
  if (!t) return;
  t.in = false;
  push();
  setTimeout(() => {
    items = items.filter((x) => x.id !== id);
    push();
  }, 400);
}

export function Toasts() {
  const [list, setList] = useState<T[]>([]);
  useEffect(() => {
    subs.add(setList);
    return () => void subs.delete(setList);
  }, []);
  return (
    <div id="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast glass${t.in ? " in" : ""}`}>
          <span>{t.msg}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
