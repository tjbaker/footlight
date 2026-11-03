// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Footlight core: pure, browser-safe transforms.
 *
 * Everything here is dependency-free — no filesystem, no subprocess, no
 * Node built-in imports — so the web/Tauri frontend can import these
 * transforms without pulling Node into the browser bundle. The Node-only I/O
 * (ffprobe, subprocess spawning, render orchestration) lives in `engine.ts`,
 * which re-exports everything here.
 *
 * The ffmpeg/ffprobe command builders and output parsers live in
 * `commands.ts`, and the loudness/swell/onset analysis in `audio.ts`. Both are
 * re-exported below so every `core.js` import keeps working.
 */

export * from "./commands.js";
export * from "./audio.js";

export const TARGET_W = 1080;
export const TARGET_H = 1920; // 9:16
export const TARGET_AR = 9 / 16;

/** A parsed [width, height, x, y] content-crop region. */
export type ContentCrop = [number, number, number, number];

/** A single crop window: width, height, x offset, y offset. */
export interface Crop {
  cw: number;
  ch: number;
  x: number;
  y: number;
}

/** One row of the clip manifest CSV. Unknown columns are ignored. */
export interface ClipRow {
  source_file: string;
  in_point: string;
  out_point: string;
  crop_offset?: string;
  content_crop?: string;
  out_name?: string;
  /** Big punch-line caption text (burned only when captions are enabled). */
  hook?: string;
  /** Secondary caption line, drawn below the hook. */
  title?: string;
  /** Vertical placement of the caption block: `top` | `center` | `bottom`. */
  text_position?: string;
  /** Fade-in length in seconds (video from black + audio from silence). */
  fade_in?: string;
  /** Fade-out length in seconds (video to black + audio to silence). */
  fade_out?: string;
  [key: string]: string | undefined;
}

/** Render-wide options (CLI flags / GUI settings, not per-row). */
export interface RenderOptions {
  /** H.264 CRF, lower = better/larger. Default 19. */
  crf: number;
  /** x264 speed/efficiency preset. Default "medium". */
  preset: string;
  /** Audio handling: "copy" (lossless passthrough) or an AAC bitrate like "256k". */
  audioBitrate: string;
  /**
   * Burn each row's `hook`/`title` text into the video at `text_position`
   * (SPEC §6.5). Off by default — clips export clean. A render-wide toggle so
   * the per-clip text can ride in the manifest as a shot-list without rendering.
   */
  burnCaptions?: boolean;
  /**
   * Caption font as a `.ttf`/`.otf` path. Its directory is handed to libass via
   * the `subtitles` filter's `fontsdir`, and its stem is used as the ASS family
   * name. Takes precedence over `captionFontName`. Bring-your-own — never bundled.
   */
  captionFontFile?: string;
  /**
   * Caption font as a fontconfig family name (the ASS `Fontname`). Used when no
   * `captionFontFile` is given; falls back to the system default sans
   * (`DEFAULT_CAPTION_FONT`) when neither is set.
   */
  captionFontName?: string;
  /** Caption fill colour as `#RRGGBB` (default white). */
  captionColor?: string;
  /** Caption outline colour as `#RRGGBB` (default black). */
  captionOutlineColor?: string;
  /** Bold the burned caption text. */
  captionBold?: boolean;
  /** Italicize the burned caption text. */
  captionItalic?: boolean;
  /** Underline the burned caption text. */
  captionUnderline?: boolean;
  /** Draw a drop shadow behind the caption text. */
  captionShadow?: boolean;
  /** Draw an opaque box behind the caption (instead of an outline). */
  captionBox?: boolean;
  /** Box colour as `#RRGGBB` when `captionBox` is on (default black). */
  captionBoxColor?: string;
  /** Rotate the caption block by this many degrees (counter-clockwise). */
  captionAngle?: number;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  crf: 19,
  preset: "medium",
  audioBitrate: "copy",
};

/**
 * The AAC bitrate forced when a clip has a fade but the render is set to the
 * default lossless `-c:a copy` (SPEC: issue #165's decide-once rule). An
 * `afade` must decode and re-encode the audio — a stream copy cannot fade —
 * so rather than silently dropping the audio fade (mismatched A/V fades feel
 * broken) or failing the clip, the engine re-encodes that clip's audio at this
 * bitrate and the callers surface it (CLI log note, GUI hint, README).
 */
export const FADE_AUDIO_BITRATE = "256k";

/**
 * Parse a per-clip fade length (seconds) from its manifest field. Empty/absent
 * means no fade (0). Anything non-numeric, non-finite, or negative is an error —
 * better to fail the row early than emit a garbage `fade` filter.
 */
