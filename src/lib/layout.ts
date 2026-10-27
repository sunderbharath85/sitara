import type { Lib } from "./api";
import { fmtMonth } from "./format";

export interface Section {
  key: string;
  title: string;
  ghost: string;
  year: number;
  month: number;
  y: number;
  /** Lib indices in this section, in display order. */
  items: number[];
  photos: number;
  videos: number;
  first: number; // index into Layout.tiles
  last: number;
}

export interface Tile {
  i: number; // lib index
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  tiles: Tile[];
  sections: Section[];
}

export interface LayoutOpts {
  rowH: number;
  gap: number;
  padL: number;
  padR: number;
  headH: number;
  sectionGap: number;
  group: boolean;
  top: number;
}

const GHOST = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function aspect(lib: Lib, i: number) {
  const w = lib.w[i],
    h = lib.h[i];
  if (!w || !h) return lib.kind[i] ? 16 / 9 : 4 / 3;
  return Math.min(4, Math.max(0.25, w / h));
}

/** Justified rows (Flickr/Google Photos style), optionally grouped under month headers. */
export function layoutGrid(lib: Lib, order: ArrayLike<number>, width: number, o: LayoutOpts): Layout {
  const W = Math.max(200, width - o.padL - o.padR);
  const tiles: Tile[] = [];
  const sections: Section[] = [];
  let y = o.top;

  const flushRows = (items: number[]) => {
    let row: number[] = [];
    let sum = 0;
    const emit = (final: boolean) => {
      if (!row.length) return;
      const gaps = (row.length - 1) * o.gap;
      let h = (W - gaps) / sum;
      if (final && h > o.rowH * 1.15) h = o.rowH;
      h = Math.min(h, o.rowH * 2.4);
      let x = o.padL;
      row.forEach((i, k) => {
        let w = aspect(lib, i) * h;
        // close the row exactly on the right edge
        if (k === row.length - 1 && !(final && h === o.rowH)) w = o.padL + W - x;
        tiles.push({ i, x, y, w, h });
        x += w + o.gap;
      });
      y += h + o.gap;
      row = [];
      sum = 0;
    };
    for (const i of items) {
      row.push(i);
      sum += aspect(lib, i);
      if (sum * o.rowH + (row.length - 1) * o.gap >= W) emit(false);
    }
    emit(true);
  };

  if (!o.group) {
    const items = Array.from(order);
    flushRows(items);
    return { width, height: y + 40, tiles, sections };
  }

  let cur: Section | null = null;
  const close = () => {
    if (!cur) return;
    cur.first = tiles.length;
    y = cur.y + o.headH;
    flushRows(cur.items);
    cur.last = tiles.length - 1;
    sections.push(cur);
    y += o.sectionGap;
  };
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const d = new Date(lib.taken[i] * 1000);
    const yr = d.getUTCFullYear(),
      mo = d.getUTCMonth();
    const group = `${yr}-${mo}`;
    if (!cur || !cur.key.startsWith(group + "#")) {
      close();
      // unique even when the order isn't chronological (e.g. hand-ordered albums)
      cur = { key: `${group}#${sections.length}`, title: fmtMonth(lib.taken[i]), ghost: GHOST[mo], year: yr, month: mo, y, items: [], photos: 0, videos: 0, first: 0, last: 0 };
    }
    cur.items.push(i);
    if (lib.kind[i]) cur.videos++;
    else cur.photos++;
  }
  close();
  return { width, height: y + 120, tiles, sections };
}

/** First tile whose bottom edge is below `top` (tiles are sorted by y). */
export function firstVisible(tiles: Tile[], top: number) {
  let lo = 0,
    hi = tiles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tiles[mid].y + tiles[mid].h < top) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
