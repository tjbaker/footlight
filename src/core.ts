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
 */

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

/** Parse `HH:MM:SS`, `MM:SS`, or plain seconds into float seconds. */
export function parseTimestamp(value: string): number {
  value = value.trim();
  if (!value) {
    throw new Error("empty timestamp");
  }
  if (value.includes(":")) {
    const parts = value.split(":");
    if (parts.length > 3) {
      throw new Error(`bad timestamp: ${JSON.stringify(value)}`);
    }
    let secs = 0;
    for (const part of parts) {
      const n = Number(part);
      if (Number.isNaN(n)) {
        throw new Error(`bad timestamp: ${JSON.stringify(value)}`);
      }
      secs = secs * 60 + n;
    }
    return secs;
  }
  const n = Number(value);
  if (Number.isNaN(n)) {
    throw new Error(`bad timestamp: ${JSON.stringify(value)}`);
  }
  return n;
}

/** Parse a `"W:H:X:Y"` content region (for stripping letterbox bars), or null. */
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
    const n = Number(p);
    if (!Number.isInteger(n)) {
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
 * 'left' / 'center' / 'right', or an integer x-pixel offset from the left.
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
      const f = Number(offset);
      if (Number.isNaN(f)) {
        throw new Error(
          `crop_offset must be left/center/right or an integer, got ${JSON.stringify(cropOffset)}`,
        );
      }
      x = Math.round(f);
      x = Math.max(0, Math.min(x, maxX)); // clamp into frame
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
  const kfs = [...keyframes].sort((a, b) => a.t - b.t);
  if (kfs.length === 1) {
    return num(kfs[0]!.x);
  }

  // Build the smoothstep expression for one segment [a, b].
  const segExpr = (a: CropPathKeyframe, b: CropPathKeyframe): string => {
    const dt = b.t - a.t;
    if (dt <= 0) {
      // Coincident/inverted keyframes: degenerate to an instantaneous step to b.
      return num(b.x);
    }
    // p clamped to [0,1] so the segment expression holds its endpoints outside
    // [a.t, b.t]; smoothstep s = p*p*(3-2*p); x = x_a + (x_b - x_a)*s.
    const p = `clip((t-${num(a.t)})/${num(dt)},0,1)`;
    const s = `(${p})*(${p})*(3-2*(${p}))`;
    const dx = b.x - a.x;
    return `(${num(a.x)}+(${num(dx)})*(${s}))`;
  };

  // Nest from the LAST segment outward, so the first segment is the outermost
  // `if`: for t < t_1 use segment 0, else fall through to the next test. The
  // final `else` is the last segment (which itself holds last x for t > t_last
  // thanks to the clamped p). t before t_0 falls into segment 0, whose clamped
  // p holds x_0.
  const last = kfs.length - 1;
  let expr = segExpr(kfs[last - 1]!, kfs[last]!);
  for (let i = last - 2; i >= 0; i--) {
    const boundary = kfs[i + 1]!.t;
    expr = `if(lt(t,${num(boundary)}),${segExpr(kfs[i]!, kfs[i + 1]!)},${expr})`;
  }
  return expr;
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
 * Build the ffmpeg argument array and output path for a single clip row.
 *
 * The filter chain: optional content-crop first, then the 9:16 crop (with an
 * `if()` x-expression for multi-segment schedules), scale to 1080x1920,
 * setsar=1, H.264 encode, and lossless audio copy by default. Dimensions are
 * passed in (already probed) so this stays pure.
 */
export function buildFfmpegArgs(row: ClipRow, opts: BuildOptions): BuiltCommand {
  const source = row.source_file.trim();

  const start = parseTimestamp(row.in_point);
  const end = parseTimestamp(row.out_point);
  const duration = end - start;
  if (duration <= 0) {
    throw new Error(`out_point (${end}s) must be after in_point (${start}s)`);
  }

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
  let cropFilter: string;
  if (opts.cropPath && opts.cropPath.length > 0) {
    // SPEC §6.9: smoothly eased crop path takes precedence over crop_offset.
    const base = computeCrop(workW, workH, "center");
    const xExpr = buildEasedCropX(opts.cropPath);
    cropFilter = `crop=${base.cw}:${base.ch}:x='${xExpr}':y=${base.y}`;
  } else if (opts.cropWindow) {
    // Explicit punch-in / zoom window: a fixed-size 9:16 crop positioned in the
    // working region. Even-round (H.264) and clamp all four into [0, work].
    const win = opts.cropWindow;
    const cw = even(win.w);
    const ch = even(win.h);
    if (cw <= 0 || ch <= 0) {
      throw new Error(`cropWindow must have positive w/h, got ${cw}x${ch}`);
    }
    if (cw > workW || ch > workH) {
      throw new Error(
        `cropWindow ${cw}x${ch} exceeds working region ${workW}x${workH}`,
      );
    }
    const x = even(Math.max(0, Math.min(win.x, workW - cw)));
    const y = even(Math.max(0, Math.min(win.y, workH - ch)));
    cropFilter = `crop=${cw}:${ch}:${x}:${y}`;
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
  if (!outName) {
    const stem = sourceStem(source);
    outName = `${safeName(stem)}_${safeName(row.in_point)}-${safeName(row.out_point)}.mp4`;
  }
  if (!outName.toLowerCase().endsWith(".mp4")) {
    outName += ".mp4";
  }
  const outPath = joinPath(opts.outdir, outName);

  const filters: string[] = [];
  if (content) {
    filters.push(`crop=${content[0]}:${content[1]}:${content[2]}:${content[3]}`);
  }
  filters.push(cropFilter);
  filters.push(`scale=${TARGET_W}:${TARGET_H}:flags=lanczos`);
  filters.push("setsar=1");
  // Optional burned captions, rendered LAST on the final 1080×1920 frame via
  // libass (SPEC §6.5). The ASS document is generated by `buildCaptionAss` and
  // written to a temp file by the caller, which passes its path here so this
  // builder stays pure. PlayResX/Y in the ASS match the output, so positions and
  // sizes are 1:1. A custom font FILE is exposed to libass via `fontsdir`.
  if (opts.captionAssPath) {
    let sub = `subtitles=filename=${filterQuote(opts.captionAssPath)}`;
    if (opts.captionFontFile) {
      sub += `:fontsdir=${filterQuote(dirname(opts.captionFontFile))}`;
    }
    filters.push(sub);
  }
  const vf = filters.join(",");

  // Audio: default to a lossless stream copy (same codec, bitrate and sample
  // rate as the source) so we never re-compress or resample. Pass a bitrate
  // (e.g. 256k) only if a re-encode is actually needed.
  const audioArgs =
    opts.audioBitrate === "copy"
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-b:a", opts.audioBitrate];

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
    ...audioArgs,
    "-movflags",
    "+faststart",
    outPath,
  ];

  return { args, outPath };
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
 */
function captionFontFamily(opts: RenderOptions): string {
  if (opts.captionFontName && opts.captionFontName.trim()) return opts.captionFontName.trim();
  if (opts.captionFontFile && opts.captionFontFile.trim()) return sourceStem(opts.captionFontFile);
  return DEFAULT_CAPTION_FONT;
}

/**
 * Escape user text for an ASS `Dialogue` text field: drop backslashes (so `\N`
 * and override escapes can't be injected), neutralize `{` `}` (ASS override
 * delimiters), and collapse real newlines (we place `\N` ourselves).
 */
function assEscape(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "")
    .replace(/[{}]/g, (m) => (m === "{" ? "(" : ")"))
    .trim();
}

/** Single-quote a value for a filtergraph option (`\` and `'` escaped; `:`/`,` are literal inside quotes). */
function filterQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
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
 * (white fill, black outline). `PlayResX/Y` match the 1080×1920 output.
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

  return (
    [
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
    ].join("\n")
  );
}

