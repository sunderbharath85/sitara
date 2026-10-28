//! Private: folders whose items show only after the user unlocks with a password.
//!
//! The vault is an X25519 key pair. Its secret half is stored twice, each copy wrapped with XChaCha20-Poly1305:
//! under a key derived from the password (Argon2id), and under one derived from the recovery key (BLAKE3; the
//! recovery key is random, so it needs no stretching). Nothing that could check a password is stored: unlocking
//! works when unwrapping does.
//!
//! Sitara's own renders of private items (thumbnails, previews, edit renders, AI layers) are sealed to the public
//! half, so the warmer makes them while Private is locked and only an unlocked session can read them. The secret
//! is held in memory only while unlocked. Originals stay where they are: Private hides items inside Sitara, it
//! doesn't encrypt the user's files.

use crate::db;
use crate::thumbs::{self, Mode};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use crypto_box::{PublicKey, SecretKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use zeroize::Zeroizing;

const AAD: &[u8] = b"sitara-private-v1";
/// Argon2id at 64 MiB, 3 passes, one lane: about half a second per try.
const KDF: &str = "argon2id;m=65536;t=3;p=1";
const RECOVERY_CONTEXT: &str = "sitara private recovery key v1";
/// Auto-lock choices offered in the UI, in seconds.
pub const IDLE_CHOICES: [i64; 4] = [60, 300, 900, 1800];
/// Wrong passwords allowed before each further try has to wait.
const FREE_TRIES: i64 = 5;
const MIN_PASSWORD: usize = 6;
/// Crockford base32: no I, L, O or U, so a written-down key reads back unambiguously.
const B32: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub struct Private {
    key: Mutex<Option<SecretKey>>,
    public: Mutex<Option<PublicKey>>,
    /// Last activity while unlocked, unix ms.
    last: AtomicI64,
    idle_ms: AtomicI64,
    lock_on_minimize: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub set_up: bool,
    pub unlocked: bool,
    pub idle_secs: i64,
    pub lock_on_minimize: bool,
    /// When the idle lock fires, unix ms.
    pub lock_at: Option<i64>,
    /// Unlock attempts are refused until then, unix ms.
    pub wait_until: Option<i64>,
    /// Empty while locked.
    pub dirs: Vec<db::PrivateDir>,
}

struct Vault {
    pk: Vec<u8>,
    kdf: String,
    salt: Vec<u8>,
    by_password: Vec<u8>,
    by_recovery: Vec<u8>,
    fails: i64,
    wait_until: i64,
}

fn vault(c: &Connection) -> Result<Option<Vault>, String> {
    c.query_row(
        "SELECT pk, kdf, salt, by_password, by_recovery, fails, wait_until FROM private_vault WHERE id=1",
        [],
        |r| {
            Ok(Vault {
                pk: r.get(0)?,
                kdf: r.get(1)?,
                salt: r.get(2)?,
                by_password: r.get(3)?,
                by_recovery: r.get(4)?,
                fails: r.get(5)?,
                wait_until: r.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn password_key(password: &str, salt: &[u8], kdf: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let num = |k: &str| -> Result<u32, String> {
        kdf.split(';')
            .find_map(|kv| kv.strip_prefix(k)?.strip_prefix('='))
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| format!("bad key settings {kdf}"))
    };
    if !kdf.starts_with("argon2id;") {
        return Err(format!("unknown key settings {kdf}"));
    }
    let params = Params::new(num("m")?, num("t")?, num("p")?, Some(32)).map_err(|e| e.to_string())?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn recovery_key(code: &[u8; 15]) -> Zeroizing<[u8; 32]> {
    Zeroizing::new(blake3::derive_key(RECOVERY_CONTEXT, code))
}

/// The secret, encrypted under `kek` and bound to the public key: nonce (24) then ciphertext.
fn wrap(kek: &Zeroizing<[u8; 32]>, sk: &SecretKey, pk: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let secret = Zeroizing::new(sk.to_bytes());
    let aad = [AAD, pk].concat();
    let ct = XChaCha20Poly1305::new(Key::from_slice(kek.as_slice()))
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: secret.as_slice(), aad: &aad })
        .expect("XChaCha20-Poly1305 encryption cannot fail for 32 bytes");
    [nonce.as_slice(), &ct].concat()
}

fn unwrap(kek: &Zeroizing<[u8; 32]>, blob: &[u8], pk: &[u8]) -> Option<SecretKey> {
    if blob.len() <= 24 {
        return None;
    }
    let (nonce, ct) = blob.split_at(24);
    let aad = [AAD, pk].concat();
    let pt = Zeroizing::new(
        XChaCha20Poly1305::new(Key::from_slice(kek.as_slice())).decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: &aad }).ok()?,
    );
    let sk = SecretKey::from_slice(&pt).ok()?;
    (sk.public_key().as_bytes().as_slice() == pk).then_some(sk)
}

/// 15 random bytes as 24 base32 symbols in six groups: "K7QM-3ZT9-8HWX-PQ2R-M4NB-VC6D".
fn encode_code(b: &[u8; 15]) -> String {
    let (mut bits, mut n, mut s) = (0u32, 0, String::with_capacity(29));
    for &x in b {
        bits = (bits << 8) | x as u32;
        n += 8;
        while n >= 5 {
            n -= 5;
            if !s.is_empty() && s.len() % 5 == 4 {
                s.push('-');
            }
            s.push(B32[((bits >> n) & 31) as usize] as char);
        }
        bits &= (1 << n) - 1;
    }
    s
}

/// Reads a recovery key back, forgiving case, dashes, spaces and the letters people confuse with digits.
fn decode_code(s: &str) -> Option<[u8; 15]> {
    let (mut bits, mut n, mut out) = (0u32, 0, Vec::with_capacity(15));
    for ch in s.chars().filter(|c| c.is_ascii_alphanumeric()) {
        let ch = match ch.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        bits = (bits << 5) | B32.iter().position(|&x| x as char == ch)? as u32;
        n += 5;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
            bits &= (1 << n) - 1;
        }
    }
    out.try_into().ok()
}

/// How long to refuse tries after `fails` wrong passwords in a row, ms.
fn backoff(fails: i64) -> i64 {
    match fails - FREE_TRIES {
        n if n < 0 => 0,
        0 => 30_000,
        1 => 60_000,
        2 => 300_000,
        _ => 900_000,
    }
}

fn wait_text(ms: i64) -> String {
    let s = (ms + 999) / 1000;
    if s < 90 { format!("{s} s") } else { format!("{} min", (s + 59) / 60) }
}

fn check_password(p: &str) -> Result<(), String> {
    if p.chars().count() < MIN_PASSWORD {
        return Err(format!("Use at least {MIN_PASSWORD} characters"));
    }
    Ok(())
}

impl Private {
    pub fn load(c: &Connection) -> Self {
        let row: Option<(Vec<u8>, i64, i64)> = c
            .query_row("SELECT pk, idle_secs, lock_on_minimize FROM private_vault WHERE id=1", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()
            .ok()
            .flatten();
        let public = row.as_ref().and_then(|r| PublicKey::from_slice(&r.0).ok());
        Private {
            key: Mutex::new(None),
            public: Mutex::new(public),
            last: AtomicI64::new(0),
            idle_ms: AtomicI64::new(row.as_ref().map(|r| r.1).unwrap_or(300) * 1000),
            lock_on_minimize: AtomicBool::new(row.is_some_and(|r| r.2 != 0)),
        }
    }

    pub fn set_up(&self) -> bool {
        self.public.lock().unwrap().is_some()
    }

    pub fn unlocked(&self) -> bool {
        self.key.lock().unwrap().is_some()
    }

    pub fn lock_on_minimize(&self) -> bool {
        self.lock_on_minimize.load(Ordering::Relaxed)
    }

    /// Encrypt to the vault's public key. Works while locked; None when Private isn't set up.
    pub fn seal(&self, bytes: &[u8]) -> Option<Vec<u8>> {
        self.public.lock().unwrap().as_ref()?.seal(&mut OsRng, bytes).ok()
    }

    /// Decrypt something `seal` made. None while locked.
    pub fn open(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        self.key.lock().unwrap().as_ref()?.unseal(sealed).ok()
    }

    fn unlock_with(&self, sk: SecretKey) {
        self.last.store(db::now_ms(), Ordering::Relaxed);
        *self.key.lock().unwrap() = Some(sk);
    }

    /// Create the vault; returns the recovery key, which is shown once. Leaves Private unlocked.
    pub fn setup(&self, c: &Connection, password: &str, idle_secs: i64) -> Result<String, String> {
        if vault(c)?.is_some() {
            return Err("Private is already set up".into());
        }
        check_password(password)?;
        let sk = SecretKey::generate(&mut OsRng);
        let pk = sk.public_key();
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let mut code = Zeroizing::new([0u8; 15]);
        OsRng.fill_bytes(code.as_mut());
        let by_password = wrap(&password_key(password, &salt, KDF)?, &sk, pk.as_bytes());
        let by_recovery = wrap(&recovery_key(&code), &sk, pk.as_bytes());
        let idle = if IDLE_CHOICES.contains(&idle_secs) { idle_secs } else { 300 };
        c.execute(
            "INSERT INTO private_vault(id, pk, kdf, salt, by_password, by_recovery, idle_secs) VALUES(1,?1,?2,?3,?4,?5,?6)",
            params![pk.as_bytes().as_slice(), KDF, salt.as_slice(), by_password, by_recovery, idle],
        )
        .map_err(|e| e.to_string())?;
        self.idle_ms.store(idle * 1000, Ordering::Relaxed);
        *self.public.lock().unwrap() = Some(pk);
        self.unlock_with(sk);
        Ok(encode_code(&code))
    }

    /// Run one unlock attempt with the wrong-password throttle around it.
    fn attempt(&self, c: &Connection, wrong: &str, f: impl FnOnce(&Vault) -> Option<SecretKey>) -> Result<SecretKey, String> {
        let v = vault(c)?.ok_or("Private isn't set up")?;
        let now = db::now_ms();
        if v.wait_until > now {
            return Err(format!("Too many tries. Try again in {}", wait_text(v.wait_until - now)));
        }
        if let Some(sk) = f(&v) {
            c.execute("UPDATE private_vault SET fails=0, wait_until=0 WHERE id=1", []).map_err(|e| e.to_string())?;
            return Ok(sk);
        }
        let fails = v.fails + 1;
        let wait = backoff(fails);
        c.execute("UPDATE private_vault SET fails=?1, wait_until=?2 WHERE id=1", params![fails, if wait > 0 { now + wait } else { 0 }])
            .map_err(|e| e.to_string())?;
        Err(if wait > 0 { format!("{wrong}. Try again in {}", wait_text(wait)) } else { wrong.to_string() })
    }

    pub fn unlock(&self, c: &Connection, password: &str) -> Result<(), String> {
        let sk = self.attempt(c, "Wrong password", |v| {
            unwrap(&password_key(password, &v.salt, &v.kdf).ok()?, &v.by_password, &v.pk)
        })?;
        self.unlock_with(sk);
        Ok(())
    }

    /// Forgot the password: the recovery key unlocks and sets a new one. The recovery key stays valid.
    pub fn recover(&self, c: &Connection, code: &str, password: &str) -> Result<(), String> {
        check_password(password)?;
        let code = Zeroizing::new(decode_code(code).ok_or("That doesn't look like a recovery key")?);
        let sk = self.attempt(c, "That recovery key doesn't match", |v| unwrap(&recovery_key(&code), &v.by_recovery, &v.pk))?;
        self.rewrap_password(c, &sk, password)?;
        self.unlock_with(sk);
        Ok(())
    }

    fn rewrap_password(&self, c: &Connection, sk: &SecretKey, password: &str) -> Result<(), String> {
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let pk = sk.public_key();
        let by_password = wrap(&password_key(password, &salt, KDF)?, sk, pk.as_bytes());
        c.execute(
            "UPDATE private_vault SET kdf=?1, salt=?2, by_password=?3 WHERE id=1",
            params![KDF, salt.as_slice(), by_password],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn change_password(&self, c: &Connection, current: &str, password: &str) -> Result<(), String> {
        check_password(password)?;
        let sk = self.attempt(c, "Wrong password", |v| {
            unwrap(&password_key(current, &v.salt, &v.kdf).ok()?, &v.by_password, &v.pk)
        })?;
        self.rewrap_password(c, &sk, password)?;
        self.unlock_with(sk);
        Ok(())
    }

    /// Replace the recovery key; the old one stops working.
    pub fn new_recovery_key(&self, c: &Connection, password: &str) -> Result<String, String> {
        let sk = self.attempt(c, "Wrong password", |v| {
            unwrap(&password_key(password, &v.salt, &v.kdf).ok()?, &v.by_password, &v.pk)
        })?;
        let mut code = Zeroizing::new([0u8; 15]);
        OsRng.fill_bytes(code.as_mut());
        let by_recovery = wrap(&recovery_key(&code), &sk, sk.public_key().as_bytes());
        c.execute("UPDATE private_vault SET by_recovery=?1 WHERE id=1", [by_recovery]).map_err(|e| e.to_string())?;
        self.unlock_with(sk);
        Ok(encode_code(&code))
    }

    /// Returns whether it was unlocked.
    pub fn lock(&self) -> bool {
        self.key.lock().unwrap().take().is_some()
    }

    /// Activity while unlocked pushes the idle lock back. Returns when it now fires.
    pub fn touch(&self) -> Option<i64> {
        if !self.unlocked() {
            return None;
        }
        self.last.store(db::now_ms(), Ordering::Relaxed);
        self.lock_at()
    }

    pub fn lock_at(&self) -> Option<i64> {
        self.unlocked().then(|| self.last.load(Ordering::Relaxed) + self.idle_ms.load(Ordering::Relaxed))
    }

    /// Lock if the idle time ran out; returns whether it locked.
    pub fn lock_if_idle(&self) -> bool {
        match self.lock_at() {
            Some(at) if db::now_ms() >= at => self.lock(),
            _ => false,
        }
    }

    pub fn settings(&self, c: &Connection, idle_secs: i64, lock_on_minimize: bool) -> Result<(), String> {
        if !IDLE_CHOICES.contains(&idle_secs) {
            return Err("Pick 1, 5, 15 or 30 minutes".into());
        }
        c.execute(
            "UPDATE private_vault SET idle_secs=?1, lock_on_minimize=?2 WHERE id=1",
            params![idle_secs, lock_on_minimize as i64],
        )
        .map_err(|e| e.to_string())?;
        self.idle_ms.store(idle_secs * 1000, Ordering::Relaxed);
        self.lock_on_minimize.store(lock_on_minimize, Ordering::Relaxed);
        Ok(())
    }

    /// Drop the vault (Reset Private). The caller removes the private items first.
    pub fn forget(&self, c: &Connection) -> Result<(), String> {
        c.execute("DELETE FROM private_vault", []).map_err(|e| e.to_string())?;
        self.lock();
        *self.public.lock().unwrap() = None;
        Ok(())
    }

    pub fn status(&self, c: &Connection) -> Result<Status, String> {
        let v = vault(c)?;
        let unlocked = self.unlocked();
        let now = db::now_ms();
        Ok(Status {
            set_up: v.is_some(),
            unlocked,
            idle_secs: self.idle_ms.load(Ordering::Relaxed) / 1000,
            lock_on_minimize: self.lock_on_minimize(),
            lock_at: self.lock_at(),
            wait_until: v.as_ref().map(|v| v.wait_until).filter(|&w| w > now),
            dirs: if unlocked { db::private_dir_infos(c).map_err(|e| e.to_string())? } else { vec![] },
        })
    }
}

/// A private item's render: the sealed cache file opened (None while locked), or rendered, sealed and cached.
pub fn ensure_sealed(p: &Private, cache: &Path, id: i64, src: &Path, ext: &str, video: bool, mode: Mode) -> Result<Option<Vec<u8>>, String> {
    let out = thumbs::sealed(&thumbs::cache_file(cache, id, mode));
    if let Ok(b) = std::fs::read(&out) {
        return Ok(p.open(&b));
    }
    let bytes = thumbs::render(src, ext, video, mode)?;
    thumbs::write_atomic(&out, &p.seal(&bytes).ok_or("Private isn't set up")?);
    Ok(Some(bytes))
}

/// AI layer hashes an edit stack refers to.
fn layer_hashes(stack: &str) -> Vec<&str> {
    stack.split(|c: char| !c.is_ascii_hexdigit()).filter(|w| w.len() == 64).collect()
}

/// Items just made private: their cached renders and edit layers are sealed, and the plain copies deleted.
pub fn seal_renders(p: &Private, c: &Connection, cache: &Path, layers: &Path, ids: &[i64]) {
    let seal = |plain: &Path| {
        let Ok(b) = std::fs::read(plain) else { return };
        if let Some(s) = p.seal(&b) {
            thumbs::write_atomic(&thumbs::sealed(plain), &s);
        }
        let _ = std::fs::remove_file(plain);
    };
    for &id in ids {
        thumbs::renders(cache, id).iter().for_each(|f| seal(f));
        if let Ok(Some(stack)) = db::edit_get(c, id) {
            layer_hashes(&stack).into_iter().for_each(|h| seal(&layers.join(format!("{h}.png"))));
        }
    }
}

/// Items made public again: sealed renders and layers are opened back into plain ones. Without the key
/// (shouldn't happen: making an item public needs Private unlocked) they're dropped and rendered afresh.
pub fn open_renders(p: &Private, c: &Connection, cache: &Path, layers: &Path, ids: &[i64]) {
    let open = |plain: &Path| {
        let sealed = thumbs::sealed(plain);
        let Ok(b) = std::fs::read(&sealed) else { return };
        if let Some(bytes) = p.open(&b) {
            thumbs::write_atomic(plain, &bytes);
        }
        let _ = std::fs::remove_file(sealed);
    };
    for &id in ids {
        thumbs::renders(cache, id).iter().for_each(|f| open(f));
        if let Ok(Some(stack)) = db::edit_get(c, id) {
            layer_hashes(&stack).into_iter().for_each(|h| open(&layers.join(format!("{h}.png"))));
        }
    }
}

/// Lock when the Windows session locks or the machine goes to sleep.
#[cfg(windows)]
pub fn on_session_lock(window: &tauri::WebviewWindow, f: impl Fn() + Send + 'static) {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{PBT_APMSUSPEND, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK};

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, data: usize) -> LRESULT {
        let locking = (msg == WM_WTSSESSION_CHANGE && wp.0 as u32 == WTS_SESSION_LOCK)
            || (msg == WM_POWERBROADCAST && wp.0 as u32 == PBT_APMSUSPEND);
        if locking {
            let f = unsafe { &*(data as *const Box<dyn Fn() + Send>) };
            f();
        }
        unsafe { DefSubclassProc(hwnd, msg, wp, lp) }
    }

    let Ok(hwnd) = window.hwnd() else { return };
    // lives as long as the window; the app has one main window for its whole run
    let data = Box::into_raw(Box::new(Box::new(f) as Box<dyn Fn() + Send>)) as usize;
    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(proc), 0x5175, data);
        if let Err(e) = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) {
            eprintln!("private: session notifications: {e}");
        }
    }
}

