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
  id        INTEGER PRIMARY KEY,
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
  id         INTEGER PRIMARY KEY,
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

/// Every visible item, newest first, packed as fixed 24-byte records so 100k items cross IPC as ~2.4 MB.
/// Layout: "SIT1" u32 count, then per item: id u32, ver u32, taken f64, w u16, h u16, kind u8, fav u8, dur u16.
pub fn library_bytes(c: &Connection) -> rusqlite::Result<Vec<u8>> {
    let mut st = c.prepare_cached(
        "SELECT id, mtime, taken, width, height, kind, favorite, duration FROM media
         WHERE trashed=0 ORDER BY taken DESC, id DESC",
    )?;
    let mut out = Vec::with_capacity(8 + 24 * 1024);
    out.extend_from_slice(b"SIT1");
    out.extend_from_slice(&0u32.to_le_bytes());
    let mut n: u32 = 0;
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let id: i64 = r.get(0)?;
        let mtime: i64 = r.get(1)?;
        let taken: i64 = r.get(2)?;
        let (mut w, mut h): (i64, i64) = (r.get(3)?, r.get(4)?);
        let kind: i64 = r.get(5)?;
        let fav: i64 = r.get(6)?;
        let dur: Option<f64> = r.get(7)?;
        // keep the aspect ratio when a panorama overflows u16
        let m = w.max(h);
        if m > 65535 {
            w = w * 65535 / m;
            h = h * 65535 / m;
        }
        out.extend_from_slice(&(id as u32).to_le_bytes());
        out.extend_from_slice(&((mtime / 1000) as u32).to_le_bytes());
        out.extend_from_slice(&(taken as f64).to_le_bytes());
        out.extend_from_slice(&(w as u16).to_le_bytes());
        out.extend_from_slice(&(h as u16).to_le_bytes());
        out.push(kind as u8);
        out.push(fav as u8);
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
}

pub fn detail(c: &Connection, id: i64) -> rusqlite::Result<Option<MediaDetail>> {
    c.query_row(
        "SELECT m.id, m.path, m.dir, m.name, m.ext, m.kind, m.size, m.mtime, m.width, m.height, m.taken,
                m.duration, m.make, m.model, m.lens, m.fnumber, m.exposure, m.iso, m.focal, m.lat, m.lon,
                m.favorite, f.path
         FROM media m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?1",
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
            })
        },
    )
    .optional()
}

/// Source info needed to render a thumbnail or preview.
pub fn source(c: &Connection, id: i64) -> rusqlite::Result<Option<(String, String, i64)>> {
    c.query_row("SELECT path, ext, kind FROM media WHERE id=?1", [id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
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
         FROM folders f LEFT JOIN media m ON m.folder_id=f.id AND m.trashed=0
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

pub fn albums(c: &Connection) -> rusqlite::Result<Albums> {
    let mut manual: Vec<AlbumInfo> = {
        let mut st = c.prepare(
            "SELECT a.id, a.name, a.updated_at, COUNT(m.id)
             FROM albums a LEFT JOIN album_items ai ON ai.album_id=a.id
             LEFT JOIN media m ON m.id=ai.media_id AND m.trashed=0
             GROUP BY a.id ORDER BY a.updated_at DESC",
        )?;
        let rows = st.query_map([], |r| {
            Ok(AlbumInfo { id: r.get(0)?, name: r.get(1)?, updated_at: r.get(2)?, count: r.get(3)?, covers: vec![] })
        })?;
        rows.collect::<Result<_, _>>()?
    };
    {
        let mut st = c.prepare(
            "SELECT album_id, media_id FROM (
               SELECT ai.album_id, ai.media_id,
                      ROW_NUMBER() OVER (PARTITION BY ai.album_id ORDER BY m.kind, m.taken DESC) rn
               FROM album_items ai JOIN media m ON m.id=ai.media_id AND m.trashed=0)
             WHERE rn<=3",
        )?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let (a, m): (i64, i64) = (r.get(0)?, r.get(1)?);
            if let Some(al) = manual.iter_mut().find(|x| x.id == a) {
                al.covers.push(m);
            }
        }
    }
    let mut folders: Vec<DirAlbum> = {
        let mut st = c.prepare(
            "SELECT dir, COUNT(*), MAX(taken) FROM media WHERE trashed=0 GROUP BY dir ORDER BY MAX(taken) DESC",
        )?;
        let rows = st.query_map([], |r| {
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
               FROM media WHERE trashed=0)
             WHERE rn<=3",
        )?;
        let mut idx = std::collections::HashMap::new();
        for (i, f) in folders.iter().enumerate() {
            idx.insert(f.dir.clone(), i);
        }
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let (d, m): (String, i64) = (r.get(0)?, r.get(1)?);
            if let Some(&i) = idx.get(&d) {
                folders[i].covers.push(m);
            }
        }
    }
    Ok(Albums { manual, folders })
}

pub fn ids(c: &Connection, sql: &str, p: impl rusqlite::Params) -> rusqlite::Result<Vec<i64>> {
    let mut st = c.prepare(sql)?;
    let rows = st.query_map(p, |r| r.get(0))?;
    rows.collect()
}

pub fn album_items(c: &Connection, album: i64) -> rusqlite::Result<Vec<i64>> {
    ids(
        c,
        "SELECT m.id FROM album_items ai JOIN media m ON m.id=ai.media_id
         WHERE ai.album_id=?1 AND m.trashed=0 ORDER BY m.taken DESC, m.id DESC",
        [album],
    )
}

pub fn dir_items(c: &Connection, dir: &str) -> rusqlite::Result<Vec<i64>> {
    ids(c, "SELECT id FROM media WHERE dir=?1 AND trashed=0 ORDER BY taken DESC, id DESC", [dir])
}

pub fn album_add(c: &mut Connection, album: i64, items: &[i64]) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    let now = now_ms();
    {
        let mut st = tx.prepare("INSERT OR IGNORE INTO album_items(album_id, media_id, added_at) VALUES(?1,?2,?3)")?;
        for &m in items {
            st.execute(params![album, m, now])?;
        }
    }
    tx.execute("UPDATE albums SET updated_at=?2 WHERE id=?1", params![album, now])?;
    tx.commit()
}

/// Free-text search over names, folders, cameras and dates ("2024", "march", "videos", "favorites", "fujifilm").
pub fn search(c: &Connection, q: &str) -> rusqlite::Result<Vec<i64>> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let mut clauses: Vec<String> = vec!["trashed=0".into()];
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