export function parseFadeSeconds(value: string | undefined | null, field: string): number {
  const v = (value ?? "").trim();
  if (!v) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `${field} must be a non-negative number of seconds, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

/** One `:`-separated timestamp part: unsigned decimal digits, optional `.fraction`. */
const TIMESTAMP_PART = /^\d+(\.\d+)?$/;

/**
 * Parse `HH:MM:SS`, `MM:SS`, or plain seconds into float seconds. Each
 * `:`-separated part (whitespace-trimmed) must be unsigned decimal — `\d+` with
 * an optional `.\d+` — so empty parts (`"1::30"`, `"1:"`), signs, hex, exponents
 * and `Infinity` are rejected rather than silently coerced by `Number()`. The
 * result is always finite and ≥ 0.
 */
export function parseTimestamp(value: string): number {
  value = value.trim();
  if (!value) {
    throw new Error("empty timestamp");
  }
  const parts = value.split(":");
  if (parts.length > 3) {
    throw new Error(`bad timestamp: ${JSON.stringify(value)}`);
  }
  let secs = 0;
  for (const raw of parts) {
    const part = raw.trim();
    if (!TIMESTAMP_PART.test(part)) {
      throw new Error(`bad timestamp: ${JSON.stringify(value)}`);
    }
    secs = secs * 60 + Number(part);
  }
  if (!Number.isFinite(secs)) {
    throw new Error(`bad timestamp: ${JSON.stringify(value)}`);
  }
  return secs;
}

/** A plain decimal integer with an optional sign: no hex, exponent, fraction or inf/NaN. */
const DECIMAL_INT = /^[+-]?\d+$/;

/**
 * Parse a whitespace-trimmed, plain decimal integer (`DECIMAL_INT`) that is
 * exactly representable (`Number.isSafeInteger`), or null. Stricter than
 * `Number()`, which also coerces `""` to 0, accepts hex (`"0x10"`), exponents
 * and `"Infinity"`, and lets `"240.0"` pass an integer check.
 */
function parseDecimalInt(value: string): number | null {
  const s = value.trim();
  if (!DECIMAL_INT.test(s)) {
    return null;
  }
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse a `"W:H:X:Y"` content region (for stripping letterbox bars), or null.
 * Each part must be a plain decimal integer (`parseDecimalInt`); W/H must be
 * positive and X/Y non-negative.
 */
export function parseContentCrop(value: string | undefined | null): ContentCrop | null {
  value = (value || "").trim();
  if (!value) {
    return null;
  }
  const parts = value.split(":");
  if (parts.length !== 4) {
    throw new Error(`content_crop must be W:H:X:Y, got ${JSON.stringify(value)}`);
  }
  const nums = parts.map((p) => {
    const n = parseDecimalInt(p);
    if (n === null) {
      throw new Error(`content_crop must be W:H:X:Y integers, got ${JSON.stringify(value)}`);
    }
    return n;
  });
  if (nums[0]! <= 0 || nums[1]! <= 0 || nums[2]! < 0 || nums[3]! < 0) {
    throw new Error(
      `content_crop needs positive W:H and non-negative X:Y, got ${JSON.stringify(value)}`,
    );
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

/**
 * Parse crop_offset into a list of [clipRelativeSeconds, offset] segments.
 *
 * A plain value ("center", "640", ...) yields a single segment at t=0. A
 * schedule like "0=center; 21=440" yields one segment per "t=offset" pair,
 * sorted by time. The first segment's offset applies from the clip start
 * regardless of its stated time.
 */
export function parseCropSchedule(value: string | undefined | null): Array<[number, string]> {
  value = (value || "center").trim();
  if (!value.includes("=")) {
    return [[0, value]];
  }
  const segments: Array<[number, string]> = [];
  for (let part of value.split(";")) {
    part = part.trim();
    if (!part) {
      continue;
    }
    if (!part.includes("=")) {
      throw new Error(`bad crop schedule segment: ${JSON.stringify(part)}`);
    }
    const idx = part.indexOf("=");
    const t = part.slice(0, idx);
    const offset = part.slice(idx + 1);
    segments.push([parseTimestamp(t), offset.trim()]);
  }
  if (segments.length === 0) {
    throw new Error(`empty crop schedule: ${JSON.stringify(value)}`);
  }
  segments.sort((a, b) => a[0] - b[0]);
  return segments;
}

/** Round down to the nearest even integer (H.264 requires even dimensions). */
export function even(n: number): number {
  return n - (n % 2);
}

/**
 * Round to the NEAREST integer, then down to even. Unlike `even` (which
 * truncates), this is for fractional box/track math where 607.9 should land on
 * 608, not 606. (H.264 requires even dimensions.)
 */
export function roundEven(n: number): number {
  const i = Math.round(n);
  return i - (i % 2);
}

/**
 * Compute {cw, ch, x, y} to extract a 9:16 region from iw x ih.
 *
 * crop_offset selects horizontal framing for the normal (landscape) case:
 * 'left' / 'center' / 'right', or a plain decimal integer x-pixel offset from
 * the left (`parseDecimalInt`; clamped into frame). Hex, exponents, fractions
 * and inf/NaN are rejected. Pinned, with the Rust mirror, to
 * test/fixtures/crop.json.
 */
export function computeCrop(iw: number, ih: number, cropOffset: string): Crop {
  const offset = cropOffset.trim().toLowerCase();

  let cw: number;
  let ch: number;
  let x: number;
  let y: number;

  if (iw / ih >= TARGET_AR) {
    // Landscape / wider than 9:16 — the normal case. Full height, crop width.
    cw = even(Math.round(ih * TARGET_AR));
    ch = even(ih);
    y = 0;
    const maxX = iw - cw;
    if (offset === "left") {
      x = 0;
    } else if (offset === "center" || offset === "centre" || offset === "") {
      x = Math.floor(maxX / 2);
    } else if (offset === "right") {
      x = maxX;
    } else {
      const n = parseDecimalInt(offset);
      if (n === null) {
        throw new Error(
          `crop_offset must be left/center/right or an integer, got ${JSON.stringify(cropOffset)}`,
        );
      }
      x = Math.max(0, Math.min(n, maxX)); // clamp into frame
    }
  } else {
    // Taller than 9:16 — crop height, full width; horizontal offset is moot.
    cw = even(iw);
    ch = even(Math.round(iw / TARGET_AR));
    x = 0;
    y = Math.floor((ih - ch) / 2);
  }

  return { cw, ch, x: even(x), y: even(y) };
}

/**
 * An explicit 9:16 crop window in WORKING-REGION pixels (after any
 * `content_crop`): a punch-in / zoom. Where `crop_offset` only chooses the
 * horizontal position of a full-height crop, this fixes the crop's size AND
 * position, so a smaller window upscales the subject. `w`/`h` should be ~9:16;
 * the engine even-rounds and clamps all four into the working region.
 */
export interface CropWindowSpec {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One keyframe of a smooth crop path: clip-relative time and crop x (px). */
export interface CropPathKeyframe {
  /** Clip-relative time in seconds. */
  t: number;
  /** Crop window x offset in pixels, within the working region. */
  x: number;
}

/**
 * One keyframe of an animated punch-in (slow push): a full crop WINDOW at a
 * clip-relative time, in working-region pixels. Where `CropPathKeyframe` only
 * animates the crop's x (horizontal tracking at fixed size), this animates the
 * window's position AND size, so the render eases between zoom levels — the
 * "slow push toward the subject". Windows should be ~9:16 like `CropWindowSpec`;
 * the engine even-rounds w/h and clamps x/y into the working region.
 */
export interface CropWindowKeyframe {
  /** Clip-relative time in seconds. */
  t: number;
  /** Window x offset in pixels, within the working region. */
  x: number;
  /** Window y offset in pixels, within the working region. */
  y: number;
  /** Window width in pixels (even-rounded by the engine). */
  w: number;
  /** Window height in pixels (even-rounded by the engine). */
  h: number;
}

/**
 * Build an ffmpeg `crop` x-EXPRESSION that smoothly interpolates x across the
 * given keyframes using smoothstep easing (SPEC §6.9 — the eased, within-shot
 * crop path for AI subject tracking). This is the SMOOTH alternative to the
 * hard-switch `if(lt(t,...))` schedule emitted by `buildFfmpegArgs`.
 *
 * Behavior:
 *  - Keyframes are sorted by `t`; at least one is required.
 *  - A single keyframe yields a constant `String(x)`.
 *  - Before the first keyframe the value holds the first x; after the last, the
 *    last x (clamped/held — no extrapolation).
 *  - Within segment [t_i, t_{i+1}]: p = (t - t_i)/(t_{i+1} - t_i),
 *    s = p*p*(3 - 2*p) (smoothstep), x = x_i + (x_{i+1} - x_i)*s.
 *
 * The expression is a single nested `if(...)` over ffmpeg's `t` variable. Each
 * segment's `p` is wrapped in `clip(...,0,1)` so the smoothstep naturally holds
 * the endpoints, and segments are selected by `lt(t, t_{i+1})` boundaries (same
 * nesting style as the hard-switch schedule). Numbers are formatted to ≤3
 * decimals; ffmpeg does the arithmetic. The result is intended to be
 * single-quoted by the caller as the `x=` field of a `crop` filter.
 *
 * @param y unused; accepted for symmetry with the crop filter's y field.
 */
export function buildEasedCropX(keyframes: CropPathKeyframe[], _y?: number): string {
  if (keyframes.length === 0) {
    throw new Error("buildEasedCropX: at least one keyframe required");
  }
  return buildEasedExpr(keyframes.map((k) => ({ t: k.t, v: k.x })));
}

/**
 * Build a smoothstep-eased ffmpeg expression over `t` for one scalar value
 * given (time, value) keyframes — the shared core of `buildEasedCropX` (eased
 * crop x) and `buildEasedCropWindowFilters` (each of the window's x/y/w/h).
 * Keyframes are sorted by `t` here; callers guarantee at least one (they
 * validate emptiness themselves for a clearer error message).
 */
function buildEasedExpr(points: Array<{ t: number; v: number }>): string {
  const kfs = [...points].sort((a, b) => a.t - b.t);
  if (kfs.length === 1) {
    return num(kfs[0]!.v);
  }

  // Build the smoothstep expression for one segment [a, b].
  const segExpr = (a: { t: number; v: number }, b: { t: number; v: number }): string => {
    const dt = b.t - a.t;
    if (dt <= 0) {
      // Coincident/inverted keyframes: degenerate to an instantaneous step to b.
      return num(b.v);
    }
    // p clamped to [0,1] so the segment expression holds its endpoints outside
    // [a.t, b.t]; smoothstep s = p*p*(3-2*p); v = v_a + (v_b - v_a)*s.
    const p = `clip((t-${num(a.t)})/${num(dt)},0,1)`;
    const s = `(${p})*(${p})*(3-2*(${p}))`;
    const dv = b.v - a.v;
    return `(${num(a.v)}+(${num(dv)})*(${s}))`;
  };

  // Nest from the LAST segment outward, so the first segment is the outermost
  // `if`: for t < t_1 use segment 0, else fall through to the next test. The
  // final `else` is the last segment (which itself holds the last value for
  // t > t_last thanks to the clamped p). t before t_0 falls into segment 0,
  // whose clamped p holds v_0.
  const last = kfs.length - 1;
  let expr = segExpr(kfs[last - 1]!, kfs[last]!);
  for (let i = last - 2; i >= 0; i--) {
    const boundary = kfs[i + 1]!.t;
    expr = `if(lt(t,${num(boundary)}),${segExpr(kfs[i]!, kfs[i + 1]!)},${expr})`;
  }
  return expr;
}

/**
 * Build the ffmpeg filter stages for an ANIMATED punch-in (slow push): a crop
 * window whose position and size smoothstep-ease across the given keyframes
 * within a single shot, landing directly at TARGET_W×TARGET_H.
 *
 * ffmpeg's `crop` filter evaluates its `w`/`h` expressions ONCE at configure
 * time (only `x`/`y` are per-frame), so a dynamic-size crop cannot animate —
 * verified empirically. Instead the zoom is rendered as:
 *
 *   1. optional static pre-crop to the keyframes' bounding box (smoothstep is a
 *      convex blend of segment endpoints, so every interpolated window stays
 *      inside the keyframe windows' union box — pre-cropping just trims the
 *      per-frame upscale cost);
 *   2. `scale=…:eval=frame` — the whole region upscaled PER FRAME by the eased
 *      zoom factor (TARGET/window), even-truncated for yuv420p;
 *   3. a FIXED TARGET_W×TARGET_H `crop` whose per-frame x/y place the eased
 *      window, clamped against the live canvas (`iw`/`ih`) so even-truncation
 *      at the edges can never push the window out of frame.
 *
 * Scaling happens once (lanczos, straight to output size), so quality matches
 * the static punch-in path. Keyframe w/h are even-rounded and x/y clamped into
 * the working region like `cropWindow`; keyframes are sorted by `t`, the first
 * window holds before its time and the last holds after (no extrapolation).
 * Returns the filter stages in order; the caller appends `setsar=1` etc.
 * Throws on no keyframes, non-positive w/h, or a window larger than the region.
 */
export function buildEasedCropWindowFilters(
  keyframes: CropWindowKeyframe[],
  workW: number,
  workH: number,
): string[] {
  if (keyframes.length === 0) {
    throw new Error("buildEasedCropWindowFilters: at least one keyframe required");
  }
  // Sanitize each window exactly like the static `cropWindow` branch: even
  // w/h (H.264-friendly sizes), x/y clamped into the working region.
  const kfs = keyframes
    .map((k) => {
      const w = even(k.w);
      const h = even(k.h);
      if (w <= 0 || h <= 0) {
        throw new Error(`cropWindowPath window at t=${k.t} must have positive w/h, got ${w}x${h}`);
      }
      if (w > workW || h > workH) {
        throw new Error(
          `cropWindowPath window at t=${k.t} (${w}x${h}) exceeds working region ${workW}x${workH}`,
        );
      }
      const x = even(Math.max(0, Math.min(k.x, workW - w)));
      const y = even(Math.max(0, Math.min(k.y, workH - h)));
      return { t: k.t, x, y, w, h };
    })
    .sort((a, b) => a.t - b.t);

  // Bounding box of all keyframe windows (every eased window stays inside it).
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const k of kfs) {
    bx0 = Math.min(bx0, k.x);
    by0 = Math.min(by0, k.y);
    bx1 = Math.max(bx1, k.x + k.w);
    by1 = Math.max(by1, k.y + k.h);
  }
  const bw = bx1 - bx0; // even: differences of even values
  const bh = by1 - by0;

  const filters: string[] = [];
  // Pre-crop to the bounding box when it actually trims something, and express
  // the keyframes relative to its origin.
  const preCrop = bw < workW || bh < workH;
  if (preCrop) {
    filters.push(`crop=${bw}:${bh}:${bx0}:${by0}`);
  }
  const srcW = preCrop ? bw : workW;
  const srcH = preCrop ? bh : workH;
  const ox = preCrop ? bx0 : 0;
  const oy = preCrop ? by0 : 0;

  const wExpr = buildEasedExpr(kfs.map((k) => ({ t: k.t, v: k.w })));
  const hExpr = buildEasedExpr(kfs.map((k) => ({ t: k.t, v: k.h })));
  const xExpr = buildEasedExpr(kfs.map((k) => ({ t: k.t, v: k.x - ox })));
  const yExpr = buildEasedExpr(kfs.map((k) => ({ t: k.t, v: k.y - oy })));

  // Per-frame canvas: the region scaled so the eased window maps onto the fixed
  // output crop. trunc(…/2)*2 keeps dimensions even for yuv420p.
  const canvasW = `trunc(${srcW}*${TARGET_W}/(${wExpr})/2)*2`;
  const canvasH = `trunc(${srcH}*${TARGET_H}/(${hExpr})/2)*2`;
  filters.push(`scale=w='${canvasW}':h='${canvasH}':eval=frame:flags=lanczos`);
  // Clamp the per-frame crop position against the CANVAS-SIZE EXPRESSION, not
  // crop's iw/ih: those link constants bind at filter-configure time (the first
  // frame's size) and do NOT track the per-frame resize, which froze the clamp
  // at 0 — verified empirically. The canvas formula is pure `t`, so re-stating
  // it keeps the whole position per-frame-correct.
  const cropX = `min(max((${xExpr})*${TARGET_W}/(${wExpr}),0),(${canvasW})-${TARGET_W})`;
  const cropY = `min(max((${yExpr})*${TARGET_H}/(${hExpr}),0),(${canvasH})-${TARGET_H})`;
  filters.push(`crop=${TARGET_W}:${TARGET_H}:x='${cropX}':y='${cropY}'`);
  return filters;
}

/**
 * Evaluate an animated punch-in's window at clip-relative time `t` as plain
 * numbers — the single-instant form of `buildEasedCropWindowFilters`'s eased
 * expressions (same smoothstep per channel, holding the first/last window
 * outside the path's range), WITHOUT the even-round/clamp (callers wanting
 * render-exact pixels apply those). Used by the GUI preview overlay to follow
 * the push over time.
 */
export function easedCropWindowAt(
  keyframes: CropWindowKeyframe[],
  t: number,
): { x: number; y: number; w: number; h: number } {
  const at = (sel: (k: CropWindowKeyframe) => number): number =>
    easedCropXAt(
      keyframes.map((k) => ({ t: k.t, x: sel(k) })),
      t,
    );
  return { x: at((k) => k.x), y: at((k) => k.y), w: at((k) => k.w), h: at((k) => k.h) };
}

/**
 * Evaluate an eased crop path's x at clip-relative time `t` as a plain number —
 * the same smoothstep math `buildEasedCropX` encodes into an ffmpeg expression
 * (p clamped to [0,1], s = p*p*(3-2p)), evaluated in JS for a single instant.
 * Holds the first/last keyframe's x outside the path's time range; coincident
 * keyframes degenerate to a step (matching the expression's behavior). Used by
 * the GUI preview overlay and the cover-frame export (`coverFrameArgs`).
 */
export function easedCropXAt(keyframes: CropPathKeyframe[], t: number): number {
  if (keyframes.length === 0) return 0;
  const kfs = [...keyframes].sort((a, b) => a.t - b.t);
  if (kfs.length === 1) return kfs[0]!.x;
  if (t <= kfs[0]!.t) return kfs[0]!.x;
  const last = kfs[kfs.length - 1]!;
  if (t >= last.t) return last.x;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const dt = b.t - a.t;
      if (dt <= 0) return b.x;
      const p = Math.max(0, Math.min(1, (t - a.t) / dt));
      const s = p * p * (3 - 2 * p);
      return a.x + (b.x - a.x) * s;
    }
  }
  return last.x;
}

/**
 * The ACTIVE offset of a parsed `crop_offset` schedule at clip-relative time
 * `t`: the last segment whose time is ≤ `t`. The first segment applies from the
 * clip start regardless of its stated time (matching the nested `if(lt(t,…))`
 * hard-switch expression `buildFfmpegArgs` emits — this is its single-instant
 * evaluation, used by the cover-frame export). `segments` must be sorted by
 * time, as `parseCropSchedule` returns them.
 */
export function scheduleOffsetAt(segments: Array<[number, string]>, t: number): string {
  if (segments.length === 0) {
    throw new Error("scheduleOffsetAt: at least one segment required");
  }
  let active = segments[0]![1];
  for (const [time, offset] of segments) {
    if (time <= t) active = offset;
    else break;
  }
  return active;
}

/** Sanitize text for use in a filename. */
export function safeName(text: string): string {
  const collapsed = text.replace(/[^A-Za-z0-9._-]+/g, "_");
  // Trim leading/trailing underscores with a linear scan rather than a
  // backtracking-prone `^_+|_+$` regex (CodeQL js/polynomial-redos).
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === "_") start++;
  while (end > start && collapsed[end - 1] === "_") end--;
  return collapsed.slice(start, end);
}

/** Format a number to a fixed 3 decimal places (ffmpeg-friendly timestamps). */
function f3(n: number): string {
  return n.toFixed(3);
}

/**
 * Format a number to at most 3 decimals, trimming trailing zeros (so integers
 * print bare: `0`, `1312`, `14.5`). Used inside the eased crop-path expression
 * to keep it compact and readable.
 */
function num(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

/** Result of building an ffmpeg invocation for one clip row. */
export interface BuiltCommand {
  args: string[];
  outPath: string;
  /**
   * True when the row has a `fade_in`/`fade_out` but the render asked for the
   * default lossless `-c:a copy`: an `afade` cannot ride a stream copy, so the
   * clip's audio was re-encoded to AAC at `FADE_AUDIO_BITRATE` instead. Callers
   * surface this (CLI log note / GUI hint) so the change is never silent.
   */
  forcedAudioReencode: boolean;
}

/** Options for building an ffmpeg command. */
export interface BuildOptions extends RenderOptions {
  /** Output directory for the rendered clip. */
  outdir: string;
  /**
   * Pre-probed source dimensions [width, height]. If omitted, callers must
   * supply them (the CLI probes via ffprobe). Exposed so tests need no files.
   */
  dims: [number, number];
  /**
   * Optional ANIMATED punch-in (slow push): smoothstep-interpolated crop-window
   * keyframes (position AND size) within a single continuous shot. When present
   * it takes precedence over everything else (`cropWindowPath` > `cropPath` >
   * `cropWindow` > `crop_offset`); the geometry renders via
   * `buildEasedCropWindowFilters` (per-frame eased upscale + fixed output-size
   * crop), replacing the usual crop + static scale stages. A single keyframe
   * degenerates to the equivalent static `cropWindow`. `content_crop`, setsar
   * and audio are unchanged.
   */
  cropWindowPath?: CropWindowKeyframe[];
  /**
   * Optional eased crop path (SPEC §6.9): smoothstep-interpolated keyframes
   * that pan the crop window's x within a single continuous shot. When present
   * it takes precedence over the row's `crop_offset` schedule — the crop x
   * becomes `buildEasedCropX(cropPath)`. Crop width/height/y are still taken
   * from `computeCrop` (full-height 9:16 over the working region); only x is
   * animated. The `content_crop` pre-crop, scale, setsar and audio are
   * unchanged.
   */
  cropPath?: CropPathKeyframe[];
  /**
   * Optional explicit 9:16 crop window (punch-in / zoom) in working-region
   * pixels. When present — and no `cropPath` is set — it takes precedence over
   * the row's `crop_offset`: the crop becomes `crop=w:h:x:y` (even-rounded and
   * clamped into the working region) instead of a full-height crop positioned by
   * offset. `content_crop`, scale, setsar and audio are unchanged.
   */
  cropWindow?: CropWindowSpec;
  /**
   * Path to a temp `.ass` file (from `buildCaptionAss`) for burned captions.
   * When set, a `subtitles=filename=…` filter is appended after `setsar`. The
   * caller writes the file and is responsible for cleaning it up; keeping the
   * path here (not the content) lets `buildFfmpegArgs` stay pure.
   */
  captionAssPath?: string;
  /**
   * Interpret `out_name` with Windows path rules (`\` is a separator; `C:…` and
   * a leading `\` are absolute) when checking it stays inside `outdir`. Default
   * false (POSIX). Passed in rather than read from `process` so this stays pure;
   * the CLI sets it from `process.platform`.
   */
  windowsPaths?: boolean;
}

/**
 * Join a directory and filename with a forward slash, normalizing a trailing
 * separator on the directory. Kept simple and POSIX-style for stable output
 * paths in tests; the CLI may pass an absolute or relative outdir.
 */
/** Strip trailing path separators (`/` or `\`) with a linear scan (no backtracking regex). */
function trimTrailingSeparators(p: string): string {
  let end = p.length;
  while (end > 0 && (p[end - 1] === "/" || p[end - 1] === "\\")) end--;
  return p.slice(0, end);
}

function joinPath(dir: string, name: string): string {
  if (dir === "") return name;
  const trimmed = trimTrailingSeparators(dir);
  return `${trimmed}/${name}`;
}

/**
 * Reject an explicit `out_name` that would write OUTSIDE the output folder: an
 * absolute path (`/x`) or any `..` path segment (`../x`, `a/../../x`). With
 * `windowsPaths`, `\` is a separator too and a drive (`C:…`) or leading `\`
 * is absolute; on POSIX those are ordinary filename characters (`A:Side`,
 * `..\x`), so they are left alone. A plain name or a relative subpath
 * (`sub/clip`) is fine and unchanged. Throws a per-clip error, so the CLI skips
 * just that clip.
 */
function assertOutNameStaysInOutdir(outName: string, windowsPaths: boolean): void {
  const absolute = windowsPaths
    ? /^[/\\]/.test(outName) || /^[A-Za-z]:/.test(outName)
    : outName.startsWith("/");
  const segments = outName.split(windowsPaths ? /[/\\]/ : "/");
  if (absolute || segments.includes("..")) {
    throw new Error(
      `out_name ${JSON.stringify(outName)} must stay inside the output folder ` +
        `(no absolute path or ".." segments)`,
    );
  }
}

/**
 * Build the ffmpeg argument array and output path for a single clip row.
 *
 * The filter chain: optional content-crop first, then the 9:16 crop (with an
 * `if()` x-expression for multi-segment schedules), scale to 1080x1920,
 * setsar=1, optional burned captions, optional per-clip fades (last, so the
 * captions fade with the video), and lossless audio copy by default — except
 * when a fade forces an AAC re-encode (see `FADE_AUDIO_BITRATE`). Dimensions
 * are passed in (already probed) so this stays pure.
 */
export function buildFfmpegArgs(row: ClipRow, opts: BuildOptions): BuiltCommand {
  const source = row.source_file.trim();

  const start = parseTimestamp(row.in_point);
  const end = parseTimestamp(row.out_point);
  const duration = end - start;
  if (duration <= 0) {
    throw new Error(`out_point (${end}s) must be after in_point (${start}s)`);
  }

  // Per-clip fades (issue #165). The clip duration is known at build time, so
  // both fades resolve to fixed start times here. Validate early: a fade pair
  // longer than the clip would push the fade-out's start before 0 / overlap the
  // fade-in and render garbage, so it is a manifest error, not a clamp.
  const fadeIn = parseFadeSeconds(row.fade_in, "fade_in");
  const fadeOut = parseFadeSeconds(row.fade_out, "fade_out");
  if (fadeIn + fadeOut > duration) {
    throw new Error(
      `fades are longer than the clip: fade_in (${num(fadeIn)}s) + fade_out (${num(fadeOut)}s) ` +
        `exceed the clip duration (${num(duration)}s) — shorten the fades or widen In/Out`,
    );
  }
  const hasFade = fadeIn > 0 || fadeOut > 0;

  const [iw, ih] = opts.dims;

  // Optional content region (strip letterbox/pillarbox) cropped before the
  // 9:16 crop. Offsets are then relative to this region's dimensions.
  const content = parseContentCrop(row.content_crop);
  const workW = content ? content[0] : iw;
  const workH = content ? content[1] : ih;

  // Crop width/height/y come from computeCrop over the working region; only x
  // varies. For the eased crop path we still need a base offset to size the
  // window — use "center" (size and y are offset-independent for a landscape
  // source, and computeCrop clamps x anyway, so the choice does not affect
  // cw/ch/y). The path itself supplies the animated x.
  const windowPath =
    opts.cropWindowPath && opts.cropWindowPath.length > 0 ? opts.cropWindowPath : null;
  let cropFilter = "";
  if (windowPath) {
    // Animated punch-in (#163) — highest precedence. Its eased per-frame
    // upscale + fixed output-size crop REPLACE the usual crop + static scale
    // stages, so no cropFilter is computed; see the assembly below.
  } else if (opts.cropPath && opts.cropPath.length > 0) {
    // SPEC §6.9: smoothly eased crop path takes precedence over crop_offset.
    const base = computeCrop(workW, workH, "center");
    const xExpr = buildEasedCropX(opts.cropPath);
    cropFilter = `crop=${base.cw}:${base.ch}:x='${xExpr}':y=${base.y}`;
  } else if (opts.cropWindow) {
    const win = clampCropWindow(opts.cropWindow, workW, workH);
    cropFilter = `crop=${win.cw}:${win.ch}:${win.x}:${win.y}`;
  } else {
    const schedule = parseCropSchedule(row.crop_offset);
    // Crop size and y are constant across the schedule; only x changes.
    const base = computeCrop(workW, workH, schedule[0]![1]);
    const cw = base.cw;
    const ch = base.ch;
    const y = base.y;
    const xs = schedule.map(([, off]) => computeCrop(workW, workH, off).x);

    // For a single fixed offset, emit positional `crop=W:H:x:y`. For a
    // time-keyed schedule, the x is an `if()` expression on `t`; emit the named
    // `crop=W:H:x='…':y=0` form and single-quote the expression so the
    // filtergraph parser does not split it on the commas/parens inside.
    if (schedule.length === 1) {
      cropFilter = `crop=${cw}:${ch}:${xs[0]}:${y}`;
    } else {
      // Build nested if(): first offset applies until the second's time, etc.
      let expr = String(xs[0]);
      for (let i = 1; i < schedule.length; i++) {
        const t = schedule[i]![0];
        const xv = xs[i];
        expr = `if(lt(t,${f3(t)}),${expr},${xv})`;
      }
      cropFilter = `crop=${cw}:${ch}:x='${expr}':y=${y}`;
    }
  }

  let outName = (row.out_name || "").trim();
  assertOutNameStaysInOutdir(outName, opts.windowsPaths ?? false);
  if (!outName) {
    const stem = sourceStem(source);
    outName = `${safeName(stem)}_${safeName(row.in_point)}-${safeName(row.out_point)}.mp4`;
  }
  if (!outName.toLowerCase().endsWith(".mp4")) {
    outName += ".mp4";
  }
  // The output path is ffmpeg's LAST argument, so one that starts with `-`
  // (an `out_name` / source stem like `-live` under `--outdir ""`, or an outdir
  // of its own like `-x`) would be parsed as an option. `./` names the same file.
  const joined = joinPath(opts.outdir, outName);
  const outPath = joined.startsWith("-") ? `./${joined}` : joined;

  const filters: string[] = [];
  if (content) {
    filters.push(`crop=${content[0]}:${content[1]}:${content[2]}:${content[3]}`);
  }
  if (windowPath) {
    // Animated punch-in: bounding-box pre-crop → per-frame eased upscale →
    // fixed 1080×1920 crop (lands at the output size, so no static scale).
    filters.push(...buildEasedCropWindowFilters(windowPath, workW, workH));
  } else {
    filters.push(cropFilter);
    filters.push(`scale=${TARGET_W}:${TARGET_H}:flags=lanczos`);
  }
  filters.push("setsar=1");
  // Optional burned captions, rendered LAST on the final 1080×1920 frame via
  // libass (SPEC §6.5). The ASS document is generated by `buildCaptionAss` and
  // written to a temp file by the caller, which passes its path here so this
  // builder stays pure. PlayResX/Y in the ASS match the output, so positions and
  // sizes are 1:1. A custom font FILE is exposed to libass via `fontsdir`.
  if (opts.captionAssPath) {
    let sub = `subtitles=filename=${filterEscape(opts.captionAssPath)}`;
    if (opts.captionFontFile) {
      sub += `:fontsdir=${filterEscape(dirname(opts.captionFontFile))}`;
    }
    filters.push(sub);
  }
  // Per-clip fades go LAST — after the burned captions — so the captions fade
  // in/out with the video instead of floating at full opacity over a black
  // frame (the polished look). Times are clip-relative: `-ss` before `-i`
  // resets timestamps to 0, so the fade-in starts at 0 and the fade-out at
  // duration − length.
  if (fadeIn > 0) filters.push(`fade=t=in:st=0:d=${f3(fadeIn)}`);
  if (fadeOut > 0) filters.push(`fade=t=out:st=${f3(duration - fadeOut)}:d=${f3(fadeOut)}`);
  const vf = filters.join(",");

  // Audio: default to a lossless stream copy (same codec, bitrate and sample
  // rate as the source) so we never re-compress or resample. Pass a bitrate
  // (e.g. 256k) only if a re-encode is actually needed.
  //
  // THE FADE/COPY RULE (issue #165, decided once): a fade needs a matching
  // `afade`, and `afade` cannot ride a stream copy — the audio must be decoded
  // and re-encoded. When a clip has a fade and the render asked for "copy",
  // force an AAC re-encode at FADE_AUDIO_BITRATE for THAT clip and report it
  // via `forcedAudioReencode` (the CLI logs a note; the GUI hints at it).
  // Fading only the video was rejected: a hard audio cut under a video fade
  // reads as broken, and silently ignoring the fade is worse.
  const forcedAudioReencode = hasFade && opts.audioBitrate === "copy";
  const audioBitrate = forcedAudioReencode ? FADE_AUDIO_BITRATE : opts.audioBitrate;
  const audioArgs =
    audioBitrate === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", audioBitrate];

  // Matching audio fades (same lengths/times as the video's).
  const afades: string[] = [];
  if (fadeIn > 0) afades.push(`afade=t=in:st=0:d=${f3(fadeIn)}`);
  if (fadeOut > 0) afades.push(`afade=t=out:st=${f3(duration - fadeOut)}:d=${f3(fadeOut)}`);
  const audioFilterArgs = afades.length > 0 ? ["-af", afades.join(",")] : [];

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-stats",
    "-y",
    "-ss",
    f3(start),
    "-i",
    source,
    "-t",
    f3(duration),
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    opts.preset,
    "-crf",
    String(opts.crf),
    "-pix_fmt",
    "yuv420p",
    ...audioFilterArgs,
    ...audioArgs,
    "-movflags",
    "+faststart",
    outPath,
  ];

  return { args, outPath, forcedAudioReencode };
}

/**
 * Even-round and clamp an explicit punch-in `CropWindowSpec` into the working
 * region (H.264 needs even dimensions; the still export keeps the same rule so
 * the cover matches the rendered clip pixel-for-pixel). Throws on a non-positive
 * or region-exceeding window. Shared by `buildFfmpegArgs` and `coverFrameArgs`;
 * exported so test/fixtures/crop.json can pin it alongside the Rust mirror.
 */
export function clampCropWindow(win: CropWindowSpec, workW: number, workH: number): Crop {
  const cw = even(win.w);
  const ch = even(win.h);
  if (cw <= 0 || ch <= 0) {
    throw new Error(`cropWindow must have positive w/h, got ${cw}x${ch}`);
  }
  if (cw > workW || ch > workH) {
    throw new Error(`cropWindow ${cw}x${ch} exceeds working region ${workW}x${workH}`);
  }
  const x = even(Math.max(0, Math.min(win.x, workW - cw)));
  const y = even(Math.max(0, Math.min(win.y, workH - ch)));
  return { cw, ch, x, y };
}

/** Options for building a cover-frame (single-PNG) ffmpeg command. */
export interface CoverFrameOptions {
  /** Pre-probed source dimensions [width, height] (passed in — stays pure). */
  dims: [number, number];
  /** Eased crop path; takes precedence over `crop_offset` (same as render). */
  cropPath?: CropPathKeyframe[];
  /** Explicit punch-in window; beats `crop_offset` when no `cropPath` is set. */
  cropWindow?: CropWindowSpec;
  /** Output target: a `.png` path, or `"-"` (the default) for PNG on stdout. */
  out?: string;
}

/**
 * Build the ffmpeg argument array that exports ONE frame at source time `t`
 * through the row's ACTIVE framing as a 1080×1920 PNG — the clip's cover image
 * (issue #166). The filter chain mirrors `buildFfmpegArgs` exactly minus the
 * encode: `[optional content_crop] → 9:16 crop → scale=1080:1920:lanczos`, with
 * `-frames:v 1` and the PNG encoder. Because a still has no timeline, the crop
 * x is a single NUMBER evaluated at `t` instead of a `t`-expression:
 *
 *  - eased `cropPath` → `easedCropXAt` at the clip-relative time (rounded and
 *    clamped into the working region), matching the smoothstep the render emits;
 *  - punch-in `cropWindow` → the same even-rounded/clamped fixed window;
 *  - `crop_offset` (fixed or schedule) → `scheduleOffsetAt` picks the segment
 *    active at the clip-relative time, then `computeCrop` resolves its x.
 *
 * `t` is in SOURCE seconds (the GUI playhead); schedule/path times are
 * clip-relative, so they are evaluated at `max(0, t - in_point)`. Precedence is
 * the render's: `cropPath` > `cropWindow` > `crop_offset`.
 *
 * The native Rust backend (app/src-tauri/src/cover.rs `cover_frame_args`) hand-
 * mirrors this builder — keep the two in sync.
 */
export function coverFrameArgs(row: ClipRow, t: number, opts: CoverFrameOptions): string[] {
  const source = row.source_file.trim();
  const [iw, ih] = opts.dims;

  // Optional content region (strip letterbox/pillarbox) cropped before the
  // 9:16 crop, exactly as in buildFfmpegArgs.
  const content = parseContentCrop(row.content_crop);
  const workW = content ? content[0] : iw;
  const workH = content ? content[1] : ih;

  // Clip-relative time for the schedule / eased path (clamped at the clip start).
  const seek = Number.isFinite(t) ? t : 0;
  const rel = Math.max(0, seek - parseTimestamp(row.in_point));

  let cropFilter: string;
  if (opts.cropPath && opts.cropPath.length > 0) {
    // SPEC §6.9 precedence: the eased path beats everything. Same "center" base
    // sizing trick as buildFfmpegArgs (cw/ch/y are offset-independent).
    const base = computeCrop(workW, workH, "center");
    const maxX = Math.max(0, workW - base.cw);
    const x = Math.round(Math.min(maxX, Math.max(0, easedCropXAt(opts.cropPath, rel))));
    cropFilter = `crop=${base.cw}:${base.ch}:${x}:${base.y}`;
  } else if (opts.cropWindow) {
    const win = clampCropWindow(opts.cropWindow, workW, workH);
    cropFilter = `crop=${win.cw}:${win.ch}:${win.x}:${win.y}`;
  } else {
    const schedule = parseCropSchedule(row.crop_offset);
    const c = computeCrop(workW, workH, scheduleOffsetAt(schedule, rel));
    cropFilter = `crop=${c.cw}:${c.ch}:${c.x}:${c.y}`;
  }

  const filters: string[] = [];
  if (content) {
    filters.push(`crop=${content[0]}:${content[1]}:${content[2]}:${content[3]}`);
  }
  filters.push(cropFilter);
  filters.push(`scale=${TARGET_W}:${TARGET_H}:flags=lanczos`);

  // INPUT-seek (accurate, same as frameExtractArgs); -y so a file target can be
  // overwritten (harmless for the stdout form).
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(seek),
    "-i",
    source,
    "-vf",
    filters.join(","),
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-c:v",
    "png",
    opts.out ?? "-",
  ];
}

/**
 * Default filename for a clip's exported cover PNG, derived from the clip the
 * same way `buildFfmpegArgs` derives its output name: the row's `out_name`
 * (minus any `.mp4`) when set, else `<stem>_<in>-<out>`, suffixed `_cover.png`.
 */
export function coverOutName(row: ClipRow): string {
  let base = (row.out_name || "").trim();
  if (base.toLowerCase().endsWith(".mp4")) base = base.slice(0, -4);
  if (!base) {
    const stem = sourceStem(row.source_file.trim());
    base = `${safeName(stem)}_${safeName(row.in_point)}-${safeName(row.out_point)}`;
  }
  return `${base}_cover.png`;
}

/** Vertical placement of the burned caption block in the 1080×1920 frame. */
export type TextPosition = "top" | "center" | "bottom";

/** Fontconfig family used when no caption font is configured (system default sans). */
export const DEFAULT_CAPTION_FONT = "Sans";

/**
 * Default caption style (SPEC §6.5), sized to the 1920px-tall output: a big
 * `hook` (~h/18) above a smaller `title` (~h/26), white fill with a black
 * outline for legibility over busy stage footage, inside a ~12% safe margin.
 */
const CAPTION_STYLE = {
  hookSize: Math.round(TARGET_H / 18), // ~107px
  titleSize: Math.round(TARGET_H / 26), // ~74px
  margin: Math.round(TARGET_H * 0.12), // ~230px safe margin
  outline: 4,
} as const;

/**
 * ASS numpad alignment (1–9) from a `text_position` string: a vertical keyword
 * (`top`/`center`/`bottom`, default bottom) optionally suffixed with a horizontal
 * one (`-left`/`-center`/`-right`, default center) — e.g. `"bottom-left"` → 1,
 * `"center"` → 5, `"top-right"` → 9. Legacy `top`/`center`/`bottom` stay centered.
 */
function assAlignment(value: string | undefined): number {
  const [v, h] = (value || "").trim().toLowerCase().split("-");
  const base = v === "top" ? 6 : v === "center" || v === "middle" ? 3 : 0;
  const col = h === "left" ? 1 : h === "right" ? 3 : 2;
  return base + col;
}

/**
 * Convert a `#RRGGBB` (or `RRGGBB`) hex colour to an opaque ASS colour
 * `&H00BBGGRR` (ASS is little-endian BGR with an alpha byte; 00 = opaque).
 * Returns `fallback` for anything malformed.
 */
function hexToAssColor(hex: string | undefined, fallback: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || "").trim());
  if (!m) return fallback;
  const h = m[1]!.toUpperCase();
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