/// Drop the webview's disk cache, which may hold renders of items from before they were made private.
pub fn clear_webview_cache(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    let _ = window.with_webview(|w| unsafe {
        use webview2_com::ClearBrowsingDataCompletedHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile2, ICoreWebView2_13, COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
        };
        use windows::core::Interface;
        let res = (|| -> windows::core::Result<()> {
            let profile = w.controller().CoreWebView2()?.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile2>()?;
            profile.ClearBrowsingData(
                COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
                &ClearBrowsingDataCompletedHandler::create(Box::new(|_| Ok(()))),
            )
        })();
        if let Err(e) = res {
            eprintln!("private: clear webview cache: {e}");
        }
    });
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        c
    }

    #[test]
    fn recovery_codes_round_trip_and_forgive_typos() {
        let b: [u8; 15] = core::array::from_fn(|i| (i * 37 + 11) as u8);
        let s = encode_code(&b);
        assert_eq!(s.len(), 29);
        assert_eq!(s.matches('-').count(), 5);
        assert_eq!(decode_code(&s), Some(b));
        let sloppy = s.to_lowercase().replace('-', " ").replace('0', "o").replace('1', "l");
        assert_eq!(decode_code(&sloppy), Some(b));
        assert_eq!(decode_code(&s[..20]), None, "too short");
        assert_eq!(decode_code("UUUU-UUUU-UUUU-UUUU-UUUU-UUUU"), None, "not in the alphabet");
    }

    #[test]
    fn password_unlocks_seals_and_wrong_ones_are_throttled() {
        let c = lib();
        let p = Private::load(&c);
        assert!(!p.set_up() && !p.unlocked());
        assert!(p.setup(&c, "12345", 300).is_err(), "too short");
        let code = p.setup(&c, "correct horse", 300).unwrap();
        assert!(p.unlocked());
        let sealed = p.seal(b"pixels").unwrap();
        assert_ne!(sealed, b"pixels");
        assert_eq!(p.open(&sealed).as_deref(), Some(&b"pixels"[..]));

        p.lock();
        assert_eq!(p.open(&sealed), None, "locked: nothing opens");
        assert!(p.seal(b"more").is_some(), "the warmer can still seal while locked");

        // a fresh session (restart) reads the vault back
        let p = Private::load(&c);
        for _ in 0..FREE_TRIES - 1 {
            assert_eq!(p.unlock(&c, "wrong horse").unwrap_err(), "Wrong password");
        }
        assert!(p.unlock(&c, "wrong horse").unwrap_err().contains("Try again in 30 s"));
        assert!(p.unlock(&c, "correct horse").unwrap_err().starts_with("Too many tries"), "even the right one waits");
        c.execute("UPDATE private_vault SET wait_until=0", []).unwrap();
        p.unlock(&c, "correct horse").unwrap();
        assert_eq!(p.open(&sealed).as_deref(), Some(&b"pixels"[..]));
        let fails: i64 = c.query_row("SELECT fails FROM private_vault", [], |r| r.get(0)).unwrap();
        assert_eq!(fails, 0, "success resets the count");

        // forgot the password: the recovery key sets a new one, and the same key still opens old renders
        p.lock();
        assert!(p.recover(&c, "0000-0000-0000-0000-0000-0000", "new password").is_err());
        p.recover(&c, &code.to_lowercase(), "new password").unwrap();
        assert_eq!(p.open(&sealed).as_deref(), Some(&b"pixels"[..]));
        p.lock();
        assert!(p.unlock(&c, "correct horse").is_err(), "old password is gone");
        p.unlock(&c, "new password").unwrap();

        p.change_password(&c, "new password", "third one").unwrap();
        let fresh = p.new_recovery_key(&c, "third one").unwrap();
        p.lock();
        assert!(p.recover(&c, &code, "fourth one").is_err(), "the replaced recovery key stops working");
        p.recover(&c, &fresh, "fourth one").unwrap();
        assert_eq!(p.open(&sealed).as_deref(), Some(&b"pixels"[..]));
    }

    #[test]
    fn idle_lock_and_settings() {
        let c = lib();
        let p = Private::load(&c);
        p.setup(&c, "a long password", 60).unwrap();
        assert!(p.settings(&c, 61, false).is_err());
        p.settings(&c, 900, true).unwrap();
        assert!(Private::load(&c).lock_on_minimize(), "settings persist");
        assert!(!p.lock_if_idle());
        p.last.store(db::now_ms() - 901_000, Ordering::Relaxed);
        assert!(p.lock_if_idle());
        assert!(!p.unlocked() && p.touch().is_none());
        p.forget(&c).unwrap();
        assert!(!p.set_up() && p.seal(b"x").is_none());
        assert!(!p.status(&c).unwrap().set_up);
    }
}
