// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { specToEditorState, type ClipSpec, type Dims } from "../src/manifest.js";

const dims: Dims = { width: 1920, height: 1080 };

// The engine's fixed 9:16 crop width for a 1920x1080 region:
// even(round(1080 * 9/16)) = even(round(607.5)) = 608.
const CROP_W = 608;
const MAX_X = dims.width - CROP_W; // 1312
const CENTER_X = Math.floor(MAX_X / 2); // 656

function spec(partial: Partial<ClipSpec>): ClipSpec {
  return {
    source_file: "in.mp4",
    in_point: "1.0",
    out_point: "5.5",
    ...partial,
  };
}

describe("specToEditorState", () => {
  it("fixed crop_offset 'center' -> full-height centered box", () => {
    const r = specToEditorState(spec({ crop_offset: "center" }), dims);
    expect(r.inPoint).toBe(1.0);
    expect(r.outPoint).toBe(5.5);
    expect(r.contentMode).toBe(false);
    expect(r.keyframes).toEqual([]);
    expect(r.cropPath).toBeNull();
    expect(r.cropBox).not.toBeNull();
    const box = r.cropBox!;
    // Full height (even), horizontally centered.
    expect(box.h).toBe(1080);
    expect(Math.abs(box.h - 1080)).toBeLessThanOrEqual(2);
    expect(box.y).toBe(0);
    expect(box.w).toBe(CROP_W);
    expect(box.x).toBe(CENTER_X);
  });

  it("integer crop_offset '440' -> box.x reflects ~440", () => {
    const r = specToEditorState(spec({ crop_offset: "440" }), dims);
    expect(r.cropBox).not.toBeNull();
    expect(Math.abs(r.cropBox!.x - 440)).toBeLessThanOrEqual(2);
    expect(r.cropBox!.w).toBe(CROP_W);
    expect(r.keyframes).toEqual([]);
  });

  it("cropWindow punch-in without content_crop -> cropBox equals it", () => {
    const cropWindow = { x: 100, y: 50, w: 608, h: 1080 };
    const r = specToEditorState(spec({ cropWindow }), dims);
    expect(r.contentMode).toBe(false);
    expect(r.cropPath).toBeNull();
    expect(r.keyframes).toEqual([]);
    expect(r.cropBox).toEqual({ x: 100, y: 50, w: 608, h: 1080 });
  });

  it("cropWindow with content_crop -> contentMode and cropBox offset by origin", () => {
    // content_crop is W:H:X:Y -> 1600x900 region at (160, 90).
    const cropWindow = { x: 100, y: 50, w: 506, h: 900 };
    const r = specToEditorState(
      spec({ cropWindow, content_crop: "1600:900:160:90" }),
      dims,
    );
    expect(r.contentMode).toBe(true);
    expect(r.contentBox).toEqual({ x: 160, y: 90, w: 1600, h: 900 });
    // cropBox shifted into source-pixel coords by the content origin.
    expect(r.cropBox).toEqual({
      x: 100 + 160,
      y: 50 + 90,
      w: 506,
      h: 900,
    });
  });

  it("schedule crop_offset -> keyframes parsed, box from first offset", () => {
    const r = specToEditorState(
      spec({ crop_offset: "0=center; 14.5=440" }),
      dims,
    );
    expect(r.cropPath).toBeNull();
    expect(r.keyframes.length).toBe(2);
    expect(r.keyframes[0]).toEqual({ t: 0, offset: "center" });
    expect(r.keyframes[1]).toEqual({ t: 14.5, offset: "440" });
    // cropBox derived from the first ("center") offset.
    expect(r.cropBox!.x).toBe(CENTER_X);
    expect(r.cropBox!.w).toBe(CROP_W);
  });

  it("cropPath -> mapped path, no keyframes, full-height centered box", () => {
    const r = specToEditorState(
      spec({
        cropPath: [
          { t: 0, x: 100 },
          { t: 2, x: 300 },
        ],
      }),
      dims,
    );
    expect(r.cropPath).toEqual([
      { t: 0, x: 100 },
      { t: 2, x: 300 },
    ]);
    expect(r.keyframes).toEqual([]);
    expect(r.cropBox).not.toBeNull();
    expect(r.cropBox!.h).toBe(1080);
    expect(r.cropBox!.w).toBe(CROP_W);
    expect(r.cropBox!.x).toBe(CENTER_X);
  });

  it("missing crop_offset defaults to center", () => {
    const r = specToEditorState(spec({}), dims);
    expect(r.keyframes).toEqual([]);
    expect(r.cropPath).toBeNull();
    expect(r.cropBox!.x).toBe(CENTER_X);
  });
});
