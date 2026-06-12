# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Footlight turns 16:9 source videos into clean **1080×1920 (9:16) H.264 MP4** clips
for Reels / TikTok / Shorts, by wrapping `ffmpeg`. It is **control-first**: it
automates the mechanical cut → crop → scale → encode *after* a human chooses the
moment and framing. It does not pick moments. The target audience is **music /
live-performance footage** (no transcript to key off of), where the subject moves
across the frame so each clip needs its own horizontal crop.

Two surfaces, both first-class (see `CONTRIBUTING.md`):
1. **Code** — the TS render engine, CLI, and Tauri GUI.
2. **The "framing brain"** — `prompts/base.md` encodes framing domain knowledge as
   prose (pillarbox traps, cut-aligned schedules, "verify the pixels"). Prose-only
   PRs to it are expected and welcome.

`ffmpeg`/`ffprobe` must be on `PATH` for anything end-to-end (burned captions need
a libass-enabled build — `homebrew-ffmpeg/ffmpeg` on macOS, not core). Requires
**Node 26+**. `SPEC.md` is the full design/roadmap (section numbers like "SPEC
§6.9" referenced in code comments).

## Repo layout (two npm packages)

- **Root** (`package.json`, `src/`, `test/`) — the render engine + `footlight` CLI,
  published as an npm package (`bin/footlight.js` → `dist/cli.js`).
- **`app/`** (`app/package.json`) — the Tauri v2 desktop GUI (separate package,
  separate `node_modules`). Frontend is Vite + TypeScript; native shell is Rust in
  `app/src-tauri/`.

The engine began as a CSV-driven Python batch script; `src/core.ts` is the
canonical port and has since moved past it (punch-in, eased crop paths, AI
tracking). There is no Python in the repo.

## Commands

Root (engine/CLI):
```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest run
npm run test:watch   # vitest (watch)
npx vitest run test/core.test.ts          # single file
npx vitest run -t "computeCrop"           # single test by name
```

CLI (after `npm run build`):
```bash
node bin/footlight.js render manifest.csv|.json [--outdir clips] [--crf 19] \
       [--preset medium] [--audio-bitrate copy|256k] [--dry-run]
node bin/footlight.js probe  <source>   # dims + cropdetect (BLACK BARS ONLY)
node bin/footlight.js scenes <source>   # scene-cut timestamps (seconds)
node bin/footlight.js track  <request.json>   # subject track -> TrackSample[] JSON
```

App (`app/`):
```bash
npm install
npm run dev          # Vite frontend (browser) — pairs with the dev:server backend
npm run dev:server   # node:http backend on :8787 (frame/probe/scenes/track/render)
cargo tauri dev      # native window (needs Rust toolchain; not built in authoring env)
cargo tauri build    # production bundle
```

## Architecture

### core.ts vs engine.ts — the browser/Node split (important)

`src/core.ts` holds **only pure, browser-safe transforms** — no `node:` imports, no
fs, no subprocess. Timestamp/crop parsing, `computeCrop`, `buildEasedCropX`, and the
`buildFfmpegArgs` argument-array builder all live here, so the Tauri/web frontend can
import them without pulling Node into the bundle.

`src/engine.ts` holds **only** the Node-touching parts — `probeDimensions` (ffprobe)
and `run` (subprocess spawn) — and `export * from "./core.js"` so existing
`import { ... } from "./engine.js"` call sites keep working. **Rule: anything pure
goes in `core.ts`; only put code in `engine.ts` if it touches fs/subprocess.** The
same split applies to `manifest.ts` and `track.ts` (both pure, frontend-safe).

### The render pipeline

`buildFfmpegArgs(row, opts)` (in `core.ts`) is the heart: it builds the ffmpeg arg
array for one clip without running anything (dimensions are passed in, so it stays
pure/testable). Filter chain per clip:
`[optional content_crop] → 9:16 crop → scale=1080:1920:lanczos → setsar=1 →
[optional burned captions] → [optional fades] → libx264 → audio` — captions burn
last on the final frame so positions are 1:1; fades run after them so captions
fade with the picture. Audio defaults to lossless `-c:a copy` (source is the
quality ceiling); a bitrate — or a fade, which needs a matching `afade` —
forces an AAC re-encode (`BuiltCommand.forcedAudioReencode` reports the forced
case; never silent). `computeCrop` fixes the 9:16 crop **width** for landscape
sources and only varies **x** (horizontal framing).

Framing precedence (highest first), all resolved here:
- **`cropWindowPath`** (JSON only) — ANIMATED punch-in / slow push: crop-window
  keyframes `{t,x,y,w,h}` smoothstep-eased via `buildEasedCropWindowFilters`
  (per-frame eased upscale + fixed output-size crop; ffmpeg's `crop` can't
  animate `w`/`h`, and its `iw`/`ih` bind at configure time — both verified
  empirically, see `test/cropwindowpath.test.ts`);
- **`cropPath`** (JSON only) — eased horizontal tracking: `buildEasedCropX`
  emits a smoothstep `x='…'` expression;
- **`cropWindow`** (JSON only) — a static punch-in / zoom window;
- **`crop_offset`** — fixed `left`/`center`/`right` or integer x (clamped into
  frame), or a time-keyed schedule `"0=center; 14.5=440"` → a nested
  `if(lt(t,…))` **hard-switch** x-expression (align switch times to scene cuts
  from `footlight scenes`).

### Manifests: CSV and JSON

`render` reads CSV (`parseCsv` in `csv.ts`) **or** JSON (`.json` → array of
`ClipSpec`). CSV is the documented source of truth (one row per clip; includes
per-clip `fade_in`/`fade_out` seconds); JSON adds the animated `cropWindowPath`,
the eased `cropPath`, the static `cropWindow`, and a per-clip `caption` style
object. CSV columns `hook`/`title`/`text_position` carry caption **text +
position** (burned only with `--burn-captions`); per-clip caption **style** (the
`caption` object) is JSON-only.

### Captions: render-wide defaults + per-clip style

Captions burn via `libass`. `--burn-captions` is the render-wide on/off switch and
the `--caption-*` flags (`--caption-font/-color/-outline-color/-bold/-italic/`
`-underline/-shadow/-box/-box-color/-angle`) are render-wide **defaults**. A JSON
clip's optional `caption` object (`font`, `color`, `outlineColor`, `bold`, `italic`,
`underline`, `shadow`, `box`, `boxColor`, `angle`) overrides those defaults per clip:
a clip's field wins, falling back to the flag, then the engine default. A per-clip
`font` is resolved on its own (a path → its real family via fc-scan, used as a
`libass` `fontsdir`; a bare name → a fontconfig family) and fully replaces the
render-wide font. In the GUI, style controls live in the editor per-clip; only the
custom fonts folder and the burn-captions toggle remain in Settings.

