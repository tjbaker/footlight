// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Footlight native (Tauri) shell.
//!
//! Mirrors the Node dev backend (app/dev-server/server.mjs): each
//! `#[tauri::command]` shells out to ffmpeg / ffprobe / the footlight CLI via
//! the async `subprocess::run_output` (see subprocess.rs for who may stop a
//! child, and when), so the frontend's `tauriPlatform` adapter has the
//! exact same capabilities as `webPlatform`. The native Help menu mirrors the
//! in-app Help dropdown (About / Report a Bug / View on GitHub).
//!
//! NOTE: this requires the Rust toolchain (rustup + `cargo tauri`) to build and
//! was NOT compiled in the environment where it was authored — see README.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cover;
mod fonts;
mod media;
mod pcm_envelope;
mod store;
mod subprocess;

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tokio::process::Command;

use crate::media::unique_temp_path;
use crate::subprocess::{run_output, Kind};

const REPO_URL: &str = "https://github.com/tjbaker/footlight";
const ISSUES_NEW_URL: &str = "https://github.com/tjbaker/footlight/issues/new";

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

/// Locate a subject across sample times (AI subject tracking, SPEC §6.9). Writes
/// the request to a temp `.json`, shells the footlight CLI's `track` command,
/// and parses its stdout (a `TrackSample[]` JSON) back to the frontend. The CLI
/// prints ONLY the samples on stdout; `mock:true` in the request runs offline.
#[tauri::command]
async fn track(app: AppHandle, req: serde_json::Value) -> Result<serde_json::Value, String> {
    // Per-call temp file, deleted when `req_path` drops at the end of the call.
    let _hold = subprocess::hold(Kind::Analysis); // outlives `req_path`
    let req_path = unique_temp_path("footlight_track_", ".json")?;
    let body = serde_json::to_string(&req).map_err(|e| format!("serialize track request: {e}"))?;
    std::fs::write(&req_path, body).map_err(|e| format!("write temp track request: {e}"))?;

    let cli = locate_cli(&app);
    let mut cmd = Command::new("node");
    cmd.arg(&cli).arg("track").arg(&req_path);
    let output = run_output(cmd, "node CLI", Kind::Analysis).await?;

    if !output.status.success() {
        return Err(format!(
            "track failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("track returned unparseable output: {e}"))
}

/// The render CLI inputs: a hand mirror of `RenderCliOptions` in
/// src/render-args.ts (the Tauri shell cannot import TS). `Deserialize` lets the
/// tests read the shared `test/fixtures/render-cli-args.json` cases verbatim.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderCliOpts {
    manifest_path: String,
    out_dir: String,
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
}

/// Build the footlight CLI `render` argv (everything after `node <cli>`):
/// manifest path, the Settings-derived flags, then `--outdir` LAST so the log's
/// trailing `--outdir <dir>` parses cleanly on the client. Documented mirror of
/// `renderCliArgs` in src/render-args.ts, pinned to its fixtures: numbers are
/// emitted whenever present (0 included), strings only when non-empty, toggles
/// only when `true`.
fn render_cli_args(o: RenderCliOpts) -> Vec<String> {
    fn value(args: &mut Vec<String>, flag: &str, v: Option<String>) {
        if let Some(v) = v.filter(|v| !v.is_empty()) {
            args.push(flag.into());
            args.push(v);
        }
    }
    fn toggle(args: &mut Vec<String>, flag: &str, v: Option<bool>) {
        if v == Some(true) {
            args.push(flag.into());
        }
    }
    let mut args: Vec<String> = vec!["render".into(), o.manifest_path];
    // A formatted number is never empty, so `value` forwards every number.
    value(&mut args, "--crf", o.crf.map(|c| c.to_string()));
    value(&mut args, "--preset", o.preset);
    value(&mut args, "--audio-bitrate", o.audio_bitrate);
    toggle(&mut args, "--dry-run", o.dry_run);
    toggle(&mut args, "--burn-captions", o.burn_captions);
    value(&mut args, "--caption-font", o.caption_font);
    value(&mut args, "--caption-color", o.caption_color);
    value(
        &mut args,
        "--caption-outline-color",
        o.caption_outline_color,
    );
    toggle(&mut args, "--caption-bold", o.caption_bold);
    toggle(&mut args, "--caption-italic", o.caption_italic);
    toggle(&mut args, "--caption-underline", o.caption_underline);
    toggle(&mut args, "--caption-shadow", o.caption_shadow);
    toggle(&mut args, "--caption-box", o.caption_box);
    value(&mut args, "--caption-box-color", o.caption_box_color);
    value(
        &mut args,
        "--caption-angle",
        o.caption_angle.map(|a| a.to_string()),
    );
    args.push("--outdir".into());
    args.push(o.out_dir);
    args
}

/// Render a JSON manifest: write it to a temp `.json` file and invoke the
/// footlight CLI. The CLI auto-detects the JSON path by the `.json` extension,
/// which lets clips carry an eased `cropPath` the CSV path can't express. The
/// CLI is resolved relative to the bundled resources; in dev it sits at the
/// repo's `bin/footlight.js`.
// The argument list IS the IPC contract the frontend's Tauri backend invokes
// (kept in sync with the web dev backend), so it stays flat and is folded into
// `RenderCliOpts` below.
#[allow(clippy::too_many_arguments)]
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
    // Per-call temp file (the `.json` suffix makes the CLI take the JSON
    // manifest path), deleted when `manifest_path` drops at the end of the call.
    let _hold = subprocess::hold(Kind::Render); // outlives `manifest_path`
    let manifest_path = unique_temp_path("footlight_manifest_", ".json")?;
    std::fs::write(&manifest_path, manifest_json)
        .map_err(|e| format!("write temp manifest: {e}"))?;

    let cli = locate_cli(&app);
    let out_dir = resolve_outdir(&cli, outdir);

    // Render flags from Settings -> CLI (see render_cli_args for the shape).
    let args = render_cli_args(RenderCliOpts {
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        out_dir,
        crf,
        preset,
        audio_bitrate,
        dry_run,
        burn_captions,
        caption_font,
        caption_color,
        caption_outline_color,
        caption_bold,
        caption_italic,
        caption_underline,
        caption_shadow,
        caption_box,
        caption_box_color,
        caption_angle,
    });

    // Kind::Render: quitting while this runs asks first (see `main`).
    let mut cmd = Command::new("node");
    cmd.arg(&cli).args(&args);
    let output = run_output(cmd, "node CLI", Kind::Render).await?;

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

/// Write `content` to `path` (a user-chosen file from the Save dialog) — used by
/// the queue → manifest export. The path is the user's explicit choice, so this
/// just writes UTF-8 text and surfaces a friendly error on failure.
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))
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

