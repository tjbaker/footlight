// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for burned captions (SPEC §6.5): the pure `buildCaptionAss` libass
 * document generator, its `buildFfmpegArgs` integration (the `subtitles` filter),
 * and the `ffmpegListHasFilter` preflight parser. No filesystem, no subprocess.
 */

import { describe, it, expect } from "vitest";
import {
  buildCaptionAss,
  buildFfmpegArgs,
  ffmpegListHasFilter,
  DEFAULT_RENDER_OPTIONS,
  TARGET_H,
  type ClipRow,
  type RenderOptions,
} from "../src/core.js";

const ROW: ClipRow = {
  source_file: "in.mp4",
  in_point: "0",
  out_point: "10",
  crop_offset: "center",
};

const HOOK_SIZE = Math.round(TARGET_H / 18); // 107
const TITLE_SIZE = Math.round(TARGET_H / 26); // 74

/** Render options with captions on; spread overrides on top. */
function opts(over: Partial<RenderOptions> = {}): RenderOptions {
  return { ...DEFAULT_RENDER_OPTIONS, burnCaptions: true, ...over };
}

/** The single `Style:` line from an ASS document. */
function styleLine(ass: string): string {
  return ass.split("\n").find((l) => l.startsWith("Style: Caption,")) ?? "";
}

/** The single `Dialogue:` line from an ASS document. */
function dialogueLine(ass: string): string {
  return ass.split("\n").find((l) => l.startsWith("Dialogue:")) ?? "";
}

describe("buildCaptionAss (pure, libass — SPEC §6.5)", () => {
  it("returns null when captions are disabled", () => {
    expect(buildCaptionAss({ ...ROW, hook: "Hi" }, DEFAULT_RENDER_OPTIONS)).toBeNull();
    expect(buildCaptionAss({ ...ROW, hook: "Hi" }, opts({ burnCaptions: false }))).toBeNull();
  });

  it("returns null when enabled but the row has no text", () => {
    expect(buildCaptionAss(ROW, opts())).toBeNull();
    expect(buildCaptionAss({ ...ROW, hook: "  ", title: "" }, opts())).toBeNull();
  });

  it("emits a valid ASS skeleton at the output resolution", () => {
    const ass = buildCaptionAss({ ...ROW, hook: "Hi" }, opts())!;
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain(`PlayResX: 1080`);
    expect(ass).toContain(`PlayResY: ${TARGET_H}`);
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("[Events]");
    expect(dialogueLine(ass)).toMatch(/^Dialogue: 0,0:00:00\.00,\d/);
  });

  it("hook only -> one sized line", () => {
    const d = dialogueLine(buildCaptionAss({ ...ROW, hook: "Big moment" }, opts())!);
    expect(d).toContain(`{\\fs${HOOK_SIZE}}Big moment`);
    expect(d).not.toContain("\\N");
  });

  it("hook + title -> hook (bigger) above title, stacked with \\N", () => {
    const d = dialogueLine(buildCaptionAss({ ...ROW, hook: "HOOK", title: "sub" }, opts())!);
    expect(d).toContain(`{\\fs${HOOK_SIZE}}HOOK\\N{\\fs${TITLE_SIZE}}sub`);
  });

  it("text_position maps to ASS alignment (top=8, center=5, bottom=2)", () => {
    const at = (p?: string) => styleLine(buildCaptionAss({ ...ROW, hook: "H", text_position: p }, opts())!);
    expect(at("top")).toMatch(/,1,4,0,8,60,60,/);
    expect(at("center")).toMatch(/,1,4,0,5,60,60,/);
    expect(at("bottom")).toMatch(/,1,4,0,2,60,60,/);
    expect(at("weird")).toMatch(/,1,4,0,2,60,60,/); // unknown -> bottom
    expect(at(undefined)).toMatch(/,1,4,0,2,60,60,/);
  });

  it("white fill + black outline, opaque (&HAABBGGRR)", () => {
    const s = styleLine(buildCaptionAss({ ...ROW, hook: "H" }, opts())!);
    // PrimaryColour white, OutlineColour black
    expect(s).toContain("&H00FFFFFF,&H000000FF,&H00000000,");
  });

  it("font resolution: name -> Fontname, file -> stem, neither -> Sans", () => {
    expect(styleLine(buildCaptionAss({ ...ROW, hook: "H" }, opts({ captionFontName: "Impact" }))!))
      .toContain("Style: Caption,Impact,");
    expect(styleLine(buildCaptionAss({ ...ROW, hook: "H" }, opts({ captionFontFile: "/f/My Font.ttf" }))!))
      .toContain("Style: Caption,My Font,");
    expect(styleLine(buildCaptionAss({ ...ROW, hook: "H" }, opts())!))
      .toContain("Style: Caption,Sans,");
  });

  it("neutralizes ASS override braces and strips backslashes/newlines from text", () => {
    const d = dialogueLine(
      buildCaptionAss({ ...ROW, hook: "a{\\b1}b\nc" }, opts())!,
    );
    // the inline \fs tag we add is intact, but the user's braces/backslash/newline are gone
    expect(d).toContain(`{\\fs${HOOK_SIZE}}a(b1)b c`);
    expect(d).not.toContain("{\\b1}");
  });
});

