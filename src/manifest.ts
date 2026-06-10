// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Footlight manifest core: pure logic the desktop GUI uses to turn drawn crop
 * boxes / selections into the CSV manifest the render engine consumes.
 *
 * This is the INVERSE of the engine's `computeCrop`: where the engine maps a
 * `crop_offset` -> a pixel crop window, here a user-drawn box maps back to the
 * `crop_offset` value. Crop-width and maxX math mirror `computeCrop` exactly so
 * the round-trip box -> offset -> crop is consistent.
 */

import {
  TARGET_AR,
  parseTimestamp,
  parseContentCrop,
  parseCropSchedule,
  computeCrop,
  roundEven,
  type CropWindowSpec,
  type CropPathKeyframe,
} from "./core.js";

/** A working-region size in pixels. */
export interface Dims {
  width: number;
  height: number;
}

/** A user-drawn box, in pixels within the working region. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A single crop keyframe: t is clip-relative seconds, offset is a crop_offset value. */
export interface CropKeyframe {
  t: number;
  offset: string;
}

/** One row of the clip manifest, GUI-facing shape. */
export interface ClipRow {
  source_file: string;
  in_point: string;
  out_point: string;
  crop_offset: string;
  content_crop?: string;
  out_name?: string;
  notes?: string;
  /** Big caption punch-line (burned only when captions are enabled; SPEC §6.5). */
  hook?: string;
  /** Secondary caption line, drawn below the hook. */
  title?: string;
  /** Caption block placement: `top` | `center` | `bottom`. */
  text_position?: string;
  /** Fade-in length in seconds (CSV cell; empty/absent = no fade). */
  fade_in?: string;
  /** Fade-out length in seconds (CSV cell; empty/absent = no fade). */
  fade_out?: string;
}

/** Tolerance (px) within which a box x snaps to a named left/center/right offset. */
const SNAP_TOLERANCE = 2;

export { roundEven };

/**
 * The fixed 9:16 crop width the engine uses for a landscape working region:
 * `even(round(height * 9/16))`.
 */
function cropWidth(region: Dims): number {
  // engine: cw = even(Math.round(ih * TARGET_AR))
  const w = Math.round(region.height * TARGET_AR);
  return w - (w % 2);
}

/**
 * Invert a drawn 9:16 crop box back to the `crop_offset` value the engine needs.
 *
 * The engine fixes the crop WIDTH and uses full height on a landscape source, so
 * the only meaningful degree of freedom is the horizontal x. We round box.x to
 * an even integer and clamp it into [0, maxX] (same as `computeCrop`). If the
 * result lands within SNAP_TOLERANCE of the canonical left (0), center
 * (floor(maxX/2)) or right (maxX) offset, we return the NAMED value instead of a
 * bare integer so manifests stay readable and stable.
 */
export function cropBoxToOffset(box: Box, region: Dims): string {
  const cw = cropWidth(region);
  const maxX = region.width - cw;

  // Match engine: x is even-rounded, then clamped into frame.
  let x = roundEven(box.x);
  x = Math.max(0, Math.min(x, maxX));

  const center = Math.floor(maxX / 2);
  if (Math.abs(x - 0) <= SNAP_TOLERANCE) return "left";
  if (Math.abs(x - center) <= SNAP_TOLERANCE) return "center";
  if (Math.abs(x - maxX) <= SNAP_TOLERANCE) return "right";

  return String(x);
}

/**
 * Convert a drawn 9:16 crop box into an explicit `CropWindowSpec` (punch-in /
 * zoom) in working-region pixels. All four values are even-rounded; the height
 * is the controlling dimension (clamped to the region height), the width is
 * re-derived as `even(h * 9/16)` to keep the window exactly 9:16 regardless of
 * the box the user drew, and x/y are clamped so the window stays in the region.
 * This is the size/position counterpart to `cropBoxToOffset` (which only encodes
 * horizontal position of a full-height crop).
 */
export function cropBoxToWindow(box: Box, region: Dims): CropWindowSpec {
  const regH = roundEven(region.height);
  const regW = roundEven(region.width);
  // Height drives the 9:16 lock; cap it so the derived width also fits.
  let h = Math.min(roundEven(box.h), regH);
  let w = roundEven(h * TARGET_AR);
  if (w > regW) {
    w = regW;
    h = roundEven(w / TARGET_AR);
  }
  const x = roundEven(Math.max(0, Math.min(box.x, regW - w)));
  const y = roundEven(Math.max(0, Math.min(box.y, regH - h)));
  return { x, y, w, h };
}

/**
 * Whether a drawn crop box is the default FULL-HEIGHT 9:16 window for the region
 * (height within `tol` px of the region height). The GUI uses this to decide
 * whether to emit a plain `crop_offset` (full height — preserves schedules and
 * auto-track) or an explicit zoomed `cropWindow`.
 */
export function isFullHeightWindow(box: Box, region: Dims, tol = 2): boolean {
  return box.h >= region.height - tol;
}

