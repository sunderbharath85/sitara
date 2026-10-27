//! Cleanup suggestions: exact duplicates, similar shots, possibly blurry photos, old screenshots.
//! Nothing is deleted here; the UI moves rejects to the Recycle Bin with undo.

use crate::analysis::hamming;
use crate::db;
use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CItem {
    pub id: i64,
    pub name: String,
    pub dir: String,
    pub size: i64,
    pub w: i64,
    pub h: i64,
    pub taken: i64,
    pub fav: bool,
    pub sharp: f64,
    pub luma: f64,
    pub clip: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub kind: &'static str, // "exact" | "similar"
    pub items: Vec<CItem>,
    pub best: usize,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub exact_groups: usize,
    pub exact_extra: usize,
    pub exact_bytes: i64,
    pub similar_groups: usize,
    pub similar_extra: usize,
    pub similar_bytes: i64,
    pub blurry: usize,
    pub blurry_bytes: i64,
    pub shots: usize,
    pub shots_bytes: i64,
    pub analyzed: usize,
    pub pending: usize,
}

#[derive(Serialize)]
pub struct Report {
    pub exact: Vec<Group>,
    pub similar: Vec<Group>,
    pub blurry: Vec<CItem>,
    pub shots: Vec<CItem>,
    pub stats: Stats,
}

struct Row {
    item: CItem,
    path: String,
    kind: i64,
    chash: Option<String>,
    dhash: Option<i64>,
    contrast: f64,
    is_shot: bool,
}

struct Dsu(Vec<usize>);
impl Dsu {
    fn find(&mut self, x: usize) -> usize {
        let mut r = x;
        while self.0[r] != r {
            r = self.0[r];
        }
        let mut x = x;
        while self.0[x] != r {
            let n = self.0[x];
            self.0[x] = r;
            x = n;
        }
        r
    }
    fn union(&mut self, a: usize, b: usize) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            self.0[b] = a;
        }
    }
}

fn hash_file(path: &str) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut h = blake3::Hasher::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(h.finalize().to_hex().to_string())
}

/// Which item to keep: sharp, well exposed, high resolution; favorites always win.
fn quality(c: &CItem, max_sharp: f64) -> f64 {
    let sharp = if max_sharp > 0.0 { c.sharp.max(0.0) / max_sharp } else { 0.5 };
    let expo = 1.0 - ((c.luma - 118.0).abs() / 118.0).min(1.0);
    let res = ((c.w * c.h).max(1) as f64).log2() / 26.0;
    sharp * 1.0 + expo * 0.35 + res * 0.3 - c.clip * 1.5 + if c.fav { 10.0 } else { 0.0 }
}

fn pick_best(items: &[CItem], exact: bool) -> usize {
    if exact {
        // identical bytes: keep a favorite, else the plainest name ("IMG_1.jpg" over "IMG_1 (1).jpg"), else the first found
        return (0..items.len())
            .min_by_key(|&i| (!items[i].fav, items[i].name.len(), items[i].id))
            .unwrap_or(0);
    }
    let max = items.iter().map(|c| c.sharp).fold(0.0, f64::max);
    (0..items.len()).max_by(|&a, &b| quality(&items[a], max).total_cmp(&quality(&items[b], max))).unwrap_or(0)
}

