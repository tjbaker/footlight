// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Footlight native (Tauri) shell.
//!
//! Mirrors the Node dev backend (app/dev-server/server.mjs): each
//! `#[tauri::command]` shells out to ffmpeg / ffprobe / the footlight CLI via
//! `std::process::Command`, so the frontend's `tauriPlatform` adapter has the
//! exact same capabilities as `webPlatform`. The native Help menu mirrors the
//! in-app Help dropdown (About / Report a Bug / View on GitHub).
//!
//! The ffmpeg/ffprobe arg arrays and output parsers below are a HAND MIRROR of
//! the canonical pure builders in src/core.ts (frameExtractArgs, ffprobeStreamArgs
//! / parseProbe, cropdetectArgs / parseCropdetect, scenesArgs / parseScenes) — the
//! CLI and the Node dev server import those directly; Rust can't, so keep this in
//! sync when they change.
//!
//! NOTE: this requires the Rust toolchain (rustup + `cargo tauri`) to build and
//! was NOT compiled in the environment where it was authored — see README.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;

use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const REPO_URL: &str = "https://github.com/tjbaker/footlight";
const ISSUES_NEW_URL: &str = "https://github.com/tjbaker/footlight/issues/new";

/// Keyring service name for the secretStore commands. MUST match the bundle
/// identifier in tauri.conf.json (`com.tjbaker.footlight`) so stored secrets are
/// namespaced to this app in the OS keychain.
const KEYRING_SERVICE: &str = "com.tjbaker.footlight";

#[derive(Serialize)]
struct ProbeResult {
    width: u32,
    height: u32,
    duration: f64,
    cropdetect: Option<String>,
}

#[derive(Serialize)]
struct RenderResult {
    ok: bool,
    log: String,
}

#[derive(Serialize)]
struct OutdirCheck {
    ok: bool,
    resolved: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Extract a single accurate frame at `t` seconds; write a temp JPEG and return
/// its absolute path (the frontend wraps it with the Tauri asset protocol).
/// Accuracy comes from ffmpeg INPUT-seek (`-ss` before `-i`) per displayed frame.
// NOTE: these commands shell out to ffmpeg/ffprobe/node and can run for many
// seconds (cropdetect, scene decode, a full render, or an Auto-track pass). They
// MUST be `async`: in Tauri a synchronous command runs on the main thread and
// freezes the entire UI (the spinning-beachball hang) until it returns. Marking
// them `async` makes Tauri run them off the main thread so the window stays live.
#[tauri::command]
async fn extract_frame(source: String, t: f64) -> Result<String, String> {
    let mut path = std::env::temp_dir();
    path.push(format!("footlight_frame_{}.jpg", std::process::id()));
    let out = path.to_string_lossy().to_string();

    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            &t.to_string(),
            "-i",
            &source,
            "-frames:v",
            "1",
            "-q:v",
            "3",
            &out,
        ])
        .status()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !status.success() {
        return Err("ffmpeg frame extraction failed".into());
    }
    Ok(out)
}

/// Probe width, height, duration via ffprobe + a cropdetect (black-bar) hint.
#[tauri::command]
async fn probe(source: String) -> Result<ProbeResult, String> {
    let probe_out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "json",
            &source,
        ])
        .output()
        .map_err(|e| format!("failed to spawn ffprobe: {e}"))?;

    if !probe_out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&probe_out.stderr)
        ));
    }

    let json: serde_json::Value = serde_json::from_slice(&probe_out.stdout)
        .map_err(|e| format!("ffprobe returned unparseable output: {e}"))?;

    let stream = json
        .get("streams")
        .and_then(|s| s.get(0))
        .cloned()
        .unwrap_or_default();
    let width = stream.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let height = stream.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    // cropdetect — black bars only (mirrors the dev server / CLI).
    let cd = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-ss",
            "60",
            "-i",
            &source,
            "-vf",
            "cropdetect=limit=24:round=2",
            "-frames:v",
            "300",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
    let stderr = String::from_utf8_lossy(&cd.stderr);
    let cropdetect = last_crop_suggestion(&stderr);

    Ok(ProbeResult {
        width,
        height,
        duration,
        cropdetect,
    })
}

