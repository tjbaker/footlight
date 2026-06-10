// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's state shape + a fresh-state factory + pure selectors, lifted out
 * of the `mountEditor()` closure (#125, Phase 3 foundation). This is the home for
 * the eventual EditorStore; for now it owns the `EditorState` type, a testable
 * `createInitialEditorState()`, and the derived-state predicates that were
 * scattered inline. Nothing here mutates or touches the DOM — data in, data out.
 */

import type { Box, Dims, ClipSpec, CropKeyframe } from "@manifest";
import type { CropPathKeyframe, CropWindowSpec } from "@core";
import { defaultCaptionStyle, clamp, round3, type CaptionStyleState } from "./editor-util.js";

/** Default source FPS until a probe reports the real one. */
export const DEFAULT_FPS = 30;

/** The full editor working state (one source + its in-progress framing/queue). */
export interface EditorState {
  source: string;
  dims: Dims | null;
  duration: number;
  fps: number;
  cropdetect: string | null;
  t: number;
  inPoint: number | null;
  outPoint: number | null;
  /** 9:16 crop box, in source-pixel coordinates. */
  cropBox: Box | null;
  /** Optional content-crop box (source pixels) when content mode is on. */
  contentBox: Box | null;
  contentMode: boolean;
  keyframes: CropKeyframe[];
  clips: ClipSpec[];
  /** Frame image natural display scale: displayedPx / sourcePx. */
  displayScale: number;
  /**
   * Optional AI subject-tracking crop path (SPEC §6.9). When set, it takes
   * precedence over the manual `crop_offset`/keyframe schedule: the preview box
   * follows it, and `addClip` emits a `cropPath` instead of a `crop_offset`.
   * x values are in working-region pixels (relative to the content box if one
   * is set), t is clip-relative seconds.
   */
  cropPath: CropPathKeyframe[] | null;
  /** Detected scene cuts (seconds) for the current source, if run. */
  sceneCuts: number[];
  /** Normalized loudness envelope (0..1) for the current source, or null. */
  loudness: number[] | null;
  /** Suggested quiet→loud "swell" moments (seconds), derived from loudness. */
  swells: { t: number; label: string }[];
  /** Detected audio onsets (seconds, ascending) — beat-snap targets for In/Out. */
  onsets: number[];
  /** Caption big line (`hook`) — shot-list data carried in the manifest. */
  hook: string;
  /** Caption secondary line (`title`). */
  title: string;
  /**
   * Caption placement on a 9-zone grid: a vertical keyword
   * (`top` | `center` | `bottom`, default bottom) optionally suffixed with a
   * horizontal one (`-left` | `-center` | `-right`, default center). Stored as the
   * bare vertical keyword when horizontal is center (back-compat: `"bottom"`), or
   * `"<v>-<h>"` otherwise (e.g. `"bottom-left"`, `"top-right"`).
   */
  textPosition: string;
  /**
   * Per-clip caption styling, edited in situ next to the caption text/preview.
   * Fields are always populated here (defaults mirror the engine); `captionStyleToSpec`
   * narrows them to a sparse `CaptionStyle` (omitting defaults) on the saved clip.
   */
  caption: CaptionStyleState;
  /** Per-clip fade-in length in seconds (0 = no fade); issue #165. */
  fadeIn: number;
  /** Per-clip fade-out length in seconds (0 = no fade). */
  fadeOut: number;
  /**
   * Animated punch-in endpoints ("push", issue #163): the drawn box captured
   * as start/end working-region windows. Armed (and emitted as the clip's
   * `cropWindowPath`, the highest framing precedence) only when BOTH are set.
   */
  push: { start: CropWindowSpec | null; end: CropWindowSpec | null };
}

/** A fresh editor state for an empty workspace (no source loaded). */
export function createInitialEditorState(): EditorState {
  return {
    source: "",
    dims: null,
    duration: 0,
    fps: DEFAULT_FPS,
    cropdetect: null,
    t: 0,
    inPoint: null,
    outPoint: null,
    cropBox: null,
    contentBox: null,
    contentMode: false,
    keyframes: [],
    clips: [],
    displayScale: 1,
    cropPath: null,
    sceneCuts: [],
    loudness: null,
    swells: [],
    onsets: [],
    hook: "",
    title: "",
    textPosition: "bottom",
    caption: defaultCaptionStyle(),
    fadeIn: 0,
    fadeOut: 0,
    push: { start: null, end: null },
  };
}

// ---- pure selectors (derived state; were scattered inline) ----

/** An AI track path owns the framing — the preview follows it and the crop box
 *  is not directly editable; `addClip` emits a `cropPath` instead of an offset. */
export function hasActiveTrack(s: EditorState): boolean {
  return !!(s.cropPath && s.cropPath.length > 0);
}

/** The crop box is directly editable (move/resize) only when no track owns it. */
export function isCropInteractive(s: EditorState): boolean {
  return !hasActiveTrack(s);
}

/** In and Out are both set and form a positive window. */
export function hasClipWindow(s: EditorState): boolean {
  return s.inPoint != null && s.outPoint != null && s.outPoint > s.inPoint;
}

/** The clip window length (Out − In) in seconds, or 0 when there's no valid window. */
export function clipLength(s: EditorState): number {
  return hasClipWindow(s) ? (s.outPoint as number) - (s.inPoint as number) : 0;
}

// ---- commit transitions (pure value math the assistant's applyCommit applies) ----

/**
 * Clamp a proposed In/Out into a valid, ordered window: In ∈ [0, duration], Out ∈
 * [In, duration], both rounded to ms. `duration` of 0 means "unknown" (no upper
 * bound yet), so the proposed value passes through. Mirrors the setInOut commit.
 */
export function clampInOut(
  inSec: number,
  outSec: number,
  duration: number,
): { inPoint: number; outPoint: number } {
  const inPoint = round3(clamp(inSec, 0, duration || inSec));
  const outPoint = round3(clamp(outSec, inPoint, duration || outSec));
  return { inPoint, outPoint };
}

/** Clamp a proposed trim Out to [inPoint, duration] (ms-rounded). Mirrors the trim commit. */
export function clampTrimOut(outSec: number, inPoint: number, duration: number): number {
  return round3(clamp(outSec, inPoint, duration || outSec));
}

/**
 * Build a crop keyframe from an addCropKeyframe commit: the working-region x is an
 * integer x-pixel offset (a valid `crop_offset` form the engine clamps into frame),
 * and the time is ms-rounded.
 */
export function keyframeFromCommit(t: number, x: number): CropKeyframe {
  return { t: round3(t), offset: String(Math.round(x)) };
}