pub fn scan(conn: &Connection) -> rusqlite::Result<Report> {
    let shot_words = ["screenshot", "screen shot", "screen_shot", "scrnshot", "screencap"];
    let mut st = conn.prepare(
        "SELECT m.id, m.name, m.dir, m.size, m.width, m.height, m.taken, m.favorite, m.path, m.kind, m.chash,
                a.dhash, a.sharp, a.luma, a.contrast, a.clip
         FROM media m LEFT JOIN analysis a ON a.media_id = m.id
         WHERE m.trashed = 0 ORDER BY m.taken ASC, m.id ASC",
    )?;
    let mut rows: Vec<Row> = st
        .query_map([], |r| {
            let name: String = r.get(1)?;
            let dir: String = r.get(2)?;
            let sharp: Option<f64> = r.get(12)?;
            let ok = sharp.is_some_and(|s| s >= 0.0);
            let (nl, dl) = (name.to_lowercase(), dir.to_lowercase());
            Ok(Row {
                is_shot: shot_words.iter().any(|k| nl.contains(k) || dl.contains(k)),
                item: CItem {
                    id: r.get(0)?,
                    name,
                    dir,
                    size: r.get(3)?,
                    w: r.get(4)?,
                    h: r.get(5)?,
                    taken: r.get(6)?,
                    fav: r.get::<_, i64>(7)? != 0,
                    sharp: sharp.unwrap_or(-1.0),
                    luma: r.get::<_, Option<f64>>(13)?.unwrap_or(118.0),
                    clip: r.get::<_, Option<f64>>(15)?.unwrap_or(0.0),
                },
                path: r.get(8)?,
                kind: r.get(9)?,
                chash: r.get(10)?,
                dhash: if ok { r.get(11)? } else { None },
                contrast: r.get::<_, Option<f64>>(14)?.unwrap_or(0.0),
            })
        })?
        .collect::<Result<_, _>>()?;

    let mut stats = Stats {
        analyzed: rows.iter().filter(|r| r.kind == db::PHOTO && r.dhash.is_some()).count(),
        pending: rows.iter().filter(|r| r.kind == db::PHOTO && r.item.sharp < 0.0 && r.dhash.is_none()).count(),
        ..Default::default()
    };

    // ---------- exact duplicates: hash only files that share a size ----------
    let mut by_size: HashMap<i64, Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        if r.item.size > 0 {
            by_size.entry(r.item.size).or_default().push(i);
        }
    }
    let need: Vec<usize> = by_size.values().filter(|v| v.len() > 1).flatten().copied().filter(|&i| rows[i].chash.is_none()).collect();
    let hashed: Vec<(usize, Option<String>)> = need.par_iter().map(|&i| (i, hash_file(&rows[i].path))).collect();
    {
        let tx = conn.unchecked_transaction()?;
        {
            let mut up = tx.prepare_cached("UPDATE media SET chash=?2 WHERE id=?1")?;
            for (i, h) in hashed {
                if let Some(h) = h {
                    up.execute(params![rows[i].item.id, h])?;
                    rows[i].chash = Some(h);
                }
            }
        }
        tx.commit()?;
    }
    let mut by_hash: HashMap<String, Vec<usize>> = HashMap::new();
    for v in by_size.values().filter(|v| v.len() > 1) {
        for &i in v {
            if let Some(h) = &rows[i].chash {
                by_hash.entry(h.clone()).or_default().push(i);
            }
        }
    }
    let mut in_group = vec![false; rows.len()];
    let mut exact: Vec<Group> = vec![];
    for idx in by_hash.into_values().filter(|v| v.len() > 1) {
        let items: Vec<CItem> = idx.iter().map(|&i| rows[i].item.clone()).collect();
        let best = pick_best(&items, true);
        for (k, &i) in idx.iter().enumerate() {
            // the kept copy may still take part in "similar"
            if k != best {
                in_group[i] = true;
            }
        }
        stats.exact_extra += items.len() - 1;
        stats.exact_bytes += items.iter().enumerate().filter(|(k, _)| *k != best).map(|(_, c)| c.size).sum::<i64>();
        exact.push(Group { kind: "exact", items, best });
    }
    exact.sort_by(|a, b| (b.items.len() as i64 * b.items[0].size).cmp(&(a.items.len() as i64 * a.items[0].size)));

    // ---------- similar shots ----------
    // flat scenes (sky, walls, black frames) all hash alike, so they don't count as "similar"
    let cand: Vec<usize> = (0..rows.len())
        .filter(|&i| rows[i].kind == db::PHOTO && !in_group[i] && rows[i].dhash.is_some() && rows[i].contrast >= 12.0)
        .collect();
    let mut dsu = Dsu((0..rows.len()).collect());
    // near-identical anywhere in the library (resized, re-encoded, upscaled copies): distance <= 4
    // means at least one of the four 16-bit chunks matches exactly (pigeonhole), so bucket by chunk
    for k in 0..4 {
        let mut buckets: HashMap<u16, Vec<usize>> = HashMap::new();
        for &i in &cand {
            buckets.entry((rows[i].dhash.unwrap() >> (16 * k)) as u16).or_default().push(i);
        }
        for b in buckets.values().filter(|b| b.len() > 1 && b.len() <= 400) {
            for x in 0..b.len() {
                for y in x + 1..b.len() {
                    if hamming(rows[b[x]].dhash.unwrap(), rows[b[y]].dhash.unwrap()) <= 4 {
                        dsu.union(b[x], b[y]);
                    }
                }
            }
        }
    }
    // bursts: shots seconds apart that still look alike (batches of generated images share a
    // timestamp but differ more, so the bar stays fairly strict)
    for (n, &i) in cand.iter().enumerate() {
        for &j in &cand[n + 1..] {
            if rows[j].item.taken - rows[i].item.taken > 10 {
                break;
            }
            if hamming(rows[i].dhash.unwrap(), rows[j].dhash.unwrap()) <= 8 {
                dsu.union(i, j);
            }
        }
    }
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for &i in &cand {
        groups.entry(dsu.find(i)).or_default().push(i);
    }
    let mut similar: Vec<Group> = vec![];
    for idx in groups.into_values().filter(|g| g.len() > 1 && g.len() <= 40) {
        let items: Vec<CItem> = idx.iter().map(|&i| rows[i].item.clone()).collect();
        let best = pick_best(&items, false);
        for &i in &idx {
            in_group[i] = true;
        }
        stats.similar_extra += items.len() - 1;
        stats.similar_bytes += items.iter().enumerate().filter(|(k, _)| *k != best).map(|(_, c)| c.size).sum::<i64>();
        similar.push(Group { kind: "similar", items, best });
    }
    similar.sort_by(|a, b| b.items[0].taken.cmp(&a.items[0].taken));

    // ---------- possibly blurry: little fine detail in a scene that has real contrast ----------
    let mut blurry: Vec<CItem> = rows
        .iter()
        .enumerate()
        .filter(|(i, r)| !in_group[*i] && r.kind == db::PHOTO && !r.item.fav && r.item.sharp >= 0.0 && r.item.sharp < 22.0 && r.contrast > 22.0)
        .map(|(_, r)| r.item.clone())
        .collect();
    blurry.sort_by(|a, b| a.sharp.total_cmp(&b.sharp));
    stats.blurry = blurry.len();
    stats.blurry_bytes = blurry.iter().map(|c| c.size).sum();
    blurry.truncate(600);

    // ---------- screenshots older than a month ----------
    let month_ago = crate::meta::local_wall_secs(db::now_ms() / 1000) - 30 * 86400;
    let mut shots: Vec<CItem> = rows
        .iter()
        .enumerate()
        .filter(|(i, r)| !in_group[*i] && r.kind == db::PHOTO && r.is_shot && !r.item.fav && r.item.taken < month_ago)
        .map(|(_, r)| r.item.clone())
        .collect();
    shots.sort_by(|a, b| a.taken.cmp(&b.taken));
    stats.shots = shots.len();
    stats.shots_bytes = shots.iter().map(|c| c.size).sum();
    shots.truncate(1000);

    stats.exact_groups = exact.len();
    stats.similar_groups = similar.len();
    exact.truncate(500);
    similar.truncate(500);
    Ok(Report { exact, similar, blurry, shots, stats })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn it(id: i64, name: &str, sharp: f64, luma: f64, fav: bool) -> CItem {
        CItem { id, name: name.into(), dir: String::new(), size: 1, w: 4000, h: 3000, taken: 0, fav, sharp, luma, clip: 0.0 }
    }

    #[test]
    fn best_pick_prefers_sharp_exposed_and_favorites() {
        let g = [it(1, "a.jpg", 40.0, 118.0, false), it(2, "b.jpg", 400.0, 110.0, false), it(3, "c.jpg", 380.0, 20.0, false)];
        assert_eq!(pick_best(&g, false), 1);
        let g = [it(1, "a.jpg", 40.0, 118.0, true), it(2, "b.jpg", 400.0, 110.0, false)];
        assert_eq!(pick_best(&g, false), 0, "a favorite is never the one to go");
        let g = [it(5, "IMG_1 (1).jpg", 0.0, 0.0, false), it(9, "IMG_1.jpg", 0.0, 0.0, false)];
        assert_eq!(pick_best(&g, true), 1, "plain name wins among identical copies");
    }
}