/**
 * Whether `ffmpeg -filters` output advertises a filter named `name`. Pure so the
 * caption preflight (which needs the libass-backed `subtitles`/`ass` filter) is
 * testable without a subprocess. Matches the listing line `<flags> <name>
 * <in>-><out> <desc>`, not a stray mention inside a description.
 */
export function ffmpegListHasFilter(filtersOutput: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\S{1,4}\\s+${escaped}\\s+\\S+->\\S+`, "m").test(filtersOutput);
}

/** Extract the filename stem (basename without final extension) from a path. */
function sourceStem(p: string): string {
  const base = trimTrailingSeparators(p).split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe command builders + output parsers (SPEC §6).
//
// One pure definition of each auxiliary command (frame extraction, probe,
// cropdetect, scenes) so the Node CLI (`cli.ts`), the engine (`engine.ts`), and
// the web dev backend (`app/dev-server/server.mjs`) all share it instead of
// hand-rolling the same arg arrays and regexes. Pure (string in, string[]/value
// out) so they stay browser-safe and unit-testable.
//
// The native Rust backend (`app/src-tauri/src/main.rs`) mirrors these commands
// by hand — it cannot import TS — so keep it in sync when the args/thresholds
// here change.
// ---------------------------------------------------------------------------

/** Scene-detection threshold for ffmpeg's `scene` filter (0..1). */
export const SCENE_THRESHOLD = 0.4;

/**
 * ffprobe args for a source's first video stream: width, height (+ container
 * duration). Pair with `parseProbe`.
 */
export function ffprobeStreamArgs(source: string): string[] {
  return [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:format=duration",
    "-of",
    "json",
    source,
  ];
}

/** Parse `ffprobeStreamArgs` JSON stdout into dimensions + duration (0 if absent). */
export function parseProbe(stdout: string): { width: number; height: number; duration: number } {
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number }>;
    format?: { duration?: string | number };
  };
  const stream = parsed.streams?.[0] ?? {};
  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    duration: Number(parsed.format?.duration) || 0,
  };
}

/**
 * Seconds before EOF that `frameExtractTailArgs` grabs the last frame from. An
 * exact-time seek that lands at/after the final frame decodes NOTHING (input-seek
 * past the last frame drops every frame), so the mjpeg encoder opens with no
 * packet and the whole command fails — this is the EOF fallback's seek distance.
 */
export const FRAME_TAIL_SEEK_SEC = 0.2;

/** Shared tail of a single-frame MJPEG-on-stdout command (everything after seek). */
function frameExtractArgsWithSeek(
  seek: string[],
  source: string,
  opts: { contentCrop?: string; maxWidth?: number },
): string[] {
  const filters: string[] = [];
  if (opts.contentCrop) filters.push(`crop=${opts.contentCrop}`);
  if (opts.maxWidth && opts.maxWidth > 0) {
    // Only shrink (never upscale); -2 keeps height even for the JPEG encoder.
    filters.push(`scale='min(${Math.round(opts.maxWidth)},iw)':-2`);
  }
  const vf = filters.length ? ["-vf", filters.join(",")] : [];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...seek,
    "-i",
    source,
    ...vf,
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-c:v",
    "mjpeg",
    "-q:v",
    "3",
    "-",
  ];
}

/**
 * ffmpeg args to extract ONE frame at `t` seconds as MJPEG on stdout. Accuracy
 * comes from INPUT-seek (`-ss` before `-i`): it decodes from the nearest
 * keyframe up to `t` and emits the displayed frame.
 *
 * If `t` is at/after the source's end (e.g. seeking to the very end, or the final
 * sampled still), this decodes nothing and the command FAILS — callers should
 * fall back to `frameExtractTailArgs`, which grabs the last available frame.
 *
 * `opts.contentCrop` (`W:H:X:Y`) crops to the working region first; `opts.maxWidth`
 * downscales the long edge (keeping even dimensions) — both used by image-based
 * subject tracking to keep the frame in working-region space and the payload small.
 */
export function frameExtractArgs(
  source: string,
  t: number,
  opts: { contentCrop?: string; maxWidth?: number } = {},
): string[] {
  const seek = Number.isFinite(t) ? t : 0;
  return frameExtractArgsWithSeek(["-ss", String(seek)], source, opts);
}

/**
 * Fallback for `frameExtractArgs`: grab the LAST decodable frame by seeking
 * relative to EOF (`-sseof -FRAME_TAIL_SEEK_SEC`). Use this when an exact-time
 * extraction yields no frame because the requested time was at/past the end —
 * seeking from EOF always lands on a real frame, so the preview/still shows the
 * clip's final frame instead of erroring.
 */
export function frameExtractTailArgs(
  source: string,
  opts: { contentCrop?: string; maxWidth?: number } = {},
): string[] {
  return frameExtractArgsWithSeek(["-sseof", String(-FRAME_TAIL_SEEK_SEC)], source, opts);
}

/**
 * ffmpeg args for a cropdetect (BLACK BARS ONLY) probe. cropdetect writes its
 * analysis to stderr; pass that to `parseCropdetect` for the suggestion.
 */
export function cropdetectArgs(source: string): string[] {
  return [
    "-hide_banner",
    "-ss",
    "60",
    "-i",
    source,
    "-vf",
    "cropdetect=limit=24:round=2",
    "-frames:v",
    "300",
    "-f",
    "null",
    "-",
  ];
}

/** Pull the LAST `W:H:X:Y` cropdetect suggestion out of ffmpeg stderr, or null. */
export function parseCropdetect(stderr: string): string | null {
  const matches = [...stderr.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)];
  return matches.length > 0 ? matches[matches.length - 1]![1]! : null;
}

/**
 * ffmpeg args for scene-cut detection. `showinfo` prints a `pts_time:` marker on
 * stderr for each frame passing the scene filter; pass stderr to `parseScenes`.
 */
export function scenesArgs(source: string): string[] {
  return [
    "-hide_banner",
    "-i",
    source,
    "-vf",
    // Downscale to 144p before the scene metric so the per-frame diff is cheap
    // (cut detection is robust to resolution); keeps the scan light enough to run
    // automatically in the background on load.
    `scale=-2:144,select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    "-f",
    "null",
    "-",
  ];
}

