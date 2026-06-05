# Footlight — Tauri (native) shell

This directory is the **native desktop shell** for Footlight. It is **ready-to-build
code, but it was NOT compiled in the environment where it was authored** — that
environment has Node + ffmpeg but **no Rust toolchain**.

## Requirements to build

- [Rust toolchain](https://rustup.rs) (`rustup`, `cargo`)
- Tauri v2 CLI: `cargo install tauri-cli --version "^2"` (or `npm i -D @tauri-apps/cli`)
- `ffmpeg`, `ffprobe`, and `node` on `PATH` at runtime (the commands shell out to them)
- The footlight CLI built at the repo root (`npm run build` in `footlight/`, producing `dist/` + `bin/footlight.js`)

## Build / run

From `app/`:

```bash
# dev (hot-reloads the Vite frontend in a native window)
cargo tauri dev      # or: npx @tauri-apps/cli dev

# production bundle
cargo tauri build    # or: npx @tauri-apps/cli build
```

`tauri.conf.json` runs `npm run dev` / `npm run build` for the frontend and points
`frontendDist` at the Vite `../dist` output.

## What the native side does

`src/main.rs` exposes four `#[tauri::command]`s — `extract_frame`, `probe`,
`scenes`, `render` — that shell out to ffmpeg/ffprobe and the footlight CLI via
`std::process::Command`, mirroring the Node dev backend in
`../dev-server/server.mjs`. The frontend selects this backend automatically when
running inside the Tauri webview (`__TAURI__` present on `window`).

The native **Help** menu (About / Report a Bug / View on GitHub) mirrors the
in-app Help dropdown; external links use the `tauri-plugin-opener` plugin.

## Icons

`tauri.conf.json` references `icons/icon.png`. Generate a full icon set with
`cargo tauri icon path/to/source.png` before a release build; a placeholder is
not committed here.

## Locating the CLI at runtime

`render` resolves the footlight CLI by walking up from the working directory for
`bin/footlight.js`, or honors a `FOOTLIGHT_CLI` env override. For a packaged app
you would instead bundle the CLI as a Tauri resource/sidecar and point at it.
