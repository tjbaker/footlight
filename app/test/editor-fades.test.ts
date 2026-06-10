// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for editor-fades.ts (#165) — the pure fade-field parsing, the sparse
 * spec round-trip, the fits-the-clip validation mirrored from the engine, and
 * the loop-seam frame times.
 */

import { describe, it, expect } from "vitest";

import {
  parseFadeField,
  fadesToSpec,
  fadesFromSpec,
  fadesFit,
  loopSeamTimes,
} from "../src/editor-fades.js";

describe("parseFadeField", () => {
  it("parses plain non-negative seconds, ms-rounded", () => {
    expect(parseFadeField("0.5")).toBe(0.5);
    expect(parseFadeField(" 1.2345 ")).toBe(1.235);
  });
  it("degrades garbage and non-positives to 0 (no error state mid-typing)", () => {
    for (const raw of ["", "  ", "abc", "-1", "Infinity", "NaN"]) {
      expect(parseFadeField(raw)).toBe(0);
    }
  });
});

describe("fadesToSpec / fadesFromSpec", () => {
  it("keeps only positive fades (sparse manifests)", () => {
    expect(fadesToSpec({ fadeIn: 0, fadeOut: 0 })).toEqual({});
    expect(fadesToSpec({ fadeIn: 0.5, fadeOut: 0 })).toEqual({ fade_in: 0.5 });
    expect(fadesToSpec({ fadeIn: 0.25, fadeOut: 1 })).toEqual({ fade_in: 0.25, fade_out: 1 });
  });
  it("round-trips through a spec and hydrates absent/invalid as 0", () => {
    const f = { fadeIn: 0.3, fadeOut: 0.7 };
    expect(fadesFromSpec(fadesToSpec(f))).toEqual(f);
    expect(fadesFromSpec({})).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(
      fadesFromSpec({ fade_in: Number.NaN as unknown as number, fade_out: -2 }),
    ).toEqual({ fadeIn: 0, fadeOut: 0 });
  });
});

describe("fadesFit", () => {
  it("mirrors the engine rule: fade_in + fade_out must fit the clip", () => {
    expect(fadesFit({ fadeIn: 0.2, fadeOut: 0.3 }, 0.5)).toBe(true);
    expect(fadesFit({ fadeIn: 0.3, fadeOut: 0.3 }, 0.5)).toBe(false);
    expect(fadesFit({ fadeIn: 0, fadeOut: 0 }, 0)).toBe(true);
  });
});

describe("loopSeamTimes", () => {
  it("steps one frame back from Out (the last frame INSIDE the clip)", () => {
    const { inT, outT } = loopSeamTimes(2, 5, 25);
    expect(inT).toBe(2);
    expect(outT).toBeCloseTo(5 - 1 / 25, 10);
  });
  it("clamps to In for sub-frame clips and defaults a missing fps to 30", () => {
    expect(loopSeamTimes(1, 1.01, 25).outT).toBe(1);
    expect(loopSeamTimes(0, 10, 0).outT).toBeCloseTo(10 - 1 / 30, 10);
  });
});
