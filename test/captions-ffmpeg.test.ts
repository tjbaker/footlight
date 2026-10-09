// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Burned captions through REAL ffmpeg (issue #247). The pure tests in
 * captions.test.ts only pin the filter string; this proves ffmpeg actually opens
 * the caption file and fonts dir when their paths contain characters that are
 * special to the filtergraph (`'`, `:`, `,`, `[`, `]`, `;`). Skipped when ffmpeg
 * (or its libass-backed `subtitles` filter) isn't available.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCaptionAss,
  buildFfmpegArgs,
  ffmpegListHasFilter,
  DEFAULT_RENDER_OPTIONS,
  type ClipRow,
} from "../src/core.js";

function hasSubtitlesFilter(): boolean {
  try {
    const out = execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
    return ffmpegListHasFilter(out, "subtitles");
  } catch {
    return false;
  }
}

/** Any system TTF/OTF to stand in as a "custom font file", or null. */
function anySystemFont(): string | null {
  for (const f of [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
  ]) {
    if (existsSync(f)) return f;
  }
  return null;
}

describe.skipIf(!hasSubtitlesFilter())("burned captions through real ffmpeg", () => {
  // Every filtergraph-special character, plus a space, in one directory name.
  const NASTY = "Trevor's Fonts:a,b;c[d] e";

  it("renders when the caption file and fonts dir paths contain ' : , ; [ ]", () => {
    const root = mkdtempSync(join(tmpdir(), "footlight-capff-"));
    const dir = join(root, NASTY);
    mkdirSync(dir);

    const src = join(root, "src.mp4");
    execFileSync("ffmpeg", [
      ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
      ...["-i", "testsrc=size=1920x1080:rate=30:duration=1", "-frames:v", "10", src],
    ]);

    const row: ClipRow = {
      source_file: src,
      in_point: "0",
      out_point: "0.2",
      crop_offset: "center",
      hook: "Hello",
    };
    const assPath = join(dir, "cap.ass");
    const renderOpts = { ...DEFAULT_RENDER_OPTIONS, burnCaptions: true };
    writeFileSync(assPath, buildCaptionAss(row, renderOpts)!, "utf8");

    const font = anySystemFont();
    let captionFontFile: string | undefined;
    if (font) {
      captionFontFile = join(dir, "font.ttf");
      copyFileSync(font, captionFontFile);
    }

    const { args, outPath } = buildFfmpegArgs(row, {
      ...renderOpts,
      dims: [1920, 1080],
      outdir: join(root, "out"),
      captionAssPath: assPath,
      ...(captionFontFile ? { captionFontFile } : {}),
    });
    mkdirSync(join(root, "out"));

    // Throws (with ffmpeg's stderr) if the filtergraph can't be parsed or the
    // caption file / fonts dir can't be opened.
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(existsSync(outPath)).toBe(true);
  }, 30_000);
});