/** Parse scene-cut timestamps (seconds, rounded to ms) from ffmpeg stderr. */
export function parseScenes(stderr: string): number[] {
  const times: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    times.push(Number(Number(m[1]).toFixed(3)));
  }
  return times;
}

// ---------------------------------------------------------------------------
// Loudness envelope + swell detection (the loudness timeline feature).
//
// A cheap pass next to `probe`. The PREFERRED path measures *perceived* loudness
// with ffmpeg's `ebur128` filter (momentary LUFS): a perceptual model ranks the
// dynamic moments correctly, where raw RMS mis-ranks bright vs. low-frequency
// content of equal energy. Per-frame `M:` LUFS values are parsed from ebur128's
// log, mapped to 0..1 over a fixed floor/ceiling, and bucketed across the
// duration. A raw-RMS path (`loudnessArgs` + `bucketLoudness`) is kept as a
// simpler, perceptually-weaker FALLBACK. The bar-rendering color lerp, the swell
// heuristic's *relative* thresholds, and the chip UI live elsewhere; this module
// owns only the numbers.
//
// Pure (text/samples in, numbers out) so it stays browser-safe and file-free in
// tests. The native Rust backend (app/src-tauri/src/main.rs) hand-mirrors these
// (same LUFS floor/ceiling + LOUDNESS_BUCKETS count) — keep them in sync when the
// args or mapping here change.
// ---------------------------------------------------------------------------