/// Detect scene-cut timestamps (seconds), mirroring the CLI's scenes command.
#[tauri::command]
async fn scenes(source: String) -> Result<Vec<f64>, String> {
    let out = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-i",
            &source,
            "-vf",
            "scale=-2:144,select='gt(scene,0.4)',showinfo",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    let stderr = String::from_utf8_lossy(&out.stderr);
    let mut times = Vec::new();
    for token in stderr.split("pts_time:").skip(1) {
        let num: String = token
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if let Ok(t) = num.parse::<f64>() {
            times.push((t * 1000.0).round() / 1000.0);
        }
    }
    Ok(times)
}

#[derive(Serialize)]
struct LoudnessResult {
    display: Vec<f64>,
    detect: Vec<f64>,
}

/// Compute the timeline's two loudness envelopes (0..1) in ONE ffmpeg pass.
/// Mirrors core.ts `loudnessCombinedArgs` + `parseEbur128Momentary`/`bucketLufs`
/// (display) + `bucketLoudness` (detect); Rust can't import the TS. The ebur128
/// analysis filter passes audio through, so the same run logs per-frame momentary
/// LUFS to stderr (→ `display`, the perceptual bars) AND emits mono 8 kHz f32le
/// PCM on stdout (→ `detect`, the raw-energy RMS the swell detector needs). Keep
/// LOUDNESS_BUCKETS (160) and the LUFS floor/ceiling in sync with core.ts.
#[tauri::command]
async fn loudness(source: String) -> Result<LoudnessResult, String> {
    // Keep these in sync with core.ts LOUDNESS_BUCKETS / LUFS_FLOOR / LUFS_CEIL.
    const LOUDNESS_BUCKETS: usize = 160;
    const LUFS_FLOOR: f64 = -40.0;
    const LUFS_CEIL: f64 = -5.0;

    // Same args as core.ts loudnessCombinedArgs.
    let out = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-nostats",
            // verbose REQUIRED: ebur128 prints per-frame `M:` only above `info`.
            "-loglevel",
            "verbose",
            "-i",
            &source,
            "-af",
            "ebur128=metadata=1",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "f32le",
            "-",
        ])
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    // --- display: per-frame momentary `M:` LUFS from stderr (mirrors bucketLufs).
    let log = String::from_utf8_lossy(&out.stderr);
    let mut momentary: Vec<f64> = Vec::new();
    for line in log.lines() {
        if let Some(idx) = line.find("M:") {
            let tok = line[idx + 2..].trim_start().split_whitespace().next().unwrap_or("");
            // Non-finite readings (-inf/nan over silence / startup) -> floor.
            momentary.push(tok.parse::<f64>().unwrap_or(f64::NEG_INFINITY));
        }
    }

    if !out.status.success() && momentary.is_empty() && out.stdout.is_empty() {
        return Err(format!("loudness failed: {log}"));
    }

    // Map one LUFS reading to 0..1 over [floor, ceil]; non-finite -> 0.
    let norm = |lufs: f64| -> f64 {
        if !lufs.is_finite() {
            return 0.0;
        }
        ((lufs - LUFS_FLOOR) / (LUFS_CEIL - LUFS_FLOOR)).clamp(0.0, 1.0)
    };

    let mn = momentary.len();
    let mut display = vec![0.0f64; LOUDNESS_BUCKETS];
    if mn > 0 {
        for (b, slot) in display.iter_mut().enumerate() {
            let start = (b * mn) / LOUDNESS_BUCKETS;
            let end = ((b + 1) * mn) / LOUDNESS_BUCKETS;
            let mut sum = 0.0f64;
            let mut count = 0usize;
            for v in &momentary[start..end] {
                if v.is_finite() {
                    sum += norm(*v);
                    count += 1;
                }
            }
            *slot = if count > 0 { sum / count as f64 } else { 0.0 };
        }
    }

    // --- detect: RMS of the mono f32le PCM on stdout (mirrors bucketLoudness:
    // per-window RMS, then normalize the whole array to 0..1 by its max).
    let bytes = &out.stdout;
    let sn = bytes.len() / 4;
    let samples: Vec<f32> = (0..sn)
        .map(|i| {
            let b = &bytes[i * 4..i * 4 + 4];
            f32::from_le_bytes([b[0], b[1], b[2], b[3]])
        })
        .collect();
    let mut detect = vec![0.0f64; LOUDNESS_BUCKETS];
    if sn > 0 {
        for (b, slot) in detect.iter_mut().enumerate() {
            let start = (b * sn) / LOUDNESS_BUCKETS;
            let end = ((b + 1) * sn) / LOUDNESS_BUCKETS;
            let count = end - start;
            let mut sum_sq = 0.0f64;
            for s in &samples[start..end] {
                let v = *s as f64;
                sum_sq += v * v;
            }
            *slot = if count > 0 { (sum_sq / count as f64).sqrt() } else { 0.0 };
        }
        let max = detect.iter().cloned().fold(0.0f64, f64::max);
        if max > 0.0 {
            for v in detect.iter_mut() {
                *v /= max;
            }
        }
    }

    Ok(LoudnessResult { display, detect })
}