/**
 * The ASS Style `Fontname`: the configured family name, else a best-effort name
 * derived from a font FILE's stem (the GUI font picker supplies real family
 * names; libass also gets the file's dir via `fontsdir`), else the system Sans.
 * Always passed through `assFontName`, since it lands in a comma-separated Style line.
 */
function captionFontFamily(opts: RenderOptions): string {
  const raw =
    opts.captionFontName && opts.captionFontName.trim()
      ? opts.captionFontName
      : opts.captionFontFile && opts.captionFontFile.trim()
        ? sourceStem(opts.captionFontFile)
        : "";
  return assFontName(raw) || DEFAULT_CAPTION_FONT;
}

/**
 * Make a family name safe for the ASS `Style:` line's `Fontname` field. The line
 * is comma-separated with no quoting, and one line per style, so a `,` would
 * shift every later field and a newline would end the line early. Each run of
 * commas / control characters (CR, LF, tab, NUL, …) — together with any spaces
 * around it — becomes one space; the result is trimmed. A name with none of
 * those is returned unchanged (trimmed). A linear scan, not a regex, so the
 * spaces-around-a-run rule can't backtrack.
 */
function assFontName(name: string): string {
  const isBad = (c: string) => c === "," || c <= "\u001F" || c === "\u007F";
  let out = "";
  let pendingBreak = false;
  for (const c of name) {
    if (isBad(c)) {
      pendingBreak = true;
      out = out.trimEnd();
    } else if (pendingBreak && c === " ") {
      // swallow spaces after a bad run
    } else {
      if (pendingBreak && out) out += " ";
      pendingBreak = false;
      out += c;
    }
  }
  return out.trim();
}

