//! Background indexer: folder scans, watcher updates and thumbnail pre-generation.
//! One thread owns indexing writes; a second, lower-throughput pool warms the thumbnail cache.

use crate::{analysis, db, meta, thumbs};
use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

pub enum Job {
    Scan(i64),
    ScanAll,
    Paths(Vec<PathBuf>),
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub scanning: bool,
    pub folder: Option<String>,
    pub found: u64,
    pub indexed: u64,
    pub warming: bool,
    pub thumbs_pending: u64,
    pub thumbs_done: u64,
    pub analyzing: bool,
    pub analysis_pending: u64,
    pub learning: bool,
    pub learn_pending: u64,
}

pub struct Indexer {
    pub tx: Sender<Job>,
    pub status: Arc<Mutex<Status>>,
    /// Nudge the warmer (thumbnails, analysis, AI) to look for work.
    pub wake: Sender<()>,
}

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    cache: PathBuf,
    status: Arc<Mutex<Status>>,
    last_status: Arc<Mutex<Instant>>,
    last_change: Arc<Mutex<Instant>>,
}

impl Ctx {
    fn update(&self, force: bool, f: impl FnOnce(&mut Status)) {
        let snap = {
            let mut s = self.status.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        let mut last = self.last_status.lock().unwrap();
        if force || last.elapsed() > Duration::from_millis(150) {
            *last = Instant::now();
            let _ = self.app.emit("index-status", snap);
        }
    }
    /// Tell the UI to refetch the library; throttled so a big scan fills the grid progressively.
    fn changed(&self, force: bool) {
        let mut last = self.last_change.lock().unwrap();
        if force || last.elapsed() > Duration::from_millis(900) {
            *last = Instant::now();
            let _ = self.app.emit("library-changed", ());
        }
    }
}

pub fn start(app: AppHandle, db_path: PathBuf, cache: PathBuf) -> Indexer {
    let (tx, rx) = mpsc::channel::<Job>();
    let (wtx, wrx) = mpsc::channel::<()>();
    let status = Arc::new(Mutex::new(Status::default()));
    let long_ago = Instant::now() - Duration::from_secs(60);
    let ctx = Ctx {
        app,
        cache,
        status: status.clone(),
        last_status: Arc::new(Mutex::new(long_ago)),
        last_change: Arc::new(Mutex::new(long_ago)),
    };
    let wake = wtx.clone();
    {
        let (ctx, db_path) = (ctx.clone(), db_path.clone());
        std::thread::Builder::new()
            .name("indexer".into())
            .spawn(move || indexer_loop(ctx, db_path, rx, wtx))
            .expect("spawn indexer");
    }
    std::thread::Builder::new()
        .name("thumb-warmer".into())
        .spawn(move || warmer_loop(ctx, db_path, wrx))
        .expect("spawn warmer");
    Indexer { tx, status, wake }
}

fn indexer_loop(ctx: Ctx, db_path: PathBuf, rx: Receiver<Job>, warm: Sender<()>) {
    let mut conn = match db::open(&db_path) {
        Ok(c) => c,
        Err(e) => return eprintln!("indexer: cannot open db: {e}"),
    };
    let _ = warm.send(());
    while let Ok(first) = rx.recv() {
        // coalesce whatever queued up while we were busy
        let mut all = false;
        let mut folders: Vec<i64> = vec![];
        let mut paths: Vec<PathBuf> = vec![];
        for job in std::iter::once(first).chain(rx.try_iter()) {
            match job {
                Job::ScanAll => all = true,
                Job::Scan(id) => folders.push(id),
                Job::Paths(p) => paths.extend(p),
            }
        }
        if all {
            folders = db::folder_roots(&conn).map(|r| r.into_iter().map(|(id, _)| id).collect()).unwrap_or_default();
        }
        folders.sort_unstable();
        folders.dedup();
        if !folders.is_empty() {
            ctx.update(true, |s| {
                s.scanning = true;
                s.found = 0;
                s.indexed = 0;
            });
            for id in folders {
                let root: Option<String> =
                    conn.query_row("SELECT path FROM folders WHERE id=?1", [id], |r| r.get(0)).optional().ok().flatten();
                if let Some(root) = root {
                    if let Err(e) = scan_folder(&ctx, &mut conn, id, Path::new(&root)) {
                        eprintln!("scan {root}: {e}");
                    }
                }
            }
            ctx.update(true, |s| {
                s.scanning = false;
                s.folder = None;
            });
        }
        if !paths.is_empty() {
            paths.sort();
            paths.dedup();
            if let Err(e) = apply_paths(&ctx, &mut conn, paths) {
                eprintln!("watch update: {e}");
            }
        }
        ctx.changed(true);
        let _ = warm.send(());
    }
}

fn skip_dir(e: &walkdir::DirEntry) -> bool {
    if e.depth() == 0 || !e.file_type().is_dir() {
        return false;
    }
    let n = e.file_name().to_string_lossy();
    n.starts_with('.')
        || n.eq_ignore_ascii_case("$RECYCLE.BIN")
        || n.eq_ignore_ascii_case("System Volume Information")
        || n == "node_modules"
        || n == "@eaDir"
}

struct Found {
    folder: i64,
    path: PathBuf,
    kind: i64,
    ext: String,
    size: i64,
    mtime: i64,
    prev: Option<i64>,
}

fn mtime_ms(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Collect media files under `dir`, skipping ones whose size and mtime are unchanged.
fn collect(
    ctx: &Ctx,
    dir: &Path,
    folder: i64,
    known: &HashMap<String, (i64, i64, i64)>,
    seen: &mut HashSet<i64>,
    todo: &mut Vec<Found>,
    excluded: &[String],
) {
    let walk = WalkDir::new(dir).follow_links(false).into_iter();
    for entry in walk.filter_entry(|e| !skip_dir(e) && !excluded.iter().any(|x| e.path() == Path::new(x))).flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        let Some(ext) = meta::ext_of(p) else { continue };
        let Some(kind) = meta::kind_of(&ext) else { continue };
        let Ok(md) = entry.metadata() else { continue };
        let (size, mtime) = (md.len() as i64, mtime_ms(&md));
        ctx.update(false, |s| s.found += 1);
        let prev = known.get(p.to_string_lossy().as_ref()).copied();
        if let Some((id, s0, m0)) = prev {
            seen.insert(id);
            if s0 == size && m0 == mtime {
                continue;
            }
        }
        todo.push(Found { folder, path: p.to_path_buf(), kind, ext, size, mtime, prev: prev.map(|p| p.0) });
    }
}

/// Read metadata in parallel and write in batches; each batch is visible to the UI immediately.
fn ingest(ctx: &Ctx, conn: &mut Connection, todo: Vec<Found>) -> rusqlite::Result<()> {
    let private_dirs = db::private_dirs(conn)?;
    for chunk in todo.chunks(256) {
        let metas: Vec<meta::Meta> = chunk.par_iter().map(|f| meta::read(&f.path, f.kind, f.mtime)).collect();
        let tx = conn.transaction()?;
        {
            let mut st = tx.prepare_cached(
                "INSERT INTO media(folder_id,path,dir,name,ext,kind,size,mtime,width,height,taken,duration,
                                   make,model,lens,fnumber,exposure,iso,focal,lat,lon,private)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
                 ON CONFLICT(path) DO UPDATE SET folder_id=excluded.folder_id, dir=excluded.dir, name=excluded.name,
                   ext=excluded.ext, kind=excluded.kind, size=excluded.size, mtime=excluded.mtime,
                   width=excluded.width, height=excluded.height, taken=excluded.taken, duration=excluded.duration,
                   make=excluded.make, model=excluded.model, lens=excluded.lens, fnumber=excluded.fnumber,
                   exposure=excluded.exposure, iso=excluded.iso, focal=excluded.focal, lat=excluded.lat,
                   lon=excluded.lon, private=excluded.private, thumb=0, trashed=0, chash=NULL",
            )?;
            let mut stale = tx.prepare_cached("DELETE FROM analysis WHERE media_id=?1")?;
            let mut stale_ai = tx.prepare_cached("DELETE FROM ai_done WHERE media_id=?1")?;
            let mut stale_clip = tx.prepare_cached("DELETE FROM clip WHERE media_id=?1")?;
            let mut stale_faces = tx.prepare_cached("DELETE FROM faces WHERE media_id=?1")?;
            for (f, m) in chunk.iter().zip(&metas) {
                let dir = f.path.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
                let name = f.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                st.execute(params![
                    f.folder,
                    f.path.to_string_lossy(),
                    dir,
                    name,
                    f.ext,
                    f.kind,
                    f.size,
                    f.mtime,
                    m.width,
                    m.height,
                    m.taken.unwrap_or(0),
                    m.duration,
                    m.make,
                    m.model,
                    m.lens,
                    m.fnumber,
                    m.exposure,
                    m.iso,
                    m.focal,
                    m.lat,
                    m.lon,
                    db::under_any(&private_dirs, &dir)
                ])?;
                if let Some(id) = f.prev {
                    thumbs::forget(&ctx.cache, id);
                    stale.execute([id])?;
                    stale_ai.execute([id])?;
                    stale_clip.execute([id])?;
                    stale_faces.execute([id])?;
                }
            }
        }
        tx.commit()?;
        ctx.update(false, |s| s.indexed += chunk.len() as u64);
        ctx.changed(false);
    }
    Ok(())
}