/**
 * Build a `W:H:X:Y` content-crop string from a drawn content region box, used
 * to strip letterbox/pillarbox bars before the 9:16 crop. All four values are
 * even-rounded integers. Note the column order is W:H:X:Y (size first).
 */
export function contentCropFromBox(box: Box): string {
  const w = roundEven(box.w);
  const h = roundEven(box.h);
  const x = roundEven(box.x);
  const y = roundEven(box.y);
  return `${w}:${h}:${x}:${y}`;
}

/** Format a clip-relative time, trimming trailing zeros (0, 14.5, 21). */
function formatTime(t: number): string {
  // Avoid -0 and exponent notation; trim trailing zeros from a fixed-decimal form.
  let s = (Math.round(t * 1000) / 1000).toString();
  if (s === "-0") s = "0";
  return s;
}

/**
 * Serialize crop keyframes into a `crop_offset` schedule string. Keyframes are
 * sorted by t and joined as `"t=offset; t=offset"`. A single keyframe at t=0
 * collapses to just its offset (e.g. `"center"`), which the engine reads as a
 * plain non-scheduled value.
 */
export function scheduleToString(keyframes: CropKeyframe[]): string {
  if (keyframes.length === 0) {
    throw new Error("scheduleToString: at least one keyframe required");
  }
  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  if (sorted.length === 1 && sorted[0]!.t === 0) {
    return sorted[0]!.offset;
  }
  return sorted.map((k) => `${formatTime(k.t)}=${k.offset}`).join("; ");
}

