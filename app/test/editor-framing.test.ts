// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Render-exact framing inside a content crop (#338). The engine first crops to
 * the even-rounded `content_crop` the editor emits (`contentCropFromBox`), then
 * applies the 9:16 crop relative to THAT region. So the editor must compute
 * `crop_offset` / `cropWindow` against the same rounded region and origin, not
 * the raw drawn content box. Each case here runs the real emission
 * (`framingToSpec`) through the real render builder (`buildFfmpegArgs`) and
 * reads the source-pixel crop back out of its `-vf` filtergraph.
 */

import { describe, it, expect } from "vitest";
import { buildFfmpegArgs, type CropPathKeyframe } from "@core";
import type { Box, Dims } from "@manifest";
import { cropRegionRect, resizeCrop } from "../src/editor-crop.js";
import { currentRegion, framingToSpec } from "../src/editor-framing.js";
import { trackedBoxXAt } from "../src/editor-offset.js";
import { createInitialEditorState } from "../src/editor-store.js";

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
const dims: Dims = { width: 1920, height: 1080 };
// An odd-sized, odd-origin content box. contentCropFromBox emits 1000:800:200:50.
const ODD_CONTENT = box(201, 51, 1001, 801);

function stateWith(cropBox: Box, contentBox: Box | null) {
  return {
    ...createInitialEditorState(),
    dims,
    contentMode: contentBox != null,
    contentBox,
    cropBox,
  };
}

/** The SOURCE-pixel box `buildFfmpegArgs` actually renders for the editor's
 *  emission: the 9:16 crop's W:H:X:Y offset by the content crop's origin. */
function renderedBox(cropBox: Box, contentBox: Box | null): Box {
  const spec = framingToSpec(stateWith(cropBox, contentBox));
  const { args } = buildFfmpegArgs(
    {
      source_file: "s.mp4",
      in_point: "0",
      out_point: "1",
      crop_offset: spec.crop_offset ?? "",
      content_crop: spec.content_crop ?? "",
    },
    {
      crf: 19,
      preset: "medium",
      audioBitrate: "copy",
      outdir: "clips",
      dims: [dims.width, dims.height],
      ...(spec.cropWindow ? { cropWindow: spec.cropWindow } : {}),
    },
  );
  const vf = args[args.indexOf("-vf") + 1]!;
  const crops = [...vf.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map((m) =>
    m.slice(1).map(Number),
  );
  const [w, h, x, y] = crops.at(-1)!;
  const [ox, oy] = crops.length > 1 ? [crops[0]![2]!, crops[0]![3]!] : [0, 0];
  return { x: ox + x!, y: oy + y!, w: w!, h: h! };
}

describe("framing inside an odd-sized content crop (#338)", () => {
  it("currentRegion is the even-rounded region the engine crops to", () => {
    expect(currentRegion(stateWith(box(500, 50, 450, 800), ODD_CONTENT))).toEqual({
      width: 1000,
      height: 800,
    });
  });

  it("a full-height crop_offset renders exactly the drawn box", () => {
    // 300px into the rendered region (origin 200): off every named snap point.
    const drawn = box(500, 50, 450, 800);
    const spec = framingToSpec(stateWith(drawn, ODD_CONTENT));
    expect(spec.cropWindow).toBeUndefined();
    expect(spec.content_crop).toBe("1000:800:200:50");
    expect(spec.crop_offset).toBe("300");
    expect(renderedBox(drawn, ODD_CONTENT)).toEqual(drawn);
  });

  it("a punch-in cropWindow renders exactly the drawn box", () => {
    const drawn = box(500, 150, 304, 540);
    const spec = framingToSpec(stateWith(drawn, ODD_CONTENT));
    expect(spec.cropWindow).toEqual({ x: 300, y: 100, w: 304, h: 540 });
    expect(renderedBox(drawn, ODD_CONTENT)).toEqual(drawn);
  });

  it("drags clamp to the rendered region, so a box at the far corner still round-trips", () => {
    const region = cropRegionRect(true, ODD_CONTENT, dims);
    expect(region).toEqual({ x0: 200, y0: 50, x1: 1200, y1: 850 });
    // Grab the bottom-right corner of a punch-in box and drag far past the frame.
    const start = box(700, 200, 304, 540);
    const edges = { l: false, r: true, t: false, b: true };
    const dragged = resizeCrop(5000, 5000, start, edges, region);
    expect(dragged.x + dragged.w).toBeLessThanOrEqual(1200);
    expect(dragged.y + dragged.h).toBeLessThanOrEqual(850);
    expect(renderedBox(dragged, ODD_CONTENT)).toEqual(dragged);
  });

  it("the AI-track preview re-adds the rendered origin, not the raw one", () => {
    const path: CropPathKeyframe[] = [{ t: 0, x: 300 }];
    expect(trackedBoxXAt(path, box(0, 50, 450, 800), dims, 0, 0, true, ODD_CONTENT)).toBe(500);
  });
});

describe("content_crop emission threshold (#338)", () => {
  // A sliver box (≤ 2px in one direction) is not a usable working region —
  // `activeContentBox` rejects it — so nothing may be emitted for it either.
  const drawn = box(656, 0, 608, 1080);

  it.each([
    ["2px wide", box(400, 0, 2, 800)],
    ["2px tall", box(400, 0, 1000, 2)],
  ])("a %s content box emits no content_crop and frames the full source", (_label, sliver) => {
    const state = stateWith(drawn, sliver);
    expect(framingToSpec(state).content_crop).toBeUndefined();
    expect(currentRegion(state)).toEqual(dims);
    expect(framingToSpec(state).crop_offset).toBe("center");
  });

  it("a 4px box is usable and emitted", () => {
    expect(framingToSpec(stateWith(drawn, box(400, 0, 4, 4))).content_crop).toBe("4:4:400:0");
  });
});