fn remove_ids(ctx: &Ctx, conn: &mut Connection, ids: &[i64]) -> rusqlite::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare_cached("DELETE FROM media WHERE id=?1")?;
        for &id in ids {
            st.execute([id])?;
        }
    }
    tx.commit()?;
    for &id in ids {
        thumbs::forget(&ctx.cache, id);
    }
    Ok(())
}

fn scan_folder(ctx: &Ctx, conn: &mut Connection, folder: i64, root: &Path) -> rusqlite::Result<()> {
    // the status shows which folder is being indexed; a private one isn't named
    let shown = (!db::under_any(&db::private_dirs(conn)?, &root.to_string_lossy())).then(|| root.to_string_lossy().into_owned());
    ctx.update(true, |s| s.folder = shown);
    let known: HashMap<String, (i64, i64, i64)> = {
        let mut st = conn.prepare("SELECT path, id, size, mtime FROM media WHERE folder_id=?1 AND trashed=0")?;
        let rows = st.query_map([folder], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut seen = HashSet::new();
    let mut todo = vec![];
    let excluded = db::excluded_dirs(conn)?;
    if root.is_dir() {
        collect(ctx, root, folder, &known, &mut seen, &mut todo, &excluded);
    } else {
        // drive unplugged or folder moved: keep the library as-is rather than wiping it
        return Ok(());
    }
    // newest files first so the top of the timeline fills in before the archive
    todo.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    ingest(ctx, conn, todo)?;
    let gone: Vec<i64> = known.values().map(|v| v.0).filter(|id| !seen.contains(id)).collect();
    remove_ids(ctx, conn, &gone)?;
    conn.execute("UPDATE folders SET last_scan=?2 WHERE id=?1", params![folder, db::now_ms()])?;
    Ok(())
}

/// Apply file-system changes reported by the watcher.
fn apply_paths(ctx: &Ctx, conn: &mut Connection, paths: Vec<PathBuf>) -> rusqlite::Result<()> {
    let roots = db::folder_roots(conn)?;
    let excluded = db::excluded_dirs(conn)?;
    let root_of = |p: &Path| {
        roots.iter().filter(|(_, r)| p.starts_with(r)).max_by_key(|(_, r)| r.len()).map(|(id, _)| *id)
    };
    let mut todo = vec![];
    let mut gone = vec![];
    for p in paths {
        let Some(folder) = root_of(&p) else { continue };
        if db::under_any(&excluded, &p.to_string_lossy()) {
            continue;
        }
        if p.is_dir() {
            let known: HashMap<String, (i64, i64, i64)> = {
                let prefix = format!("{}{}", p.to_string_lossy(), std::path::MAIN_SEPARATOR);
                let mut st = conn.prepare_cached(
                    "SELECT path, id, size, mtime FROM media WHERE trashed=0 AND substr(path,1,?1)=?2",
                )?;
                let rows = st.query_map(params![prefix.chars().count() as i64, prefix], |r| {
                    Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
                })?;
                rows.collect::<Result<_, _>>()?
            };
            collect(ctx, &p, folder, &known, &mut HashSet::new(), &mut todo, &excluded);
        } else if p.is_file() {
            let Some(ext) = meta::ext_of(&p) else { continue };
            let Some(kind) = meta::kind_of(&ext) else { continue };
            let Ok(md) = std::fs::metadata(&p) else { continue };
            let (size, mtime) = (md.len() as i64, mtime_ms(&md));
            let prev: Option<(i64, i64, i64)> = conn
                .query_row("SELECT id, size, mtime FROM media WHERE path=?1", [p.to_string_lossy()], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()?;
            if matches!(prev, Some((_, s, m)) if s == size && m == mtime) {
                continue;
            }
            todo.push(Found { folder, path: p, kind, ext, size, mtime, prev: prev.map(|p| p.0) });
        } else {
            // deleted or renamed away; a trashed row stays until the session ends so Undo can find it
            let s = p.to_string_lossy().into_owned();
            let prefix = format!("{s}{}", std::path::MAIN_SEPARATOR);
            gone.extend(db::ids(
                conn,
                "SELECT id FROM media WHERE trashed=0 AND (path=?1 OR substr(path,1,?2)=?3)",
                params![s, prefix.chars().count() as i64, prefix],
            )?);
        }
    }
    ingest(ctx, conn, todo)?;
    remove_ids(ctx, conn, &gone)
}

fn warmer_loop(ctx: Ctx, db_path: PathBuf, rx: Receiver<()>) {
    let conn = match db::open(&db_path) {
        Ok(c) => c,
        Err(e) => return eprintln!("warmer: cannot open db: {e}"),
    };
    let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).max(1);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("thumb-{i}"))
        .build()
        .expect("thumb pool");
    let mut collected = false;
    while rx.recv().is_ok() {
        while rx.try_recv().is_ok() {}
        if !collected {
            collected = true;
            collect_garbage(&ctx.cache, &conn);
        }
        purge_private(&ctx, &conn);
        let private = {
            use tauri::Manager;
            ctx.app.try_state::<crate::AppState>().map(|s| s.private.clone())
        };
        loop {
            let pending: u64 = conn
                .query_row("SELECT COUNT(*) FROM media WHERE thumb=0 AND trashed=0", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0) as u64;
            if pending == 0 {
                break;
            }
            ctx.update(false, |s| {
                s.warming = true;
                s.thumbs_pending = pending;
            });
            // private items wait until the app state (with the Private key) is up
            let batch: Vec<(i64, String, String, i64, bool)> = (|| -> rusqlite::Result<_> {
                let mut st = conn.prepare_cached(
                    "SELECT id, path, ext, kind, private FROM media WHERE thumb=0 AND trashed=0 AND (private=0 OR ?1)
                     ORDER BY taken DESC LIMIT 128",
                )?;
                let rows = st.query_map([private.is_some()], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, i64>(4)? != 0))
                })?;
                rows.collect()
            })()
            .unwrap_or_default();
            if batch.is_empty() {
                break;
            }
            let cache = ctx.cache.clone();
            let results: Vec<(i64, i64)> = pool.install(|| {
                batch
                    .par_iter()
                    .map(|(id, path, ext, kind, is_private)| {
                        let (src, video) = (Path::new(path), *kind == db::VIDEO);
                        let file = thumbs::cache_file(&cache, *id, thumbs::Mode::Thumb);
                        let ok = match private.as_deref().filter(|_| *is_private) {
                            Some(p) => {
                                thumbs::sealed(&file).exists()
                                    || crate::private::ensure_sealed(p, &cache, *id, src, ext, video, thumbs::Mode::Thumb).is_ok()
                            }
                            None => file.exists() || thumbs::ensure(&cache, *id, src, ext, video, thumbs::Mode::Thumb).is_ok(),
                        };
                        (*id, if ok { 1 } else { 2 })
                    })
                    .collect()
            });
            let _ = (|| -> rusqlite::Result<()> {
                let tx = conn.unchecked_transaction()?;
                {
                    let mut st = tx.prepare_cached("UPDATE media SET thumb=?2 WHERE id=?1")?;
                    for (id, v) in &results {
                        st.execute(params![id, v])?;
                    }
                }
                tx.commit()
            })();
            ctx.update(false, |s| s.thumbs_done += results.len() as u64);
        }
        ctx.update(true, |s| {
            s.warming = false;
            s.thumbs_pending = 0;
        });
        analyze_pending(&ctx, &conn, &pool);
        learn_pending(&ctx, &conn, &pool);
    }
}