/// Locate a subject across sample times (AI subject tracking, SPEC §6.9). Writes
/// the request to a temp `.json`, shells the footlight CLI's `track` command,
/// and parses its stdout (a `TrackSample[]` JSON) back to the frontend. The CLI
/// prints ONLY the samples on stdout; `mock:true` in the request runs offline.
#[tauri::command]
async fn track(app: AppHandle, req: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut req_path = std::env::temp_dir();
    req_path.push(format!("footlight_track_{}.json", std::process::id()));
    let body = serde_json::to_string(&req).map_err(|e| format!("serialize track request: {e}"))?;
    std::fs::write(&req_path, body).map_err(|e| format!("write temp track request: {e}"))?;

    let cli = locate_cli(&app);
    let output = Command::new("node")
        .arg(&cli)
        .arg("track")
        .arg(&req_path)
        .output()
        .map_err(|e| format!("failed to spawn node CLI: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "track failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("track returned unparseable output: {e}"))
}

/// Render a JSON manifest: write it to a temp `.json` file and invoke the
/// footlight CLI. The CLI auto-detects the JSON path by the `.json` extension,
/// which lets clips carry an eased `cropPath` the CSV path can't express. The
/// CLI is resolved relative to the bundled resources; in dev it sits at the
/// repo's `bin/footlight.js`.
#[tauri::command]
async fn render(
    app: AppHandle,
    manifest_json: String,
    outdir: Option<String>,
    crf: Option<i64>,
    preset: Option<String>,
    audio_bitrate: Option<String>,
    dry_run: Option<bool>,
    burn_captions: Option<bool>,
    caption_font: Option<String>,
    caption_color: Option<String>,
    caption_outline_color: Option<String>,
    caption_bold: Option<bool>,
    caption_italic: Option<bool>,
    caption_underline: Option<bool>,
    caption_shadow: Option<bool>,
    caption_box: Option<bool>,
    caption_box_color: Option<String>,
    caption_angle: Option<f64>,
) -> Result<RenderResult, String> {
    let mut manifest_path = std::env::temp_dir();
    manifest_path.push(format!("footlight_manifest_{}.json", std::process::id()));
    std::fs::write(&manifest_path, manifest_json)
        .map_err(|e| format!("write temp manifest: {e}"))?;

    let cli = locate_cli(&app);
    let out_dir = resolve_outdir(&cli, outdir);

    // Render flags from Settings -> CLI. --outdir is appended LAST so the log's
    // trailing `--outdir <dir>` parses cleanly on the client.
    let mut args: Vec<String> = vec!["render".into(), manifest_path.to_string_lossy().into_owned()];
    if let Some(c) = crf {
        args.push("--crf".into());
        args.push(c.to_string());
    }
    if let Some(p) = preset {
        if !p.is_empty() {
            args.push("--preset".into());
            args.push(p);
        }
    }
    if let Some(a) = audio_bitrate {
        if !a.is_empty() {
            args.push("--audio-bitrate".into());
            args.push(a);
        }
    }
    if dry_run.unwrap_or(false) {
        args.push("--dry-run".into());
    }
    if burn_captions == Some(true) {
        args.push("--burn-captions".into());
    }
    if let Some(f) = caption_font {
        args.push("--caption-font".into());
        args.push(f);
    }
    if let Some(c) = caption_color {
        if !c.is_empty() {
            args.push("--caption-color".into());
            args.push(c);
        }
    }
    if let Some(c) = caption_outline_color {
        if !c.is_empty() {
            args.push("--caption-outline-color".into());
            args.push(c);
        }
    }
    if caption_bold == Some(true) {
        args.push("--caption-bold".into());
    }
    if caption_italic == Some(true) {
        args.push("--caption-italic".into());
    }
    if caption_underline == Some(true) {
        args.push("--caption-underline".into());
    }
    if caption_shadow == Some(true) {
        args.push("--caption-shadow".into());
    }
    if caption_box == Some(true) {
        args.push("--caption-box".into());
    }
    if let Some(c) = caption_box_color {
        if !c.is_empty() {
            args.push("--caption-box-color".into());
            args.push(c);
        }
    }
    if let Some(a) = caption_angle {
        args.push("--caption-angle".into());
        args.push(a.to_string());
    }
    args.push("--outdir".into());
    args.push(out_dir.clone());

    let output = Command::new("node")
        .arg(&cli)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to spawn node CLI: {e}"))?;

    let log = format!(
        "$ node {} {}\n\n{}{}",
        cli,
        args.join(" "),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    Ok(RenderResult {
        ok: output.status.success(),
        log,
    })
}

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

/// Load the persisted render history. A missing file yields an empty list; the
/// frontend owns capping/ordering. Entries are opaque JSON (the TS HistoryEntry
/// shape) so Rust does not mirror the type.
#[tauri::command]
async fn load_history(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let path = history_path(&app)?;
    let body = match std::fs::read_to_string(&path) {
        Ok(b) => b,
        Err(_) => return Ok(vec![]),
    };
    serde_json::from_str(&body).map_err(|e| format!("parse history: {e}"))
}

/// Persist the full render-history array to the app config dir.
#[tauri::command]
async fn save_history(app: AppHandle, entries: Vec<serde_json::Value>) -> Result<(), String> {
    let path = history_path(&app)?;
    let body = serde_json::to_string(&entries).map_err(|e| format!("serialize history: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write history: {e}"))?;
    Ok(())
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

/// Load the persisted working session. A missing file yields `None`; the session
/// is opaque JSON (the TS SessionData shape) so Rust does not mirror the type.
#[tauri::command]
async fn load_session(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = session_path(&app)?;
    let body = match std::fs::read_to_string(&path) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    let value = serde_json::from_str(&body).map_err(|e| format!("parse session: {e}"))?;
    Ok(Some(value))
}

/// Persist the working session to the app config dir.
#[tauri::command]
async fn save_session(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = session_path(&app)?;
    let body = serde_json::to_string(&data).map_err(|e| format!("serialize session: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write session: {e}"))?;
    Ok(())
}

/// One installed font family for the caption picker. Family-only is enough —
/// CoreText / fontconfig resolve a `Fontname` by name at render time — so `path`
/// is always `None` here (the web/dev backend fills it from fontconfig).
#[derive(Serialize)]
struct FontInfoDto {
    family: String,
    path: Option<String>,
}

/// Enumerate system font families via font-kit (CoreText on macOS, DirectWrite
/// on Windows, fontconfig on Linux), deduped and sorted case-insensitively.
/// Best-effort: any enumeration error yields an empty list so the picker falls
/// back to the free-text font field rather than failing.
#[tauri::command]
async fn list_fonts() -> Result<Vec<FontInfoDto>, String> {
    let mut families = match font_kit::source::SystemSource::new().all_families() {
        Ok(f) => f,
        Err(_) => return Ok(vec![]),
    };
    families.sort_by_key(|f| f.to_lowercase());
    families.dedup();
    Ok(families
        .into_iter()
        .map(|family| FontInfoDto { family, path: None })
        .collect())
}

/// Recursively collect font-file paths (`.ttf`/`.otf`/`.ttc`) under `dir`,
/// bounded by depth/count so a pathological tree can't wedge the walk.
/// Best-effort: unreadable sub-directories are skipped silently.
fn collect_font_files(dir: &std::path::Path, depth: usize, acc: &mut Vec<std::path::PathBuf>) {
    const MAX_DEPTH: usize = 8;
    const MAX_FILES: usize = 5000;
    if depth > MAX_DEPTH || acc.len() >= MAX_FILES {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // unreadable directory — skip.
    };
    for entry in entries.flatten() {
        if acc.len() >= MAX_FILES {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_font_files(&path, depth + 1, acc);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_lowercase().as_str(), "ttf" | "otf" | "ttc"))
            .unwrap_or(false)
        {
            acc.push(path);
        }
    }
}

/// Scan a user fonts folder for `.ttf`/`.otf`/`.ttc`, loading each file with
/// font-kit to read its real family name, returning a deduped (by `family+path`)
/// list sorted case-insensitively by family. Unlike `list_fonts`, `path` is
/// populated here so the caller can reference the exact file. An empty or
/// unreadable directory yields an empty list rather than an error.
#[tauri::command]
async fn list_fonts_in_dir(dir: String) -> Result<Vec<FontInfoDto>, String> {
    if dir.is_empty() {
        return Ok(vec![]);
    }
    let mut files = Vec::new();
    collect_font_files(std::path::Path::new(&dir), 0, &mut files);

    let mut seen = std::collections::HashSet::new();
    let mut fonts: Vec<FontInfoDto> = Vec::new();
    for file in files {
        let family = match font_kit::handle::Handle::from_path(file.clone(), 0).load() {
            Ok(font) => font.family_name(),
            Err(_) => continue, // unreadable/unsupported font file — skip.
        };
        if family.is_empty() {
            continue;
        }
        let path = file.to_string_lossy().to_string();
        if !seen.insert(format!("{family} {path}")) {
            continue;
        }
        fonts.push(FontInfoDto {
            family,
            path: Some(path),
        });
    }
    fonts.sort_by(|a, b| a.family.to_lowercase().cmp(&b.family.to_lowercase()));
    Ok(fonts)
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
async fn get_secret(key: String) -> Result<Option<String>, String> {
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
async fn set_secret(key: String, value: String) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    entry
        .set_password(&value)
        .map_err(|e| format!("write secret: {e}"))
}

/// Delete a secret from the OS keychain. A missing entry is treated as success
/// so callers can delete idempotently.
#[tauri::command]
async fn delete_secret(key: String) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete secret: {e}")),
    }
}

/// Build the separate Activity window. Its own close button HIDES it (rather than
/// destroying it) and emits `activity-hidden` so the main window keeps the toggle
/// state in sync — and reopening is instant.
fn build_activity_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let win = WebviewWindowBuilder::new(app, "activity", WebviewUrl::App("activity.html".into()))
        .title("Footlight — Activity")
        .inner_size(700.0, 420.0)
        .min_inner_size(320.0, 180.0)
        .build()
        .map_err(|e| e.to_string())?;
    let w = win.clone();
    let app2 = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = w.hide();
            let _ = app2.emit("activity-hidden", ());
        }
    });
    Ok(win)
}

