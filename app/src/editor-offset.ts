// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure crop-offset / working-region math, lifted out of editor.ts so it can be
 * unit-tested without a DOM. All source-pixel math, no `state`/`document`: the
 * editor reads `state` and hands these functions plain values. The companion to
 * `editor-crop.ts` (box geometry) — these turn a drawn crop box + working region
 * into the engine's `crop_offset` string and evaluate the eased AI-track x.
 */

import type { CropPathKeyframe } from "@core";
import { easedCropXAt } from "./autotrack.js";
import { cropBoxToOffset, type Box, type Dims } from "@manifest";
import { clamp } from "./editor-util.js";

/**
 * The working region a `crop_offset` is computed against (source px): the content
 * box's dimensions when content-crop mode is active (and the box is usable), else
 * the full frame.
 */
export function currentRegion(contentMode: boolean, contentBox: Box | null, dims: Dims): Dims {
  // crop_offset is computed relative to the content region if one is set.
  if (contentMode && contentBox && contentBox.w > 0) {
    return { width: contentBox.w, height: contentBox.h };
  }
  return dims;
}

/**
 * The `crop_offset` string for `cropBox` within its working region. When a content
 * box is active the box x is shifted into content-relative coordinates first (the
 * region origin), mirroring how the engine resolves offsets inside a content crop.
 */
export function offsetForBox(
  cropBox: Box,
  contentMode: boolean,
  contentBox: Box | null,
  region: Dims,
): string {
  let box = cropBox;
  if (contentMode && contentBox) {
    box = { ...cropBox, x: cropBox.x - contentBox.x };
  }
  return cropBoxToOffset(box, region);
}

/**
 * The drawn-box x for the AI-track preview at clip-relative time `t - inPoint`.
 * The cropPath x is in working-region pixels; when a content box is active it is
 * relative to that box's origin, so we add it back to land in source-frame
 * coordinates. Clamped into the frame to match `boxCenterToCropX`/`computeCrop`.
 */
export function trackedBoxXAt(
  cropPath: CropPathKeyframe[],
  cropBox: Box,
  dims: Dims,
  t: number,
  inPoint: number,
  contentMode: boolean,
  contentBox: Box | null,
): number {
  const rel = clamp(t - inPoint, 0, Number.POSITIVE_INFINITY);
  let x = easedCropXAt(cropPath, rel);
  if (contentMode && contentBox) {
    x += contentBox.x;
  }
  const maxX = dims.width - cropBox.w;
  return clamp(x, 0, Math.max(0, maxX));
}
