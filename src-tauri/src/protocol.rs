//! `thumb://localhost/{id}` and `preview://localhost/{id}`: cached JPEGs rendered on demand.
//! Requests queue on a semaphore (FIFO) so the tiles the user is looking at render first.

use crate::thumbs::{self, Mode};
use crate::{db, AppState};
use std::path::PathBuf;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

fn reply(status: StatusCode, body: Vec<u8>, cache: bool) -> Response<Vec<u8>> {
    let mut b = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*") // lets the viewer read pixels for histogram and palette
        .header(header::CONTENT_TYPE, if status == StatusCode::OK { "image/jpeg" } else { "text/plain" });
    if cache {
        // URLs carry ?v=<mtime>, so a cached response can never go stale
        b = b.header(header::CACHE_CONTROL, "public, max-age=31536000, immutable");
    }
    b.body(body).unwrap()
}

pub async fn serve(app: AppHandle, req: Request<Vec<u8>>, mode: Mode) -> Response<Vec<u8>> {
    let id: Option<i64> = req.uri().path().trim_start_matches('/').split('/').next().and_then(|s| s.parse().ok());
    let Some(id) = id else { return reply(StatusCode::BAD_REQUEST, b"bad id".to_vec(), false) };
    let Some(state) = app.try_state::<AppState>() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, b"starting".to_vec(), false);
    };
    let cache = state.cache.clone();

    let cached = thumbs::cache_file(&cache, id, mode);
    if let Ok(Ok(bytes)) = tauri::async_runtime::spawn_blocking(move || std::fs::read(cached)).await {
        return reply(StatusCode::OK, bytes, true);
    }

    let src = { db::source(&state.db.lock().unwrap(), id).ok().flatten() };
    let Some((path, ext, kind)) = src else { return reply(StatusCode::NOT_FOUND, b"unknown".to_vec(), false) };
    let Ok(_permit) = state.render_slots.clone().acquire_owned().await else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, b"closing".to_vec(), false);
    };
    let res = tauri::async_runtime::spawn_blocking(move || {
        thumbs::ensure(&cache, id, &PathBuf::from(path), &ext, kind == db::VIDEO, mode)
    })
    .await;
    match res {
        Ok(Ok(bytes)) => reply(StatusCode::OK, bytes, true),
        Ok(Err(e)) => reply(StatusCode::UNPROCESSABLE_ENTITY, e.into_bytes(), false),
        Err(_) => reply(StatusCode::INTERNAL_SERVER_ERROR, b"render panicked".to_vec(), false),
    }
}
