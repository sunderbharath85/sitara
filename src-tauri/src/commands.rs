//! IPC commands called from the React UI.

use crate::scan::{Job, Status};
use crate::{db, thumbs, watch, AppState};
use rusqlite::params;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

type R<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

pub fn start_watch(app: &AppHandle, s: &AppState, id: i64, path: &Path) {
    // the webview may load originals from library folders only
    let _ = app.asset_protocol_scope().allow_directory(path, true);
    match watch::watch(path, s.indexer.tx.clone()) {
        Ok(w) => {
            s.watchers.lock().unwrap().insert(id, w);
        }
        Err(err) => eprintln!("watch {}: {err}", path.display()),
    }
}

fn path_of(s: &AppState, id: i64) -> R<String> {
    let c = s.db.lock().unwrap();
    db::source(&c, id).map_err(e)?.map(|x| x.0).ok_or_else(|| "Item not found".into())
}

#[tauri::command]
pub fn library(s: State<'_, AppState>) -> R<Response> {
    let c = s.db.lock().unwrap();
    Ok(Response::new(db::library_bytes(&c).map_err(e)?))
}

#[tauri::command]
pub fn media_detail(s: State<'_, AppState>, id: i64) -> R<Option<db::MediaDetail>> {
    db::detail(&s.db.lock().unwrap(), id).map_err(e)
}

#[tauri::command]
pub fn folders(s: State<'_, AppState>) -> R<Vec<db::FolderInfo>> {
    db::folders(&s.db.lock().unwrap()).map_err(e)
}

#[tauri::command]
pub fn add_folder(app: AppHandle, s: State<'_, AppState>, path: String) -> R<Vec<db::FolderInfo>> {
    let p = dunce::canonicalize(&path).map_err(|_| format!("Can't open {path}"))?;
    if !p.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let ps = p.to_string_lossy().into_owned();
    let id = {
        let c = s.db.lock().unwrap();
        let roots = db::folder_roots(&c).map_err(e)?;
        if let Some((_, r)) = roots.iter().find(|(_, r)| p.starts_with(r)) {
            return Err(format!("Already in your library through {r}"));
        }
        c.execute("INSERT INTO folders(path, added_at) VALUES(?1, ?2)", params![ps, db::now_ms()]).map_err(e)?;
        let id = c.last_insert_rowid();
        // a parent of existing folders absorbs them instead of indexing twice
        for (old, r) in roots.iter().filter(|(_, r)| Path::new(r).starts_with(&p)) {
            c.execute("UPDATE media SET folder_id=?1 WHERE folder_id=?2", [id, *old]).map_err(e)?;
            c.execute("DELETE FROM folders WHERE id=?1", [*old]).map_err(e)?;
            s.watchers.lock().unwrap().remove(old);
            eprintln!("merged {r} into {ps}");
        }
        id
    };
    start_watch(&app, &s, id, &p);
    let _ = s.indexer.tx.send(Job::Scan(id));
    folders(s)
}

#[tauri::command]
pub fn remove_folder(app: AppHandle, s: State<'_, AppState>, id: i64) -> R<Vec<db::FolderInfo>> {
    s.watchers.lock().unwrap().remove(&id);
    let ids = {
        let c = s.db.lock().unwrap();
        let ids = db::ids(&c, "SELECT id FROM media WHERE folder_id=?1", [id]).map_err(e)?;
        c.execute("DELETE FROM folders WHERE id=?1", [id]).map_err(e)?;
        ids
    };
    let cache = s.cache.clone();
    std::thread::spawn(move || ids.into_iter().for_each(|i| thumbs::forget(&cache, i)));
    let _ = app.emit("library-changed", ());
    folders(s)
}

#[tauri::command]
pub fn rescan(s: State<'_, AppState>) {
    let _ = s.indexer.tx.send(Job::ScanAll);
}

#[tauri::command]
pub fn index_status(s: State<'_, AppState>) -> Status {
    s.indexer.status.lock().unwrap().clone()
}

#[derive(Serialize)]
pub struct Suggestion {
    path: String,
    label: String,
}

