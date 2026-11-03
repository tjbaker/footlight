---
name: add-platform-capability
description: Add a capability to the FootlightPlatform interface across all four surfaces (types, web backend, Tauri backend, tests). Use whenever the frontend needs something new from the backend (a probe, a file operation, an ffmpeg invocation, a secret, …).
---

# Add a platform capability

The frontend talks to ONE `FootlightPlatform` interface (`app/src/platform/`),
with two backends that must stay in sync. A capability is NOT done until all
of these exist:

1. **`app/src/platform/types.ts`** — the interface method, with a doc comment
   saying what it does and what each backend maps it to.
2. **Web backend** — `app/src/platform/web.ts` (the fetch) **and**
   `app/dev-server/server.mjs` (the dependency-free `node:http` endpoint that
   serves it, shelling out to ffmpeg/ffprobe or the root `footlight` CLI).
3. **Native backend** — `app/src/platform/tauri.ts` (the invoke) **and** the
   `#[tauri::command]` in its domain module under `app/src-tauri/src/`
   (`media.rs` ffmpeg/ffprobe, `cover.rs`, `render.rs` CLI runs and output
   files, `store.rs` persistence and secrets, `fonts.rs`, `menu.rs` windows;
   see `app/src-tauri/README.md`). Make it `pub(crate)` and **register it** in
   the `tauri::generate_handler![…]` list in `main.rs`'s `invoke_handler`, or
   the invoke fails at runtime. Shell out through `subprocess::run_output`.
4. **Mirror tests** — if the Rust side mirrors a pure TS builder (it cannot
   import TS), add a `#[cfg(test)]` test pinned to the SAME fixtures the TS
   tests use, so drift fails CI. This is the only sanctioned duplication
   (see CLAUDE.md "DRY by delegation").
5. **Frontend tests** — cover the new method in `app/test/platform-web.test.ts`
   AND `app/test/platform-tauri.test.ts`, and add it to the mock in
   `app/test/helpers/platform-mock.ts` (the jsdom editor suites mount against
   that mock; a missing method fails them).

Both backends must expose IDENTICAL behavior — same inputs, same outputs,
same error shapes. Verify with `npm run verify` in `app/` and `cargo test`
in `app/src-tauri/`.