/// Toggle the Activity window: hide it if shown, show (or create) it if not.
/// Returns whether it is now visible so the main window can sync its toggle.
/// Synchronous so window creation runs on the main thread.
#[tauri::command]
fn toggle_activity_window(app: AppHandle) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window("activity") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return Ok(false);
        }
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(true);
    }
    let win = build_activity_window(&app)?;
    let _ = win.set_focus();
    Ok(true)
}

/// Reveal the Activity window (create if needed) — used to surface failures.
#[tauri::command]
fn show_activity_window(app: AppHandle) -> Result<(), String> {
    let win = match app.get_webview_window("activity") {
        Some(w) => w,
        None => build_activity_window(&app)?,
    };
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// Resolve a render outdir. An absolute path is used verbatim; a relative one
/// (the default `clips`) is resolved against the REPO ROOT — the directory two
/// levels up from the located CLI (`<root>/bin/footlight.js`) — so GUI renders
/// land in the project-root `clips/` next to the CLI's own output, NOT in the
/// Tauri process cwd (which under `cargo tauri dev` is `app/src-tauri/`, where
/// clips would silently pile up out of sight). Mirrors the dev server's
/// REPO_ROOT handling in app/dev-server/server.mjs — keep the two in sync.
///
/// NOTE: in a packaged `.app` the CLI sits at `<resources>/engine/bin/...`, so a
/// relative outdir would resolve under the read-only bundle; packaged builds
/// should pass an absolute outdir.
fn resolve_outdir(cli: &str, outdir: Option<String>) -> String {
    let raw = outdir.unwrap_or_else(|| "clips".into());
    if std::path::Path::new(&raw).is_absolute() {
        return raw;
    }
    if let Some(root) = std::path::Path::new(cli)
        .parent() // <root>/bin
        .and_then(|bin| bin.parent())
    {
        return root.join(&raw).to_string_lossy().to_string();
    }
    raw
}

/// The default render output folder for a fresh install: a `footlight` folder in
/// `~/Movies` (the macOS video folder, the natural home for rendered clips),
/// resolved via Tauri's path API. Falls back to the repo-relative `clips` if that
/// dir can't be determined. Used only to seed an empty Outdir field; a path the
/// user set always wins (issue #58).
#[tauri::command]
fn default_outdir(app: AppHandle) -> String {
    app.path()
        .video_dir()
        .map(|d| d.join("footlight").to_string_lossy().into_owned())
        .unwrap_or_else(|_| "clips".into())
}

/// A short, user-facing reason for a filesystem error (no raw errno/OS string).
fn friendly_fs_error(err: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::PermissionDenied => "permission denied".into(),
        ErrorKind::NotFound => "the parent folder does not exist".into(),
        _ => "it could not be created".into(),
    }
}

