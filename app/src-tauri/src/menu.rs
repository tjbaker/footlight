// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The native menu bar (rebuilt standard macOS menus plus the Help items), the
//! separate Activity window, and asking before a quit that would stop a render.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::subprocess;

const REPO_URL: &str = "https://github.com/tjbaker/footlight";
const ISSUES_NEW_URL: &str = "https://github.com/tjbaker/footlight/issues/new";

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
pub(crate) fn toggle_activity_window(app: AppHandle) -> Result<bool, String> {
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
pub(crate) fn show_activity_window(app: AppHandle) -> Result<(), String> {
    let win = match app.get_webview_window("activity") {
        Some(w) => w,
        None => build_activity_window(&app)?,
    };
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// Set once the user has confirmed quitting during a render, so the quit that
/// follows isn't asked about again.
pub(crate) static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);
/// Set while the quit dialog is up, so a second close / Cmd-Q doesn't stack a
/// second dialog.
static QUIT_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

/// Whether a quit (or a main-window close) must ask first: a render is running
/// and the user hasn't already said to stop it. Renders are never stopped
/// silently (#262); everything else stops on quit without asking.
pub(crate) fn quit_needs_confirmation() -> bool {
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
pub(crate) fn confirm_quit_during_render(app: &AppHandle) {
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

/// Build and install the app's menu bar and route its events (`main`'s setup).
pub(crate) fn install(app: &mut tauri::App) -> tauri::Result<()> {
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
}
