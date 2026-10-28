//! People: faces grouped into identities. A new face joins a person when their clearest faces agree with
//! it; the rest are grouped with each other, and a group seen in at least two photos (three faces) becomes
//! a new, unnamed person. Names, merges and "not this person" belong to the user and are never undone.

use super::faces::{DIM, cosine};
use rusqlite::{Connection, params};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// SFace cosine similarity between two faces that count as a match. OpenCV suggests 0.363 for "same person";
/// grouping uses stricter values, and always compares faces with faces (an averaged face drifts toward a
/// generic one that resembles everybody).
const MATCH: f32 = 0.5;
const LINK: f32 = 0.55;
/// Two people whose faces average this similar are one person (split while grouping).
const MERGE: f32 = 0.6;
/// Nearest known faces that must agree before a new face joins someone.
const VOTES: usize = 3;
/// Per person, the clearest faces kept as references.
const EXEMPLARS: usize = 40;
/// Unplaced faces are grouped this many at a time (pairwise work grows with the square).
const CHUNK: usize = 3000;
const MIN_FACES: usize = 3;

fn vec_of(b: &[u8]) -> Option<Vec<f32>> {
    (b.len() == DIM * 4).then(|| b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
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
            self.0[a] = b;
        }
    }
}

/// Place unassigned faces: join a known person when their faces agree, else group with other unplaced
/// faces. Returns how many found a person.
pub fn assign(c: &Connection) -> rusqlite::Result<usize> {
    let mut placed = 0;
    let mut after = 0i64;
    loop {
        let chunk: Vec<(i64, i64, Vec<f32>)> = {
            let mut st = c.prepare("SELECT id, media_id, vec FROM faces WHERE person_id IS NULL AND blocked=0 AND id>?1 ORDER BY id LIMIT ?2")?;
            let rows = st.query_map(params![after, CHUNK as i64], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, Vec<u8>>(2)?)))?;
            rows.filter_map(|r| r.ok()).filter_map(|(id, m, b)| vec_of(&b).map(|v| (id, m, v))).collect()
        };
        let Some(last) = chunk.last().map(|x| x.0) else { break };
        after = last;
        placed += place(c, chunk)?;
    }
    if placed > 0 {
        consolidate(c)?;
    }
    Ok(placed)
}

/// Merge people whose reference faces are, on average, as alike as faces of one person are. Groups formed
/// from near-duplicate bursts fragment; this joins them. Two named people are never merged.
fn consolidate(c: &Connection) -> rusqlite::Result<()> {
    let mut refs: HashMap<i64, Vec<Vec<f32>>> = HashMap::new();
    {
        let mut st = c.prepare(
            "SELECT person_id, vec FROM (
               SELECT f.person_id, f.vec, ROW_NUMBER() OVER (PARTITION BY f.person_id ORDER BY f.score * f.w DESC) rn
               FROM faces f JOIN people p ON p.id=f.person_id AND p.hidden=0)
             WHERE rn <= ?1",
        )?;
        let mut rows = st.query([EXEMPLARS as i64])?;
        while let Some(r) = rows.next()? {
            if let Some(v) = vec_of(&r.get::<_, Vec<u8>>(1)?) {
                refs.entry(r.get(0)?).or_default().push(v);
            }
        }
    }
    let named: HashSet<i64> = crate::db::ids(c, "SELECT id FROM people WHERE name IS NOT NULL", [])?.into_iter().collect();
    // biggest first, so smaller groups fold into the established person
    let mut ids: Vec<i64> = refs.keys().copied().collect();
    ids.sort_by_key(|p| std::cmp::Reverse(refs[p].len()));
    let mut into: HashMap<i64, i64> = HashMap::new();
    for (i, &a) in ids.iter().enumerate() {
        if into.contains_key(&a) {
            continue;
        }
        for &b in &ids[i + 1..] {
            if into.contains_key(&b) || (named.contains(&a) && named.contains(&b)) {
                continue;
            }
            let (ra, rb) = (&refs[&a], &refs[&b]);
            let avg = ra.iter().flat_map(|x| rb.iter().map(move |y| cosine(x, y))).sum::<f32>() / (ra.len() * rb.len()) as f32;
            if avg >= MERGE {
                into.insert(b, a);
            }
        }
    }
    for (from, to) in into {
        merge(c, from, to)?;
    }
    Ok(())
}

