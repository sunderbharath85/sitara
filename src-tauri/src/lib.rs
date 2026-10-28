mod ai;
mod analysis;
mod cleanup;
mod commands;
mod db;
mod export;
mod geo;
mod meta;
mod protocol;
mod raw;
mod scan;
#[cfg(windows)]
mod shell;
mod smart;
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
    /// Heavy read-mostly work (smart albums, cleanup) opens its own connection off the main thread.
    pub db_path: PathBuf,
    pub cache: PathBuf,
    pub indexer: scan::Indexer,
    pub watchers: Mutex<HashMap<i64, watch::Watcher>>,
    /// Concurrent on-demand thumbnail renders.
    pub render_slots: Arc<Semaphore>,
    /// Optional on-device AI (search by meaning, people).
    pub ai: Arc<ai::Ai>,
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
            let models = h.path().app_local_data_dir()?.join("models");
            std::fs::create_dir_all(&data)?;
            std::fs::create_dir_all(&cache)?;
            let db_path = data.join("library.db");
            let conn = db::open(&db_path)?;
            db::migrate(&conn)?;
            let roots = db::folder_roots(&conn)?;
            let indexer = scan::start(h.clone(), db_path.clone(), cache.clone());
            let slots = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).max(2);
            app.manage(AppState {
                db: Mutex::new(conn),
                db_path,
                cache,
                indexer,
                watchers: Mutex::new(HashMap::new()),
                render_slots: Arc::new(Semaphore::new(slots)),
                ai: Arc::new(ai::Ai::new(models)),
            });
            let state = app.state::<AppState>();
            for (id, path) in roots {
                commands::start_watch(h, &state, id, Path::new(&path));
            }
            // AI-edit layers no saved edit refers to (abandoned edits) are deleted
            {
                let (db_path, layers) = (state.db_path.clone(), state.ai.layers.clone());
                std::thread::spawn(move || ai::gc_layers(&db_path, &layers));
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
            commands::smart_albums,
            commands::cleanup_scan,
            commands::edit_load,
            commands::edit_save,
            commands::edit_revert,
            commands::export_save,
            commands::ai_status,
            commands::ai_install,
            commands::ai_remove,
            commands::ai_search,
            commands::people,
            commands::person_items,
            commands::person_rename,
            commands::person_merge,
            commands::person_hide,
            commands::person_remove,
            commands::ai_op,
            commands::ai_layer_put,
            commands::ai_release,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sitara");
}