### Subject tracking (AI-assisted, opt-in, BYOK)

`track.ts` (pure) turns a moving subject in **one continuous shot** into an eased
`CropPathKeyframe[]`: `planSampleTimes` → injected `VisionTracker` → `refineByMotion`
(adaptive densify) → `samplesToCropPath` (one-euro smoothing → deadzone → velocity
limit). Detection is **injected** via the `VisionTracker` interface
(`providers/types.ts`) so the math stays pure and testable — `MockTracker`
(deterministic, offline) backs tests; `GeminiTracker` is the reference provider.
**Opt-in and BYOK**: a provider never ships a key and never runs in tests; the eased
path stays within a single shot (cuts are the hard-switch schedule's job). Output is
a human-in-the-loop *suggestion* — review/edit before render.

### manifest.ts — GUI ↔ manifest

`manifest.ts` is the **inverse of the engine**: it turns drawn crop boxes/selections
back into `crop_offset` / `content_crop` / schedule strings and serializes manifests
(CSV and JSON). Its crop-width/maxX/even-rounding math mirrors `computeCrop` exactly
so the round-trip box → offset → crop is consistent.

### App backend abstraction

The frontend talks to one `FootlightPlatform` interface (`app/src/platform/`),
selected at runtime in `platform/index.ts`: the **native Tauri backend** (`tauri.ts`,
backed by the Rust `#[tauri::command]`s in `app/src-tauri/src/main.rs`) when
`__TAURI__` is on `window`, else the **web dev backend** (`web.ts` →
`app/dev-server/server.mjs`, a dependency-free `node:http` server on :8787). Both
expose the same capabilities (frame/probe/scenes/loudness/track/render/cover and
more) by shelling out to ffmpeg/ffprobe and the root `footlight` CLI — keep the
two backends in sync when changing the interface. The Rust side HAND-MIRRORS the
pure builders in `src/core.ts` (it cannot import TS); every mirror carries a
`#[cfg(test)]` test pinned to the TS fixtures so drift fails CI.

## Conventions

- **Read files with the Read tool, search with Grep/Glob — never `sed`/`cat`/
  `head`/`tail` through Bash**, not even tucked inside compound commands (each
  Bash read forces a permission prompt, and `sed` cannot be safely allowlisted:
  `-i`, `w`/`W`/`s///w`, and GNU `e` all write or execute). This applies to
  subagents too — include it when briefing them.
- **TypeScript strict**, ESM (`"type": "module"`), `.js` extensions in relative
  imports (NodeNext-style), `noUncheckedIndexedAccess` on (note the `!` assertions).
- Source files carry the `// Copyright … SPDX-License-Identifier: Apache-2.0` header.
- H.264 needs **even** crop dimensions — `even`/`roundEven` are used throughout;
  preserve this when touching crop math.
- Engine/CLI changes **need tests** (`CONTRIBUTING.md`). Tests pass dimensions in to
  keep things file-free; mirror that pattern.
- **DRY by delegation — always.** Never restate logic that already exists in a
  pure module: reuse it, or extract a shared helper and delegate (the smoothstep
  easing, crop-width rule, even-rounding, and window clamping each live in
  exactly ONE place in `core.ts`; the editor's framing emission is the single
  `framingToSpec`). The only sanctioned duplication is a **documented mirror
  that cannot import its source** — the Rust shell and `manifest.ts`'s
  inverse-of-the-engine math — and every mirror MUST be pinned by tests that
  reuse the original's fixtures so drift fails CI. Shared test scaffolding
  lives in `app/test/helpers/`, never copied into individual suites.
- **Prettier owns formatting** (`npm run format` in each package; CI runs
  `format:check`) — don't hand-wrangle whitespace or argue style in review.
- ffmpeg `cropdetect` sees **black bars only** — colored/blurred pillarboxing is
  invisible to it. Framing is a human call; don't trust metadata over pixels.
- **No telemetry** — the project does not phone home.

## The verification loop (run this before declaring anything done)

Every change must pass, in order:

1. `npm run verify` at the **root** (engine) AND in **`app/`** — they are
   separate packages with separate Prettier configs and test runs; a root
   format/test pass does NOT cover `app/`.
2. **Behavior-preserving refactors:** the jsdom editor suites must pass
   **unchanged** — editing a test to make a refactor pass means the refactor
   changed behavior, which is a finding, not a fix.
3. **Rust-mirror changes** (`app/src-tauri/`): `cargo test` — the mirrors are
   pinned to the TS fixtures, so drift fails there, not in review.

## Working the loop (PRs and issues)

- One shippable slice per PR; CI green before merge; squash-merge only
  (PR titles are Conventional Commits — they ship in the changelog).
- After pushing a PR, watch CI and fix failures proactively rather than
  waiting on review; run a code review pass (a separate verifier context)
  before merging.
- Issues are the loop's state: write them with **Where things stand / Plan /
  Guardrails / Done when** sections (see `.github/ISSUE_TEMPLATE/agent-task.md`)
  so any human or agent can resume them cold.