#[tauri::command]
pub fn suggest_folders(app: AppHandle, s: State<'_, AppState>) -> Vec<Suggestion> {
    let pr = app.path();
    let mut c: Vec<(Option<PathBuf>, &str)> = vec![(pr.picture_dir().ok(), "Pictures"), (pr.video_dir().ok(), "Videos")];
    if let Ok(home) = pr.home_dir() {
        c.push((Some(home.join("OneDrive").join("Pictures")), "OneDrive Pictures"));
        c.push((Some(home.join("Pictures").join("Camera Roll")), "Camera Roll"));
    }
    let roots = db::folder_roots(&s.db.lock().unwrap()).unwrap_or_default();
    let mut out: Vec<Suggestion> = vec![];
    for (p, label) in c {
        let Some(p) = p.filter(|p| p.is_dir()) else { continue };
        let p = dunce::canonicalize(&p).unwrap_or(p);
        let ps = p.to_string_lossy().into_owned();
        let covered = roots.iter().any(|(_, r)| p.starts_with(r)) || out.iter().any(|o| p.starts_with(&o.path));
        if !covered {
            out.push(Suggestion { path: ps, label: label.into() });
        }
    }
    out
}

#[tauri::command]
pub fn set_favorite(s: State<'_, AppState>, ids: Vec<i64>, value: bool) -> R<()> {
    let mut c = s.db.lock().unwrap();
    let tx = c.transaction().map_err(e)?;
    {
        let mut st = tx.prepare("UPDATE media SET favorite=?2 WHERE id=?1").map_err(e)?;
        for id in ids {
            st.execute(params![id, value as i64]).map_err(e)?;
        }
    }
    tx.commit().map_err(e)
}

/// Move items to the OS Recycle Bin / Trash. Rows stay (flagged) for the session so Undo can restore them.
#[tauri::command]
pub fn trash_items(app: AppHandle, s: State<'_, AppState>, ids: Vec<i64>) -> R<Vec<i64>> {
    let items: Vec<(i64, String)> = {
        let c = s.db.lock().unwrap();
        ids.iter().filter_map(|&id| db::source(&c, id).ok().flatten().map(|x| (id, x.0))).collect()
    };
    let ok: Vec<i64> = if trash::delete_all(items.iter().map(|x| &x.1)).is_ok() {
        items.iter().map(|x| x.0).collect()
    } else {
        items.iter().filter(|(_, p)| trash::delete(p).is_ok() || !Path::new(p).exists()).map(|x| x.0).collect()
    };
    {
        let c = s.db.lock().unwrap();
        for id in &ok {
            c.execute("UPDATE media SET trashed=1 WHERE id=?1", [id]).map_err(e)?;
        }
    }
    let _ = app.emit("library-changed", ());
    if ok.is_empty() && !items.is_empty() {
        return Err("Couldn't move these files to the Recycle Bin".into());
    }
    Ok(ok)
}

#[tauri::command]
pub fn restore_items(app: AppHandle, s: State<'_, AppState>, ids: Vec<i64>) -> R<Vec<i64>> {
    #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
    {
        use std::collections::HashMap;
        let wanted: HashMap<PathBuf, i64> = {
            let c = s.db.lock().unwrap();
            ids.iter()
                .filter_map(|&id| {
                    c.query_row("SELECT path FROM media WHERE id=?1 AND trashed=1", [id], |r| r.get::<_, String>(0))
                        .ok()
                        .map(|p| (PathBuf::from(p), id))
                })
                .collect()
        };
        // newest trash entry per original path
        let mut pick: HashMap<PathBuf, trash::TrashItem> = HashMap::new();
        for it in trash::os_limited::list().map_err(e)? {
            let op = it.original_path();
            if wanted.contains_key(&op) && pick.get(&op).is_none_or(|p| p.time_deleted < it.time_deleted) {
                pick.insert(op, it);
            }
        }
        let restored: Vec<i64> = pick.keys().filter_map(|p| wanted.get(p).copied()).collect();
        trash::os_limited::restore_all(pick.into_values()).map_err(e)?;
        {
            let c = s.db.lock().unwrap();
            for id in &restored {
                c.execute("UPDATE media SET trashed=0 WHERE id=?1", [id]).map_err(e)?;
            }
        }
        let _ = app.emit("library-changed", ());
        Ok(restored)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (app, s, ids);
        Err("Undo isn't available on macOS yet. Restore from the Trash in Finder.".into())
    }
}

#[tauri::command]
pub fn albums(s: State<'_, AppState>) -> R<db::Albums> {
    db::albums(&s.db.lock().unwrap()).map_err(e)
}

#[tauri::command]
pub fn album_items(s: State<'_, AppState>, id: i64) -> R<Vec<i64>> {
    db::album_items(&s.db.lock().unwrap(), id).map_err(e)
}

#[tauri::command]
pub fn dir_items(s: State<'_, AppState>, dir: String) -> R<Vec<i64>> {
    db::dir_items(&s.db.lock().unwrap(), &dir).map_err(e)
}

