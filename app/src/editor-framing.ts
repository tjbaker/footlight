// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's framing EMISSION layer (#125 Phase 4): pure functions over the
 * `EditorState` that turn the live framing (crop box, content box, keyframes,
 * AI track path, animated push) into the engine's manifest fields. Lifted out
 * of editor.ts so the precedence logic is testable without a DOM and so the
 * views (viewer, inspector) and the editor's actions share ONE copy via
 * `(…) => fn(state)` closures. Each function delegates to the pure helpers in
 * `editor-crop` / `editor-offset` / `editor-push` — no math is restated here.
 */

import { easedCropWindowAt } from "@core";
import { contentCropFromBox, scheduleToString, type ClipSpec, type Dims } from "@manifest";
import { cropWindowSpec as cropWindowSpecPure } from "./editor-crop.js";
import { currentRegion as currentRegionPure, offsetForBox } from "./editor-offset.js";
import { pushKeyframes } from "./editor-push.js";
import { hasActiveTrack, clipLength, type EditorState } from "./editor-store.js";

/** Content-box origin when content mode is active (source ↔ region shift). */
export function contentOrigin(state: EditorState): { x: number; y: number } | null {
  return state.contentMode && state.contentBox
    ? { x: state.contentBox.x, y: state.contentBox.y }
    : null;
}

/**
 * The working region a `crop_offset` is computed against. Thin wrapper over the
 * pure `editor-offset` math, reading the live state.
 */
export function currentRegion(state: EditorState): Dims {
  return currentRegionPure(state.contentMode, state.contentBox, state.dims!);
}

/**
 * The explicit punch-in/zoom window for the current crop box, in WORKING-REGION
 * pixels (relative to the content box origin when one is active) — or null when
 * the box is still full height, in which case the engine should get a plain
 * `crop_offset` (which preserves schedules and auto-track) instead.
 */
export function cropWindowSpec(state: EditorState): ReturnType<typeof cropWindowSpecPure> {
  if (!state.cropBox || !state.dims) return null;
  const o = contentOrigin(state);
  const box = o
    ? { ...state.cropBox, x: state.cropBox.x - o.x, y: state.cropBox.y - o.y }
    : state.cropBox;
  return cropWindowSpecPure(box, currentRegion(state));
}

/** The `crop_offset` string for the current crop box ("center" before a load). */
export function currentOffset(state: EditorState): string {
  if (!state.cropBox || !state.dims) return "center";
  return offsetForBox(state.cropBox, state.contentMode, state.contentBox, currentRegion(state));
}

/**
 * The CURRENT framing as manifest fields — the ONE place the framing
 * precedence is encoded for emission (addClip and the cover export share it):
 * push (`cropWindowPath`, #163) > AI track (`cropPath`, SPEC §6.9) > punch-in
 * window > keyframe schedule / fixed offset, plus any content crop. Each
 * animated form keeps a sensible static `crop_offset` fallback so the row
 * stays valid if its path is ever stripped.
 *
 * `coverAtT` (a SOURCE time) flattens an armed push to its eased window at
 * that instant — the cover backends take a static window, and a cover is one
 * frame, so this is the render-exact framing for it.
 */
export function framingToSpec(
  state: EditorState,
  coverAtT?: number,
): Pick<ClipSpec, "cropWindowPath" | "cropPath" | "cropWindow" | "crop_offset" | "content_crop"> {
  const spec: ReturnType<typeof framingToSpec> = {};
  const win = cropWindowSpec(state);
  const dur =
    state.inPoint != null && state.outPoint != null
      ? state.outPoint - state.inPoint
      : clipLength(state);
  const pushKfs = pushKeyframes(state.push, dur);
  if (pushKfs && coverAtT != null) {
    const w = easedCropWindowAt(pushKfs, Math.max(0, coverAtT - (state.inPoint ?? 0)));
    spec.cropWindow = { x: w.x, y: w.y, w: w.w, h: w.h };
    spec.crop_offset = "center";
  } else if (pushKfs) {
    spec.cropWindowPath = pushKfs;
    spec.crop_offset = "center";
  } else if (hasActiveTrack(state)) {
    spec.cropPath = state.cropPath!.map((k) => ({ t: k.t, x: k.x }));
    spec.crop_offset = "center";
  } else if (win) {
    // Schedules don't apply to a fixed window, so keyframes are intentionally
    // ignored here; the offset fallback keeps the row framing sensibly.
    spec.cropWindow = win;
    spec.crop_offset = currentOffset(state);
  } else {
    spec.crop_offset = state.keyframes.length
      ? scheduleToString(state.keyframes)
      : currentOffset(state);
  }
  if (state.contentMode && state.contentBox && state.contentBox.w > 0) {
    spec.content_crop = contentCropFromBox(state.contentBox);
  }
  return spec;
}
