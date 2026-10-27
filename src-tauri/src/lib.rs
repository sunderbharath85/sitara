mod commands;
mod db;
mod meta;
mod protocol;
mod scan;
#[cfg(windows)]
mod shell;
mod thumbs;
mod watch;

use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tokio::sync::Semaphore;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub cache: PathBuf,
    pub indexer: scan::Indexer,
    pub watchers: Mutex<HashMap<i64, watch::Watcher>>,
    /// Concurrent on-demand thumbnail renders.
    pub render_slots: Arc<Semaphore>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(protocol::serve(app, req, thumbs::Mode::Thumb).await);
            });
        })
        .register_asynchronous_uri_scheme_protocol("preview", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(protocol::serve(app, req, thumbs::Mode::Preview).await);
            });
        })
        .setup(|app| {
            let h = app.handle();
            let data = h.path().app_data_dir()?;
            let cache = h.path().app_cache_dir()?.join("thumbs");
            std::fs::create_dir_all(&data)?;
            std::fs::create_dir_all(&cache)?;
            let db_path = data.join("library.db");
            let conn = db::open(&db_path)?;
            db::migrate(&conn)?;
            let roots = db::folder_roots(&conn)?;
            let indexer = scan::start(h.clone(), db_path, cache.clone());
            let slots = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).max(2);
            app.manage(AppState {
                db: Mutex::new(conn),
                cache,
                indexer,
                watchers: Mutex::new(HashMap::new()),
                render_slots: Arc::new(Semaphore::new(slots)),
            });
            let state = app.state::<AppState>();
            for (id, path) in roots {
                commands::start_watch(h, &state, id, Path::new(&path));
            }
            // catch up on changes made while the app was closed
            let _ = state.indexer.tx.send(scan::Job::ScanAll);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library,
            commands::media_detail,
            commands::folders,
            commands::add_folder,
            commands::remove_folder,
            commands::rescan,
            commands::index_status,
            commands::suggest_folders,
            commands::set_favorite,
            commands::trash_items,
            commands::restore_items,
            commands::albums,
            commands::album_items,
            commands::dir_items,
            commands::album_create,
            commands::album_add,
            commands::album_remove,
            commands::album_rename,
            commands::album_delete,
            commands::search,
            commands::reveal,
            commands::open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sitara");
}
