// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for burned captions (SPEC §6.5): the pure `buildCaptionFilters`
 * drawtext builder and its integration into `buildFfmpegArgs`. Dimensions are
 * passed in so nothing touches the filesystem.
 */

import { describe, it, expect } from "vitest";
import {
  buildCaptionFilters,
  buildFfmpegArgs,
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

/** Render options with captions on; spread overrides on top. */
function opts(over: Partial<RenderOptions> = {}): RenderOptions {
  return { ...DEFAULT_RENDER_OPTIONS, burnCaptions: true, ...over };
}

/** Pull the numeric `y=` from a drawtext filter string. */
function yOf(filter: string): number {
  const m = filter.match(/:y=(\d+)$/);
  if (!m) throw new Error(`no y= in ${filter}`);
  return Number(m[1]);
}

describe("buildCaptionFilters (pure, SPEC §6.5)", () => {
  it("returns nothing when captions are disabled", () => {
    expect(buildCaptionFilters({ ...ROW, hook: "Hi" }, DEFAULT_RENDER_OPTIONS)).toEqual([]);
    expect(buildCaptionFilters({ ...ROW, hook: "Hi" }, opts({ burnCaptions: false }))).toEqual([]);
  });

  it("returns nothing when enabled but the row has no text", () => {
    expect(buildCaptionFilters(ROW, opts())).toEqual([]);
    expect(buildCaptionFilters({ ...ROW, hook: "   ", title: "" }, opts())).toEqual([]);
  });

  it("hook only -> one drawtext, hook size, centered, white w/ black outline", () => {
    const f = buildCaptionFilters({ ...ROW, hook: "Big moment" }, opts());
    expect(f).toHaveLength(1);
    const d = f[0]!;
    expect(d).toContain("text='Big moment'");
    expect(d).toContain(`fontsize=${Math.round(TARGET_H / 18)}`);
    expect(d).toContain("fontcolor=white");
    expect(d).toContain("borderw=4");
    expect(d).toContain("bordercolor=black@0.8");
    expect(d).toContain("x=(w-text_w)/2");
  });

  it("hook + title -> two drawtexts, hook above title, correct sizes", () => {
    const f = buildCaptionFilters({ ...ROW, hook: "HOOK", title: "title" }, opts());
    expect(f).toHaveLength(2);
    expect(f[0]).toContain("text='HOOK'");
    expect(f[0]).toContain(`fontsize=${Math.round(TARGET_H / 18)}`);
    expect(f[1]).toContain("text='title'");
    expect(f[1]).toContain(`fontsize=${Math.round(TARGET_H / 26)}`);
    expect(yOf(f[0]!)).toBeLessThan(yOf(f[1]!)); // hook sits above title
  });

  it("text_position places the block top / center / bottom", () => {
    const top = buildCaptionFilters({ ...ROW, hook: "H", text_position: "top" }, opts());
    const center = buildCaptionFilters({ ...ROW, hook: "H", text_position: "center" }, opts());
    const bottom = buildCaptionFilters({ ...ROW, hook: "H", text_position: "bottom" }, opts());
    expect(yOf(top[0]!)).toBeLessThan(yOf(center[0]!));
    expect(yOf(center[0]!)).toBeLessThan(yOf(bottom[0]!));
    // unknown / missing -> bottom
    const dflt = buildCaptionFilters({ ...ROW, hook: "H", text_position: "weird" }, opts());
    expect(yOf(dflt[0]!)).toBe(yOf(bottom[0]!));
  });

  it("escapes special characters and quotes the text so the filtergraph is safe", () => {
    const f = buildCaptionFilters(
      { ...ROW, hook: "a:b, c '90% off' \\x" },
      opts(),
    );
    const d = f[0]!;
    // single-quoted, with ' \\ and % escaped; : and , protected by the quotes
    expect(d).toContain("text='a:b, c \\'90\\% off\\' \\\\x'");
  });

  it("font resolution: file -> fontfile=, name -> font=, neither -> system Sans", () => {
    const file = buildCaptionFilters({ ...ROW, hook: "H" }, opts({ captionFontFile: "/f/My Font.ttf" }));
    expect(file[0]).toContain("fontfile='/f/My Font.ttf'");
    const name = buildCaptionFilters({ ...ROW, hook: "H" }, opts({ captionFontName: "Impact" }));
    expect(name[0]).toContain("font='Impact'");
    const dflt = buildCaptionFilters({ ...ROW, hook: "H" }, opts());
    expect(dflt[0]).toContain("font='Sans'");
    // file wins over name
    const both = buildCaptionFilters(
      { ...ROW, hook: "H" },
      opts({ captionFontFile: "/f/a.otf", captionFontName: "Impact" }),
    );
    expect(both[0]).toContain("fontfile='/f/a.otf'");
    expect(both[0]).not.toContain("font='Impact'");
  });
});

describe("buildFfmpegArgs caption integration", () => {
  const dims: [number, number] = [1920, 1080];

  it("appends drawtext after setsar when captions are on", () => {
    const { args } = buildFfmpegArgs(
      { ...ROW, hook: "Yo" },
      { ...opts(), dims, outdir: "out" },
    );
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain("setsar=1");
    expect(vf).toContain("drawtext=");
    // drawtext comes after setsar (drawn on the final frame)
    expect(vf.indexOf("setsar=1")).toBeLessThan(vf.indexOf("drawtext="));
  });

  it("emits no drawtext when captions are off (clean export by default)", () => {
    const { args } = buildFfmpegArgs(
      { ...ROW, hook: "Yo" },
      { ...DEFAULT_RENDER_OPTIONS, dims, outdir: "out" },
    );
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).not.toContain("drawtext");
  });
});