/** Resolution of the loudness envelope: number of windows across the source. */
export const LOUDNESS_BUCKETS = 160;

/** LUFS mapped to 0 (the quiet floor). Below this reads as silence. */
export const LUFS_FLOOR = -40;
/** LUFS mapped to 1 (the loud ceiling). At/above this reads as full. */
export const LUFS_CEIL = -5;

/**
 * ffmpeg args to measure perceived loudness with the EBU R128 `ebur128` filter,
 * emitting per-frame momentary-loudness lines to the LOG (stderr) while
 * discarding A/V output (`-f null -`). `-loglevel verbose` is REQUIRED — ebur128
 * prints only its end-of-run Summary at the default `info` level; the per-frame
 * `[Parsed_ebur128…] t: … M:<LUFS> …` lines (≈10/sec) appear at verbose.
 * `-nostats` keeps the periodic progress line out. Collect stderr as TEXT and
 * pass it to `parseEbur128Momentary`.
 */
export function loudnessEbur128Args(source: string): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "verbose",
    "-i",
    source,
    "-af",
    "ebur128=metadata=1",
    "-f",
    "null",
    "-",
  ];
}

/**
 * ffmpeg args for the production loudness pass — ONE decode yielding BOTH signals
 * the timeline needs (the `ebur128` analysis filter passes audio through, so we
 * can log LUFS *and* emit PCM from the same run):
 *   • stderr — per-frame momentary LUFS (`parseEbur128Momentary` → `bucketLufs`),
 *     the *perceptual* envelope for the waveform BARS;
 *   • stdout — mono 8 kHz `f32le` PCM (`bucketLoudness`), the raw-energy RMS
 *     envelope fed to the swell DETECTOR (it exposes the musical dips that
 *     perceptually-gated LUFS smooths away on compressed material).
 * Collect stdout as BINARY and stderr as TEXT from the single invocation.
 */