/// Validate the render output folder before rendering: resolve it exactly like
/// `render` does, create it if missing, and confirm it is writable (a write probe,
/// since creating an already-existing read-only dir succeeds). Returns the resolved
/// absolute path plus a friendly reason on failure, so the GUI can warn up front
/// instead of surfacing a raw EACCES mid-render (issue #58).
#[tauri::command]
fn check_outdir(app: AppHandle, outdir: Option<String>) -> OutdirCheck {
    let cli = locate_cli(&app);
    let resolved = resolve_outdir(&cli, outdir);
    if let Err(e) = std::fs::create_dir_all(&resolved) {
        return OutdirCheck {
            ok: false,
            resolved,
            error: Some(friendly_fs_error(&e)),
        };
    }
    let probe = std::path::Path::new(&resolved).join(".footlight_write_test");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            OutdirCheck {
                ok: true,
                resolved,
                error: None,
            }
        }
        Err(e) => OutdirCheck {
            ok: false,
            resolved,
            error: Some(friendly_fs_error(&e)),
        },
    }
}

/// Find the footlight CLI. Resolution order:
///   1. `FOOTLIGHT_CLI` env override.
///   2. The bundled resource at `<resourceDir>/engine/bin/footlight.js` (works
///      in a double-clicked `.app`, where cwd is `/`). The companion engine
///      `dist/` is bundled alongside it at `engine/dist`, so `footlight.js`'s
///      relative `../dist/cli.js` import still resolves.
///   3. Walk up from the current dir looking for `bin/footlight.js` (dev mode,
///      `tauri dev`, where the repo tree is intact).
fn locate_cli(app: &AppHandle) -> String {
    if let Ok(p) = std::env::var("FOOTLIGHT_CLI") {
        return p;
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled = res_dir.join("engine").join("bin").join("footlight.js");
        if bundled.exists() {
            return bundled.to_string_lossy().to_string();
        }
    }
    let mut dir = std::env::current_dir().unwrap_or_default();
    for _ in 0..6 {
        let candidate = dir.join("bin").join("footlight.js");
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
        if !dir.pop() {
            break;
        }
    }
    "footlight.js".into()
}

