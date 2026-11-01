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
import { TARGET_AR, computeCrop } from "@core";
import { specToEditorState, type Box, type Dims } from "@manifest";
import { framingToSpec } from "../src/editor-framing.js";
import { createInitialEditorState } from "../src/editor-store.js";
import {
  edgeHits,
  insideBox,
  cropRegionRect,
  resizeCrop,
  fullHeightCropBox,
  cropWindowSpec,
  parseContentCropPx,
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
    expect(cropRegionRect(true, box(0, 0, 1, 1), dims)).toEqual({
      x0: 0,
      y0: 0,
      x1: 1920,
      y1: 1080,
    });
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
  const dims: Dims = { width: 1920, height: 1080 };

  /** The box the ENGINE renders for `cropBox`: the editor's real emission
   *  (`framingToSpec` over an EditorState) read back through
   *  `specToEditorState`, which applies the engine's framing precedence
   *  (computeCrop over the parsed content crop, offset by its origin). */
  function engineBox(cropBox: Box, contentMode: boolean, contentBox: Box | null, d: Dims) {
    const state = { ...createInitialEditorState(), dims: d, contentMode, contentBox, cropBox };
    const spec = { source_file: "s.mp4", in_point: "0", out_point: "1", ...framingToSpec(state) };
    return specToEditorState(spec, d).cropBox;
  }

  it("a wide region → full height, centered horizontally, even dims", () => {
    const out = fullHeightCropBox(false, null, dims);
    expect(out.h).toBe(1080);
    expect(isEven(out.w)).toBe(true);
    expect(out.w).toBe(608); // even(1080 * 9/16)
    expect(out.x).toBe(656); // floor((1920 - 608) / 2)
    expect(out.y).toBe(0);
  });

  it("a tall/narrow region → full width, centered vertically", () => {
    const out = fullHeightCropBox(false, null, { width: 400, height: 1080 });
    expect(out.w).toBe(400);
    expect(out.h).toBe(Math.round(400 / TARGET_AR) - (Math.round(400 / TARGET_AR) % 2));
    expect(out.x).toBe(0);
    expect(out.y).toBeGreaterThan(0);
  });

  it("respects a non-zero region origin (content box)", () => {
    const out = fullHeightCropBox(true, box(200, 50, 1000, 800), dims);
    expect(out.y).toBe(50); // full height of the content region
    expect(out.x).toBeGreaterThanOrEqual(200);
  });

  it("is exactly computeCrop's centered box, like initCropBox (#302)", () => {
    // Odd-height source: both "default box" paths must agree.
    const { x, y, cw, ch } = computeCrop(1920, 1081, "center");
    expect(fullHeightCropBox(false, null, { width: 1920, height: 1081 })).toEqual({
      x,
      y,
      w: cw,
      h: ch,
    });
  });

  it("lands on the even x the engine renders inside a content box (#302)", () => {
    // maxX = 1000 − 450 = 550 → floor(275) = 275 is odd; computeCrop evens it
    // to 274. The un-rounded restatement drew x = 475; the engine renders 474.
    const cb = box(200, 50, 1000, 800);
    const out = fullHeightCropBox(true, cb, dims);
    expect(out).toEqual({ x: 474, y: 50, w: 450, h: 800 });
    expect(engineBox(out, true, cb, dims)).toEqual(out);
  });

  it("uses the engine's even-rounded content crop for an odd content box (#302)", () => {
    // contentCropFromBox emits 1000:800:200:50 for this box, so the engine
    // crops within the region at (200,50), not (201,51).
    const cb = box(201, 51, 1001, 801);
    const out = fullHeightCropBox(true, cb, dims);
    expect(out).toEqual({ x: 474, y: 50, w: 450, h: 800 });
    expect(engineBox(out, true, cb, dims)).toEqual(out);
    for (const v of [out.x, out.y, out.w, out.h]) expect(isEven(v)).toBe(true);
  });
});

describe("cropWindowSpec", () => {
  const region: Dims = { width: 1920, height: 1080 };
  it("returns null for a full-height box (engine gets a plain offset instead)", () => {
    expect(cropWindowSpec(fullHeightCropBox(false, null, region), region)).toBeNull();
  });
  it("returns a window for a punch-in (shorter-than-frame) box", () => {
    expect(cropWindowSpec(box(700, 200, 304, 540), region)).not.toBeNull();
  });
});

describe("parseContentCropPx", () => {
  it("parses a valid W:H:X:Y string into a Box", () => {
    expect(parseContentCropPx("1000:800:200:50")).toEqual({ x: 200, y: 50, w: 1000, h: 800 });
  });
  it("returns null for the wrong arity or non-numeric parts", () => {
    expect(parseContentCropPx("1000:800:200")).toBeNull();
    expect(parseContentCropPx("1000:800:200:50:0")).toBeNull();
    expect(parseContentCropPx("a:b:c:d")).toBeNull();
    expect(parseContentCropPx("")).toBeNull();
  });
});
