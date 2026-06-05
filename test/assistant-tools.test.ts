// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  TOOLS,
  TOOL_BY_NAME,
  DETERMINISTIC_TOOLS,
  clampCropX,
  interpretTool,
  buildSuggestCropAction,
  buildTrackSubjectAction,
} from "../src/assistant/tools.js";
import { cropBoxToOffset, type Box, type Dims } from "../src/studio.js";
import { samplesToCropPath } from "../src/track.js";
import type { TrackSample } from "../src/providers/types.js";

const region: Dims = { width: 1920, height: 1080 };
// Engine crop width for this region: even(round(1080 * 9/16)) = 608 -> maxX = 1312.
const MAX_X = 1312;

describe("tool registry", () => {
  const EXPECTED = [
    "setInOut",
    "addCropKeyframe",
    "setContentCrop",
    "detectScenes",
    "suggestCropForFrame",
    "trackSubject",
    "trim",
    "render",
  ];

  it("exposes exactly the 8 tools, each looked up by name", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
    for (const name of EXPECTED) expect(TOOL_BY_NAME.get(name as never)?.name).toBe(name);
  });

  it("every required param is declared in the schema's properties", () => {
    for (const t of TOOLS) {
      for (const req of t.paramSchema.required) {
        expect(Object.keys(t.paramSchema.properties)).toContain(req);
      }
      expect(t.paramSchema.additionalProperties).toBe(false);
    }
  });

  it("marks the right tools deterministic (vision tools excluded)", () => {
    expect(DETERMINISTIC_TOOLS.has("setInOut")).toBe(true);
    expect(DETERMINISTIC_TOOLS.has("suggestCropForFrame")).toBe(false);
    expect(DETERMINISTIC_TOOLS.has("trackSubject")).toBe(false);
  });
});

describe("clampCropX parity with the engine/studio", () => {
  it("even-rounds and clamps into [0, maxX]", () => {
    expect(clampCropX(-50, region)).toBe(0);
    expect(clampCropX(99999, region)).toBe(MAX_X);
    expect(clampCropX(701, region)).toBe(700); // even-rounded
  });

  it("matches cropBoxToOffset's numeric result for an unsnapped x", () => {
    const x = 700;
    const box: Box = { x, y: 0, w: 608, h: 1080 };
    expect(String(clampCropX(x, region))).toBe(cropBoxToOffset(box, region));
  });
});

describe("interpretTool (deterministic tools)", () => {
  it("setInOut builds an ordered region commit + ghost", () => {
    const a = interpretTool("setInOut", { inSec: 62, outSec: 76.8 }, { region });
    expect(a.commit).toEqual({ kind: "setInOut", inSec: 62, outSec: 76.8 });
    expect(a.ghost?.region).toEqual({ inSec: 62, outSec: 76.8 });
  });

  it("setInOut rejects out <= in", () => {
    expect(() => interpretTool("setInOut", { inSec: 10, outSec: 10 }, { region })).toThrow(/greater than/);
  });

  it("addCropKeyframe clamps x into frame", () => {
    const a = interpretTool("addCropKeyframe", { t: 6.4, x: 99999 }, { region });
    expect(a.commit).toEqual({ kind: "addCropKeyframe", t: 6.4, x: MAX_X });
    expect(a.ghost?.keyframe).toEqual({ t: 6.4, x: MAX_X });
  });

  it("setContentCrop validates the W:H:X:Y region", () => {
    const a = interpretTool("setContentCrop", { contentCrop: "1800:1010:60:34" }, { region });
    expect(a.commit).toEqual({ kind: "setContentCrop", contentCrop: "1800:1010:60:34" });
    expect(() => interpretTool("setContentCrop", { contentCrop: "nope" }, { region })).toThrow();
  });

  it("trim / detectScenes / render map to their commit kinds", () => {
    expect(interpretTool("trim", { outSec: 30 }, { region }).commit).toEqual({ kind: "trim", outSec: 30 });
    expect(interpretTool("detectScenes", {}, { region }).commit).toEqual({ kind: "detectScenes" });
    expect(interpretTool("render", {}, { region }).commit).toEqual({ kind: "render" });
  });

  it("rejects vision tools (they need a model result)", () => {
    expect(() => interpretTool("trackSubject", { subjectHint: "x" }, { region })).toThrow(/vision tool/);
    expect(() => interpretTool("suggestCropForFrame", { t: 1 }, { region })).toThrow(/vision tool/);
  });

  it("rejects malformed args", () => {
    expect(() => interpretTool("setInOut", { inSec: "a", outSec: 2 } as never, { region })).toThrow(/finite number/);
  });
});

describe("vision-result builders", () => {
  it("buildSuggestCropAction inverts the box via cropBoxToOffset", () => {
    const box: Box = { x: 700, y: 240, w: 608, h: 600 };
    const a = buildSuggestCropAction(3.2, box, region);
    expect(a.commit).toEqual({ kind: "suggestCropForFrame", t: 3.2, cropOffset: cropBoxToOffset(box, region) });
    expect(a.ghost?.crop).toEqual(box);
  });

  it("buildTrackSubjectAction delegates to samplesToCropPath", () => {
    const samples: TrackSample[] = [
      { t: 0, box: { x: 300, y: 240, w: 200, h: 600 } },
      { t: 1, box: { x: 700, y: 240, w: 200, h: 600 } },
      { t: 2, box: { x: 1100, y: 240, w: 200, h: 600 } },
    ];
    const a = buildTrackSubjectAction(samples, region);
    expect(a.commit.kind).toBe("trackSubject");
    if (a.commit.kind === "trackSubject") {
      expect(a.commit.cropPath).toEqual(samplesToCropPath(samples, region));
      expect(a.commit.cropPath.length).toBeGreaterThan(0);
    }
    expect(a.ghost?.path?.length).toBe(samplesToCropPath(samples, region).length);
  });
});