/**
 * Escape user text for an ASS `Dialogue` text field: drop backslashes (so
 * override escapes can't be injected), neutralize `{` `}` (ASS override
 * delimiters), then turn the user's real newlines into `\N` line breaks — the
 * only backslash sequence we emit ourselves. Backslashes are stripped BEFORE
 * the newline conversion so user text can never smuggle one in. Per-line
 * trimming uses split/trim/join (not an adjacent-quantifier regex) so
 * library-supplied text can't trigger polynomial backtracking.
 */
function assEscape(value: string): string {
  const cleaned = value
    .replace(/\\/g, "")
    .replace(/[{}]/g, (m) => (m === "{" ? "(" : ")"))
    .trim();
  return cleaned
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .join("\\N");
}

/**
 * Escape an arbitrary string (e.g. a file path) as a filter option VALUE inside
 * an `-vf` filtergraph. ffmpeg unescapes it twice (see "Quoting and escaping" in
 * ffmpeg-filters), so we escape for each level, innermost first:
 *  1. the filter's option parser splits on `:` and treats `\` and `'` specially;
 *  2. the filtergraph parser treats `\ ' [ ] , ;` specially.
 * Quoting is NOT used: inside `'…'` a backslash is literal, so a path containing
 * `'` can't be expressed, and the option-level `:` split still applies after the
 * graph level strips the quotes (a Windows `C:\…` path broke every caption).
 * Argv is passed without a shell, so there is no third level.
 */
