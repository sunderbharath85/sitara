//! `thumb://localhost/{id}` and `preview://localhost/{id}`: cached JPEGs rendered on demand.
//! Requests queue on a semaphore (FIFO) so the tiles the user is looking at render first.
//! An edited photo serves the editor's renders instead. `preview://localhost/{id}?full=1&max=N`
//! returns the editor's full-resolution source pixels (see `thumbs::full_source`), uncached.
//!
//! Private items are served only while Private is unlocked, from sealed cache files, and never cached by the
//! webview. Their URLs carry `p=1`, so they never share a cache entry with the item's URL from before it was
//! made private. `preview://localhost/{id}?orig=1` streams a private item's original (with byte ranges, for
//! video), since the asset protocol would let the webview cache it.

use crate::thumbs::{self, Mode};
use crate::{db, AppState};
use std::path::PathBuf;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

fn reply(status: StatusCode, body: Vec<u8>, cache: bool) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*") // lets the viewer read pixels for histogram and palette
        .header(header::CONTENT_TYPE, if status == StatusCode::OK { "image/jpeg" } else { "text/plain" })
        // URLs carry ?v=<mtime + edit revision>, so a cached response can never go stale
        .header(header::CACHE_CONTROL, if cache { "public, max-age=31536000, immutable" } else { "no-store" })
        .body(body)
        .unwrap()
}

fn locked() -> Response<Vec<u8>> {
    reply(StatusCode::FORBIDDEN, b"Private is locked".to_vec(), false)
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
    let src = { db::source(&state.db.lock().unwrap(), id).ok().flatten() };
    let Some((path, ext, kind, private)) = src else { return reply(StatusCode::NOT_FOUND, b"unknown".to_vec(), false) };
    if private && !state.private.unlocked() {
        return locked();
    }

    if mode == Mode::Preview && query(&req, "full").is_some() {
        let max: u32 = query(&req, "max").and_then(|m| m.parse().ok()).unwrap_or(16384);
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
    if mode == Mode::Preview && query(&req, "orig").is_some() {
        return original(&req, path, ext, kind).await;
    }

    if private {
        let p = state.private.clone();
        let (edited, cached) = (thumbs::edited_file(&cache, id, mode), thumbs::cache_file(&cache, id, mode));
        let hit = tauri::async_runtime::spawn_blocking(move || {
            let b = std::fs::read(thumbs::sealed(&edited)).or_else(|_| std::fs::read(thumbs::sealed(&cached))).ok()?;
            Some(p.open(&b))
        })
        .await;
        match hit {
            Ok(Some(Some(bytes))) => return reply(StatusCode::OK, bytes, false),
            Ok(Some(None)) => return locked(),
            _ => {}
        }
    } else {
        // `p=1` on a public item (made public again): serve it, but keep it out of the webview cache
        let cache_ok = query(&req, "p").is_none();
        let (edited, cached) = (thumbs::edited_file(&cache, id, mode), thumbs::cache_file(&cache, id, mode));
        let hit = tauri::async_runtime::spawn_blocking(move || std::fs::read(edited).or_else(|_| std::fs::read(cached))).await;
        if let Ok(Ok(bytes)) = hit {
            return reply(StatusCode::OK, bytes, cache_ok);
        }
    }

    let Ok(_permit) = state.render_slots.clone().acquire_owned().await else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, b"closing".to_vec(), false);
    };
    let p = state.private.clone();
    let cache_ok = !private && query(&req, "p").is_none();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let (src, video) = (PathBuf::from(path), kind == db::VIDEO);
        if private {
            crate::private::ensure_sealed(&p, &cache, id, &src, &ext, video, mode)?.ok_or_else(|| "Private is locked".to_string())
        } else {
            thumbs::ensure(&cache, id, &src, &ext, video, mode)
        }
    })
    .await;
    match res {
        Ok(Ok(bytes)) => reply(StatusCode::OK, bytes, cache_ok),
        Ok(Err(e)) => reply(StatusCode::UNPROCESSABLE_ENTITY, e.into_bytes(), false),
        Err(_) => reply(StatusCode::INTERNAL_SERVER_ERROR, b"render panicked".to_vec(), false),
    }
}