/// On-device AI pass (search vectors, faces), when the user has turned it on.
fn learn_pending(ctx: &Ctx, conn: &Connection, pool: &rayon::ThreadPool) {
    use tauri::Manager;
    let Some(state) = ctx.app.try_state::<crate::AppState>() else { return };
    let ai = state.ai.clone();
    if !ai.any_on() {
        return;
    }
    let n = crate::ai::index_pending(&ai, &ctx.cache, conn, pool, |pending| {
        ctx.update(false, |s| {
            s.learning = pending > 0;
            s.learn_pending = pending;
        })
    });
    ctx.update(true, |s| {
        s.learning = false;
        s.learn_pending = 0;
    });
    if n > 0 {
        let _ = ctx.app.emit("ai-changed", ());
    }
}

/// Compute dHash, sharpness and exposure for photos whose thumbnail is cached.
fn analyze_pending(ctx: &Ctx, conn: &Connection, pool: &rayon::ThreadPool) {
    const PENDING: &str = "FROM media m WHERE m.kind=0 AND m.trashed=0 AND m.thumb=1 AND m.private=0
                           AND NOT EXISTS (SELECT 1 FROM analysis a WHERE a.media_id=m.id)";
    let mut done_any = false;
    loop {
        let pending: u64 =
            conn.query_row(&format!("SELECT COUNT(*) {PENDING}"), [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64;
        if pending == 0 {
            break;
        }
        ctx.update(false, |s| {
            s.analyzing = true;
            s.analysis_pending = pending;
        });
        let ids = db::ids(conn, &format!("SELECT m.id {PENDING} ORDER BY m.taken DESC LIMIT 256"), []).unwrap_or_default();
        if ids.is_empty() {
            break;
        }
        let cache = ctx.cache.clone();
        let results: Vec<(i64, Option<analysis::Analysis>)> = pool.install(|| {
            ids.par_iter()
                .map(|&id| {
                    let a = std::fs::read(thumbs::cache_file(&cache, id, thumbs::Mode::Thumb))
                        .ok()
                        .and_then(|b| analysis::from_jpeg(&b));
                    (id, a)
                })
                .collect()
        });
        let ok = (|| -> rusqlite::Result<()> {
            let tx = conn.unchecked_transaction()?;
            {
                let mut st = tx.prepare_cached(
                    "INSERT OR REPLACE INTO analysis(media_id, dhash, sharp, luma, contrast, clip) VALUES(?1,?2,?3,?4,?5,?6)",
                )?;
                for (id, a) in &results {
                    // unreadable thumbnails get a sentinel row so they aren't retried every pass
                    let a = a.unwrap_or(analysis::Analysis { dhash: 0, sharp: -1.0, luma: 0.0, contrast: 0.0, clip: 0.0 });
                    st.execute(params![id, a.dhash, a.sharp, a.luma, a.contrast, a.clip])?;
                }
            }
            tx.commit()
        })();
        if ok.is_err() {
            break;
        }
        done_any = true;
    }
    ctx.update(true, |s| {
        s.analyzing = false;
        s.analysis_pending = 0;
    });
    if done_any {
        let _ = ctx.app.emit("analysis-changed", ());
    }
}

/// Forget what AI and analysis learned from items that became private (a pass may have been in flight).
fn purge_private(ctx: &Ctx, conn: &Connection) {
    match db::purge_private_ai(conn) {
        Ok(faces) if !faces.is_empty() => {
            for f in faces {
                let _ = std::fs::remove_file(thumbs::face_file(&ctx.cache, f));
            }
            let _ = ctx.app.emit("ai-changed", ());
        }
        Ok(_) => {}
        Err(e) => eprintln!("private: purge AI rows: {e}"),
    }
}

/// Drop cached thumbnails whose media rows no longer exist.
fn collect_garbage(cache: &Path, conn: &Connection) {
    let Ok(live) = db::ids(conn, "SELECT id FROM media", []) else { return };
    let live: HashSet<i64> = live.into_iter().collect();
    for sub in ["t", "p", "et", "ep"] {
        for e in WalkDir::new(cache.join(sub)).min_depth(2).max_depth(2).into_iter().flatten() {
            let stem = e.path().file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<i64>().ok());
            let stale_tmp = e.path().extension().is_some_and(|x| x == "tmp");
            if stale_tmp || stem.is_some_and(|id| !live.contains(&id)) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    // face crops are keyed by face id
    let Ok(faces) = db::ids(conn, "SELECT id FROM faces", []) else { return };
    let faces: HashSet<i64> = faces.into_iter().collect();
    for e in WalkDir::new(cache.join("f")).min_depth(2).max_depth(2).into_iter().flatten() {
        let stem = e.path().file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<i64>().ok());
        if stem.is_some_and(|id| !faces.contains(&id)) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