export function loudnessCombinedArgs(source: string): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "verbose",
    "-i",
    source,
    "-af",
    "ebur128=metadata=1",
    "-ac",
    "1",
    "-ar",
    "8000",
    "-f",
    "f32le",
    "-",
  ];
}

/**
 * Parse the per-frame momentary-loudness values (the `M:` field, in LUFS) from
 * ebur128's log text, in time order. ffmpeg prints, per measurement frame, a
 * line like `[Parsed_ebur128_0 @ 0x…] t: 1.2  TARGET:-23 LUFS  M: -22.4 S:…`.
 * Non-finite readings (`-inf`/`nan`, emitted during the initial 400 ms window or
 * over silence) become `-Infinity` so callers can treat them as the floor.
 */
export function parseEbur128Momentary(log: string): number[] {
  const out: number[] = [];
  const re = /\bM:\s*(-?\d+(?:\.\d+)?|-?inf|nan)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const tok = m[1]!.toLowerCase();
    out.push(tok === "nan" || tok.endsWith("inf") ? Number.NEGATIVE_INFINITY : parseFloat(tok));
  }
  return out;
}

/** Map one LUFS reading to 0..1 over [LUFS_FLOOR, LUFS_CEIL]; non-finite → 0. */
export function lufsToNormalized(lufs: number): number {
  if (!Number.isFinite(lufs)) return 0;
  const t = (lufs - LUFS_FLOOR) / (LUFS_CEIL - LUFS_FLOOR);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Bucket per-frame momentary-LUFS readings into `buckets` equal-width windows,
 * averaging each window's normalized (0..1) level. Unlike the RMS path this is an
 * ABSOLUTE perceptual scale (not max-normalized), so quiet material reads quiet;
 * the swell heuristic adapts via its own relative thresholds. Non-finite readings
 * are skipped within a window (an all-silence window → 0). Empty input → zeros.
 */
export function bucketLufs(lufs: number[], buckets: number = LOUDNESS_BUCKETS): number[] {
  if (buckets <= 0) return [];
  const out = new Array<number>(buckets).fill(0);
  const n = lufs.length;
  if (n === 0) return out;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.floor(((b + 1) * n) / buckets);
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const v = lufs[i]!;
      if (!Number.isFinite(v)) continue;
      sum += lufsToNormalized(v);
      count++;
    }
    out[b] = count > 0 ? sum / count : 0;
  }
  return out;
}