fn mime(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "jpe" | "jfif" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        "heic" | "heif" => "image/heic",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "3gp" => "video/3gpp",
        "mts" | "m2ts" => "video/mp2t",
        _ => "application/octet-stream",
    }
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` (first range only), clamped to the file.
fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let s: u64 = a.parse().ok()?;
        (s, if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) })
    };
    (start <= end).then_some((start, end))
}

/// A private item's original file, uncached. Ranges are served in chunks of at most 8 MiB, so a video plays
/// and seeks without reading the whole file.
async fn original(req: &Request<Vec<u8>>, path: String, ext: String, kind: i64) -> Response<Vec<u8>> {
    const CHUNK: u64 = 8 << 20;
    const WHOLE: u64 = 64 << 20;
    let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let res = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<Option<(u64, u64, u64, Vec<u8>)>> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&path)?;
        let len = f.metadata()?.len();
        if len == 0 {
            return Ok(Some((0, 0, 0, vec![])));
        }
        let (start, end) = match range.as_deref() {
            Some(h) => match parse_range(h, len) {
                Some((s, e)) => (s, e.min(s + CHUNK - 1)),
                None => return Ok(None),
            },
            None => (0, if len <= WHOLE { len - 1 } else { CHUNK - 1 }),
        };
        f.seek(SeekFrom::Start(start))?;
        let mut buf = vec![0; (end - start + 1) as usize];
        f.read_exact(&mut buf)?;
        Ok(Some((start, end, len, buf)))
    })
    .await;
    let content_type = if kind == db::VIDEO && mime(&ext) == "application/octet-stream" { "video/mp4" } else { mime(&ext) };
    match res {
        Ok(Ok(Some((start, end, len, body)))) => {
            let partial = len > 0 && (req.headers().contains_key(header::RANGE) || end + 1 < len);
            let mut b = Response::builder()
                .status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::CONTENT_TYPE, content_type)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CACHE_CONTROL, "no-store");
            if partial {
                b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
            }
            b.body(body).unwrap()
        }
        Ok(Ok(None)) => reply(StatusCode::RANGE_NOT_SATISFIABLE, b"bad range".to_vec(), false),
        Ok(Err(e)) => reply(StatusCode::NOT_FOUND, e.to_string().into_bytes(), false),
        Err(_) => reply(StatusCode::INTERNAL_SERVER_ERROR, b"read panicked".to_vec(), false),
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

/// `thumb://localhost/layer/{hash}`: pixels made by an AI edit. A private photo's layers are sealed.
async fn layer(app: AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let hash = req.uri().path().trim_start_matches("/layer/").to_string();
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return reply(StatusCode::BAD_REQUEST, b"bad layer".to_vec(), false);
    }
    let Some(state) = app.try_state::<AppState>() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, b"starting".to_vec(), false);
    };
    let (dir, p) = (state.ai.layers.clone(), state.private.clone());
    let res = tauri::async_runtime::spawn_blocking(move || match std::fs::read(dir.join(format!("{hash}.png"))) {
        Ok(b) => Some((b, true)),
        Err(_) => std::fs::read(dir.join(format!("{hash}.sealed"))).ok().map(|b| (p.open(&b).unwrap_or_default(), false)),
    })
    .await;
    match res {
        Ok(Some((bytes, _))) if bytes.is_empty() => locked(),
        Ok(Some((bytes, plain))) => Response::builder()
            .status(StatusCode::OK)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, if plain { "public, max-age=31536000, immutable" } else { "no-store" })
            .body(bytes)
            .unwrap(),
        _ => reply(StatusCode::NOT_FOUND, b"missing layer".to_vec(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=200-", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
    }
}