describe("buildCaptionAss styling (color + bold/italic/underline)", () => {
  // Style fields, comma-split: [3]=PrimaryColour(fill) [5]=OutlineColour
  // [7]=Bold [8]=Italic [9]=Underline.
  const fields = (over: Partial<RenderOptions>) =>
    styleLine(buildCaptionAss({ ...ROW, hook: "H" }, opts(over))!).split(",");

  it("defaults to white fill, black outline, no bold/italic/underline", () => {
    const s = fields({});
    expect(s[3]).toBe("&H00FFFFFF");
    expect(s[5]).toBe("&H00000000");
    expect(s.slice(7, 10)).toEqual(["0", "0", "0"]);
  });

  it("maps #RRGGBB to ASS &H00BBGGRR (fill + outline)", () => {
    expect(fields({ captionColor: "#00FF00" })[3]).toBe("&H0000FF00");
    expect(fields({ captionOutlineColor: "#0000FF" })[5]).toBe("&H00FF0000");
    expect(fields({ captionColor: "ff8800" })[3]).toBe("&H000088FF"); // no '#' ok
  });

  it("bold / italic / underline set the ASS flag to -1", () => {
    expect(fields({ captionBold: true })[7]).toBe("-1");
    expect(fields({ captionItalic: true })[8]).toBe("-1");
    expect(fields({ captionUnderline: true })[9]).toBe("-1");
  });

  it("malformed colour falls back to the default", () => {
    expect(fields({ captionColor: "red" })[3]).toBe("&H00FFFFFF");
    expect(fields({ captionOutlineColor: "#fff" })[5]).toBe("&H00000000");
  });
});

describe("buildCaptionAss styling v2 (shadow, box, position, angle)", () => {
  // Style fields, comma-split: [5]=OutlineColour(box fill when boxed)
  // [14]=Angle [15]=BorderStyle [17]=Shadow [18]=Alignment.
  const fields = (over: Partial<RenderOptions>, pos?: string) =>
    styleLine(buildCaptionAss({ ...ROW, hook: "H", text_position: pos }, opts(over))!).split(",");

  it("9-zone text_position maps to ASS alignment 1–9", () => {
    expect(fields({}, "bottom-left")[18]).toBe("1");
    expect(fields({}, "bottom")[18]).toBe("2");
    expect(fields({}, "bottom-right")[18]).toBe("3");
    expect(fields({}, "center-left")[18]).toBe("4");
    expect(fields({}, "center")[18]).toBe("5");
    expect(fields({}, "top-right")[18]).toBe("9");
    expect(fields({}, undefined)[18]).toBe("2"); // default bottom-center
  });

  it("angle sets the ASS Angle field", () => {
    expect(fields({ captionAngle: 12 })[14]).toBe("12");
    expect(fields({})[14]).toBe("0");
  });

  it("shadow sets a non-zero Shadow depth", () => {
    expect(Number(fields({ captionShadow: true })[17])).toBeGreaterThan(0);
    expect(fields({})[17]).toBe("0");
  });

  it("box uses BorderStyle 3 with the box colour in the outline slot", () => {
    const s = fields({ captionBox: true, captionBoxColor: "#FFCC00" });
    expect(s[15]).toBe("3"); // BorderStyle = opaque box
    expect(s[5]).toBe("&H0000CCFF"); // box colour (#FFCC00 -> BGR)
    expect(fields({})[15]).toBe("1"); // default = outline
  });
});

describe("ffmpegListHasFilter (libass preflight)", () => {
  const WITH = [
    "Filters:",
    " ... subtitles         V->V       Render text subtitles onto input video using libass.",
    " ... scale             V->V       Scale the input video size.",
  ].join("\n");
  const WITHOUT = [
    "Filters:",
    " ... scale             V->V       Scale the input video size.",
    " ... ebur128           A->N       EBU R128 scanner.",
  ].join("\n");

  it("detects an advertised filter", () => {
    expect(ffmpegListHasFilter(WITH, "subtitles")).toBe(true);
  });
  it("reports a missing filter (build without libass)", () => {
    expect(ffmpegListHasFilter(WITHOUT, "subtitles")).toBe(false);
  });
  it("does not match a name only in a description", () => {
    expect(ffmpegListHasFilter(WITH, "libass")).toBe(false);
  });
});

describe("buildFfmpegArgs caption integration", () => {
  const dims: [number, number] = [1920, 1080];

  it("appends the subtitles filter after setsar when an ASS path is given", () => {
    const { args } = buildFfmpegArgs(
      { ...ROW, hook: "Yo" },
      { ...opts(), dims, outdir: "out", captionAssPath: "/tmp/c.ass" },
    );
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain("subtitles=filename='/tmp/c.ass'");
    expect(vf.indexOf("setsar=1")).toBeLessThan(vf.indexOf("subtitles="));
  });

  it("adds fontsdir when a caption font file is set", () => {
    const { args } = buildFfmpegArgs(
      { ...ROW, hook: "Yo" },
      { ...opts(), dims, outdir: "out", captionAssPath: "/tmp/c.ass", captionFontFile: "/f/My Font.ttf" },
    );
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain("subtitles=filename='/tmp/c.ass':fontsdir='/f'");
  });

  it("points fontsdir at the root for a root-level font file", () => {
    const { args } = buildFfmpegArgs(
      { ...ROW, hook: "Yo" },
      { ...opts(), dims, outdir: "out", captionAssPath: "/tmp/c.ass", captionFontFile: "/My Font.ttf" },
    );
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain("subtitles=filename='/tmp/c.ass':fontsdir='/'");
  });

  it("emits no subtitles filter without an ASS path (clean export)", () => {
    const { args } = buildFfmpegArgs({ ...ROW, hook: "Yo" }, { ...opts(), dims, outdir: "out" });
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).not.toContain("subtitles");
  });
});