export function filterEscape(value: string): string {
  // One pass that yields both levels at once (equivalent to escaping for the
  // option level, then escaping THAT for the graph level):
  //  - option-level specials (`\` `'` `:`), plus a whitespace first/last char
  //    (both levels trim unescaped edge whitespace), get an option-level `\`,
  //    which the graph level doubles to `\\`; if the char is itself
  //    graph-special (`\` `'`) it is graph-escaped too;
  //  - graph-only specials (`[` `]` `,` `;`) get a single `\`.
  return value.replace(/[\\':[\],;]|^[ \t\n\r]|[ \t\n\r]$/g, (c) => {
    if (c === "[" || c === "]" || c === "," || c === ";") return `\\${c}`;
    return c === "\\" || c === "'" ? `\\\\\\${c}` : `\\\\${c}`;
  });
}

/** Directory portion of a path (`.` when there is none). Index-based (no
 * backtracking regex) so library-supplied paths can't trigger ReDoS. */
function dirname(p: string): string {
  const t = trimTrailingSeparators(p);
  const slash = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  if (slash === 0) return t.slice(0, 1); // root-level file: "/font.ttf" -> "/"
  return slash > 0 ? t.slice(0, slash) : ".";
}

/**
 * Build the libass **ASS subtitle document** for one row's burned captions, or
 * `null` when captions are off or the row has no `hook`/`title` (SPEC §6.5).
 * Pure — the caller writes this to a temp `.ass` and passes its path as
 * `BuildOptions.captionAssPath`. The hook (bigger) sits above the title via an
 * inline `\fs`, stacked with `\N`, as one block placed at `text_position`
 * (white fill, black outline). Newlines INSIDE `hook`/`title` are honored: each
 * becomes a `\N` line break at that field's size, so either field can span
 * multiple lines. `PlayResX/Y` match the 1080×1920 output.
 */