/// Set once the user has confirmed quitting during a render, so the quit that
/// follows isn't asked about again.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);
/// Set while the quit dialog is up, so a second close / Cmd-Q doesn't stack a
/// second dialog.
static QUIT_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

/// Whether a quit (or a main-window close) must ask first: a render is running
/// and the user hasn't already said to stop it. Renders are never stopped
/// silently (#262); everything else stops on quit without asking.
fn quit_needs_confirmation() -> bool {
    subprocess::render_running() && !QUIT_CONFIRMED.load(Ordering::SeqCst)
}

/// Quit from the app's own Quit item: ask first while a render runs, else
/// exit now. Footlight's menu uses a custom Quit item rather than the
/// predefined one because the predefined item sends macOS `terminate:`, which
/// tao turns straight into `RunEvent::Exit` with no `ExitRequested` to
/// intercept (#262).
fn request_quit(app: &AppHandle) {
    if quit_needs_confirmation() {
        confirm_quit_during_render(app);
    } else {
        app.exit(0);
    }
}

/// Ask whether to quit while a render is running. "Quit" exits (which stops the
/// render via `RunEvent::Exit`); "Keep Rendering" leaves everything as it was.
fn confirm_quit_during_render(app: &AppHandle) {
    use tauri_plugin_dialog::{
        DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
    };
    // "Keep Rendering" is the first (default, Return) button so a reflexive
    // Enter never stops a render; only an explicit "Quit" does. Closing the
    // dialog any other way keeps rendering too.
    const KEEP: &str = "Keep Rendering";
    const QUIT: &str = "Quit";
    if QUIT_PROMPT_OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(
            "A render is still running. Quitting now stops it and leaves that clip unfinished.",
        )
        .title("Quit Footlight?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            KEEP.into(),
            QUIT.into(),
        ))
        .show_with_result(move |result| {
            QUIT_PROMPT_OPEN.store(false, Ordering::SeqCst);
            if result == MessageDialogResult::Custom(QUIT.into()) {
                QUIT_CONFIRMED.store(true, Ordering::SeqCst);
                handle.exit(0);
            }
        });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            media::extract_frame,
            cover::export_cover,
            media::probe,
            media::scenes,
            media::loudness,
            track,
            render,
            default_outdir,
            check_outdir,
            write_text_file,
            store::load_history,
            store::save_history,
            store::load_session,
            store::save_session,
            store::get_secret,
            store::set_secret,
            store::delete_secret,
            fonts::list_fonts,
            fonts::list_fonts_in_dir,
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
            // Quit is a custom item (see `request_quit`) so quitting during a
            // render asks first.
            let quit = MenuItemBuilder::with_id("app_quit", "Quit Footlight")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;
            let settings = MenuItemBuilder::with_id("app_settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            // The single About item, in the standard macOS location (the app menu).
            // It opens the in-app Settings → About panel (the one source of truth)
            // rather than the generic system panel.
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
                .item(&quit)
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
                "app_quit" => request_quit(app),
                "help_guide" => {
                    let _ = app.emit("show-guide", ());
                }
                "help_about" => {
                    // Ask the frontend to open Settings → About (single source of truth).
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
        // Closing the main window while a render runs asks first, rather than
        // closing the window and leaving the render running unseen.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && quit_needs_confirmation() {
                    api.prevent_close();
                    confirm_quit_during_render(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Footlight")
        .run(|app, event| match event {
            // An exit request (last window closed, `app.exit`) while a render
            // runs: ask first (#262).
            tauri::RunEvent::ExitRequested { api, .. } if quit_needs_confirmation() => {
                api.prevent_exit();
                confirm_quit_during_render(app);
            }
            // Leave no ffmpeg / node behind once the app is going. A render is
            // stopped only if the user confirmed; an OS-initiated terminate
            // (Dock > Quit, logout) arrives here without asking, and then a
            // running render is left to finish rather than killed silently.
            tauri::RunEvent::Exit => {
                subprocess::stop_all(QUIT_CONFIRMED.load(Ordering::SeqCst));
            }
            _ => {}
        });
}

// Unit tests for the pure pieces of the shell: the hand-mirrored ffmpeg/ffprobe
// arg builders and output parsers, plus the path helpers. Where a piece mirrors
// src/core.ts, the test mirrors the corresponding vitest case (cited per test)
// with the SAME inputs and expected values, so drift between the two
// implementations fails one suite or the other.
#[cfg(test)]
mod tests {
    use super::*;

    // --- render -----------------------------------------------------------

    /// The SAME cases test/render-args.test.ts runs against `renderCliArgs` in
    /// src/render-args.ts, read from the shared JSON so drift fails here.
    #[test]
    fn render_cli_args_matches_shared_fixtures() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../../test/fixtures/render-cli-args.json"))
                .unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap().to_string();
            let opts: RenderCliOpts = serde_json::from_value(case["opts"].clone()).unwrap();
            let want: Vec<String> = serde_json::from_value(case["argv"].clone()).unwrap();
            assert_eq!(render_cli_args(opts), want, "case {name:?}");
        }
    }

    // --- path helpers -----------------------------------------------------

    #[test]
    fn resolve_outdir_keeps_absolute_paths_verbatim() {
        assert_eq!(
            resolve_outdir("/repo/bin/footlight.js", Some("/abs/clips".into())),
            "/abs/clips"
        );
    }

    /// A relative outdir resolves against the repo root (two levels up from the
    /// located `<root>/bin/footlight.js`), defaulting to `clips`.
    #[test]
    fn resolve_outdir_resolves_relative_against_repo_root() {
        assert_eq!(
            resolve_outdir("/repo/bin/footlight.js", None),
            "/repo/clips"
        );
        assert_eq!(
            resolve_outdir("/repo/bin/footlight.js", Some("out".into())),
            "/repo/out"
        );
    }

    /// A bare CLI path (no repo root to walk up to) falls back to the raw value.
    #[test]
    fn resolve_outdir_bare_cli_falls_back_to_raw() {
        assert_eq!(resolve_outdir("footlight.js", None), "clips");
    }

    #[test]
    fn friendly_fs_error_maps_kinds_to_friendly_reasons() {
        use std::io::{Error, ErrorKind};
        assert_eq!(
            friendly_fs_error(&Error::from(ErrorKind::PermissionDenied)),
            "permission denied"
        );
        assert_eq!(
            friendly_fs_error(&Error::from(ErrorKind::NotFound)),
            "the parent folder does not exist"
        );
        assert_eq!(
            friendly_fs_error(&Error::from(ErrorKind::TimedOut)),
            "it could not be created"
        );
    }
}
