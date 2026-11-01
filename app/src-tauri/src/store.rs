// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Persisted app state: the render history and working session (JSON files in
//! the app config dir, read with corrupt-file recovery and written atomically)
//! and the OS-keychain secret store behind the frontend's `secretStore` seam.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Keyring service name for the secretStore commands. MUST match the bundle
/// identifier in tauri.conf.json (`com.tjbaker.footlight`) so stored secrets are
/// namespaced to this app in the OS keychain.
const KEYRING_SERVICE: &str = "com.tjbaker.footlight";

/// Path to the persisted render-history file inside the app config dir, creating
/// the config dir if it does not yet exist.
fn history_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app config dir: {e}"))?;
    Ok(dir.join("history.json"))
}

/// Read a persisted JSON file, falling back to `T::default()` when it is missing.
/// An UNPARSEABLE file (e.g. truncated by a crash mid-write from an older build,
/// possibly mid-UTF-8 sequence) also yields the default, so one bad file can't
/// wedge the feature for good (#263); it is first renamed aside to
/// `<name>.corrupt` so the bytes aren't silently destroyed. Any OTHER read error
/// (permissions, I/O) is returned, not defaulted — the file may be fine, and a
/// default would let the next save clobber it. Bytes are parsed directly, so
/// invalid UTF-8 counts as corrupt, not unreadable. Mirrors `readJsonOrDefault`
/// in app/dev-server/server.mjs — keep the two in parity.
fn read_json_or_default<T: serde::de::DeserializeOwned + Default>(
    path: &std::path::Path,
) -> Result<T, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(value),
        Err(_) => {
            // Best effort: if the rename fails the default is still returned and
            // the next atomic save replaces the bad file.
            let _ = std::fs::rename(path, corrupt_path(path));
            Ok(T::default())
        }
    }
}

/// `<path>.corrupt` — where `read_json_or_default` moves an unparseable file.
fn corrupt_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".corrupt");
    std::path::PathBuf::from(name)
}

/// Serialize `value` and replace `path` ATOMICALLY: write a uniquely named temp
/// file in the same directory, flush it to disk, then rename it over `path`. A
/// crash mid-write leaves the previous file intact, never a truncated one (#263).
/// Mirrors `writeJsonAtomic` in app/dev-server/server.mjs.
fn write_json_atomic<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
    use std::io::Write;
    let body = serde_json::to_string(value).map_err(|e| format!("serialize: {e}"))?;
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    // Dropped (and deleted) on any early return, so no partial temp file lingers.
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| format!("create temp: {e}"))?;
    tmp.write_all(body.as_bytes())
        .map_err(|e| format!("write temp: {e}"))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("sync temp: {e}"))?;
    tmp.persist(path)
        .map_err(|e| format!("replace {}: {}", path.display(), e.error))?;
    Ok(())
}

/// Load the persisted render history. A missing or corrupt file yields an empty
/// list (see `read_json_or_default`); the frontend owns capping/ordering.
/// Entries are opaque JSON (the TS HistoryEntry shape) so Rust does not mirror
/// the type.
#[tauri::command]
pub(crate) async fn load_history(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    read_json_or_default(&history_path(&app)?).map_err(|e| format!("load history: {e}"))
}

/// Persist the full render-history array to the app config dir (atomically).
#[tauri::command]
pub(crate) async fn save_history(
    app: AppHandle,
    entries: Vec<serde_json::Value>,
) -> Result<(), String> {
    write_json_atomic(&history_path(&app)?, &entries).map_err(|e| format!("save history: {e}"))
}

/// Path to the persisted working-session file inside the app config dir, creating
/// the config dir if it does not yet exist.
fn session_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app config dir: {e}"))?;
    Ok(dir.join("session.json"))
}

/// Load the persisted working session. A missing or corrupt file yields `None`
/// (see `read_json_or_default`); the session is opaque JSON (the TS SessionData
/// shape) so Rust does not mirror the type.
#[tauri::command]
pub(crate) async fn load_session(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    read_json_or_default(&session_path(&app)?).map_err(|e| format!("load session: {e}"))
}

/// Persist the working session to the app config dir (atomically).
#[tauri::command]
pub(crate) async fn save_session(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    write_json_atomic(&session_path(&app)?, &data).map_err(|e| format!("save session: {e}"))
}

/// Build a keyring entry for `key` under this app's service. The platform
/// secretStore seam (app/src/platform/tauri.ts) maps `getSecret`/`setSecret`/
/// `deleteSecret` to the three commands below.
fn secret_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, key).map_err(|e| format!("keyring entry: {e}"))
}

