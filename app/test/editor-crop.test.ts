// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure crop-interaction geometry (editor-crop.ts) lifted out
 * of editor.ts. All source-pixel math: hit-testing, the 9:16 aspect-locked
 * resize, the working-region rect, and the default full-height box. Invariants
 * that matter: the resize stays locked to 9:16 with EVEN dimensions and never
 * leaves the working region; full-height is centered with even dims.
 */

import { describe, it, expect } from "vitest";
import { TARGET_AR } from "@core";
import type { Box, Dims } from "@manifest";
import {
  edgeHits,
  insideBox,
  cropRegionRect,
  resizeCrop,
  fullHeightCropBox,
  cropWindowSpec,
  MIN_CROP_H,
  type RegionRect,
} from "../src/editor-crop.js";

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
const isEven = (n: number) => n % 2 === 0;
/** even(h * 9/16) — the engine's locked 9:16 width for a crop height. */
const lockedW = (h: number) => Math.round(h * TARGET_AR) - (Math.round(h * TARGET_AR) % 2);

describe("edgeHits", () => {
  const b = box(100, 100, 200, 300); // edges at x=100/300, y=100/400
  it("detects the grabbed corner within margin", () => {
    expect(edgeHits(100, 100, b, 5)).toMatchObject({ l: true, t: true, r: false, b: false });
    expect(edgeHits(300, 400, b, 5)).toMatchObject({ r: true, b: true, l: false, t: false });
  });
  it("detects a single edge along its span", () => {
    expect(edgeHits(100, 250, b, 5)).toMatchObject({ l: true, t: false, b: false });
  });
  it("misses when outside the margin", () => {
    expect(edgeHits(150, 250, b, 5)).toEqual({ l: false, r: false, t: false, b: false });
  });
});

describe("insideBox", () => {
  const b = box(100, 100, 200, 300);
  it("is true inside, false outside, and respects the margin", () => {
    expect(insideBox(150, 150, b)).toBe(true);
    expect(insideBox(90, 150, b)).toBe(false);
    expect(insideBox(95, 150, b, 10)).toBe(true);
  });
});

describe("cropRegionRect", () => {
  const dims: Dims = { width: 1920, height: 1080 };
  it("is the full frame when content mode is off", () => {
    expect(cropRegionRect(false, null, dims)).toEqual({ x0: 0, y0: 0, x1: 1920, y1: 1080 });
  });
  it("is the content box when content mode is on and the box is usable", () => {
    expect(cropRegionRect(true, box(200, 50, 1000, 800), dims)).toEqual({
      x0: 200,
      y0: 50,
      x1: 1200,
      y1: 850,
    });
  });
  it("falls back to the full frame for a degenerate content box", () => {
    expect(cropRegionRect(true, box(0, 0, 1, 1), dims)).toEqual({ x0: 0, y0: 0, x1: 1920, y1: 1080 });
  });
});

describe("resizeCrop (9:16 aspect-locked corner resize)", () => {
  const region: RegionRect = { x0: 0, y0: 0, x1: 1920, y1: 1080 };
  const start = box(100, 100, 200, 356);

  it("keeps width locked to even(height * 9/16) with even dims", () => {
    // Grab bottom-right (anchor = top-left), drag down-right.
    const out = resizeCrop(700, 700, start, { l: false, r: true, t: false, b: true }, region);
    expect(isEven(out.w)).toBe(true);
    expect(isEven(out.h)).toBe(true);
    expect(out.w).toBe(lockedW(out.h)); // 9:16 lock
    // anchor stays put (top-left corner)
    expect(out.x).toBe(100);
    expect(out.y).toBe(100);
  });

  it("clamps to MIN_CROP_H when the pointer collapses the box", () => {
    const out = resizeCrop(101, 101, start, { l: false, r: true, t: false, b: true }, region);
    expect(out.h).toBe(MIN_CROP_H);
    expect(out.w).toBe(lockedW(MIN_CROP_H));
  });

  it("never leaves the working region (clamped to available room)", () => {
    // Grab bottom-right and drag far past the frame; box must stay within region.
    const out = resizeCrop(5000, 5000, start, { l: false, r: true, t: false, b: true }, region);
    expect(out.x).toBeGreaterThanOrEqual(region.x0);
    expect(out.y).toBeGreaterThanOrEqual(region.y0);
    expect(out.x + out.w).toBeLessThanOrEqual(region.x1);
    expect(out.y + out.h).toBeLessThanOrEqual(region.y1);
  });

  it("anchors the opposite corner when grabbing top-left", () => {
    // Grab top-left (anchor = bottom-right = 300,456); shrink toward it.
    const out = resizeCrop(250, 400, start, { l: true, r: false, t: true, b: false }, region);
    expect(out.x + out.w).toBe(300); // right edge (anchor) unmoved
    expect(out.y + out.h).toBe(456); // bottom edge (anchor) unmoved
  });
});

describe("fullHeightCropBox", () => {
  it("a wide region → full height, centered horizontally, even dims", () => {
    const out = fullHeightCropBox({ x0: 0, y0: 0, x1: 1920, y1: 1080 });
    expect(out.h).toBe(1080);
    expect(isEven(out.w)).toBe(true);
    expect(out.w).toBe(608); // even(1080 * 9/16)
    expect(out.x).toBe(656); // floor((1920 - 608) / 2)
    expect(out.y).toBe(0);
  });

  it("a tall/narrow region → full width, centered vertically", () => {
    const out = fullHeightCropBox({ x0: 0, y0: 0, x1: 400, y1: 1080 });
    expect(out.w).toBe(400);
    expect(out.h).toBe(Math.round(400 / TARGET_AR) - (Math.round(400 / TARGET_AR) % 2));
    expect(out.x).toBe(0);
    expect(out.y).toBeGreaterThan(0);
  });

  it("respects a non-zero region origin (content box)", () => {
    const out = fullHeightCropBox({ x0: 200, y0: 50, x1: 1200, y1: 850 });
    expect(out.y).toBe(50); // full height of the content region
    expect(out.x).toBeGreaterThanOrEqual(200);
  });
});

describe("cropWindowSpec", () => {
  const region: Dims = { width: 1920, height: 1080 };
  it("returns null for a full-height box (engine gets a plain offset instead)", () => {
    expect(cropWindowSpec(fullHeightCropBox({ x0: 0, y0: 0, x1: 1920, y1: 1080 }), region)).toBeNull();
  });
  it("returns a window for a punch-in (shorter-than-frame) box", () => {
    expect(cropWindowSpec(box(700, 200, 304, 540), region)).not.toBeNull();
  });
});
