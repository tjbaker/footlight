// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure caption-preview layout math extracted from editor.ts
 * (editor-caption-preview.ts). These pin the WHAT/WHERE half of the on-canvas
 * caption hint: the newline → line-list split (mirroring the engine's \N
 * behavior, including blank inner lines as spacing), the hook/title sizing,
 * the block geometry, the 9-zone grid anchor, and the per-line CSS font
 * strings (family quoting, path fallback, bold/italic). The ctx painting half
 * stays in editor.ts and is exercised separately.
 */

import { describe, it, expect } from "vitest";
import {
  splitCaptionLines,
  isFontPath,
  previewCaptionFont,
  layoutPreviewCaptions,
} from "../src/editor-caption-preview.js";
import { defaultCaptionStyle } from "../src/editor-util.js";

// A convenient canvas size: ch=1000 makes the derived metrics round numbers —
// hookSize 52, titleSize 36, gap 12, pad 30.
const CW = 562;
const CH = 1000;

describe("splitCaptionLines (newlines → preview lines, mirroring the engine's \\N)", () => {
  it("empty / whitespace-only text yields no lines", () => {
    expect(splitCaptionLines("")).toEqual([]);
    expect(splitCaptionLines("   \n  ")).toEqual([]);
  });

  it("splits on LF, CRLF, and bare CR", () => {
    expect(splitCaptionLines("A\nB")).toEqual(["A", "B"]);
    expect(splitCaptionLines("A\r\nB\rC")).toEqual(["A", "B", "C"]);
  });

  it("trims each line but keeps blank INNER lines as spacing (like \\N\\N)", () => {
    expect(splitCaptionLines("  A  \n  B  ")).toEqual(["A", "B"]);
    expect(splitCaptionLines("A\n\nB")).toEqual(["A", "", "B"]);
  });
});

describe("isFontPath", () => {
  it("treats slashes and font-file extensions as paths", () => {
    expect(isFontPath("/Library/Fonts/Inter.ttf")).toBe(true);
    expect(isFontPath("C:\\Fonts\\Inter.otf")).toBe(true);
    expect(isFontPath("Inter.ttc")).toBe(true);
  });

  it("a bare family name is not a path", () => {
    expect(isFontPath("Avenir Next")).toBe(false);
    expect(isFontPath("")).toBe(false);
  });
});

describe("previewCaptionFont (per-line CSS font string)", () => {
  it("default style → semibold system stack", () => {
    expect(previewCaptionFont(defaultCaptionStyle(), 52)).toBe(
      "600 52px system-ui, sans-serif",
    );
  });

  it("bold bumps the weight; italic prefixes the style", () => {
    expect(previewCaptionFont({ ...defaultCaptionStyle(), bold: true }, 36)).toBe(
      "800 36px system-ui, sans-serif",
    );
    expect(previewCaptionFont({ ...defaultCaptionStyle(), italic: true }, 36)).toBe(
      "italic 600 36px system-ui, sans-serif",
    );
  });

  it("a bare family name is quoted first (apostrophes stripped)", () => {
    expect(previewCaptionFont({ ...defaultCaptionStyle(), font: "Avenir Next" }, 52)).toBe(
      "600 52px 'Avenir Next', system-ui, sans-serif",
    );
    expect(previewCaptionFont({ ...defaultCaptionStyle(), font: "O'Neil" }, 52)).toBe(
      "600 52px 'ONeil', system-ui, sans-serif",
    );
  });

  it("a font file path can't be canvas-rendered → falls back to the system face", () => {
    expect(
      previewCaptionFont({ ...defaultCaptionStyle(), font: "/Library/Fonts/X.ttf" }, 52),
    ).toBe("600 52px system-ui, sans-serif");
  });
});

describe("layoutPreviewCaptions (block geometry + grid anchor)", () => {
  const cap = defaultCaptionStyle();

  it("no caption text → null (nothing to draw)", () => {
    expect(layoutPreviewCaptions("", "", "bottom", cap, CW, CH)).toBeNull();
    expect(layoutPreviewCaptions("  ", "\n", "bottom", cap, CW, CH)).toBeNull();
  });

  it("hook lines come first at the big size, then title lines at the small size", () => {
    const l = layoutPreviewCaptions("BIG\nNIGHT", "live", "bottom", cap, CW, CH)!;
    expect(l.lines.map((x) => ({ text: x.text, size: x.size }))).toEqual([
      { text: "BIG", size: 52 },
      { text: "NIGHT", size: 52 },
      { text: "live", size: 36 },
    ]);
    expect(l.lines[0]!.font).toBe("600 52px system-ui, sans-serif");
    expect(l.lines[2]!.font).toBe("600 36px system-ui, sans-serif");
    expect(l.hookSize).toBe(52);
  });

  it("block height sums line sizes plus the gaps between them", () => {
    const l = layoutPreviewCaptions("BIG\nNIGHT", "live", "bottom", cap, CW, CH)!;
    // 52 + 52 + 36 + 2×12
    expect(l.blockH).toBe(164);
    expect(l.gap).toBe(12);
    expect(l.pad).toBe(30);
  });

  it("vertical placement: top pads down, center centers, bottom (default) pads up", () => {
    const top = layoutPreviewCaptions("Hook", "", "top", cap, CW, CH)!;
    expect(top.top).toBe(30);
    const center = layoutPreviewCaptions("Hook", "", "center", cap, CW, CH)!;
    expect(center.top).toBe((CH - 52) / 2);
    const bottom = layoutPreviewCaptions("Hook", "", "bottom", cap, CW, CH)!;
    expect(bottom.top).toBe(CH - 52 - 30);
    // An unknown / empty position falls back to bottom (parseTextPosition default).
    const fallback = layoutPreviewCaptions("Hook", "", "", cap, CW, CH)!;
    expect(fallback.top).toBe(bottom.top);
  });

  it("horizontal placement anchors x left / center / right (h doubles as textAlign)", () => {
    const left = layoutPreviewCaptions("Hook", "", "bottom-left", cap, CW, CH)!;
    expect(left.x).toBe(30);
    expect(left.h).toBe("left");
    const center = layoutPreviewCaptions("Hook", "", "bottom", cap, CW, CH)!;
    expect(center.x).toBe(CW / 2);
    expect(center.h).toBe("center");
    const right = layoutPreviewCaptions("Hook", "", "top-right", cap, CW, CH)!;
    expect(right.x).toBe(CW - 30);
    expect(right.h).toBe("right");
  });

  it("a blank inner hook line still occupies a full hook-sized slot", () => {
    const l = layoutPreviewCaptions("A\n\nB", "", "bottom", cap, CW, CH)!;
    expect(l.lines).toHaveLength(3);
    expect(l.lines[1]).toMatchObject({ text: "", size: 52 });
    // 3×52 + 2×12
    expect(l.blockH).toBe(180);
  });

  it("style flows into every line's font string", () => {
    const styled = { ...defaultCaptionStyle(), bold: true, italic: true, font: "Inter" };
    const l = layoutPreviewCaptions("Hook", "title", "bottom", styled, CW, CH)!;
    expect(l.lines[0]!.font).toBe("italic 800 52px 'Inter', system-ui, sans-serif");
    expect(l.lines[1]!.font).toBe("italic 800 36px 'Inter', system-ui, sans-serif");
  });
});