/** Quote a CSV field if it contains a comma, double-quote, or newline. */
function csvField(value: string | undefined): string {
  const s = value ?? "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** The canonical manifest column order. */
const MANIFEST_COLUMNS: Array<keyof ClipRow> = [
  "source_file",
  "in_point",
  "out_point",
  "fade_in",
  "fade_out",
  "crop_offset",
  "content_crop",
  "out_name",
  "hook",
  "title",
  "text_position",
  "notes",
];

/**
 * Serialize clip rows into a valid manifest CSV with the canonical header and
 * one line per row. Optional fields that are empty/absent become empty cells.
 * Fields needing quoting (comma/quote/newline) are double-quote escaped. Output
 * round-trips through `csv.ts`'s `parseCsv`.
 */
export function serializeManifestCSV(rows: ClipRow[]): string {
  const lines: string[] = [];
  lines.push(MANIFEST_COLUMNS.join(","));
  for (const row of rows) {
    lines.push(MANIFEST_COLUMNS.map((col) => csvField(row[col])).join(","));
  }
  return lines.join("\n") + "\n";
}

/** One keyframe of a smooth, eased crop path: clip-relative time and crop x (px). */
export interface CropPathPoint {
  /** Clip-relative time in seconds. */
  t: number;
  /** Crop window x offset in pixels, within the working region. */
  x: number;
}

/**
 * A single clip in a JSON manifest — the richer alternative to a CSV row that
 * the `render` JSON path consumes. It carries the same fields a manifest CSV
 * row does, plus an optional `cropPath`: an eased subject-tracking crop path
 * (SPEC §6.9) that, when present, takes precedence over `crop_offset` and is
 * rendered as the smoothstep `x='…'` expression by `buildFfmpegArgs`.
 */
/**
 * Per-clip caption styling — set in the editor next to the caption text/preview,
 * so each clip can look different. Carried on `ClipSpec.caption` (JSON manifest)
 * and merged over the render-wide CLI defaults at render time. `font` is a family
 * name or a `.ttf`/`.otf` path; colours are `#RRGGBB`; `angle` is in degrees.
 */
export interface CaptionStyle {
  font?: string;
  color?: string;
  outlineColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  shadow?: boolean;
  box?: boolean;
  boxColor?: string;
  angle?: number;
}

export interface ClipSpec {
  source_file: string;
  in_point: string;
  out_point: string;
  crop_offset?: string;
  content_crop?: string;
  out_name?: string;
  notes?: string;
  /** Big caption punch-line (burned only when captions are enabled; SPEC §6.5). */
  hook?: string;
  /** Secondary caption line, drawn below the hook. */
  title?: string;
  /** Caption block placement: `top|center|bottom` optionally `-left|-center|-right`. */
  text_position?: string;
  /**
   * Fade-in length in SECONDS (≥ 0; omitted = no fade). Video fades from black
   * and the audio fades from silence over the same length; a fade forces an AAC
   * audio re-encode when the render is set to `-c:a copy` (see the engine's
   * `FADE_AUDIO_BITRATE`). A plain number in JSON; the CSV column carries it as
   * a numeric string.
   */
  fade_in?: number;
  /** Fade-out length in seconds — the tail counterpart of `fade_in`. */
  fade_out?: number;
  /** Per-clip caption styling (font + colour + emphasis + effects), applied when burned. */
  caption?: CaptionStyle;
  /** Optional eased crop path; takes precedence over `crop_offset` at render. */
  cropPath?: CropPathPoint[];
  /**
   * Optional explicit 9:16 crop window (punch-in / zoom) in working-region
   * pixels. When present (and no `cropPath`), takes precedence over
   * `crop_offset` at render — see `CropWindowSpec` in core.
   */
  cropWindow?: CropWindowSpec;
}

/**
 * Serialize clip specs into pretty-printed JSON that the `render` JSON path can
 * read back. Round-trips: `JSON.parse(serializeManifestJSON(specs))` deep-equals
 * the input specs (including any `cropPath`). The output is a plain JSON array,
 * two-space indented, with a trailing newline.
 */
export function serializeManifestJSON(clips: ClipSpec[]): string {
  return JSON.stringify(clips, null, 2) + "\n";
}

/**
 * Editor-facing state for one clip — the rehydrated form of a `ClipSpec`. This
 * is the INVERSE of how the GUI builds a spec (its `addClip`): every drawn box
 * and selection that the manifest helpers collapse into manifest strings is
 * reconstructed here so the GUI can re-open an existing manifest for editing.
 */
export interface RehydratedClip {
  /** Clip in-point in seconds (parsed from `spec.in_point`). */
  inPoint: number;
  /** Clip out-point in seconds (parsed from `spec.out_point`). */
  outPoint: number;
  /** The 9:16 crop box in SOURCE-pixel coords, or null if indeterminate. */
  cropBox: Box | null;
  /** The content-crop box (full frame when no `content_crop` is present). */
  contentBox: Box | null;
  /** True iff `spec.content_crop` is present. */
  contentMode: boolean;
  /** Keyframes from a schedule `crop_offset`, else `[]`. */
  keyframes: CropKeyframe[];
  /** Eased crop path from `spec.cropPath`, else null. */
  cropPath: CropPathKeyframe[] | null;
  /** Output name (`spec.out_name ?? ""`). */
  name: string;
}

/**
 * Rehydrate a `ClipSpec` into editor state — the inverse of the GUI's addClip.
 *
 * Manifest strings are re-expanded into the boxes/selections the editor draws:
 * timestamps are parsed, `content_crop` becomes a `contentBox` (defaulting to
 * the full frame), and the framing is reconstructed following the SAME
 * precedence the engine uses at render — `cropPath` > `cropWindow` >
 * `crop_offset` (schedule or fixed). The reconstructed 9:16 `cropBox` is
 * expressed in SOURCE-pixel coords (offset by the content origin when a
 * content crop is active), mirroring `computeCrop`/`cropBoxToWindow`.
 */
export function specToEditorState(spec: ClipSpec, dims: Dims): RehydratedClip {
  const inPoint = parseTimestamp(spec.in_point);
  const outPoint = parseTimestamp(spec.out_point);

  const contentMode = !!spec.content_crop;
  let contentBox: Box;
  if (contentMode) {
    const cc = parseContentCrop(spec.content_crop)!; // [w, h, x, y]
    contentBox = { x: cc[2], y: cc[3], w: cc[0], h: cc[1] };
  } else {
    contentBox = { x: 0, y: 0, w: dims.width, h: dims.height };
  }

  // The working region the engine crops within, plus its origin in source px.
  const region: Dims = contentMode
    ? { width: contentBox.w, height: contentBox.h }
    : dims;
  const originX = contentMode ? contentBox.x : 0;
  const originY = contentMode ? contentBox.y : 0;

  let cropBox: Box | null;
  let keyframes: CropKeyframe[] = [];
  let cropPath: CropPathKeyframe[] | null = null;

  if (spec.cropPath?.length) {
    // Eased crop path wins: editor shows a full-height centered 9:16 box.
    cropPath = spec.cropPath.map((p) => ({ t: p.t, x: p.x }));
    const c = computeCrop(region.width, region.height, "center");
    cropBox = { x: c.x + originX, y: c.y + originY, w: c.cw, h: c.ch };
  } else if (spec.cropWindow) {
    // Explicit punch-in / zoom window: use it verbatim, offset to source px.
    const cw = spec.cropWindow;
    cropBox = { x: cw.x + originX, y: cw.y + originY, w: cw.w, h: cw.h };
  } else {
    // crop_offset string (undefined -> "center"); may be a schedule.
    const s = spec.crop_offset ?? "center";
    let boxOffset: string;
    if (s.includes(";") || s.includes("=")) {
      const pairs = parseCropSchedule(s);
      keyframes = pairs.map(([t, off]) => ({ t, offset: off }));
      boxOffset = pairs[0]?.[1] ?? "center";
    } else {
      boxOffset = s;
    }
    const c = computeCrop(region.width, region.height, boxOffset);
    cropBox = { x: c.x + originX, y: c.y + originY, w: c.cw, h: c.ch };
  }

  return {
    inPoint,
    outPoint,
    cropBox,
    contentBox,
    contentMode,
    keyframes,
    cropPath,
    name: spec.out_name ?? "",
  };
}
