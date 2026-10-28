//! Downloads for the optional AI pack: streamed to disk with progress, checked against pinned SHA-256
//! digests before they are used. The Windows runtime is pulled out of Microsoft's release zip with
//! HTTP range requests, so only the one library is transferred, not the whole archive.

use flate2::read::{DeflateDecoder, GzDecoder};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

/// `(bytes done, bytes total)`; total is 0 when unknown.
pub type Progress<'a> = &'a dyn Fn(u64, u64);

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent("Sitara (https://github.com/sunderbharath85/sitara)")
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_recv_body(Some(Duration::from_secs(60)))
        .build()
        .into()
}

/// Copy `r` into `dest` (via a temp file), hashing as it goes; the file only appears if the digest matches.
fn save(mut r: impl Read, dest: &Path, sha256: &str, total: u64, progress: Progress) -> Result<(), String> {
    let tmp = dest.with_extension("part");
    let mut f = File::create(&tmp).map_err(es)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut done = 0u64;
    loop {
        let n = r.read(&mut buf).map_err(es)?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n]).map_err(es)?;
        h.update(&buf[..n]);
        done += n as u64;
        progress(done, total);
    }
    f.sync_all().map_err(es)?;
    drop(f);
    let got = hex(&h.finalize());
    if !sha256.is_empty() && got != sha256 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("download check failed for {} (got {got})", dest.display()));
    }
    std::fs::rename(&tmp, dest).map_err(es)
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
pub fn sha256_file(p: &Path) -> Option<String> {
    let mut f = File::open(p).ok()?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h).ok()?;
    Some(hex(&h.finalize()))
}

/// A whole file.
pub fn file(url: &str, dest: &Path, sha256: &str, progress: Progress) -> Result<(), String> {
    let mut resp = agent().get(url).call().map_err(es)?;
    let total = resp.body().content_length().unwrap_or(0);
    save(resp.body_mut().as_reader(), dest, sha256, total, progress)
}

fn range(url: &str, from: u64, to_incl: u64) -> Result<Vec<u8>, String> {
    let mut resp = agent().get(url).header("Range", format!("bytes={from}-{to_incl}")).call().map_err(es)?;
    if resp.status().as_u16() != 206 {
        return Err("the server doesn't support partial downloads".into());
    }
    resp.body_mut().with_config().limit(64 << 20).read_to_vec().map_err(es)
}

fn u16le(b: &[u8], o: usize) -> u64 {
    u16::from_le_bytes([b[o], b[o + 1]]) as u64
}
fn u32le(b: &[u8], o: usize) -> u64 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as u64
}

/// One member of a remote zip, found through its central directory and fetched by byte range.
pub fn zip_member(url: &str, suffix: &str, dest: &Path, sha256: &str, progress: Progress) -> Result<(), String> {
    // learn the size, then read the end-of-central-directory record from the last 22..65557 bytes
    let mut resp = agent().get(url).header("Range", "bytes=0-0").call().map_err(es)?;
    let total: u64 = resp
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('/').next())
        .and_then(|v| v.parse().ok())
        .ok_or("the server doesn't support partial downloads")?;
    let _ = resp.body_mut().read_to_vec();
    let tail = range(url, total.saturating_sub(65557), total - 1)?;
    let eocd = (0..tail.len().saturating_sub(21)).rev().find(|&i| tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06]).ok_or("not a zip")?;
    let (cd_size, cd_off) = (u32le(&tail, eocd + 12), u32le(&tail, eocd + 16));
    if cd_off == 0xFFFF_FFFF || cd_off + cd_size > total {
        return Err("unsupported zip layout".into());
    }
    let cd = range(url, cd_off, cd_off + cd_size - 1)?;
    let mut p = 0usize;
    while p + 46 <= cd.len() && cd[p..p + 4] == [0x50, 0x4b, 0x01, 0x02] {
        let method = u16le(&cd, p + 10);
        let csize = u32le(&cd, p + 20);
        let usize_ = u32le(&cd, p + 24);
        let (n, e, c) = (u16le(&cd, p + 28) as usize, u16le(&cd, p + 30) as usize, u16le(&cd, p + 32) as usize);
        let local = u32le(&cd, p + 42);
        let name = String::from_utf8_lossy(&cd[p + 46..p + 46 + n]).replace('\\', "/");
        if name.ends_with(suffix) {
            let head = range(url, local, local + 29)?;
            if head[0..4] != [0x50, 0x4b, 0x03, 0x04] {
                return Err("corrupt zip entry".into());
            }
            let start = local + 30 + u16le(&head, 26) + u16le(&head, 28);
            let mut resp = agent().get(url).header("Range", format!("bytes={start}-{}", start + csize - 1)).call().map_err(es)?;
            let raw = resp.body_mut().as_reader();
            return match method {
                0 => save(raw, dest, sha256, usize_, progress),
                8 => save(DeflateDecoder::new(raw), dest, sha256, usize_, progress),
                m => Err(format!("unsupported zip compression {m}")),
            };
        }
        p += 46 + n + e + c;
    }
    Err(format!("{suffix} not found in the archive"))
}

