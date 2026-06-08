// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure helpers extracted from editor.ts (editor-util.ts). The
 * caption-style ↔ spec round-trip is the important coverage: it decides exactly
 * what each clip carries in the rendered manifest, so a regression here silently
 * corrupts output.
 */

import { describe, it, expect } from "vitest";
import {
  defaultCaptionStyle,
  captionStyleToSpec,
  captionStyleFromSpec,
  parseTextPosition,
  joinTextPosition,
  clamp,
  round3,
  roundEvenLocal,
  shorten,
  fmtClock,
  fmtTC,
  errMsg,
  baseName,
  safeParse,
  escapeHtml,
  kfCount,
} from "../src/editor-util.js";

describe("captionStyleToSpec (editor state → sparse manifest spec)", () => {
  it("a default style narrows to null (clip carries no caption object)", () => {
    expect(captionStyleToSpec(defaultCaptionStyle())).toBeNull();
  });

  it("keeps only non-default fields", () => {
    const c = { ...defaultCaptionStyle(), bold: true, color: "#FF0000" };
    expect(captionStyleToSpec(c)).toEqual({ bold: true, color: "#FF0000" });
  });

  it("treats the default colors case-insensitively (lowercase #ffffff == default)", () => {
    const c = { ...defaultCaptionStyle(), color: "#ffffff", outlineColor: "#000000" };
    expect(captionStyleToSpec(c)).toBeNull();
  });

  it("trims the font and omits an empty/whitespace one", () => {
    expect(captionStyleToSpec({ ...defaultCaptionStyle(), font: "   " })).toBeNull();
    expect(captionStyleToSpec({ ...defaultCaptionStyle(), font: "  Inter  " })).toEqual({
      font: "Inter",
    });
  });

  it("only emits boxColor when the box is on AND the color is non-default", () => {
    // box off → boxColor ignored entirely
    expect(captionStyleToSpec({ ...defaultCaptionStyle(), box: false, boxColor: "#123456" })).toBeNull();
    // box on, default boxColor → just { box: true }
    expect(captionStyleToSpec({ ...defaultCaptionStyle(), box: true })).toEqual({ box: true });
    // box on, custom boxColor → both
    expect(captionStyleToSpec({ ...defaultCaptionStyle(), box: true, boxColor: "#123456" })).toEqual({
      box: true,
      boxColor: "#123456",
    });
  });

  it("omits a zero / non-finite angle, keeps a real one", () => {
    expect(captionStyleToSpec({ ...defaultCaptionStyle(), angle: 0 })).toBeNull();
    expect(captionStyleToSpec({ ...defaultCaptionStyle(), angle: NaN })).toBeNull();
    expect(captionStyleToSpec({ ...defaultCaptionStyle(), angle: -7 })).toEqual({ angle: -7 });
  });
});

describe("captionStyleFromSpec (manifest spec → editor state)", () => {
  it("undefined spec → full defaults", () => {
    expect(captionStyleFromSpec(undefined)).toEqual(defaultCaptionStyle());
  });

  it("hydrates provided fields and coerces booleans", () => {
    const c = captionStyleFromSpec({ bold: true, italic: true, color: "#FF0000", angle: 12 });
    expect(c.bold).toBe(true);
    expect(c.italic).toBe(true);
    expect(c.color).toBe("#FF0000");
    expect(c.angle).toBe(12);
    expect(c.underline).toBe(false); // absent → false, not undefined
  });

  it("ignores a non-finite angle in the spec (keeps the default 0)", () => {
    expect(captionStyleFromSpec({ angle: Infinity }).angle).toBe(0);
  });
});

describe("caption round-trip (fromSpec ∘ toSpec is stable on the meaningful fields)", () => {
  for (const style of [
    { ...defaultCaptionStyle(), bold: true, underline: true, color: "#00FF00" },
    { ...defaultCaptionStyle(), box: true, boxColor: "#222222", angle: 30 },
    { ...defaultCaptionStyle(), font: "Inter", shadow: true, italic: true },
  ]) {
    it(`survives a to→from→to cycle: ${JSON.stringify(captionStyleToSpec(style))}`, () => {
      const spec = captionStyleToSpec(style);
      const rehydrated = captionStyleFromSpec(spec ?? undefined);
      expect(captionStyleToSpec(rehydrated)).toEqual(spec);
    });
  }
});