#[tauri::command]
pub fn album_create(s: State<'_, AppState>, name: String, ids: Vec<i64>) -> R<i64> {
    let name = name.trim();
    let name = if name.is_empty() { "Untitled album" } else { name };
    let mut c = s.db.lock().unwrap();
    let now = db::now_ms();
    c.execute("INSERT INTO albums(name, created_at, updated_at) VALUES(?1, ?2, ?2)", params![name, now]).map_err(e)?;
    let id = c.last_insert_rowid();
    db::album_add(&mut c, id, &ids).map_err(e)?;
    Ok(id)
}

#[tauri::command]
pub fn album_add(s: State<'_, AppState>, id: i64, ids: Vec<i64>) -> R<()> {
    db::album_add(&mut s.db.lock().unwrap(), id, &ids).map_err(e)
}

#[tauri::command]
pub fn album_remove(s: State<'_, AppState>, id: i64, ids: Vec<i64>) -> R<()> {
    let c = s.db.lock().unwrap();
    for m in ids {
        c.execute("DELETE FROM album_items WHERE album_id=?1 AND media_id=?2", [id, m]).map_err(e)?;
    }
    c.execute("UPDATE albums SET updated_at=?2 WHERE id=?1", params![id, db::now_ms()]).map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn album_rename(s: State<'_, AppState>, id: i64, name: String) -> R<()> {
    let c = s.db.lock().unwrap();
    c.execute("UPDATE albums SET name=?2, updated_at=?3 WHERE id=?1", params![id, name.trim(), db::now_ms()])
        .map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn album_delete(s: State<'_, AppState>, id: i64) -> R<()> {
    s.db.lock().unwrap().execute("DELETE FROM albums WHERE id=?1", [id]).map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn search(s: State<'_, AppState>, q: String) -> R<Vec<i64>> {
    db::search(&s.db.lock().unwrap(), &q).map_err(e)
}

#[tauri::command]
pub fn reveal(app: AppHandle, s: State<'_, AppState>, id: i64) -> R<()> {
    app.opener().reveal_item_in_dir(path_of(&s, id)?).map_err(e)
}

#[tauri::command]
pub fn open_external(app: AppHandle, s: State<'_, AppState>, id: i64) -> R<()> {
    app.opener().open_path(path_of(&s, id)?, None::<&str>).map_err(e)
}

async fn off_main<T: Send + 'static>(s: &AppState, f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T> + Send + 'static) -> R<T> {
    let path = s.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = db::open(&path).map_err(e)?;
        f(&c).map_err(e)
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn smart_albums(s: State<'_, AppState>) -> R<Vec<crate::smart::SmartAlbum>> {
    off_main(&s, crate::smart::compute).await
}

#[tauri::command]
pub async fn cleanup_scan(s: State<'_, AppState>) -> R<crate::cleanup::Report> {
    off_main(&s, crate::cleanup::scan).await
}

// ---------- editor ----------

/// Raw-body IPC for large binary payloads: [u32 LE header length][JSON header][bytes...].
fn raw_body<'a, H: serde::de::DeserializeOwned>(req: &'a tauri::ipc::Request<'_>) -> R<(H, &'a [u8])> {
    let tauri::ipc::InvokeBody::Raw(body) = req.body() else { return Err("expected a binary body".into()) };
    let n = body.get(..4).map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize).ok_or("short body")?;
    let head = body.get(4..4 + n).ok_or("short body")?;
    Ok((serde_json::from_slice(head).map_err(e)?, &body[4 + n..]))
}

fn is_jpeg(b: &[u8]) -> bool {
    b.len() > 4 && b[0..2] == [0xFF, 0xD8]
}

/// The saved edit stack (editor JSON), if the photo has edits.
#[tauri::command]
pub fn edit_load(s: State<'_, AppState>, id: i64) -> R<Option<String>> {
    db::edit_get(&s.db.lock().unwrap(), id).map_err(e)
}

#[derive(serde::Deserialize)]
struct SaveHead {
    id: i64,
    w: i64,
    h: i64,
    stack: serde_json::Value,
    /// Byte length of the thumbnail JPEG; the preview JPEG follows it.
    thumb: usize,
}

/// Save an edit stack with the editor's renders of the result (grid thumbnail + large preview).
/// Originals are never touched. Returns the new revision.
#[tauri::command]
pub async fn edit_save(app: AppHandle, s: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> R<i64> {
    let (head, rest): (SaveHead, &[u8]) = raw_body(&request)?;
    let (thumb, preview) = rest.split_at(head.thumb.min(rest.len()));
    if !is_jpeg(thumb) || !is_jpeg(preview) || head.w <= 0 || head.h <= 0 {
        return Err("The edited renders are incomplete".into());
    }
    // renders first, so a new version never points at missing files
    thumbs::write_atomic(&thumbs::edited_file(&s.cache, head.id, thumbs::Mode::Thumb), thumb);
    thumbs::write_atomic(&thumbs::edited_file(&s.cache, head.id, thumbs::Mode::Preview), preview);
    let rev = db::edit_put(&s.db.lock().unwrap(), head.id, &head.stack.to_string(), head.w, head.h).map_err(e)?;
    let _ = app.emit("library-changed", ());
    Ok(rev)
}

/// Drop all edits: the photo shows its original again.
#[tauri::command]
pub fn edit_revert(app: AppHandle, s: State<'_, AppState>, id: i64) -> R<bool> {
    let had = db::edit_delete(&s.db.lock().unwrap(), id).map_err(e)?;
    thumbs::forget_edited(&s.cache, id);
    let _ = app.emit("library-changed", ());
    Ok(had)
}

#[derive(serde::Deserialize)]
struct ExportHead {
    id: i64,
    path: String,
    w: u32,
    h: u32,
    /// Copy camera metadata (EXIF) from the original.
    exif: bool,
    /// Keep the location when copying metadata.
    gps: bool,
}

/// Write an exported copy (encoded by the editor) to a path the user picked. Never overwrites the original.
#[tauri::command]
pub async fn export_save(s: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> R<String> {
    let (head, bytes): (ExportHead, &[u8]) = raw_body(&request)?;
    let original = PathBuf::from(path_of(&s, head.id)?);
    let target = PathBuf::from(&head.path);
    let same = |a: &Path, b: &Path| match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same(&original, &target) {
        return Err("Sitara won't overwrite the original. Pick a new file name.".into());
    }
    let mut out = bytes.to_vec();
    if head.exif && is_jpeg(&out) {
        let orig = original.clone();
        let app1 = tauri::async_runtime::spawn_blocking(move || crate::export::exif_for_export(&orig, head.w, head.h, head.gps))
            .await
            .map_err(e)?;
        if let Some(spliced) = app1.and_then(|p| crate::export::splice_app1(&out, &p)) {
            out = spliced;
        }
    }
    let tmp = target.with_extension("sitara-tmp");
    std::fs::write(&tmp, &out).map_err(|err| format!("Couldn't write {}: {err}", target.display()))?;
    std::fs::rename(&tmp, &target).map_err(|err| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't write {}: {err}", target.display())
    })?;
    Ok(target.to_string_lossy().into_owned())
}

// ---------- on-device AI ----------

#[tauri::command]
pub async fn ai_status(s: State<'_, AppState>) -> R<crate::ai::AiStatus> {
    let ai = s.ai.clone();
    off_main(&s, move |c| Ok(ai.status(c))).await
}

/// Download and turn on "search" or "people"; the warmer starts learning once it's done.
#[tauri::command]
pub fn ai_install(app: AppHandle, s: State<'_, AppState>, feature: String) -> R<()> {
    let wake = s.indexer.wake.clone();
    s.ai.install(app, feature, move || {
        let _ = wake.send(());
    })
}

#[tauri::command]
pub fn ai_remove(app: AppHandle, s: State<'_, AppState>, feature: String) -> R<()> {
    s.ai.remove(&s.db.lock().unwrap(), &feature)?;
    let _ = app.emit("ai-changed", ());
    Ok(())
}

/// Photo ids that match a description, best first.
#[tauri::command]
pub async fn ai_search(s: State<'_, AppState>, q: String) -> R<Vec<i64>> {
    let ai = s.ai.clone();
    let path = s.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = db::open(&path).map_err(e)?;
        Ok(ai.search(&c, &q)?.into_iter().map(|x| x.0).collect())
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn people(s: State<'_, AppState>) -> R<Vec<crate::ai::people::Person>> {
    off_main(&s, crate::ai::people::list).await
}

#[tauri::command]
pub fn person_items(s: State<'_, AppState>, id: i64) -> R<Vec<i64>> {
    crate::ai::people::items(&s.db.lock().unwrap(), id).map_err(e)
}

#[tauri::command]
pub fn person_rename(app: AppHandle, s: State<'_, AppState>, id: i64, name: String) -> R<()> {
    crate::ai::people::rename(&s.db.lock().unwrap(), id, &name).map_err(e)?;
    let _ = app.emit("ai-changed", ());
    Ok(())
}

#[tauri::command]
pub fn person_merge(app: AppHandle, s: State<'_, AppState>, from: i64, into: i64) -> R<()> {
    crate::ai::people::merge(&s.db.lock().unwrap(), from, into).map_err(e)?;
    let _ = app.emit("ai-changed", ());
    Ok(())
}

#[tauri::command]
pub fn person_hide(app: AppHandle, s: State<'_, AppState>, id: i64, hidden: bool) -> R<()> {
    crate::ai::people::hide(&s.db.lock().unwrap(), id, hidden).map_err(e)?;
    let _ = app.emit("ai-changed", ());
    Ok(())
}

/// "Not this person" for some photos.
#[tauri::command]
pub fn person_remove(app: AppHandle, s: State<'_, AppState>, id: i64, ids: Vec<i64>) -> R<()> {
    crate::ai::people::remove_media(&s.db.lock().unwrap(), id, &ids).map_err(e)?;
    let _ = app.emit("ai-changed", ());
    Ok(())
}

// ---------- AI editing ----------

#[derive(serde::Deserialize)]
struct OpHead {
    op: String,
    w: u32,
    h: u32,
    /// Text for "rank".
    q: Option<String>,
    /// Number of images for "rank".
    n: Option<usize>,
}

fn rgba(img: image::RgbImage) -> Vec<u8> {
    img.pixels().flat_map(|p| [p[0], p[1], p[2], 255]).collect()
}

/// AI editing on pixels the editor sends (RGBA, upright sRGB). Images come back as RGBA, masks as one byte
/// per pixel, faces and ranks as JSON.
#[tauri::command]
pub async fn ai_op(s: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> R<Response> {
    use crate::ai::edit;
    let (head, body): (OpHead, &[u8]) = raw_body(&request)?;
    let (ai, body) = (s.ai.clone(), body.to_vec());
    tauri::async_runtime::spawn_blocking(move || -> R<Response> {
        let (w, h) = (head.w, head.h);
        let px = (w * h) as usize;
        let rgb = |b: &[u8]| -> R<image::RgbImage> {
            image::RgbImage::from_raw(w, h, b.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect()).ok_or_else(|| "bad image".to_string())
        };
        let n = head.n.unwrap_or(1).max(1);
        if body.len() < px * 4 * if head.op == "rank" { n } else { 1 } {
            return Err("The image data is incomplete".into());
        }
        let out: Vec<u8> = match head.op.as_str() {
            "inpaint" => {
                let mask = image::GrayImage::from_raw(w, h, body.get(px * 4..px * 5).ok_or("missing mask")?.to_vec()).ok_or("bad mask")?;
                rgba(edit::inpaint(&ai, &rgb(&body[..px * 4])?, &mask)?)
            }
            "subject" => edit::subject(&ai, &rgb(&body[..px * 4])?)?.into_raw(),
            "sky" => edit::sky(&ai, &rgb(&body[..px * 4])?)?.into_raw(),
            "depth" => edit::depth(&ai, &rgb(&body[..px * 4])?)?.into_raw(),
            "denoise" => rgba(edit::denoise(&ai, &rgb(&body[..px * 4])?)?),
            "upscale" => rgba(edit::upscale(&ai, &rgb(&body[..px * 4])?)?),
            "colorize" => rgba(edit::colorize(&ai, &rgb(&body[..px * 4])?)?),
            "restore_faces" => rgba(edit::restore_faces(&ai, &rgb(&body[..px * 4])?)?.0),
            "faces" => serde_json::to_vec(&edit::faces(&ai, &rgb(&body[..px * 4])?)?).map_err(e)?,
            "rank" => {
                let imgs = (0..n).map(|k| rgb(&body[k * px * 4..(k + 1) * px * 4])).collect::<R<Vec<_>>>()?;
                serde_json::to_vec(&edit::rank(&ai, head.q.as_deref().unwrap_or(""), &imgs)?).map_err(e)?
            }
            other => return Err(format!("unknown AI operation {other}")),
        };
        Ok(Response::new(out))
    })
    .await
    .map_err(e)?
}

/// Keep pixels an AI edit made (PNG), content-addressed; edit stacks refer to them by hash.
#[tauri::command]
pub async fn ai_layer_put(s: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> R<String> {
    let tauri::ipc::InvokeBody::Raw(png) = request.body() else { return Err("expected a binary body".into()) };
    if png.len() < 8 || png[..8] != *b"\x89PNG\r\n\x1a\n" {
        return Err("expected a PNG".into());
    }
    let hash = blake3::hash(png).to_hex().to_string();
    let path = s.ai.layers.join(format!("{hash}.png"));
    if !path.exists() {
        std::fs::create_dir_all(&s.ai.layers).map_err(e)?;
        thumbs::write_atomic(&path, png);
    }
    Ok(hash)
}

/// The editor closed: free the editing models.
#[tauri::command]
pub fn ai_release(s: State<'_, AppState>) {
    s.ai.release_edit();
}
