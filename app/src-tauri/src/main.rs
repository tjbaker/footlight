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
mod menu;
mod pcm_envelope;
mod render;
mod store;
mod subprocess;

use std::sync::atomic::Ordering;

use tauri::Manager;

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
            render::track,
            render::render,
            render::default_outdir,
            render::check_outdir,
            render::write_text_file,
            store::load_history,
            store::save_history,
            store::load_session,
            store::save_session,
            store::get_secret,
            store::set_secret,
            store::delete_secret,
            fonts::list_fonts,
            fonts::list_fonts_in_dir,
            menu::toggle_activity_window,
            menu::show_activity_window
        ])
        .setup(|app| {
            menu::install(app)?;
            Ok(())
        })
        // Closing the main window while a render runs asks first, rather than
        // closing the window and leaving the render running unseen.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && menu::quit_needs_confirmation() {
                    api.prevent_close();
                    menu::confirm_quit_during_render(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Footlight")
        .run(|app, event| match event {
            // An exit request (last window closed, `app.exit`) while a render
            // runs: ask first (#262).
            tauri::RunEvent::ExitRequested { api, .. } if menu::quit_needs_confirmation() => {
                api.prevent_exit();
                menu::confirm_quit_during_render(app);
            }
            // Leave no ffmpeg / node behind once the app is going. A render is
            // stopped only if the user confirmed; an OS-initiated terminate
            // (Dock > Quit, logout) arrives here without asking, and then a
            // running render is left to finish rather than killed silently.
            tauri::RunEvent::Exit => {
                subprocess::stop_all(menu::QUIT_CONFIRMED.load(Ordering::SeqCst));
            }
            _ => {}
        });
}