fn place(c: &Connection, chunk: Vec<(i64, i64, Vec<f32>)>) -> rusqlite::Result<usize> {
    // reference faces of known people
    let refs: Vec<(i64, Vec<f32>)> = {
        let mut st = c.prepare(
            "SELECT person_id, vec FROM (
               SELECT person_id, vec, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY score * w DESC) rn
               FROM faces WHERE person_id IS NOT NULL)
             WHERE rn <= ?1",
        )?;
        let rows = st.query_map([EXEMPLARS as i64], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
        rows.filter_map(|r| r.ok()).filter_map(|(p, b)| vec_of(&b).map(|v| (p, v))).collect()
    };
    let mut per_person: HashMap<i64, usize> = HashMap::new();
    for (p, _) in &refs {
        *per_person.entry(*p).or_default() += 1;
    }
    let tx = c.unchecked_transaction()?;
    let mut placed = 0;
    let mut rest: Vec<(i64, i64, Vec<f32>)> = vec![];
    {
        let mut set = tx.prepare("UPDATE faces SET person_id=?2 WHERE id=?1")?;
        for (id, m, v) in chunk {
            // vote among the nearest matching reference faces
            let mut near: Vec<(f32, i64)> = refs.iter().map(|(p, r)| (cosine(r, &v), *p)).filter(|x| x.0 >= MATCH).collect();
            near.sort_by(|a, b| b.0.total_cmp(&a.0));
            near.truncate(7);
            let mut votes: HashMap<i64, usize> = HashMap::new();
            for (_, p) in &near {
                *votes.entry(*p).or_default() += 1;
            }
            let best = votes.into_iter().max_by_key(|x| x.1);
            match best {
                Some((p, n)) if n >= VOTES.min(per_person[&p]) && n * 2 > near.len() => {
                    set.execute(params![id, p])?;
                    placed += 1;
                }
                _ => rest.push((id, m, v)),
            }
        }
        // group the rest: mutual nearest neighbours above LINK, joined into components
        let n = rest.len();
        let mut nbrs: Vec<Vec<(f32, usize)>> = vec![vec![]; n];
        for i in 0..n {
            for j in i + 1..n {
                let s = cosine(&rest[i].2, &rest[j].2);
                if s >= LINK {
                    nbrs[i].push((s, j));
                    nbrs[j].push((s, i));
                }
            }
        }
        let top: Vec<HashSet<usize>> = nbrs
            .iter_mut()
            .map(|l| {
                l.sort_by(|a, b| b.0.total_cmp(&a.0));
                l.iter().take(10).map(|x| x.1).collect()
            })
            .collect();
        let mut dsu = Dsu((0..n).collect());
        for i in 0..n {
            for &j in &top[i] {
                if top[j].contains(&i) {
                    dsu.union(i, j);
                }
            }
        }
        let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
        for i in 0..n {
            groups.entry(dsu.find(i)).or_default().push(i);
        }
        let now = crate::db::now_ms();
        let mut new = tx.prepare("INSERT INTO people(name, hidden, created) VALUES(NULL, 0, ?1)")?;
        for members in groups.into_values() {
            let photos: HashSet<i64> = members.iter().map(|&k| rest[k].1).collect();
            if members.len() < MIN_FACES || photos.len() < 2 {
                continue;
            }
            new.execute([now])?;
            let p = tx.last_insert_rowid();
            for k in members {
                set.execute(params![rest[k].0, p])?;
                placed += 1;
            }
        }
    }
    tx.commit()?;
    Ok(placed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: i64,
    pub name: Option<String>,
    pub count: i64,
    /// Face id for the portrait.
    pub cover: i64,
    pub hidden: bool,
}

pub fn list(c: &Connection) -> rusqlite::Result<Vec<Person>> {
    let mut st = c.prepare(
        "SELECT p.id, p.name, p.hidden, COUNT(DISTINCT f.media_id),
                (SELECT f2.id FROM faces f2 JOIN media m2 ON m2.id=f2.media_id AND m2.trashed=0 AND m2.private=0
                 WHERE f2.person_id=p.id ORDER BY (f2.id=p.cover) DESC, f2.score * f2.w DESC LIMIT 1)
         FROM people p JOIN faces f ON f.person_id=p.id JOIN media m ON m.id=f.media_id AND m.trashed=0 AND m.private=0
         GROUP BY p.id ORDER BY (p.name IS NULL), COUNT(DISTINCT f.media_id) DESC",
    )?;
    let rows = st.query_map([], |r| {
        Ok(Person {
            id: r.get(0)?,
            name: r.get(1)?,
            hidden: r.get::<_, i64>(2)? != 0,
            count: r.get(3)?,
            cover: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
        })
    })?;
    rows.collect()
}

pub fn items(c: &Connection, person: i64) -> rusqlite::Result<Vec<i64>> {
    crate::db::ids(
        c,
        "SELECT m.id FROM media m WHERE m.trashed=0 AND m.private=0 AND EXISTS (SELECT 1 FROM faces f WHERE f.media_id=m.id AND f.person_id=?1)
         ORDER BY m.taken DESC, m.id DESC",
        [person],
    )
}

pub fn rename(c: &Connection, person: i64, name: &str) -> rusqlite::Result<()> {
    let name = name.trim();
    c.execute("UPDATE people SET name=?2 WHERE id=?1", params![person, (!name.is_empty()).then_some(name)])?;
    Ok(())
}