/// Read a secret. For the Gemini BYOK key, an environment variable
/// (`GEMINI_API_KEY` / `FOOTLIGHT_GEMINI_API_KEY`) takes precedence and is
/// returned WITHOUT touching the OS keychain — so launching from a shell with
/// the var set both overrides a stored key and avoids the keychain prompt.
/// Otherwise read from the keychain; a missing entry is `None`, not an error.
#[tauri::command]
pub(crate) async fn get_secret(key: String) -> Result<Option<String>, String> {
    if key == "footlight.apiKey.gemini" {
        for var in ["GEMINI_API_KEY", "FOOTLIGHT_GEMINI_API_KEY"] {
            if let Ok(v) = std::env::var(var) {
                if !v.trim().is_empty() {
                    return Ok(Some(v));
                }
            }
        }
    }
    let entry = secret_entry(&key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("read secret: {e}")),
    }
}

/// Store (or overwrite) a secret in the OS keychain.
#[tauri::command]
pub(crate) async fn set_secret(key: String, value: String) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    entry
        .set_password(&value)
        .map_err(|e| format!("write secret: {e}"))
}

/// Delete a secret from the OS keychain. A missing entry is treated as success
/// so callers can delete idempotently.
#[tauri::command]
pub(crate) async fn delete_secret(key: String) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete secret: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- history / session persistence (#263) ----------------------------

    /// A truncated/corrupt history file loads as the default instead of an
    /// error, and is preserved as `<name>.corrupt` rather than destroyed.
    #[test]
    fn read_json_or_default_recovers_from_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        std::fs::write(&path, "[{\"id\":\"a\"").unwrap();
        let entries: Vec<serde_json::Value> = read_json_or_default(&path).unwrap();
        assert!(entries.is_empty());
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("history.json.corrupt")).unwrap(),
            "[{\"id\":\"a\""
        );
        // Same for the session: an empty (truncated) file -> None.
        let session = dir.path().join("session.json");
        std::fs::write(&session, "").unwrap();
        let data: Option<serde_json::Value> = read_json_or_default(&session).unwrap();
        assert!(data.is_none());
        assert!(dir.path().join("session.json.corrupt").exists());
    }

    /// A crash can truncate mid multi-byte character (accented caption text):
    /// invalid UTF-8 is corrupt, not "unreadable" — the bytes are kept aside.
    #[test]
    fn read_json_or_default_keeps_a_file_truncated_mid_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let full = "{\"title\":\"caf\u{e9}\"}".as_bytes().to_vec();
        let cut = &full[..full.len() - 3]; // ends inside the 2-byte 'é'
        assert!(std::str::from_utf8(cut).is_err());
        std::fs::write(&path, cut).unwrap();
        let data: Option<serde_json::Value> = read_json_or_default(&path).unwrap();
        assert!(data.is_none());
        assert_eq!(
            std::fs::read(dir.path().join("session.json.corrupt")).unwrap(),
            cut
        );
    }

    /// A read error other than NotFound is surfaced, not defaulted, and the
    /// file is left in place (a default would let the next save clobber it).
    #[test]
    fn read_json_or_default_surfaces_other_read_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        std::fs::create_dir(&path).unwrap(); // reading a directory fails
        assert!(read_json_or_default::<Vec<serde_json::Value>>(&path).is_err());
        assert!(path.is_dir());
        assert!(!dir.path().join("history.json.corrupt").exists());
    }

    /// Valid JSON of the wrong shape (an object where history wants an array)
    /// is treated as corrupt too, matching the web backend.
    #[test]
    fn read_json_or_default_treats_a_wrong_shape_as_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        std::fs::write(&path, "{}").unwrap();
        let entries: Vec<serde_json::Value> = read_json_or_default(&path).unwrap();
        assert!(entries.is_empty());
        assert!(dir.path().join("history.json.corrupt").exists());
    }

    #[test]
    fn read_json_or_default_missing_file_is_default_and_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let data: Option<serde_json::Value> = read_json_or_default(&path).unwrap();
        assert!(data.is_none());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    /// An atomic write replaces the old contents, round-trips through
    /// `read_json_or_default`, and leaves no temp file behind.
    #[test]
    fn write_json_atomic_replaces_and_leaves_no_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        std::fs::write(&path, "old").unwrap();
        let entries = vec![serde_json::json!({"id": "a", "ts": 1})];
        write_json_atomic(&path, &entries).unwrap();
        let back: Vec<serde_json::Value> = read_json_or_default(&path).unwrap();
        assert_eq!(back, entries);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("history.json")]);
    }

    /// A failed write (target dir gone) errors and leaves nothing behind.
    #[test]
    fn write_json_atomic_failure_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("session.json");
        assert!(write_json_atomic(&path, &serde_json::json!({"a": 1})).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
