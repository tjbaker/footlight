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

  it("emits no subtitles filter without an ASS path (clean export)", () => {
    const { args } = buildFfmpegArgs({ ...ROW, hook: "Yo" }, { ...opts(), dims, outdir: "out" });
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).not.toContain("subtitles");
  });
});
