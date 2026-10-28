//! `thumb://localhost/{id}` and `preview://localhost/{id}`: cached JPEGs rendered on demand.
//! Requests queue on a semaphore (FIFO) so the tiles the user is looking at render first.
//! An edited photo serves the editor's renders instead. `preview://localhost/{id}?full=1&max=N`
//! returns the editor's full-resolution source pixels (see `thumbs::full_source`), uncached.

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
        // URLs carry ?v=<mtime + edit revision>, so a cached response can never go stale
        b = b.header(header::CACHE_CONTROL, "public, max-age=31536000, immutable");
    }
    b.body(body).unwrap()
}

fn query(req: &Request<Vec<u8>>, key: &str) -> Option<String> {
    req.uri().query()?.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| v.to_string())
    })
}

pub async fn serve(app: AppHandle, req: Request<Vec<u8>>, mode: Mode) -> Response<Vec<u8>> {
    if mode == Mode::Thumb && req.uri().path().starts_with("/face/") {
        return face(app, req).await;
    }
    if mode == Mode::Thumb && req.uri().path().starts_with("/layer/") {
        return layer(app, req).await;
    }
    let id: Option<i64> = req.uri().path().trim_start_matches('/').split('/').next().and_then(|s| s.parse().ok());
    let Some(id) = id else { return reply(StatusCode::BAD_REQUEST, b"bad id".to_vec(), false) };
    let Some(state) = app.try_state::<AppState>() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, b"starting".to_vec(), false);
    };
    let cache = state.cache.clone();

    if mode == Mode::Preview && query(&req, "full").is_some() {
        let max: u32 = query(&req, "max").and_then(|m| m.parse().ok()).unwrap_or(16384);
        let src = { db::source(&state.db.lock().unwrap(), id).ok().flatten() };
        let Some((path, ext, _)) = src else { return reply(StatusCode::NOT_FOUND, b"unknown".to_vec(), false) };
        let res = tauri::async_runtime::spawn_blocking(move || thumbs::full_source(&PathBuf::from(path), &ext, max)).await;
        return match res {
            Ok(Ok(bytes)) => Response::builder()
                .status(StatusCode::OK)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .header(header::CACHE_CONTROL, "no-store")
                .body(bytes)
                .unwrap(),
            Ok(Err(e)) => reply(StatusCode::UNPROCESSABLE_ENTITY, e.into_bytes(), false),
            Err(_) => reply(StatusCode::INTERNAL_SERVER_ERROR, b"decode panicked".to_vec(), false),
        };
    }

    let (edited, cached) = (thumbs::edited_file(&cache, id, mode), thumbs::cache_file(&cache, id, mode));
    let hit = tauri::async_runtime::spawn_blocking(move || std::fs::read(edited).or_else(|_| std::fs::read(cached))).await;
    if let Ok(Ok(bytes)) = hit {
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

/// `thumb://localhost/face/{faceId}`: a square portrait for People.
async fn face(app: AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let id: Option<i64> = req.uri().path().trim_start_matches("/face/").parse().ok();
    let Some(id) = id else { return reply(StatusCode::BAD_REQUEST, b"bad id".to_vec(), false) };
    let Some(state) = app.try_state::<AppState>() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, b"starting".to_vec(), false);
    };
    let row = { crate::ai::people::face(&state.db.lock().unwrap(), id).ok().flatten() };
    let Some((path, ext, b)) = row else { return reply(StatusCode::NOT_FOUND, b"unknown".to_vec(), false) };
    let cache = state.cache.clone();
    let Ok(_permit) = state.render_slots.clone().acquire_owned().await else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, b"closing".to_vec(), false);
    };
    match tauri::async_runtime::spawn_blocking(move || thumbs::face(&cache, id, &PathBuf::from(path), &ext, b)).await {
        Ok(Ok(bytes)) => reply(StatusCode::OK, bytes, true),
        Ok(Err(e)) => reply(StatusCode::UNPROCESSABLE_ENTITY, e.into_bytes(), false),
        Err(_) => reply(StatusCode::INTERNAL_SERVER_ERROR, b"render panicked".to_vec(), false),
    }
}

/// `thumb://localhost/layer/{hash}`: pixels made by an AI edit.
async fn layer(app: AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let hash = req.uri().path().trim_start_matches("/layer/").to_string();
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return reply(StatusCode::BAD_REQUEST, b"bad layer".to_vec(), false);
    }
    let Some(state) = app.try_state::<AppState>() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, b"starting".to_vec(), false);
    };
    let path = state.ai.layers.join(format!("{hash}.png"));
    match tauri::async_runtime::spawn_blocking(move || std::fs::read(path)).await {
        Ok(Ok(bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(bytes)
            .unwrap(),
        _ => reply(StatusCode::NOT_FOUND, b"missing layer".to_vec(), false),
    }
}