/// Pull the LAST `crop=W:H:X:Y` suggestion out of cropdetect stderr.
fn last_crop_suggestion(stderr: &str) -> Option<String> {
    let mut last = None;
    for token in stderr.split("crop=").skip(1) {
        let candidate: String = token
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == ':')
            .collect();
        if candidate.matches(':').count() == 3 {
            last = Some(candidate);
        }
    }
    last
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            extract_frame,
            probe,
            scenes,
            loudness,
            track,
            render,
            default_outdir,
            check_outdir,
            load_history,
            save_history,
            load_session,
            save_session,
            get_secret,
            set_secret,
            delete_secret,
            list_fonts,
            list_fonts_in_dir,
            toggle_activity_window,
            show_activity_window
        ])
        .setup(|app| {
            // Setting ANY custom menu replaces the entire default menu bar, so we
            // must rebuild the standard macOS menus by hand — otherwise Quit
            // (Cmd-Q), copy/paste, and window controls all disappear. We use the
            // SubmenuBuilder convenience methods (predefined OS items) for those
            // and append our custom Help submenu mirroring the in-app dropdown.

            // App menu (macOS shows it titled with the app name). Holds Quit/Cmd-Q
            // and the standard Settings… (Cmd-,) item, which opens the in-app modal.
            let settings = MenuItemBuilder::with_id("app_settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            // The single About item, in the standard macOS location (the app menu).
            // It opens the in-app About modal rather than the generic system panel.
            let about = MenuItemBuilder::with_id("help_about", "About Footlight").build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Footlight")
                .item(&about)
                .separator()
                .item(&settings)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let file_menu = SubmenuBuilder::new(app, "File").close_window().build()?;

            // Edit menu — needed for cut/copy/paste in the source-path field.
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .close_window()
                .build()?;

            // Custom Help menu (About lives in the app menu, macOS-style — not here).
            let guide = MenuItemBuilder::with_id("help_guide", "User Guide").build(app)?;
            let bug = MenuItemBuilder::with_id("help_bug", "Report a Bug").build(app)?;
            let gh = MenuItemBuilder::with_id("help_github", "View on GitHub").build(app)?;
            let help = SubmenuBuilder::new(app, "Help")
                .item(&guide)
                .item(&bug)
                .item(&gh)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .item(&help)
                .build()?;
            app.set_menu(menu)?;

            app.on_menu_event(move |app, event| match event.id().as_ref() {
                "app_settings" => {
                    let _ = app.emit("show-settings", ());
                }
                "help_guide" => {
                    let _ = app.emit("show-guide", ());
                }
                "help_about" => {
                    // Ask the frontend to show its About modal (single source of truth).
                    let _ = app.emit("show-about", ());
                }
                "help_bug" => {
                    let _ = app.opener().open_url(ISSUES_NEW_URL, None::<&str>);
                }
                "help_github" => {
                    let _ = app.opener().open_url(REPO_URL, None::<&str>);
                }
                _ => {}
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Footlight");
}