describe("text position (9-zone grid) parse/join round-trip", () => {
  it("defaults a blank/garbage value to bottom-center → stored as bare 'bottom'", () => {
    expect(parseTextPosition(undefined)).toEqual({ v: "bottom", h: "center" });
    expect(parseTextPosition("nonsense")).toEqual({ v: "bottom", h: "center" });
    expect(joinTextPosition("bottom", "center")).toBe("bottom");
  });

  it("round-trips every zone", () => {
    for (const v of ["top", "center", "bottom"] as const) {
      for (const h of ["left", "center", "right"] as const) {
        const stored = joinTextPosition(v, h);
        expect(parseTextPosition(stored)).toEqual({ v, h });
      }
    }
  });

  it("is case-insensitive and trims", () => {
    expect(parseTextPosition("  TOP-LEFT ")).toEqual({ v: "top", h: "left" });
  });
});

describe("scalar / string utils", () => {
  it("clamp bounds into [lo, hi]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it("round3 rounds to 3 decimals", () => {
    expect(round3(1.23456)).toBe(1.235);
    expect(round3(2)).toBe(2);
  });

  it("roundEvenLocal rounds to the nearest even integer", () => {
    expect(roundEvenLocal(5)).toBe(4);
    expect(roundEvenLocal(5.6)).toBe(6);
    expect(roundEvenLocal(7)).toBe(6);
  });

  it("shorten keeps the basename and ellipsizes past 28 chars", () => {
    expect(shorten("/a/b/clip.mp4")).toBe("clip.mp4");
    const long = "/x/" + "a".repeat(40) + ".mp4";
    const out = shorten(long);
    expect(out.length).toBe(26); // 25 + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("fmtClock formats m:ss and optional .mmm, flooring negatives to 0", () => {
    expect(fmtClock(62, false)).toBe("1:02");
    expect(fmtClock(62.04, true)).toBe("1:02.040");
    expect(fmtClock(-5, true)).toBe("0:00.000");
  });

  it("fmtTC formats mm:ss.s", () => {
    expect(fmtTC(62.04)).toBe("01:02.0");
    expect(fmtTC(0)).toBe("00:00.0");
  });

  it("errMsg unwraps an Error message, stringifies anything else", () => {
    expect(errMsg(new Error("boom"))).toBe("boom");
    expect(errMsg("plain")).toBe("plain");
    expect(errMsg(42)).toBe("42");
  });

  it("baseName returns the last path segment (no truncation)", () => {
    expect(baseName("/a/b/c.mp4")).toBe("c.mp4");
    expect(baseName("C:\\a\\b\\c.mp4")).toBe("c.mp4");
    expect(baseName("solo")).toBe("solo");
  });

  it("safeParse returns seconds for a valid timestamp, NaN otherwise", () => {
    expect(safeParse("1:30")).toBe(90);
    expect(safeParse("5")).toBe(5);
    expect(safeParse("not-a-time")).toBeNaN();
    expect(safeParse("")).toBeNaN();
  });

  it("escapeHtml escapes the five HTML-sensitive characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("kfCount (clip keyframe/switch-point count)", () => {
  const base = { source_file: "s.mp4", in_point: "0", out_point: "1" } as const;

  it("counts crop-path points when a track path is present", () => {
    expect(kfCount({ ...base, cropPath: [{ t: 0, x: 0 }, { t: 1, x: 10 }] })).toBe(2);
  });

  it("counts schedule switch points in a keyed crop_offset", () => {
    expect(kfCount({ ...base, crop_offset: "0=center; 14.5=440" })).toBe(2);
  });

  it("is 0 for a fixed offset or no offset", () => {
    expect(kfCount({ ...base, crop_offset: "center" })).toBe(0);
    expect(kfCount({ ...base })).toBe(0);
  });
});