/**
 * FALLBACK path (perceptually weaker than `loudnessEbur128Args`; use only when
 * ebur128 is unavailable). ffmpeg args to decode a source to raw mono PCM float
 * samples on stdout, for RMS bucketing. `-ac 1` downmixes to mono, `-ar 8000` is
 * plenty for an energy envelope (we only need loudness over time, not fidelity),
 * and `-f f32le -` emits little-endian 32-bit floats to stdout. Collect stdout as
 * BINARY and read it as a `Float32Array` (mind 4-byte alignment), then
 * `bucketLoudness`.
 */
export function loudnessArgs(source: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    source,
    "-ac",
    "1",
    "-ar",
    "8000",
    "-f",
    "f32le",
    "-",
  ];
}

/**
 * Bucket raw mono PCM float samples into `buckets` equal-width windows, compute
 * the RMS of each window, then normalize the whole array to 0..1 by dividing by
 * the max (guarding max=0 → all zeros). Returns an array of length `buckets`.
 *
 * Pure: pass a `Float32Array` (e.g. from the f32le stdout of `loudnessArgs`) and
 * a bucket count (default `LOUDNESS_BUCKETS`). Empty input yields all zeros.
 */
export function bucketLoudness(samples: Float32Array, buckets: number = LOUDNESS_BUCKETS): number[] {
  const out = new Array<number>(buckets).fill(0);
  const n = samples.length;
  if (buckets <= 0) return [];
  if (n === 0) return out;

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.floor(((b + 1) * n) / buckets);
    let sumSq = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i]!;
      sumSq += s * s;
      count++;
    }
    out[b] = count > 0 ? Math.sqrt(sumSq / count) : 0;
  }

  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max <= 0) return out;
  for (let b = 0; b < buckets; b++) out[b] = out[b]! / max;
  return out;
}

// Tunable thresholds for the swell heuristic — kept named so they are easy to
// adjust. A swell is a rising run whose climb is large RELATIVE TO THE
// ENVELOPE'S OWN DYNAMIC RANGE (not against an absolute "near-silence" floor),
// so it fires on compressed live-music audio that never drops to silence — the
// project's actual target footage — and not just on clips with true quiet parts.
/** Moving-average half-pass window (buckets) used to smooth before detection. */
export const SWELL_SMOOTH_WINDOW = 3;
/** A swell starts from the QUIET band — its trough must sit at or below this
 *  fraction up the envelope's own dynamic range (p10..p90). */
export const SWELL_TROUGH_FRAC = 0.3;
/** …and arrives at the LOUD band — its peak must reach at least this far up the
 *  range. The gap between the two bands is what makes a rise a real swell. */
export const SWELL_TOP_FRAC = 0.7;
/** A swell's rise must also cover at least this fraction of the dynamic range. */
export const SWELL_RISE_FRAC = 0.45;
/** Absolute floor (normalized 0..1) on the rise magnitude, so shallow choppiness
 *  in loud material can't masquerade as a swell. */
export const SWELL_MIN_RISE = 0.18;
/** If the envelope's p10..p90 spread is below this, it is too flat to hold a
 *  meaningful swell — detect none. */
export const SWELL_MIN_RANGE = 0.1;
/** While extending a rise, stop once it falls this far below the running peak
 *  (the rise is over — don't span across into the next valley). */
export const SWELL_DROP_TOL = 0.15;
/** Max span (seconds) over which the rise must happen to count as a swell. */
export const SWELL_MAX_SPAN_SEC = 6;
/** Merge markers closer together than this many seconds into one. */
export const SWELL_MERGE_SEC = 2;

