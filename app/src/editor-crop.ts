// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure crop-box interaction geometry, lifted out of editor.ts so it can be
 * unit-tested without a DOM. All source-pixel math, no `state`/`document`: the
 * editor reads `state` and hands these functions plain values. Mirrors the
 * engine's crop conventions — 9:16 aspect lock (`TARGET_AR`), even dimensions for
 * the H.264 encoder (`roundEvenLocal`), clamped inside the working region.
 */

import { TARGET_AR } from "@core";
import { cropBoxToWindow, isFullHeightWindow, type Box, type Dims } from "@manifest";
import { roundEvenLocal } from "./editor-util.js";

/** Smallest crop-box height (source px) a punch-in resize allows — keeps the
 *  derived 9:16 width sane and the upscale from going absurd. */
export const MIN_CROP_H = 80;

/** The working region the crop box lives in, in source-pixel edges. */
export interface RegionRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Which crop-box edges a pointer is over (for resize handles / cursor). */
export interface CropEdges {
  l: boolean;
  r: boolean;
  t: boolean;
  b: boolean;
}

/** Which edges of `b` are within margin `m` of (px,py) — the resize-handle hits. */
export function edgeHits(px: number, py: number, b: Box, m: number): CropEdges {
  const withinX = px >= b.x - m && px <= b.x + b.w + m;
  const withinY = py >= b.y - m && py <= b.y + b.h + m;
  return {
    l: withinY && Math.abs(px - b.x) <= m,
    r: withinY && Math.abs(px - (b.x + b.w)) <= m,
    t: withinX && Math.abs(py - b.y) <= m,
    b: withinX && Math.abs(py - (b.y + b.h)) <= m,
  };
}

/** True when (px,py) is inside `b`, expanded by margin `m`. */
export function insideBox(px: number, py: number, b: Box, m = 0): boolean {
  return px >= b.x - m && px <= b.x + b.w + m && py >= b.y - m && py <= b.y + b.h + m;
}

/**
 * The working region the crop box lives in, in SOURCE-pixel coordinates: the
 * content box when content-crop mode is active (and drawn), else the full frame.
 * Used to clamp moves/resizes and to know what "full height" means.
 */
export function cropRegionRect(
  contentMode: boolean,
  contentBox: Box | null,
  dims: Dims,
): RegionRect {
  if (contentMode && contentBox && contentBox.w > 2 && contentBox.h > 2) {
    return {
      x0: contentBox.x,
      y0: contentBox.y,
      x1: contentBox.x + contentBox.w,
      y1: contentBox.y + contentBox.h,
    };
  }
  return { x0: 0, y0: 0, x1: dims.width, y1: dims.height };
}

/**
 * Aspect-locked (9:16) corner resize of the crop box. `edges` says which corner
 * is grabbed; the diagonally opposite corner is the fixed anchor. Height drives
 * the lock (`w = even(h * 9/16)`); the box is clamped to MIN_CROP_H and to the
 * room available inside `region` so it can never leave frame.
 */
export function resizeCrop(
  px: number,
  py: number,
  box: Box,
  edges: CropEdges,
  region: RegionRect,
): Box {
  const anchorX = edges.l ? box.x + box.w : box.x;
  const anchorY = edges.t ? box.y + box.h : box.y;
  const dirX = edges.l ? -1 : 1;
  const dirY = edges.t ? -1 : 1;
  // Candidate height: satisfy the pointer on whichever axis pulls harder.
  let h = Math.max(Math.abs(py - anchorY), Math.abs(px - anchorX) / TARGET_AR);
  const roomY = dirY > 0 ? region.y1 - anchorY : anchorY - region.y0;
  const roomX = dirX > 0 ? region.x1 - anchorX : anchorX - region.x0;
  h = Math.min(h, roomY, roomX / TARGET_AR);
  h = Math.max(h, MIN_CROP_H);
  h = roundEvenLocal(h);
  const w = roundEvenLocal(h * TARGET_AR);
  const x = dirX > 0 ? anchorX : anchorX - w;
  const y = dirY > 0 ? anchorY : anchorY - h;
  return { x, y, w, h };
}

/** The default FULL-HEIGHT, centered 9:16 crop box for a working region. */
export function fullHeightCropBox(region: RegionRect): Box {
  const rw = region.x1 - region.x0;
  const rh = region.y1 - region.y0;
  if (rw / rh >= TARGET_AR) {
    const cw = roundEvenLocal(rh * TARGET_AR);
    const maxX = rw - cw;
    return { x: region.x0 + Math.floor(maxX / 2), y: region.y0, w: cw, h: roundEvenLocal(rh) };
  }
  const ch = roundEvenLocal(rw / TARGET_AR);
  return { x: region.x0, y: region.y0 + Math.floor((rh - ch) / 2), w: roundEvenLocal(rw), h: ch };
}

/**
 * The explicit punch-in/zoom window for `cropBox` within `region` (working-region
 * px), or null when the box is still full height — in which case the engine should
 * get a plain `crop_offset` (which preserves schedules and auto-track) instead.
 */
export function cropWindowSpec(
  cropBox: Box,
  region: Dims,
): ReturnType<typeof cropBoxToWindow> | null {
  if (isFullHeightWindow(cropBox, region)) return null;
  return cropBoxToWindow(cropBox, region);
}