/// One regular file from a remote .tgz, streamed (the whole archive is read, only the member is kept).
pub fn tgz_member(url: &str, suffix: &str, dest: &Path, sha256: &str, progress: Progress) -> Result<(), String> {
    let mut resp = agent().get(url).call().map_err(es)?;
    let total = resp.body().content_length().unwrap_or(0);
    struct Count<'a, R: Read> {
        r: R,
        n: u64,
        total: u64,
        f: Progress<'a>,
    }
    impl<R: Read> Read for Count<'_, R> {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            let k = self.r.read(b)?;
            self.n += k as u64;
            (self.f)(self.n, self.total);
            Ok(k)
        }
    }
    let counted = Count { r: resp.body_mut().as_reader(), n: 0, total, f: progress };
    let mut ar = tar::Archive::new(GzDecoder::new(counted));
    for entry in ar.entries().map_err(es)? {
        let entry = entry.map_err(es)?;
        let path = entry.path().map_err(es)?.to_string_lossy().replace('\\', "/");
        if entry.header().entry_type().is_file() && path.ends_with(suffix) {
            return save(entry, dest, sha256, 0, &|_, _| {});
        }
    }
    Err(format!("{suffix} not found in the archive"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Prints the digests to pin for every platform's runtime library (network; run on demand).
    #[test]
    #[ignore]
    fn runtime_digests() {
        let base = "https://github.com/microsoft/onnxruntime/releases/download/v1.31.0";
        let dir = std::env::temp_dir().join("sitara-ort-pins");
        std::fs::create_dir_all(&dir).unwrap();
        for (archive, member) in [
            ("onnxruntime-win-x64-1.31.0.zip", "lib/onnxruntime.dll"),
            ("onnxruntime-win-arm64-1.31.0.zip", "lib/onnxruntime.dll"),
            ("onnxruntime-linux-x64-1.31.0.tgz", "lib/libonnxruntime.so.1.31.0"),
            ("onnxruntime-linux-aarch64-1.31.0.tgz", "lib/libonnxruntime.so.1.31.0"),
            ("onnxruntime-osx-arm64-1.31.0.tgz", "lib/libonnxruntime.1.31.0.dylib"),
        ] {
            let dest = dir.join(archive.replace('.', "_"));
            let url = format!("{base}/{archive}");
            let r = if archive.ends_with(".zip") {
                zip_member(&url, member, &dest, "", &|_, _| {})
            } else {
                tgz_member(&url, member, &dest, "", &|_, _| {})
            };
            let len = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            println!("{archive} {member}: {r:?} {len} {}", sha256_file(&dest).unwrap_or_default());
        }
    }
}
