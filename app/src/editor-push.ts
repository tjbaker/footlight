// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure helpers for the animated punch-in ("push", issue #163). DRY by
 * delegation: box→window conversion reuses `cropBoxToWindow` (the manifest's
 * inverse-of-the-engine math) and the eased evaluation reuses the engine's
 * `easedCropWindowAt` — nothing here re-derives crop or smoothstep math. The
 * editor captures the drawn box twice (start and end), these helpers turn the
 * pair into the manifest's `cropWindowPath` and back, and place the preview
 * ghost at the eased window for any playhead time.
 */

import { easedCropWindowAt, type CropWindowKeyframe, type CropWindowSpec } from "@core";
import { cropBoxToWindow, type Box, type Dims } from "@manifest";

/** The editor's captured push endpoints (working-region windows), if any. */
export interface PushState {
  start: CropWindowSpec | null;
  end: CropWindowSpec | null;
}

/**
 * Convert a drawn box (SOURCE px) to a working-region window: shift by the
 * content origin when a content crop is active, then `cropBoxToWindow`. The
 * same conversion the static punch-in uses — without its null-for-full-height
 * special case, because a push may deliberately start at the full frame.
 */
export function boxToRegionWindow(
  box: Box,
  contentOrigin: { x: number; y: number } | null,
  region: Dims,
): CropWindowSpec {
  const shifted = contentOrigin
    ? { ...box, x: box.x - contentOrigin.x, y: box.y - contentOrigin.y }
    : box;
  return cropBoxToWindow(shifted, region);
}

/**
 * The two-keyframe `cropWindowPath` for a captured push: start at t=0, end at
 * the clip's duration (the push spans the whole clip in v1). Returns null
 * until BOTH endpoints are captured — a one-ended push has no meaning.
 */
export function pushKeyframes(push: PushState, durationSec: number): CropWindowKeyframe[] | null {
  if (!push.start || !push.end) return null;
  const end = Math.max(0.001, durationSec);
  return [
    { t: 0, ...push.start },
    { t: end, ...push.end },
  ];
}

/**
 * The eased window at clip-relative time `relT`, expressed back in SOURCE px
 * for the overlay ghost (re-adding the content origin the windows dropped).
 */
export function pushPreviewBox(
  keyframes: CropWindowKeyframe[],
  relT: number,
  contentOrigin: { x: number; y: number } | null,
): Box {
  const w = easedCropWindowAt(keyframes, relT);
  return {
    x: w.x + (contentOrigin?.x ?? 0),
    y: w.y + (contentOrigin?.y ?? 0),
    w: w.w,
    h: w.h,
  };
}

/** Compact readout for the captured push, e.g. `608×1080 → 304×540`. */
export function describePush(push: PushState): string {
  const fmt = (w: CropWindowSpec | null): string => (w ? `${w.w}×${w.h}` : "—");
  return `${fmt(push.start)} → ${fmt(push.end)}`;
}
