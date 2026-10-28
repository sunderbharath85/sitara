//! SQLite library: schema, migrations and the queries shared by commands and the indexer.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

pub const PHOTO: i64 = 0;
pub const VIDEO: i64 = 1;

const SCHEMA_V1: &str = r#"
CREATE TABLE folders(
  id        INTEGER PRIMARY KEY,
  path      TEXT NOT NULL UNIQUE,
  added_at  INTEGER NOT NULL,
  last_scan INTEGER
);
CREATE TABLE media(
  id        INTEGER PRIMARY KEY AUTOINCREMENT, -- ids key the thumbnail cache, never reuse them
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  path      TEXT NOT NULL UNIQUE,
  dir       TEXT NOT NULL,
  name      TEXT NOT NULL,
  ext       TEXT NOT NULL,
  kind      INTEGER NOT NULL,            -- 0 photo, 1 video
  size      INTEGER NOT NULL,
  mtime     INTEGER NOT NULL,            -- unix ms
  width     INTEGER NOT NULL DEFAULT 0,
  height    INTEGER NOT NULL DEFAULT 0,
  taken     INTEGER NOT NULL,            -- wall-clock capture time, seconds, stored as if UTC
  duration  REAL,
  make TEXT, model TEXT, lens TEXT,
  fnumber REAL, exposure TEXT, iso INTEGER, focal REAL,
  lat REAL, lon REAL,
  favorite  INTEGER NOT NULL DEFAULT 0,
  thumb     INTEGER NOT NULL DEFAULT 0,  -- 0 pending, 1 cached, 2 failed
  trashed   INTEGER NOT NULL DEFAULT 0   -- moved to Recycle Bin this session (kept for undo)
);
CREATE INDEX media_taken  ON media(taken DESC, id DESC);
CREATE INDEX media_dir    ON media(dir);
CREATE INDEX media_folder ON media(folder_id);
CREATE INDEX media_thumb  ON media(thumb) WHERE thumb = 0;
CREATE TABLE albums(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE album_items(
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY(album_id, media_id)
);
"#;

/// v2: signals for smart albums and cleanup.
const SCHEMA_V2: &str = r#"
ALTER TABLE media ADD COLUMN chash TEXT;       -- blake3 of the file, computed only for same-size candidates
CREATE TABLE analysis(
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  dhash    INTEGER NOT NULL,                  -- 64-bit difference hash of the thumbnail
  sharp    REAL NOT NULL,                     -- variance of Laplacian; -1 when the thumbnail couldn't be read
  luma     REAL NOT NULL,
  contrast REAL NOT NULL,
  clip     REAL NOT NULL
);
"#;

/// v3: non-destructive edits. `stack` is the editor's JSON; width/height are the edited (cropped) size;
/// `rev` is the save time in ms, mixed into the thumbnail URL version so every save busts caches.
const SCHEMA_V3: &str = r#"
CREATE TABLE edits(
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  stack    TEXT NOT NULL,
  width    INTEGER NOT NULL,
  height   INTEGER NOT NULL,
  rev      INTEGER NOT NULL
);
"#;

/// v4: on-device AI. `ai_done` remembers which passes have seen a photo; CLIP vectors are int8;
/// face vectors are f32 with boxes normalized to the upright photo.
const SCHEMA_V4: &str = r#"
CREATE TABLE ai_done(
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  clip     INTEGER NOT NULL DEFAULT 0,
  faces    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE clip(
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  vec      BLOB NOT NULL
);
CREATE TABLE people(
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT,
  hidden  INTEGER NOT NULL DEFAULT 0,
  cover   INTEGER,
  created INTEGER NOT NULL
);
CREATE TABLE faces(
  id        INTEGER PRIMARY KEY AUTOINCREMENT, -- keys the face-crop cache
  media_id  INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  score     REAL NOT NULL,
  vec       BLOB NOT NULL,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  blocked   INTEGER NOT NULL DEFAULT 0          -- the user said "not this person"
);
CREATE INDEX faces_media  ON faces(media_id);
CREATE INDEX faces_person ON faces(person_id);
"#;

/// v5: Private. `media.private` is derived from `private_dirs` (a folder and everything under it) by the indexer;
/// `excluded_dirs` are left out of the library after a Private reset; `private_vault` is `private.rs`'s key store.
const SCHEMA_V5: &str = r#"
ALTER TABLE media  ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE albums ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
CREATE INDEX media_private ON media(private) WHERE private=1;
CREATE TABLE private_dirs(
  path     TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL
);
CREATE TABLE excluded_dirs(
  path TEXT PRIMARY KEY
);
CREATE TABLE private_vault(
  id               INTEGER PRIMARY KEY CHECK(id=1),
  pk               BLOB NOT NULL,              -- X25519 public key; renders of private items are sealed to it
  kdf              TEXT NOT NULL,              -- password key derivation and its settings
  salt             BLOB NOT NULL,
  by_password      BLOB NOT NULL,              -- the secret key, wrapped under the password
  by_recovery      BLOB NOT NULL,              -- the secret key, wrapped under the recovery key
  idle_secs        INTEGER NOT NULL DEFAULT 300,
  lock_on_minimize INTEGER NOT NULL DEFAULT 0,
  fails            INTEGER NOT NULL DEFAULT 0, -- wrong tries in a row
  wait_until       INTEGER NOT NULL DEFAULT 0  -- unix ms; tries are refused until then
);
"#;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    c.busy_timeout(Duration::from_secs(15))?;
    c.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
    c.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;")?;
    Ok(c)
}

pub fn migrate(c: &Connection) -> rusqlite::Result<()> {
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 {
        c.execute_batch(&format!("BEGIN; {SCHEMA_V1} PRAGMA user_version=1; COMMIT;"))?;
    }
    if v < 2 {
        c.execute_batch(&format!("BEGIN; {SCHEMA_V2} PRAGMA user_version=2; COMMIT;"))?;
    }
    if v < 3 {
        c.execute_batch(&format!("BEGIN; {SCHEMA_V3} PRAGMA user_version=3; COMMIT;"))?;
    }
    if v < 4 {
        c.execute_batch(&format!("BEGIN; {SCHEMA_V4} PRAGMA user_version=4; COMMIT;"))?;
    }
    if v < 5 {
        c.execute_batch(&format!("BEGIN; {SCHEMA_V5} PRAGMA user_version=5; COMMIT;"))?;
    }
    // the undo window for Recycle Bin moves is one session
    c.execute("DELETE FROM media WHERE trashed=1", [])?;
    Ok(())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Cache-busting version for an item's renders: file mtime, plus the edit revision when edited.
pub fn version(mtime_ms: i64, rev: i64) -> u32 {
    ((mtime_ms / 1000) as u32).wrapping_add((rev as u32).wrapping_mul(0x9E37_79B1))
}

/// Every visible item of the main library (or of Private), newest first, packed as fixed 24-byte records so 100k items cross IPC as ~2.4 MB.
/// Layout: "SIT1" u32 count, then per item: id u32, ver u32, taken f64, w u16, h u16, kind u8,
/// flags u8 (bit 0 favorite, bit 1 edited), dur u16. Edited items report their cropped size.
pub fn library_bytes(c: &Connection, private: bool) -> rusqlite::Result<Vec<u8>> {
    let mut st = c.prepare_cached(
        "SELECT m.id, m.mtime, m.taken, COALESCE(e.width, m.width), COALESCE(e.height, m.height), m.kind, m.favorite,
                m.duration, COALESCE(e.rev, 0)
         FROM media m LEFT JOIN edits e ON e.media_id=m.id
         WHERE m.trashed=0 AND m.private=?1 ORDER BY m.taken DESC, m.id DESC",
    )?;
    let mut out = Vec::with_capacity(8 + 24 * 1024);
    out.extend_from_slice(b"SIT1");
    out.extend_from_slice(&0u32.to_le_bytes());
    let mut n: u32 = 0;
    let mut rows = st.query([private])?;
    while let Some(r) = rows.next()? {
        let id: i64 = r.get(0)?;
        let mtime: i64 = r.get(1)?;
        let taken: i64 = r.get(2)?;
        let (mut w, mut h): (i64, i64) = (r.get(3)?, r.get(4)?);
        let kind: i64 = r.get(5)?;
        let fav: i64 = r.get(6)?;
        let dur: Option<f64> = r.get(7)?;
        let rev: i64 = r.get(8)?;
        // keep the aspect ratio when a panorama overflows u16
        let m = w.max(h);
        if m > 65535 {
            w = w * 65535 / m;
            h = h * 65535 / m;
        }
        out.extend_from_slice(&(id as u32).to_le_bytes());
        out.extend_from_slice(&version(mtime, rev).to_le_bytes());
        out.extend_from_slice(&(taken as f64).to_le_bytes());
        out.extend_from_slice(&(w as u16).to_le_bytes());
        out.extend_from_slice(&(h as u16).to_le_bytes());
        out.push(kind as u8);
        out.push(fav as u8 | if rev != 0 { 2 } else { 0 });
        out.extend_from_slice(&(dur.unwrap_or(0.0).round().clamp(0.0, 65535.0) as u16).to_le_bytes());
        n += 1;
    }
    out[4..8].copy_from_slice(&n.to_le_bytes());
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDetail {
    pub id: i64,
    pub path: String,
    pub dir: String,
    pub name: String,
    pub ext: String,
    pub kind: i64,
    pub size: i64,
    pub mtime: i64,
    pub width: i64,
    pub height: i64,
    pub taken: i64,
    pub duration: Option<f64>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub fnumber: Option<f64>,
    pub exposure: Option<String>,
    pub iso: Option<i64>,
    pub focal: Option<f64>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub favorite: bool,
    pub folder: String,
    /// Edit revision, 0 when the photo has no edits.
    pub edited: i64,
    pub private: bool,
}

pub fn detail(c: &Connection, id: i64) -> rusqlite::Result<Option<MediaDetail>> {
    c.query_row(
        "SELECT m.id, m.path, m.dir, m.name, m.ext, m.kind, m.size, m.mtime, m.width, m.height, m.taken,
                m.duration, m.make, m.model, m.lens, m.fnumber, m.exposure, m.iso, m.focal, m.lat, m.lon,
                m.favorite, f.path, COALESCE(e.rev, 0), m.private
         FROM media m JOIN folders f ON f.id = m.folder_id LEFT JOIN edits e ON e.media_id = m.id WHERE m.id = ?1",
        [id],
        |r| {
            Ok(MediaDetail {
                id: r.get(0)?,
                path: r.get(1)?,
                dir: r.get(2)?,
                name: r.get(3)?,
                ext: r.get(4)?,
                kind: r.get(5)?,
                size: r.get(6)?,
                mtime: r.get(7)?,
                width: r.get(8)?,
                height: r.get(9)?,
                taken: r.get(10)?,
                duration: r.get(11)?,
                make: r.get(12)?,
                model: r.get(13)?,
                lens: r.get(14)?,
                fnumber: r.get(15)?,
                exposure: r.get(16)?,
                iso: r.get(17)?,
                focal: r.get(18)?,
                lat: r.get(19)?,
                lon: r.get(20)?,
                favorite: r.get::<_, i64>(21)? != 0,
                folder: r.get(22)?,
                edited: r.get(23)?,
                private: r.get::<_, i64>(24)? != 0,
            })
        },
    )
    .optional()
}

/// What rendering a thumbnail or preview needs: path, extension, kind, and whether the item is private.
pub fn source(c: &Connection, id: i64) -> rusqlite::Result<Option<(String, String, i64, bool)>> {
    c.query_row("SELECT path, ext, kind, private FROM media WHERE id=?1", [id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0))
    })
    .optional()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub id: i64,
    pub path: String,
    pub count: i64,
    pub photos: i64,
    pub videos: i64,
    pub bytes: i64,
    pub last_scan: Option<i64>,
}

pub fn folders(c: &Connection) -> rusqlite::Result<Vec<FolderInfo>> {
    let mut st = c.prepare(
        "SELECT f.id, f.path, f.last_scan,
                COUNT(m.id), COALESCE(SUM(m.kind=0),0), COALESCE(SUM(m.kind=1),0), COALESCE(SUM(m.size),0)
         FROM folders f LEFT JOIN media m ON m.folder_id=f.id AND m.trashed=0 AND m.private=0
         WHERE f.path NOT IN (SELECT path FROM private_dirs)
         GROUP BY f.id ORDER BY f.path COLLATE NOCASE",
    )?;
    let rows = st.query_map([], |r| {
        Ok(FolderInfo {
            id: r.get(0)?,
            path: r.get(1)?,
            last_scan: r.get(2)?,
            count: r.get(3)?,
            photos: r.get(4)?,
            videos: r.get(5)?,
            bytes: r.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn folder_roots(c: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut st = c.prepare("SELECT id, path FROM folders")?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumInfo {
    pub id: i64,
    pub name: String,
    pub count: i64,
    pub covers: Vec<i64>,
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirAlbum {
    pub dir: String,
    pub name: String,
    pub parent: String,
    pub count: i64,
    pub covers: Vec<i64>,
    pub latest: i64,
}

#[derive(Serialize)]
pub struct Albums {
    pub manual: Vec<AlbumInfo>,
    pub folders: Vec<DirAlbum>,
}

/// Manual albums and folders-as-albums, of the main library or of Private.
pub fn albums(c: &Connection, private: bool) -> rusqlite::Result<Albums> {
    let mut manual: Vec<AlbumInfo> = {
        let mut st = c.prepare(
            "SELECT a.id, a.name, a.updated_at, COUNT(m.id)
             FROM albums a LEFT JOIN album_items ai ON ai.album_id=a.id
             LEFT JOIN media m ON m.id=ai.media_id AND m.trashed=0 AND m.private=a.private
             WHERE a.private=?1
             GROUP BY a.id ORDER BY a.updated_at DESC",
        )?;
        let rows = st.query_map([private], |r| {
            Ok(AlbumInfo { id: r.get(0)?, name: r.get(1)?, updated_at: r.get(2)?, count: r.get(3)?, covers: vec![] })
        })?;
        rows.collect::<Result<_, _>>()?
    };
    {
        let mut st = c.prepare(
            "SELECT album_id, media_id FROM (
               SELECT ai.album_id, ai.media_id,
                      ROW_NUMBER() OVER (PARTITION BY ai.album_id ORDER BY m.kind, m.taken DESC) rn
               FROM album_items ai JOIN albums a ON a.id=ai.album_id
               JOIN media m ON m.id=ai.media_id AND m.trashed=0 AND m.private=a.private
               WHERE a.private=?1)
             WHERE rn<=3",
        )?;
        let mut rows = st.query([private])?;
        while let Some(r) = rows.next()? {
            let (a, m): (i64, i64) = (r.get(0)?, r.get(1)?);
            if let Some(al) = manual.iter_mut().find(|x| x.id == a) {
                al.covers.push(m);
            }
        }
    }
    let mut folders: Vec<DirAlbum> = {
        let mut st = c.prepare(
            "SELECT dir, COUNT(*), MAX(taken) FROM media WHERE trashed=0 AND private=?1 GROUP BY dir ORDER BY MAX(taken) DESC",
        )?;
        let rows = st.query_map([private], |r| {
            let dir: String = r.get(0)?;
            let p = Path::new(&dir);
            Ok(DirAlbum {
                name: p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| dir.clone()),
                parent: p.parent().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                dir,
                count: r.get(1)?,
                latest: r.get(2)?,
                covers: vec![],
            })
        })?;
        rows.collect::<Result<_, _>>()?
    };
    {
        let mut st = c.prepare(
            "SELECT dir, id FROM (
               SELECT dir, id, ROW_NUMBER() OVER (PARTITION BY dir ORDER BY kind, taken DESC) rn
               FROM media WHERE trashed=0 AND private=?1)
             WHERE rn<=3",
        )?;
        let mut idx = std::collections::HashMap::new();
        for (i, f) in folders.iter().enumerate() {
            idx.insert(f.dir.clone(), i);
        }
        let mut rows = st.query([private])?;
        while let Some(r) = rows.next()? {
            let (d, m): (String, i64) = (r.get(0)?, r.get(1)?);
            if let Some(&i) = idx.get(&d) {
                folders[i].covers.push(m);
            }
        }
    }
    Ok(Albums { manual, folders })
}

pub fn edit_get(c: &Connection, id: i64) -> rusqlite::Result<Option<String>> {
    c.query_row("SELECT stack FROM edits WHERE media_id=?1", [id], |r| r.get(0)).optional()
}

/// Store an edit stack; returns its revision. Revisions are the save time and always move forward.
pub fn edit_put(c: &Connection, id: i64, stack: &str, w: i64, h: i64) -> rusqlite::Result<i64> {
    let prev: i64 = c.query_row("SELECT COALESCE(MAX(rev), 0) FROM edits WHERE media_id=?1", [id], |r| r.get(0))?;
    let rev = now_ms().max(prev + 1);
    c.execute(
        "INSERT INTO edits(media_id, stack, width, height, rev) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(media_id) DO UPDATE SET stack=excluded.stack, width=excluded.width, height=excluded.height, rev=excluded.rev",
        params![id, stack, w, h, rev],
    )?;
    Ok(rev)
}

pub fn edit_delete(c: &Connection, id: i64) -> rusqlite::Result<bool> {
    Ok(c.execute("DELETE FROM edits WHERE media_id=?1", [id])? > 0)
}

pub fn ids(c: &Connection, sql: &str, p: impl rusqlite::Params) -> rusqlite::Result<Vec<i64>> {
    let mut st = c.prepare(sql)?;
    let rows = st.query_map(p, |r| r.get(0))?;
    rows.collect()
}

/// An album only ever lists items on its own side of Private.
pub fn album_items(c: &Connection, album: i64) -> rusqlite::Result<Vec<i64>> {
    ids(
        c,
        "SELECT m.id FROM album_items ai JOIN albums a ON a.id=ai.album_id
         JOIN media m ON m.id=ai.media_id AND m.private=a.private
         WHERE ai.album_id=?1 AND m.trashed=0 ORDER BY m.taken DESC, m.id DESC",
        [album],
    )
}

pub fn album_private(c: &Connection, album: i64) -> rusqlite::Result<Option<bool>> {
    c.query_row("SELECT private FROM albums WHERE id=?1", [album], |r| Ok(r.get::<_, i64>(0)? != 0)).optional()
}

pub fn dir_items(c: &Connection, dir: &str, with_private: bool) -> rusqlite::Result<Vec<i64>> {
    ids(
        c,
        "SELECT id FROM media WHERE dir=?1 AND trashed=0 AND (private=0 OR ?2) ORDER BY taken DESC, id DESC",
        params![dir, with_private],
    )
}

pub fn album_add(c: &mut Connection, album: i64, items: &[i64]) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    let now = now_ms();
    {
        // private items only go into private albums, and the other way round
        let mut st = tx.prepare(
            "INSERT OR IGNORE INTO album_items(album_id, media_id, added_at)
             SELECT a.id, m.id, ?3 FROM albums a JOIN media m ON m.id=?2 AND m.private=a.private WHERE a.id=?1",
        )?;
        for &m in items {
            st.execute(params![album, m, now])?;
        }
    }
    tx.execute("UPDATE albums SET updated_at=?2 WHERE id=?1", params![album, now])?;
    tx.commit()
}

/// Free-text search over names, folders, cameras and dates ("2024", "march", "videos", "favorites", "fujifilm").
pub fn search(c: &Connection, q: &str, private: bool) -> rusqlite::Result<Vec<i64>> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let mut clauses: Vec<String> = vec!["trashed=0".into(), format!("private={}", private as i64)];
    let mut args: Vec<rusqlite::types::Value> = vec![];
    for raw in q.split_whitespace() {
        let t = raw.trim_matches(|c: char| c == '"' || c == ',' || c == '“' || c == '”').to_lowercase();
        if t.is_empty() {
            continue;
        }
        match t.as_str() {
            "video" | "videos" | "clips" => {
                clauses.push(format!("kind={VIDEO}"));
                continue;
            }
            "photo" | "photos" | "pictures" => {
                clauses.push(format!("kind={PHOTO}"));
                continue;
            }
            "favorite" | "favorites" | "favourites" | "loved" => {
                clauses.push("favorite=1".into());
                continue;
            }
            _ => {}
        }
        if t.len() == 4 && t.chars().all(|c| c.is_ascii_digit()) {
            args.push(t.clone().into());
            clauses.push(format!("strftime('%Y', taken, 'unixepoch')=?{}", args.len()));
            continue;
        }
        if t.len() >= 3 {
            if let Some(m) = MONTHS.iter().position(|m| t.starts_with(m) && "january february march april may june july august september october november december".contains(&t)) {
                args.push(format!("{:02}", m + 1).into());
                clauses.push(format!("strftime('%m', taken, 'unixepoch')=?{}", args.len()));
                continue;
            }
        }
        args.push(format!("%{}%", t.replace('%', "\\%").replace('_', "\\_")).into());
        let n = args.len();
        clauses.push(format!(
            "(lower(path) LIKE ?{n} ESCAPE '\\' OR lower(COALESCE(make,'')||' '||COALESCE(model,'')||' '||COALESCE(lens,'')) LIKE ?{n} ESCAPE '\\')"
        ));
    }
    let sql = format!(
        "SELECT id FROM media WHERE {} ORDER BY taken DESC, id DESC LIMIT 20000",
        clauses.join(" AND ")
    );
    ids(c, &sql, rusqlite::params_from_iter(args))
}

// ---------- Private ----------

pub fn private_dirs(c: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut st = c.prepare("SELECT path FROM private_dirs")?;
    let rows = st.query_map([], |r| r.get(0))?;
    rows.collect()
}

pub fn excluded_dirs(c: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut st = c.prepare("SELECT path FROM excluded_dirs")?;
    let rows = st.query_map([], |r| r.get(0))?;
    rows.collect()
}

/// Whether `path` is one of `dirs` or inside one.
pub fn under_any(dirs: &[String], path: &str) -> bool {
    dirs.iter().any(|d| Path::new(path).starts_with(d))
}

/// Re-derive `media.private` from `private_dirs`. Returns the items that changed, with their new value.
pub fn refresh_private(c: &Connection) -> rusqlite::Result<Vec<(i64, bool)>> {
    let dirs = private_dirs(c)?;
    let mut changed = vec![];
    {
        let mut st = c.prepare("SELECT id, dir, private FROM media")?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let (id, dir, was): (i64, String, i64) = (r.get(0)?, r.get(1)?, r.get(2)?);
            let now = under_any(&dirs, &dir);
            if now != (was != 0) {
                changed.push((id, now));
            }
        }
    }
    let mut st = c.prepare("UPDATE media SET private=?2 WHERE id=?1")?;
    for (id, p) in &changed {
        st.execute(params![id, p])?;
    }
    Ok(changed)
}

/// Drop what on-device AI and analysis learned from private items, so search, people, smart albums and cleanup
/// know nothing about them. Returns the face ids removed (their portrait crops are cached by id).
pub fn purge_private_ai(c: &Connection) -> rusqlite::Result<Vec<i64>> {
    const OF_PRIVATE: &str = "media_id IN (SELECT id FROM media WHERE private=1)";
    let faces = ids(c, &format!("SELECT id FROM faces WHERE {OF_PRIVATE}"), [])?;
    // people stay (with their names), so someone who only appears in private photos is simply not listed
    for t in ["faces", "clip", "ai_done", "analysis"] {
        c.execute(&format!("DELETE FROM {t} WHERE {OF_PRIVATE}"), [])?;
    }
    Ok(faces)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrivateDir {
    pub path: String,
    pub name: String,
    pub count: i64,
    pub photos: i64,
    pub videos: i64,
    pub bytes: i64,
    /// A library folder of its own, rather than a folder inside one.
    pub root: bool,
}

pub fn private_dir_infos(c: &Connection) -> rusqlite::Result<Vec<PrivateDir>> {
    let roots: Vec<String> = folder_roots(c)?.into_iter().map(|r| r.1).collect();
    let mut out: Vec<PrivateDir> = private_dirs(c)?
        .into_iter()
        .map(|d| PrivateDir {
            name: Path::new(&d).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| d.clone()),
            root: roots.contains(&d),
            path: d,
            count: 0,
            photos: 0,
            videos: 0,
            bytes: 0,
        })
        .collect();
    let mut st = c.prepare("SELECT dir, kind, size FROM media WHERE private=1 AND trashed=0")?;
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let (dir, kind, size): (String, i64, i64) = (r.get(0)?, r.get(1)?, r.get(2)?);
        if let Some(d) = out.iter_mut().find(|d| Path::new(&dir).starts_with(&d.path)) {
            d.count += 1;
            d.photos += (kind == PHOTO) as i64;
            d.videos += (kind == VIDEO) as i64;
            d.bytes += size;
        }
    }
    out.sort_by_key(|d| d.name.to_lowercase());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        migrate(&c).unwrap();
        c.execute("INSERT INTO folders(path, added_at) VALUES('/pics', 0)", []).unwrap();
        let rows = [
            ("/pics/2024 Kyoto/IMG_1.jpg", 0, 1_717_200_000i64, 6000, 4000, None, Some("FUJIFILM")),
            ("/pics/2024 Kyoto/VID_2.mp4", 1, 1_717_300_000, 1920, 1080, Some(12.4), None),
            ("/pics/Camera/IMG_3.jpg", 0, 1_640_000_000, 120000, 3000, None, Some("Apple")),
        ];
        for (p, kind, taken, w, h, dur, make) in rows {
            let path = std::path::Path::new(p);
            c.execute(
                "INSERT INTO media(folder_id,path,dir,name,ext,kind,size,mtime,width,height,taken,duration,make)
                 VALUES(1,?1,?2,?3,'jpg',?4,10,1000,?5,?6,?7,?8,?9)",
                params![p, path.parent().unwrap().to_str(), path.file_name().unwrap().to_str(), kind, w, h, taken, dur, make],
            )
            .unwrap();
        }
        c
    }

    #[test]
    fn library_is_packed_newest_first() {
        let c = lib();
        let b = library_bytes(&c, false).unwrap();
        assert_eq!(&b[0..4], b"SIT1");
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 3);
        assert_eq!(b.len(), 8 + 3 * 24);
        let rec = |i: usize| &b[8 + i * 24..8 + (i + 1) * 24];
        // newest first: the video (taken 1_717_300_000) leads
        assert_eq!(f64::from_le_bytes(rec(0)[8..16].try_into().unwrap()), 1_717_300_000.0);
        assert_eq!(rec(0)[20], 1, "kind = video");
        assert_eq!(u16::from_le_bytes(rec(0)[22..24].try_into().unwrap()), 12, "duration rounded");
        // a 120000x3000 panorama is scaled into u16 range keeping its ratio
        let (w, h) = (u16::from_le_bytes(rec(2)[16..18].try_into().unwrap()), u16::from_le_bytes(rec(2)[18..20].try_into().unwrap()));
        assert_eq!(w, 65535);
        assert!((w as f64 / h as f64 - 40.0).abs() < 0.1);
    }

    #[test]
    fn search_understands_kinds_years_and_text() {
        let c = lib();
        assert_eq!(search(&c, "videos", false).unwrap().len(), 1);
        assert_eq!(search(&c, "2024", false).unwrap().len(), 2);
        assert_eq!(search(&c, "kyoto photos", false).unwrap().len(), 1);
        assert_eq!(search(&c, "fujifilm", false).unwrap().len(), 1);
        assert_eq!(search(&c, "100%_", false).unwrap().len(), 0, "LIKE wildcards are escaped");
        assert_eq!(search(&c, "december", false).unwrap().len(), 1, "1_640_000_000 is Dec 2021");
    }

    #[test]
    fn edits_override_size_flag_items_and_bump_versions() {
        let c = lib();
        let rec = |b: &[u8], i: usize| b[8 + i * 24..8 + (i + 1) * 24].to_vec();
        let before = rec(&library_bytes(&c, false).unwrap(), 1); // IMG_1, 6000x4000
        let id = u32::from_le_bytes(before[0..4].try_into().unwrap()) as i64;
        assert_eq!(before[21], 0);
        let r1 = edit_put(&c, id, r#"{"v":1}"#, 3000, 3000).unwrap();
        let after = rec(&library_bytes(&c, false).unwrap(), 1);
        assert_eq!(after[21], 2, "edited flag, not favorite");
        assert_eq!(u16::from_le_bytes(after[16..18].try_into().unwrap()), 3000, "cropped width");
        assert_ne!(before[4..8], after[4..8], "version changes so cached thumbnails refresh");
        let r2 = edit_put(&c, id, r#"{"v":1,"x":1}"#, 3000, 3000).unwrap();
        assert!(r2 > r1);
        assert_eq!(edit_get(&c, id).unwrap().as_deref(), Some(r#"{"v":1,"x":1}"#));
        assert_eq!(detail(&c, id).unwrap().unwrap().edited, r2);
        assert!(edit_delete(&c, id).unwrap());
        assert_eq!(rec(&library_bytes(&c, false).unwrap(), 1), before, "revert restores the original record");
    }

    #[test]
    fn private_dirs_hide_items_everywhere_but_private() {
        let mut c = lib();
        c.execute("INSERT INTO private_dirs(path, added_at) VALUES('/pics/2024 Kyoto', 0)", []).unwrap();
        let changed = refresh_private(&c).unwrap();
        assert_eq!(changed.len(), 2);
        assert!(changed.iter().all(|x| x.1));
        assert!(refresh_private(&c).unwrap().is_empty(), "nothing changes twice");
        let count = |b: Vec<u8>| u32::from_le_bytes(b[4..8].try_into().unwrap());
        assert_eq!(count(library_bytes(&c, false).unwrap()), 1);
        assert_eq!(count(library_bytes(&c, true).unwrap()), 2);
        assert!(search(&c, "kyoto", false).unwrap().is_empty());
        assert_eq!(search(&c, "kyoto", true).unwrap().len(), 2);
        assert_eq!(albums(&c, false).unwrap().folders.len(), 1, "only /pics/Camera");
        assert_eq!(albums(&c, true).unwrap().folders[0].count, 2);
        assert_eq!(folders(&c).unwrap()[0].count, 1, "folder totals leave private items out");
        assert!(dir_items(&c, "/pics/2024 Kyoto", false).unwrap().is_empty());
        assert_eq!(dir_items(&c, "/pics/2024 Kyoto", true).unwrap().len(), 2);

        // albums stay on their own side
        c.execute("INSERT INTO albums(name, created_at, updated_at, private) VALUES('pub', 0, 0, 0), ('priv', 0, 0, 1)", []).unwrap();
        let all: Vec<i64> = ids(&c, "SELECT id FROM media", []).unwrap();
        album_add(&mut c, 1, &all).unwrap();
        album_add(&mut c, 2, &all).unwrap();
        assert_eq!(album_items(&c, 1).unwrap().len(), 1);
        assert_eq!(album_items(&c, 2).unwrap().len(), 2);
        assert_eq!(albums(&c, false).unwrap().manual.len(), 1);
        assert_eq!(albums(&c, true).unwrap().manual[0].count, 2);

        // what AI learned from private items is dropped
        for id in &all {
            c.execute("INSERT INTO clip(media_id, vec) VALUES(?1, x'00')", [id]).unwrap();
        }
        purge_private_ai(&c).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM clip", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);

        // the root itself private hides its folder row; un-marking brings everything back
        c.execute("INSERT INTO private_dirs(path, added_at) VALUES('/pics', 0)", []).unwrap();
        refresh_private(&c).unwrap();
        assert!(folders(&c).unwrap().is_empty());
        assert_eq!(private_dir_infos(&c).unwrap().iter().map(|d| d.count).sum::<i64>(), 3, "each item counted once");
        c.execute("DELETE FROM private_dirs", []).unwrap();
        assert_eq!(refresh_private(&c).unwrap().len(), 3);
        assert_eq!(count(library_bytes(&c, false).unwrap()), 3);
    }

    #[test]
    fn trashed_rows_are_hidden_then_purged() {
        let c = lib();
        c.execute("UPDATE media SET trashed=1 WHERE kind=1", []).unwrap();
        assert_eq!(u32::from_le_bytes(library_bytes(&c, false).unwrap()[4..8].try_into().unwrap()), 2);
        migrate(&c).unwrap(); // next session
        let n: i64 = c.query_row("SELECT COUNT(*) FROM media", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }
}
