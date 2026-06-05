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

`ffmpeg`/`ffprobe` must be on `PATH` for anything end-to-end; `yt-dlp` is optional
for downloads. Requires **Node 26+**. `SPEC.md` is the full design/roadmap (section
numbers like "SPEC §6.9" referenced in code comments).

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
same split applies to `studio.ts` and `track.ts` (both pure, frontend-safe).

### The render pipeline

`buildFfmpegArgs(row, opts)` (in `core.ts`) is the heart: it builds the ffmpeg arg
array for one clip without running anything (dimensions are passed in, so it stays
pure/testable). Filter chain per clip:
`[optional content_crop] → 9:16 crop → scale=1080:1920:lanczos → setsar=1 → libx264 → audio`.
Audio defaults to lossless `-c:a copy` (source is the quality ceiling); a bitrate
forces an AAC re-encode. `computeCrop` fixes the 9:16 crop **width** for landscape
sources and only varies **x** (horizontal framing).

`crop_offset` has three forms, all resolved here:
- fixed: `left`/`center`/`right` or an integer x-pixel offset (clamped into frame);
- time-keyed schedule `"0=center; 14.5=440"` → a nested `if(lt(t,…))` **hard-switch**
  x-expression (align switch times to scene cuts from `footlight scenes`);
- eased `cropPath` (JSON manifest only) → `buildEasedCropX` emits a smoothstep
  `x='…'` expression. **A `cropPath` takes precedence over `crop_offset`.**

### Manifests: CSV and JSON

`render` reads CSV (`parseCsv` in `csv.ts`) **or** JSON (`.json` → array of
`ClipSpec`). CSV is the documented source of truth (one row per clip); JSON adds the
eased `cropPath`. Reserved CSV columns `hook`/`title`/`text_position` are for a
**not-yet-implemented** caption feature and are ignored by the engine.

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

### studio.ts — GUI ↔ manifest

`studio.ts` is the **inverse of the engine**: it turns drawn crop boxes/selections
back into `crop_offset` / `content_crop` / schedule strings and serializes manifests
(CSV and JSON). Its crop-width/maxX/even-rounding math mirrors `computeCrop` exactly
so the round-trip box → offset → crop is consistent.

### App backend abstraction

The frontend talks to one `FootlightPlatform` interface (`app/src/platform/`),
selected at runtime in `platform/index.ts`: the **native Tauri backend** (`tauri.ts`,
four Rust `#[tauri::command]`s in `app/src-tauri/src/main.rs`) when `__TAURI__` is on
`window`, else the **web dev backend** (`web.ts` → `app/dev-server/server.mjs`, a
dependency-free `node:http` server on :8787). Both expose the same
frame/probe/scenes/track/render capabilities by shelling out to ffmpeg/ffprobe and
the root `footlight` CLI — keep the two backends in sync when changing the interface.

## Conventions

- **TypeScript strict**, ESM (`"type": "module"`), `.js` extensions in relative
  imports (NodeNext-style), `noUncheckedIndexedAccess` on (note the `!` assertions).
- Source files carry the `// Copyright … SPDX-License-Identifier: Apache-2.0` header.
- H.264 needs **even** crop dimensions — `even`/`roundEven` are used throughout;
  preserve this when touching crop math.
- Engine/CLI changes **need tests** (`CONTRIBUTING.md`). Tests pass dimensions in to
  keep things file-free; mirror that pattern.
- ffmpeg `cropdetect` sees **black bars only** — colored/blurred pillarboxing is
  invisible to it. Framing is a human call; don't trust metadata over pixels.
- **No telemetry** — the project does not phone home.
