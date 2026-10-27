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