/// Fold `from` into `into` (keeping a name if only one of them has it).
pub fn merge(c: &Connection, from: i64, into: i64) -> rusqlite::Result<()> {
    if from == into {
        return Ok(());
    }
    let tx = c.unchecked_transaction()?;
    tx.execute("UPDATE people SET name=COALESCE(name, (SELECT name FROM people WHERE id=?1)) WHERE id=?2", params![from, into])?;
    tx.execute("UPDATE faces SET person_id=?2 WHERE person_id=?1", params![from, into])?;
    tx.execute("DELETE FROM people WHERE id=?1", [from])?;
    tx.commit()
}

pub fn hide(c: &Connection, person: i64, hidden: bool) -> rusqlite::Result<()> {
    c.execute("UPDATE people SET hidden=?2 WHERE id=?1", params![person, hidden as i64])?;
    Ok(())
}

/// "Not this person": detach their faces in these photos and keep them from being regrouped.
pub fn remove_media(c: &Connection, person: i64, media: &[i64]) -> rusqlite::Result<()> {
    let tx = c.unchecked_transaction()?;
    {
        let mut st = tx.prepare("UPDATE faces SET person_id=NULL, blocked=1 WHERE person_id=?1 AND media_id=?2")?;
        for m in media {
            st.execute(params![person, m])?;
        }
    }
    tx.execute("DELETE FROM people WHERE id=?1 AND NOT EXISTS (SELECT 1 FROM faces WHERE person_id=?1)", [person])?;
    tx.commit()
}

/// Face box (normalized, in the upright photo) and the photo it's in.
pub fn face(c: &Connection, id: i64) -> rusqlite::Result<Option<(String, String, [f32; 4])>> {
    use rusqlite::OptionalExtension;
    c.query_row("SELECT m.path, m.ext, f.x, f.y, f.w, f.h FROM faces f JOIN media m ON m.id=f.media_id WHERE f.id=?1", [id], |r| {
        Ok((r.get(0)?, r.get(1)?, [r.get::<_, f64>(2)? as f32, r.get::<_, f64>(3)? as f32, r.get::<_, f64>(4)? as f32, r.get::<_, f64>(5)? as f32]))
    })
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(mut v: Vec<f32>) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
        v.iter_mut().for_each(|x| *x /= n);
        v
    }

    fn face(c: &Connection, media: i64, v: &[f32]) {
        let v = unit(v.to_vec());
        let b: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
        c.execute("INSERT INTO faces(media_id, x, y, w, h, score, vec) VALUES(?1, .1, .1, .2, .2, .9, ?2)", params![media, b]).unwrap();
    }

    #[test]
    fn groups_repeated_faces_and_respects_merges() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        c.execute("INSERT INTO folders(path, added_at) VALUES('/p', 0)", []).unwrap();
        for i in 1..=8 {
            c.execute(
                "INSERT INTO media(folder_id,path,dir,name,ext,kind,size,mtime,taken) VALUES(1,?1,'/p','x','jpg',0,1,1,?2)",
                params![format!("/p/{i}.jpg"), i],
            )
            .unwrap();
        }
        let base = |k: usize| {
            let mut v = vec![0.0; DIM];
            v[k] = 1.0;
            v
        };
        let near = |k: usize, j: usize| {
            let mut v = base(k);
            v[j] = 0.3;
            v
        };
        // person A in photos 1-4, person B in 5-7, a stranger once in 8
        for m in 1..=4 {
            face(&c, m, &near(0, m as usize + 10));
        }
        for m in 5..=7 {
            face(&c, m, &near(1, m as usize + 10));
        }
        face(&c, 8, &base(2));
        assign(&c).unwrap();
        let people = list(&c).unwrap();
        assert_eq!(people.len(), 2);
        assert_eq!(people[0].count, 4);
        assert_eq!(people[1].count, 3);
        // a new photo of A joins A
        c.execute("INSERT INTO media(folder_id,path,dir,name,ext,kind,size,mtime,taken) VALUES(1,'/p/9.jpg','/p','x','jpg',0,1,1,9)", []).unwrap();
        face(&c, 9, &near(0, 30));
        assign(&c).unwrap();
        assert_eq!(list(&c).unwrap()[0].count, 5);
        // naming and merging stick
        let (a, b) = (people[0].id, people[1].id);
        rename(&c, b, "Asha").unwrap();
        merge(&c, b, a).unwrap();
        let after = list(&c).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].name.as_deref(), Some("Asha"));
        assert_eq!(items(&c, a).unwrap().len(), 8);
        remove_media(&c, a, &[9]).unwrap();
        assign(&c).unwrap();
        assert_eq!(items(&c, a).unwrap().len(), 7, "a removed photo is not regrouped");
    }
}