/**
 * Detect "swell" suggestions — quiet→loud build-ups — in a normalized loudness
 * envelope. Explainable heuristic (this is a *suggestion*, never a verdict),
 * tuned for live-music footage where the audio is loud throughout and the
 * interesting moments are *relative* dips-then-rises, not silence→loud:
 *   (a) smooth the envelope with a small moving average;
 *   (b) measure the envelope's own dynamic range from its p10..p90 spread; if
 *       that spread is below `SWELL_MIN_RANGE` the track is too flat → none;
 *   (c) from each trough, extend a rise (allowing minor dips up to
 *       `SWELL_DROP_TOL`) within `SWELL_MAX_SPAN_SEC`; it counts as a swell when
 *       the climb covers ≥ `SWELL_RISE_FRAC` of the range (and ≥ `SWELL_MIN_RISE`
 *       absolute) AND the peak lands in the top `SWELL_TOP_FRAC` of the range;
 *   (d) emit a marker at the steepest point of each qualifying rise, then merge
 *       markers closer than `SWELL_MERGE_SEC`.
 *
 * Returns markers in seconds, labelled `"quiet → loud"`. Pure: envelope in,
 * markers out.
 */
export function detectSwells(
  loudness: number[],
  durationSec: number,
): { t: number; label: string }[] {
  const n = loudness.length;
  if (n < 2 || !(durationSec > 0)) return [];

  // (a) Smooth with a small centered moving average.
  const w = Math.max(0, Math.floor(SWELL_SMOOTH_WINDOW));
  const smooth = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      sum += loudness[j]!;
      count++;
    }
    smooth[i] = sum / count;
  }

  // Map a bucket index to a source-seconds timestamp (bucket center).
  const toSec = (idx: number): number =>
    Number((((idx + 0.5) / n) * durationSec).toFixed(3));
  // Max bucket span allowed for a rise, derived from the time budget.
  const maxSpanBuckets = Math.max(1, Math.ceil((SWELL_MAX_SPAN_SEC / durationSec) * n));

  // (b) Derive thresholds from the envelope's OWN dynamic range (p10..p90), so
  // detection adapts to compressed/loud material instead of an absolute floor.
  const sorted = smooth.slice().sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))]!;
  const p10 = at(0.1);
  const p90 = at(0.9);
  const range = p90 - p10;
  if (range < SWELL_MIN_RANGE) return []; // too flat to hold a meaningful swell
  const troughThresh = p10 + SWELL_TROUGH_FRAC * range;
  const peakThresh = p10 + SWELL_TOP_FRAC * range;
  const riseThresh = Math.max(SWELL_MIN_RISE, SWELL_RISE_FRAC * range);

  // (c) From each QUIET-band seed, extend a rise (tolerating minor dips) within
  // the span budget; it qualifies when the peak reaches the LOUD band and the
  // climb clears `riseThresh`. On a hit, mark the steepest step and resume past
  // the peak.
  const markers: number[] = [];
  let i = 0;
  while (i < n) {
    if (smooth[i]! > troughThresh) {
      i++;
      continue; // not a genuine low — a swell must build up from the quiet band
    }
    let peak = smooth[i]!;
    let peakIdx = i;
    let j = i;
    while (j + 1 < n && j - i < maxSpanBuckets) {
      j++;
      const v = smooth[j]!;
      if (v > peak) {
        peak = v;
        peakIdx = j;
      } else if (peak - v > SWELL_DROP_TOL) {
        break; // fell well off the peak — the rise is over
      }
    }
    const rise = peak - smooth[i]!;
    if (rise >= riseThresh && peak >= peakThresh && peakIdx > i) {
      // Steepest point = bucket with the largest positive step in [i, peakIdx].
      let steepIdx = i;
      let steepSlope = -Infinity;
      for (let k = i; k < peakIdx; k++) {
        const slope = smooth[k + 1]! - smooth[k]!;
        if (slope > steepSlope) {
          steepSlope = slope;
          steepIdx = k;
        }
      }
      markers.push(toSec(steepIdx));
      i = peakIdx + 1; // resume past this run's peak
      continue;
    }
    i++;
  }

  // (d) Merge markers closer than SWELL_MERGE_SEC (keep the earlier one).
  const merged: number[] = [];
  for (const t of markers) {
    if (merged.length > 0 && t - merged[merged.length - 1]! < SWELL_MERGE_SEC) continue;
    merged.push(t);
  }

  return merged.map((t) => ({ t, label: "quiet → loud" }));
}
