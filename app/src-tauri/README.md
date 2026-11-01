# Footlight — Tauri (native) shell

This directory is the **native desktop shell** for Footlight. It **needs the Rust
toolchain to build** — which the engine, CLI, and browser GUI do not. If you only
have Node + ffmpeg, use `make gui` for the browser UI; install Rust (below) to
build the native window.

## Requirements to build

- [Rust toolchain](https://rustup.rs) (`rustup`, `cargo`)
- Tauri v2 CLI: `cargo install tauri-cli --version "^2"` (or use the
  `@tauri-apps/cli` devDependency already in `app/package.json`, via `npx tauri`)
- `ffmpeg`, `ffprobe`, and `node` on `PATH` at runtime (the commands shell out to them)
- The footlight CLI built at the repo root (`npm run build` there, producing
  `dist/` alongside `bin/footlight.js`) — both dev mode and the production bundle
  need it

## Build / run

From `app/` (or `make tauri-dev` / `make tauri-build` from the repo root, which
also build the engine and install the GUI dependencies first):

```bash
# dev (hot-reloads the Vite frontend in a native window)
cargo tauri dev      # or: npx tauri dev

# production bundle
cargo tauri build    # or: npx tauri build
```

`tauri.conf.json` runs `npm run dev` / `npm run build` for the frontend and points
`frontendDist` at the Vite `../dist` output.

## What the native side does

`src/main.rs` registers 21 `#[tauri::command]`s — the native half of the
`FootlightPlatform` interface, mirroring the Node dev backend in
`../dev-server/server.mjs`. They live in modules by area, each with its tests
beside it:

- **media** (`src/media.rs`) — `extract_frame`, `probe`, `scenes`, `loudness`
  (shell out to ffmpeg/ffprobe);
- **cover** (`src/cover.rs`) — `export_cover`, plus the crop mirrors pinned to
  `test/fixtures/{timestamps,crop}.json`;
- **engine** (`src/render.rs`) — `track`, `render` (run the footlight CLI under
  `node`), `default_outdir`, `check_outdir`, `write_text_file`;
- **persistence** (`src/store.rs`) — `load_history`, `save_history`,
  `load_session`, `save_session`;
- **fonts** (`src/fonts.rs`) — `list_fonts`, `list_fonts_in_dir`;
- **secrets** (`src/store.rs`; OS keychain, for BYOK provider keys) —
  `get_secret`, `set_secret`, `delete_secret`;
- **windows** (`src/menu.rs`) — `toggle_activity_window`, `show_activity_window`.

Subprocesses run through one async helper, `run_output` in `src/subprocess.rs`
(`tokio::process`), so a long render never ties up the threads other commands
need. Quitting stops every ffmpeg / node child the app started, including the
CLI's own ffmpeg (each child runs in its own process group on Unix; Windows
uses `taskkill /T`). If a render is running, Quit (Cmd-Q) and closing the main
window ask first, so a render is never stopped silently. A quit macOS sends
without asking (Dock > Quit, logout) leaves a running render to finish.
The frontend selects this backend
automatically when running inside the Tauri webview (`__TAURI__` present on
`window`).

The native menu mirrors the in-app Help dropdown: **About Footlight** sits in the
app menu (macOS-style) and opens the in-app Settings → About panel, and the
**Help** menu holds User Guide / Report a Bug / View on GitHub. External links use
the `tauri-plugin-opener` plugin.

## Icons

The full icon set is committed under `icons/` (desktop PNG/`.icns`/`.ico`, plus
the Windows Store logos and `android/` / `ios/` sets that `cargo tauri icon`
generates). `tauri.conf.json`'s `bundle.icon` references `icons/32x32.png`,
`icons/128x128.png`, `icons/128x128@2x.png`, `icons/icon.icns`, and
`icons/icon.ico`. To change the artwork, regenerate the set with
`cargo tauri icon path/to/source.png`.

## Locating the CLI at runtime

`tauri.conf.json` bundles the engine as Tauri resources: `../../bin/footlight.js`
→ `engine/bin/footlight.js` and `../../dist` → `engine/dist`, so the launcher's
relative `../dist/cli.js` import still resolves inside the bundle. The CLI still
runs under the system `node`.

`track`, `render`, and `check_outdir` find the CLI via `locate_cli`, in order:

1. the `FOOTLIGHT_CLI` env override;
2. the bundled `<resourceDir>/engine/bin/footlight.js` (a packaged app, where the
   working directory may be `/`);
3. walking up from the working directory (up to six levels) for
   `bin/footlight.js` (dev mode, `cargo tauri dev`, where the repo tree is intact);
4. otherwise a bare `footlight.js`.

A relative render outdir resolves against the directory two levels above the
located CLI (the repo root in dev). In a packaged app that would land inside the
read-only bundle, so packaged builds should use an absolute outdir — a fresh
install's default (`default_outdir`) is `footlight` in the OS videos folder
(`~/Movies/footlight` on macOS).