export function buildCaptionAss(row: ClipRow, opts: RenderOptions): string | null {
  if (!opts.burnCaptions) return null;
  const hook = (row.hook || "").trim();
  const title = (row.title || "").trim();
  if (!hook && !title) return null;

  const align = assAlignment(row.text_position);
  const family = captionFontFamily(opts);

  const lines: string[] = [];
  if (hook) lines.push(`{\\fs${CAPTION_STYLE.hookSize}}${assEscape(hook)}`);
  if (title) lines.push(`{\\fs${CAPTION_STYLE.titleSize}}${assEscape(title)}`);
  const text = lines.join("\\N");

  // ASS colour is &HAABBGGRR (AA=00 opaque); default white fill, black outline.
  // Bold/Italic/Underline are -1 (on) / 0 (off). Outline scales with PlayRes via
  // ScaledBorderAndShadow.
  const fill = hexToAssColor(opts.captionColor, "&H00FFFFFF");
  const bold = opts.captionBold ? -1 : 0;
  const italic = opts.captionItalic ? -1 : 0;
  const underline = opts.captionUnderline ? -1 : 0;
  const angle = Number.isFinite(opts.captionAngle) ? Math.round(opts.captionAngle as number) : 0;
  // BorderStyle 1 = outline (OutlineColour) + optional drop shadow (BackColour);
  // BorderStyle 3 = opaque box, drawn in OutlineColour (so the box colour rides
  // the OutlineColour slot, with Outline as the box padding).
  const box = !!opts.captionBox;
  const borderStyle = box ? 3 : 1;
  const borderColor = box
    ? hexToAssColor(opts.captionBoxColor, "&H00000000")
    : hexToAssColor(opts.captionOutlineColor, "&H00000000");
  const borderW = box ? 10 : CAPTION_STYLE.outline;
  const shadow = opts.captionShadow ? 4 : 0;
  const style =
    `Style: Caption,${family},${CAPTION_STYLE.titleSize},` +
    `${fill},&H000000FF,${borderColor},&H00000000,` +
    `${bold},${italic},${underline},0,100,100,0,${angle},${borderStyle},${borderW},${shadow},${align},60,60,${CAPTION_STYLE.margin},1`;

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${TARGET_W}`,
    `PlayResY: ${TARGET_H}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:00.00,9:59:59.99,Caption,,0,0,0,,${text}`,
    "",
  ].join("\n");
}

/** Extract the filename stem (basename without final extension) from a path. */
function sourceStem(p: string): string {
  const base = trimTrailingSeparators(p).split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
