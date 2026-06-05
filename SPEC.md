# Footlight — Project Specification

> Status: living spec — the render engine, CLI, and GUI are implemented; some
> items remain roadmap (see §11). License: **Apache-2.0**. Open source,
> GUI-first, wraps `ffmpeg`.

This document specifies an open-source desktop application for turning 16:9
source videos into 1080×1920 (9:16) short-form clips for Reels / TikTok / YouTube
Shorts. It grew out of a working CSV-driven batch script and the real-world
lessons from editing live-performance footage of a one-man-band musician. The spec covers the render engine, the GUI, and an optional AI
assistant, and it is grounded in the five clips already produced with the
original batch script (see [Worked examples](#worked-examples)).

---

## 1. Purpose & philosophy

**Purpose.** Make it fast for a human editor to cut a 16:9 performance video into
well-framed vertical clips, automating everything *after* the creative decisions
(which moment, where to crop) without trying to make those decisions for them.

**Core philosophy — control-first, not auto-magic.**
- The slow, unavoidable human work is **finding the moment and deciding the
  framing.** The tool automates the mechanical rest (cut → crop → scale → encode).
- AI auto-clippers (Opus Clip, Klap, Vizard, etc.) pick moments from
  **transcripts** and are built for talking-head content. They are weak on
  instrumental / live music, where there is no speech to key off. This tool
  deliberately serves the underserved case: **music and live performance**, where
  the editor knows the moment and the subject moves across the frame.
- AI is an **optional accelerant**, never a gate. The full editing and rendering
  workflow must work with no API key and no network.

**Non-goals.**
- Not a general-purpose NLE (use Premiere / DaVinci / CapCut for that).
- Not a transcript-based auto-clipper.
- Not a captioning suite — captions are optional and minimal (see §6.5).
- Continuous subject-tracking / motion auto-reframe is **opt-in, not the default
  path.** The fixed-crop and cut-aligned cases (~90%, see §6.3) need no AI; the
  moving-subject-within-a-shot case is served by the **AI-assisted tracked crop
  path** (opt-in, BYOK — see §6.9), a human-in-the-loop suggestion, never a gate.

---

## 2. Users

- **The editor (primary user).** Technically comfortable, does the actual
  clipping. Builds and dogfoods the tool. Wants speed and precise control.
- **The artist / customer.** A musician (e.g. an independent one-man-band) who
  needs a steady supply of vertical clips but does not edit. May use the app
  occasionally; must be able to without touching a terminal or an API key.
- **The wider community (OSS).** Other indie performers and editors who hit the
  same gap. They may contribute code *and* framing knowledge (see §10).

---

## 3. Core concepts

### 3.1 The pipeline
For each clip the engine does, in order:

```
[optional content-crop] → cut (in→out) → crop to 9:16 → scale to 1080×1920
  → encode H.264 → [optional caption burn-in] → mux audio
```

### 3.2 The clip manifest (CSV) is the source of truth
A render is described by a **CSV**, one row per clip. The GUI is a visual editor
*over* this CSV; the CLI consumes it directly. Keeping the CSV as the canonical
interchange keeps the GUI and engine decoupled, the output diff-able and
inspectable, and lets power users hand-edit or script it. See [§8](#8-data-formats).

### 3.3 The crop model
The single most important decision per clip is the **9:16 crop window**, because
a one-man-band moves between instruments and a naive center crop cuts off the
action. The model has three levels of control:

1. **Named offset** — `left` / `center` / `right` (horizontal framing of a
   full-height 9:16 window on a landscape source).
2. **Numeric x-offset** — an integer x (pixels from the left of the working
   region), clamped into frame, for precise framing between the named presets.
3. **Time-keyed schedule** — for sources that *cut between shots*, a list of
   `time=offset` pairs (e.g. `0=center; 14.5=440`). The crop x switches at each
   clip-relative timestamp. **Switches are hard cuts and must be aligned to the
   source's own edit points** so they're invisible.

Additionally, **`content_crop`** (`W:H:X:Y`) crops the source to a content region
*before* the 9:16 crop, to strip letterbox/pillarbox bars. Crop offsets are then
relative to that region.

Two further controls extend the model: an **explicit 9:16 window** (`cropWindow`
— a punch-in/zoom that fixes the crop's size *and* position, upscaling the
subject) and an **eased crop path** (`cropPath`, §6.9) that smoothly pans within a
single shot. Precedence at render: eased path → explicit window →
`crop_offset`/schedule.

---

## 4. Worked examples (from real footage)

These five clips were produced with the original batch script and define the
behaviors the GUI must reproduce. They are the acceptance fixtures — labelled by
the **source trait**, not the specific clip.

| Source | Source trait | Crop solution |
|--------|-------------|---------------|
| **Banner pillarbox** | colored side banners that `cropdetect` cannot see; a `right` crop would grab the banner | `center` only (the editor must eyeball pillarboxing) |
| **Off-center subject** | full-frame; subject stands right of center | numeric `crop_offset=720` (nudged right to recenter them) |
| **Centered, full-frame** | subject centered | `center` |
| **Tight dynamic shot** | full-frame | numeric `crop_offset=750` |
| **Letterboxed edit** | **letterboxed** (`1800×1010+60+34`) edited music video that cuts between wide singer / piano-hands / tight singer; subject sits in a different x per shot; needed last second trimmed | `content_crop=1800:1010:60:34`, schedule `0=center; 14.5=440` (switch lands on the singer→piano cut), `out_point` trimmed by 1s |

Lessons encoded by these examples:
- **Pillarboxing is partly undetectable.** `cropdetect` finds black bars only;
  colored/blurred banners are invisible. The framing call is human.
- **`clip_potential`-style metadata cannot see pixels.** Always verify framing on
  the actual frames.
- **Edited sources need per-section crops** keyed to cuts — the time-keyed
  schedule, with switches snapped to scene boundaries.
- **Audio should not be re-compressed** — see §6.4.

---

## 5. Architecture

### 5.1 Stack
- **UI:** **vanilla TypeScript** (Vite) — imperative DOM, no UI framework — kept
  deliberately dependency-light. A `<canvas>` overlay draws the crop box.
- **Shell:** **Tauri v2** (small footprint, minimal Rust glue). The same frontend
  also runs against a dependency-free Node dev backend, so the whole UI is
  verifiable in a plain browser without the Rust toolchain.
- **Render engine:** **`ffmpeg`/`ffprobe` invoked as subprocesses** from the
  user's `PATH` (**not bundled** — see §10). The crop math / schedule /
  content-crop logic lives in a pure TypeScript core (`src/core.ts`) so it ships
  in-app and is shared by the CLI, the GUI, and the dev backend.
- **CLI parity:** the `footlight` CLI is a supported, headless entry point
  reading the same CSV/JSON manifests, sharing the TS core with the GUI.

### 5.2 Frame-accurate playback (the key technical risk — de-risk first)
HTML5 `<video>` seeks to keyframes, which is too imprecise for picking in/out
points and drawing a box on an exact frame. **The shipped approach is on-demand
frame extraction**; the alternatives are kept here for the record:
- **On-demand frame extraction** (shipped) via `ffmpeg -ss … -frames:v 1` for the
  displayed frame — dead accurate, slight scrub lag, debounced while scrubbing.
  *(This is also how the frames in the worked examples were inspected.)*
- **Low-res proxy** with dense keyframes for smooth scrubbing; render from the
  original.
- **Native player** (mpv embed / AVFoundation) that steps frames precisely.

### 5.3 Privacy posture (a headline feature)
**There are no servers.** Footage never leaves the machine. If the AI assistant
is enabled, frames/prompts go directly from the user's machine to their chosen AI
provider using **their own key**; nothing is proxied or logged centrally. This is
a deliberate differentiator from cloud auto-clippers that upload source video.

---

## 6. Functional requirements

### 6.1 Source acquisition
- Import local files, or download via **`yt-dlp`** (optional, detected on `PATH`)
  given a URL. Default download format prioritizes the best available **video**;
  audio is handled per §6.4.
- Sources land in a `downloads/` (or user-chosen) directory; rendered clips in
  `clips/` (configurable per project).
- Pre-screen helper: run `cropdetect` on a source and surface the suggested
  content region (catches **black bars only** — must warn that colored-banner
  pillarboxing is invisible and needs a human eyeball).

### 6.2 Playback & clip selection
- Frame-accurate playback (on-demand frame extraction, §5.2) with frame-step
  controls and audio playback to find in/out by ear.
- A full-width **loudness timeline** is the primary scrubber and trimmer: it draws
  perceived volume over time (so the eye is drawn to the dynamic moments). **Drag
  across it to set in/out**, click to seek, hover to preview frames, and drag the
  region edges (or select an in/out marker and nudge it a frame at a time) to
  adjust. It surfaces suggested quiet→loud **swells** (seek-only suggestions, never
  auto-set in/out) and scene-cut ticks with previous/next-cut jumps.
- Set **in/out points**; show resulting duration. Trim handles (e.g. trim the
  last second, as the letterboxed-edit example required) are the draggable region
  edges on the timeline.

### 6.3 Crop authoring
- A **9:16-locked crop box** drawn/positioned on the current frame. Reading the
  box yields the `crop_offset` (and, when boxing inside bars, the `content_crop`).
- **Punch-in / zoom**: resize the crop box smaller than the full frame to author
  an explicit `cropWindow` (size + position). Since output is always scaled to
  1080×1920, a smaller window upscales the subject for a tighter crop.
- **Crop keyframes on a timeline**: drop a keyframe at a time, set its box. This
  authors the time-keyed schedule visually. Between keyframes the crop is a **hard
  switch** at the keyframe time (matching the engine).
- **Scene-cut detection** (`ffmpeg` scene score / `select='gt(scene,…)'`) to
  **suggest keyframe positions snapped to real cuts**, so switches are invisible.
  (This is the assisted version of the manual letterboxed-edit workflow.)
- **`content_crop` (deletterbox)**: a content region cropped *first* so crop
  offsets become relative to it. Supported by the engine and the CSV/JSON manifest;
  the in-app draw-mode for it was **removed to keep the framing UI focused** (the
  `cropdetect` suggestion is still surfaced on probe for black-bar cases).
- Live **9:16 output preview** of the cropped result at the playhead — a small,
  draggable phone-shaped panel updating across schedule switches and the tracked
  path, with optional **safe-area guides** (the caption/button zones the social
  platforms overlay).

### 6.4 Encoding & audio
- **Video:** H.264, `yuv420p`, target **1080×1920**, `+faststart`. Quality via
  CRF (default 19) and x264 preset (default medium); both exposed.
- **Audio (default: lossless passthrough).** Copy the source audio stream
  untouched (`-c:a copy`) — same codec, **bitrate, and sample rate** — so the
  encode never adds a compression generation or resamples. The source is the
  quality ceiling (YouTube tops out ~128k AAC / ~140k Opus); re-encoding higher
  only pads it. Provide an explicit "re-encode AAC @ <bitrate>" option for the
  rare case (e.g. a frame-exact audio cut on a downbeat), but it is **not** the
  default.
- **Scale** with a high-quality filter (`lanczos`); enforce even dimensions.

### 6.5 Captions / branding (optional, off by default)
- Clips export **clean** by default — no burned-in text. Native per-platform
  captions are added later in-app (Reels/TikTok/Shorts), which also avoids the
  ranking penalty platforms apply to non-native on-screen text.
- The manifest carries **`hook`**, **`title`**, **`text_position`** fields as a
  self-contained shot-list regardless of rendering.
- A global **"burn captions"** toggle feeds `hook`/`title` into `ffmpeg drawtext`
  at `text_position` when explicitly enabled. Default style: bundled bold sans;
  white fill with black outline (`borderw=4:bordercolor=black@0.8`) for legibility
  over busy stage footage; size scaled to frame (`hook ≈ h/18`, `title ≈ h/26`);
  ~12% safe margins top/bottom; `hook` above `title`. All overridable.

### 6.6 Batch & queue
- Multiple clips per project; render the queue with progress per clip and a
  summary. Honor `--dry-run`-style "show the ffmpeg commands" for transparency.

### 6.7 AI assistant (optional)
- **Opt-in, BYOK.** User pastes an API key in **Settings**, never in the project
  files. *(Today it is kept in app local storage; moving it to the **OS keychain**
  for the packaged app is a tracked follow-up.)*
- **Provider-agnostic from day one.** The AI layer is an abstraction over
  providers (Anthropic Claude, Google Gemini, …), selectable **per capability** —
  e.g. Gemini for vision/tracking (per-frame images + bounding boxes, see §6.9)
  and Claude or Gemini for the chat assistant. Designing this in from the start
  avoids a later refactor and matches the maintainer's provider preferences.
- **Natural-language editing via tool use.** The assistant is given the current
  project state and a small set of app tools, e.g.: `setInOut`, `addCropKeyframe`,
  `setContentCrop`, `detectScenes`, `suggestCropForFrame`, `trackSubject`, `trim`,
  `render`. The user types intent ("trim the dead air and bump the crop left after
  the piano comes in") and the assistant proposes/executes tool calls with an
  explanation.
- **Vision-assisted framing.** Given a frame (or a few), the assistant proposes a
  9:16 crop box ("subject is left of center here — nudge left"). This mirrors the
  manual frame-inspection workflow used to produce the worked examples. **It must
  warn it cannot see colored-banner pillarboxing** and that suggestions are
  starting points, not final calls — human-in-the-loop by design.
- **Managed-key option (future, optional).** A hosted key-proxy so non-technical
  users can enable AI without their own provider account. Strictly optional; the
  BYOK and keyless paths always remain. (See economic note in §12.)

### 6.8 Editable AI instruction ("the framing brain")
- Ship a **comprehensive base system prompt** encoding the domain knowledge in
  this repo (the pillarbox traps, the move-across-the-frame principle, the
  cut-aligned schedule technique, "verify the pixels", the clean-export caption
  policy, etc.). The current `CLAUDE.md` is effectively its first draft.
- The base prompt is **viewable** (transparency) and **versioned in the repo**.
- Users **augment** it with their own layer (e.g. "I always want my face in the
  top third"; "this venue never letterboxes") — a **base (read-only) + user
  overlay** model so base updates never clobber customizations, mirroring how
  `CLAUDE.md` + user memory compose.
- The base prompt is a **contribution surface**: community members improve the
  framing brain via PRs (e.g. a newly discovered pillarbox failure mode), not just
  code. See §10.

### 6.9 AI-assisted tracked crop path (implemented, opt-in)
For the one framing case the fixed-crop and hard-switch-schedule models don't
cover — **a subject moving across a single continuous shot** — Footlight generates
an **eased crop path** driven by a **vision API**, not hand-keyed interpolation and
not a bundled local ML model. This ships in `src/track.ts` (the pure pipeline:
plan sample times → inject a `VisionTracker` → adaptive densify → one-euro smooth
→ deadzone → velocity-limit → eased keyframes), with `MockTracker` for
offline/tests and `GeminiTracker` as the reference provider. It stays opt-in,
BYOK, and human-in-the-loop.

**Why a vision API (vs. a local tracker).** Routing detection through a vision API
removes the single hardest engineering problem of the local-model approach —
**bundling an ML runtime (ONNX/MediaPipe) into a signed cross-platform desktop
app.** Detection becomes an HTTP call returning coordinates: no model to ship, no
platform builds, no GPU concerns. The cost moves to tokens, which is acceptable
because this feature is **opt-in and BYOK** (the user who turns it on pays for it;
it never burdens the free/keyless path).

**Provider & source delivery.** Built on the provider-agnostic AI layer (§6.7).
**Gemini is the reference target** and returns **2D bounding boxes with normalized
coordinates** — close to the exact output a crop path needs. The implementation
sends **one sampled frame per timestamp as an inline image** (extracted from the
In→Out window in the working region), not the video: a local path is not a valid
Gemini `file_uri`, uploading a whole clip is wasteful and would misalign
clip-relative times, and per-frame images keep payloads small and times aligned
by construction. The trade-off is that the model sees discrete frames rather than
motion continuity; the subject hint plus the smoothing/deadzone (below) and
human review absorb that. Other providers plug in behind the same interface.

**Cost control — configurable keyframe interval.** Sampling density is the core
cost↔fidelity dial and is **user-configurable**:
- **Fixed interval** (e.g. one keyframe every N seconds) for predictable cost.
- **Adaptive interval** (preferred): sample coarsely, then **densify only where
  motion is high** (large box-delta between consecutive samples). Spends tokens
  where the subject actually moves and almost none where they're still — same or
  lower cost, better tracking than a fixed rate.
- **Cut-anchored always.** Whatever the interval, force a keyframe right after
  every detected scene cut (§6.3) and never interpolate across a cut.
- **Cost-model note:** with per-frame images, the "interval" is literally how many
  frames you send — so adaptive sampling directly controls token cost.
- **Coarse-then-refine workflow:** run a cheap coarse pass, **preview the path,
  and densify only if it looks rough.** Pay-as-you-refine — respects
  cost-conscious BYOK users even when the maintainer's own budget is unbounded.

**Smoothing & easing (real work regardless of budget).** Raw API boxes jitter
frame-to-frame; a crop that snaps to them looks terrible. Tokens don't fix this —
it's signal processing:
- Temporal smoothing (**one-euro filter** or Kalman), a **deadzone** so small
  movements don't move the crop, and velocity limiting.
- **Ease-in/ease-out (smoothstep), never raw-linear** — constant-velocity crop
  moves read as robotic.
- The smoother must handle **uneven keyframe spacing** (from adaptive sampling).
- The resulting path drives the `crop` x via a time expression (ffmpeg's `crop` x
  already accepts one), bounded per shot.

**Subject identity.** When more than one person is in frame (band member,
audience), the system must know *which* box is the subject — via a user anchor
(click the subject in the first frame, or a description like "the person with the
guitar") and identity-holding logic through occlusion and detection dropouts.

**Scope & control.**
- **Within a single shot only.** Path segments are bounded by detected scene cuts
  (§6.3); across cuts the hard-switch schedule (§3.3) still applies.
- **Human-in-the-loop.** The generated path is a reviewable, editable suggestion
  (adjust/trim keyframes, accept, or discard), consistent with the control-first
  philosophy (§1).
- **Pillarbox caveat:** vision can't see colored-banner pillarboxing; combine with
  `content_crop` (§3.3) when the source is pillarboxed.

**Explicitly rejected: manual linear interpolation.** Hand-keyed linear pans are
worse than subject tracking for following an unpredictably moving performer (more
authoring effort, still inaccurate between keyframes) and look mechanical. If
smooth motion is built, it is the auto-generated, eased, vision-API tracked path
above; until it ships, this case stays in CapCut.

---

## 7. Non-functional requirements

- **Offline-first:** everything except the optional AI works with no network.
- **Cross-platform:** the engine/CLI and GUI are platform-neutral; **macOS is the
  primary target today**, Windows/Linux best-effort.
- **Distribution (roadmap):** signed/notarized installers are a future goal.
  Today Footlight is **run/built from source** (`make gui`, or `make tauri-dev`),
  there is no signed prebuilt download yet, and it relies on a system `ffmpeg`.
- **Transparent:** show the underlying `ffmpeg` commands; never a black box.
- **Performance:** scrubbing responsive; render speed bound by `ffmpeg`.

---

## 8. Data formats

### 8.1 Clip manifest (CSV) — canonical render input
One row per clip. Columns:

| Column | Required | Meaning |
|--------|----------|---------|
| `source_file` | yes | Path to the source video. |
| `in_point` | yes | Start timestamp — `HH:MM:SS`, `MM:SS`, or seconds. |
| `out_point` | yes | End timestamp — same formats. |
| `crop_offset` | yes | `left`/`center`/`right`, integer x px, **or** a time-keyed schedule `t=offset; t=offset` (clip-relative times; crop x switches at each, hard-cut). |
| `content_crop` | no | `W:H:X:Y` region cropped first to strip letterbox/pillarbox; offsets become relative to it. |
| `hook` | no | Hook/headline text (shot-list metadata; burned only if captions enabled). |
| `title` | no | Song/title text (same). |
| `text_position` | no | `top`/`center`/`bottom` or numeric y-offset for burned text. |
| `out_name` | no | Output filename; auto-generated from source + timestamps if blank. |
| `notes` | no | Free-text editor notes. |

Render-wide settings (CRF, preset, audio policy, outdir, burn-captions) are CLI
flags / GUI settings, not per-row, in the current design.

### 8.2 Session & history (GUI) — implemented
The GUI **autosaves the working session** (source, the clip queue, destination) to
a local JSON and restores it on next launch, and keeps a local **render history**
(past renders, each re-openable to restore its source + in/out + framing for a
re-frame/re-encode). It exports the queue as a CSV/JSON manifest on demand — the
manifest remains the contract with the engine and CLI. (All local; nothing leaves
the machine.)

### 8.3 System prompt
- `prompts/base.md` — versioned base "framing brain" (read-only at runtime).
- User overlay stored in app config (editable), appended to the base at request
  time.

---

## 9. CLI

```
footlight render manifest.csv|.json --outdir clips [--crf 19] [--preset medium]
                                    [--audio-bitrate copy|256k] [--dry-run]
footlight probe  SOURCE          # dims + cropdetect suggestion (black bars only)
footlight scenes SOURCE          # detected cut timestamps (to seed schedule keyframes)
footlight track  REQUEST.json    # subject track → eased crop-path keyframes (§6.9)
```
The manifest contract is identical between GUI and CLI. CSV is canonical; JSON
additionally carries the eased `cropPath` / explicit `cropWindow` the CSV can't
express. (A `--burn-captions` flag is reserved — captions are not yet built, §6.5.)

---

## 10. Open-source & contribution model

- **License: Apache-2.0** for the application code (permissive; patent grant;
  good for adoption and contribution).
- **`ffmpeg` is invoked, not bundled** — it stays a separately installed system
  dependency, so its LGPL/GPL terms apply to the user's own install, not to
  Footlight (whose code stays Apache-2.0). If a future build *does* bundle ffmpeg,
  it must ship ffmpeg's license/notices (and, since H.264 via libx264 is GPL, a
  source offer). Documented in `NOTICE`.
- **Two contribution surfaces:**
  1. **Code** — engine, GUI, platform packaging.
  2. **The framing brain** (`prompts/base.md`) — domain knowledge as prose. New
     framing gotchas, source-type recipes, and crop heuristics arrive as prompt
     PRs. `CONTRIBUTING.md` explicitly invites this.
- **No telemetry by default.** If any usage stats are ever added, opt-in only.

---

## 11. Roadmap (staged — each milestone independently useful)

**M1 — Visual single-clip cutter (MVP). ✓ Done.** Import/open a source;
frame-accurate scrubber; set in/out; draw one 9:16 box (named or numeric); live
preview; write a manifest; render via system `ffmpeg`; lossless audio copy.

**M2 — Letterbox + batch. ✓ Done.** `content_crop` (deletterbox) with `cropdetect`
assist; multi-clip queue + batch render; CLI parity.

**M3 — Keyframed crop schedule. ✓ Done.** Crop keyframes on a timeline;
hard-switch preview; **scene-cut detection** to snap keyframes to cuts (the
assisted letterboxed-edit workflow).

**M4 — AI assistant (BYOK). ◑ Partial.** Done: the **tracked crop path** (§6.9 —
BYOK key in Settings, a deterministic `MockTracker` backing offline tests, viewable
base prompt in `prompts/base.md`). Pending: the natural-language tool-use assistant
(§6.7) and vision crop suggestions for static frames.

**M5 — Polish & distribution. ☐ Pending.** Signed/notarized cross-platform
installers; auto-update; optional captions burn-in (§6.5); docs site. (Today the
app is run/built from source.)

**Also shipped (beyond the original M-line).** Explicit **punch-in / zoom**
(`cropWindow`); a **loudness timeline** scrubber/trimmer with quiet→loud **swell**
suggestions and **hover-scrub thumbnails**; **background scene auto-detection** with
previous/next-cut jumps; a live **9:16 output preview** with social **safe-area
guides**; an **editable clip queue** (re-edit / reorder / duplicate) with real
frame thumbnails; **render history** with one-click re-framing plus **session
autosave/restore**; **drag-to-load** and **keyboard-first** operation with a
shortcuts overlay; bundled local UI **fonts** (OFL); a localizable in-app **User
Guide** and **Settings** dialog; and a dependency-free web dev backend mirroring
the native one.

**Later / optional.** Provider-agnostic AI beyond the Gemini reference; managed-key
tier for non-technical users. Manual linear interpolation is explicitly out (§6.9).

---

## 12. Risks & open questions

- **Frame accuracy** (§5.2) is the main engineering risk — prototype first.
- **Vision crop reliability** — good but not pixel-perfect, and blind to
  colored-banner pillarbox; keep human-in-the-loop, present as suggestions.
- **BYOK friction** for non-technical users — mitigated by AI being fully
  optional and by the future managed-key option.
- **Scope creep** — the GUI + AI surface is large; the staged roadmap exists to
  ship value early and avoid stalling.
- **Maintenance** — even as funded OSS with no revenue goal, expect issues/PRs and
  OS-update churn; the prompt-as-contribution model and community help share it.
- **Economics** — project is funded by the maintainer as a useful tool, not a
  business. Any monetization (managed-key tier, paid prebuilt binaries) must
  preserve a fully functional free/BYOK/keyless path and never gate the open code.

## Naming
The project is named **Footlight** — a stage-lighting term, fitting for
live-performance footage. The CLI binary is `footlight`.
