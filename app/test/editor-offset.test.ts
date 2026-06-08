// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure crop-offset / working-region math (editor-offset.ts)
 * lifted out of editor.ts. Behaviors that matter: the working region is the
 * content box (when content mode is on) else the full frame; the `crop_offset`
 * string snaps to left/center/right and reports a bare x for a punch-in, in
 * content-relative coordinates when a content box is active; and the AI-track x
 * eases between keyframes, holds at the ends, and clamps into the frame.
 */

import { describe, it, expect } from "vitest";
import type { CropPathKeyframe } from "@core";
import type { Box, Dims } from "@manifest";
import { currentRegion, offsetForBox, trackedBoxXAt } from "../src/editor-offset.js";

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
const dims: Dims = { width: 1920, height: 1080 };
// For a 1920×1080 region the engine's 9:16 crop width is 608, so maxX = 1312 and
// the centered offset is floor(1312/2) = 656.
const CW = 608;
const MAX_X = 1920 - CW; // 1312
const CENTER = Math.floor(MAX_X / 2); // 656

describe("currentRegion", () => {
  it("is the full frame when content mode is off", () => {
    expect(currentRegion(false, null, dims)).toEqual({ width: 1920, height: 1080 });
  });
  it("is the content box dims when content mode is on and the box is usable", () => {
    expect(currentRegion(true, box(200, 50, 1000, 800), dims)).toEqual({ width: 1000, height: 800 });
  });
  it("falls back to the full frame for a zero-width content box", () => {
    expect(currentRegion(true, box(0, 0, 0, 0), dims)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("offsetForBox", () => {
  it("snaps a centered full-height box to 'center'", () => {
    expect(offsetForBox(box(CENTER, 0, CW, 1080), false, null, dims)).toBe("center");
  });
  it("snaps a left-aligned box to 'left'", () => {
    expect(offsetForBox(box(0, 0, CW, 1080), false, null, dims)).toBe("left");
  });
  it("snaps a right-aligned box to 'right'", () => {
    expect(offsetForBox(box(MAX_X, 0, CW, 1080), false, null, dims)).toBe("right");
  });
  it("reports a bare x for an off-snap (punch-in / panned) box", () => {
    // x = 900 is well clear of left(0)/center(656)/right(1312), so it stays numeric.
    expect(offsetForBox(box(900, 0, CW, 1080), false, null, dims)).toBe("900");
  });
  it("shifts the offset into content-relative coords when a content box is active", () => {
    // Content box origin at x=400; a crop box drawn at source x=400 is the content
    // region's left edge → content-relative x=0 → "left".
    const content = box(400, 0, 1000, 800);
    const region = currentRegion(true, content, dims);
    expect(offsetForBox(box(400, 0, 304, 800), true, content, region)).toBe("left");
  });
});

describe("trackedBoxXAt", () => {
  const path: CropPathKeyframe[] = [
    { t: 0, x: 100 },
    { t: 2, x: 500 },
  ];
  const cropBox = box(0, 0, CW, 1080);

  it("holds the first keyframe's x before the path starts (clip-relative)", () => {
    // t - inPoint = 5 - 5 = 0 → first keyframe x.
    expect(trackedBoxXAt(path, cropBox, dims, 5, 5, false, null)).toBe(100);
  });
  it("holds the last keyframe's x after the path ends", () => {
    // t - inPoint = 10 - 5 = 5 > last t (2) → last keyframe x.
    expect(trackedBoxXAt(path, cropBox, dims, 10, 5, false, null)).toBe(500);
  });
  it("eases (smoothstep) between keyframes at the midpoint", () => {
    // rel = 1.0 → halfway in time; smoothstep(0.5) = 0.5 → x = 100 + 400*0.5 = 300.
    expect(trackedBoxXAt(path, cropBox, dims, 6, 5, false, null)).toBeCloseTo(300, 6);
  });
  it("clamps a beyond-frame eased x into [0, width - cropW]", () => {
    const far: CropPathKeyframe[] = [{ t: 0, x: 5000 }];
    expect(trackedBoxXAt(far, cropBox, dims, 5, 5, false, null)).toBe(MAX_X);
  });
  it("adds the content-box origin back so x lands in source-frame coords", () => {
    const content = box(400, 0, 1000, 800);
    // single keyframe held at x=100 (content-relative) + content origin 400 = 500.
    const single: CropPathKeyframe[] = [{ t: 0, x: 100 }];
    expect(trackedBoxXAt(single, cropBox, dims, 5, 5, true, content)).toBe(500);
  });
});
