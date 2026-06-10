// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the animated punch-in (issue #163): `buildEasedCropWindowFilters`
 * (the eased per-frame upscale + fixed output-size crop that works around
 * ffmpeg's configure-time crop w/h), its sanitization, the render precedence
 * in `buildFfmpegArgs`, the `easedCropWindowAt` single-instant evaluator, and
 * a REAL-ffmpeg verification: the animated render's first/last frames must
 * match static punch-in renders of the start/end windows (PSNR), while the
 * midpoint matches neither — proving the window actually animates.
 */

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildEasedCropWindowFilters,
  easedCropWindowAt,
  buildFfmpegArgs,
  TARGET_W,
  TARGET_H,
  type ClipRow,
  type CropWindowKeyframe,
} from "../src/engine.js";

const START: CropWindowKeyframe = { t: 0, x: 656, y: 0, w: 608, h: 1080 };
const END: CropWindowKeyframe = { t: 1.5, x: 808, y: 270, w: 304, h: 540 };

const ROW: ClipRow = {
  source_file: "in.mp4",
  in_point: "0",
  out_point: "2",
  crop_offset: "left",
};

function vfOf(args: string[]): string {
  return args[args.indexOf("-vf") + 1]!;
}

describe("buildEasedCropWindowFilters", () => {
  it("emits pre-crop → per-frame eased scale → fixed output-size crop", () => {
    const f = buildEasedCropWindowFilters([START, END], 1920, 1080);
    expect(f).toHaveLength(3);
    // Bounding box of both windows: x 656..1264 (start's right edge wins),
    // y 0..1080 → 608×1080 @ (656,0).
    expect(f[0]).toBe("crop=608:1080:656:0");
    expect(f[1]).toContain("scale=w='trunc(");
    expect(f[1]).toContain(":eval=frame:flags=lanczos");
    expect(f[2]).toMatch(new RegExp(`^crop=${TARGET_W}:${TARGET_H}:x='`));
    // The eased expressions clamp against the live canvas so even-truncation
    // can never push the fixed window out of frame.
    expect(f[2]).toContain(`)-${TARGET_W})`);
    expect(f[2]).toContain(`)-${TARGET_H})`);
  });

  it("skips the pre-crop when a keyframe window spans the whole region", () => {
    const full: CropWindowKeyframe = { t: 0, x: 0, y: 0, w: 1920, h: 1080 };
    const f = buildEasedCropWindowFilters([full, END], 1920, 1080);
    expect(f).toHaveLength(2);
    expect(f[0]).toContain("eval=frame");
  });

  it("even-rounds w/h and clamps x/y like the static cropWindow", () => {
    // 405→404 wide; x 9999 clamps to 1920−404=1516 (already even).
    const f = buildEasedCropWindowFilters([{ t: 0, x: 9999, y: -50, w: 405, h: 720 }], 1920, 1080);
    expect(f[0]).toBe("crop=404:720:1516:0");
  });

  it("throws on empty input, non-positive windows, and region-exceeding windows", () => {
    expect(() => buildEasedCropWindowFilters([], 1920, 1080)).toThrow(/at least one/);
    expect(() =>
      buildEasedCropWindowFilters([{ t: 0, x: 0, y: 0, w: 1, h: 0 }], 1920, 1080),
    ).toThrow(/positive w\/h/);
    expect(() =>
      buildEasedCropWindowFilters([{ t: 0, x: 0, y: 0, w: 404, h: 2000 }], 1920, 1080),
    ).toThrow(/exceeds working region/);
  });
});

describe("easedCropWindowAt", () => {
  it("eases all four channels with the same smoothstep (midpoint = halfway)", () => {
    const mid = easedCropWindowAt([START, END], 0.75); // temporal midpoint → s=0.5
    expect(mid.x).toBeCloseTo((656 + 808) / 2, 10);
    expect(mid.y).toBeCloseTo((0 + 270) / 2, 10);
    expect(mid.w).toBeCloseTo((608 + 304) / 2, 10);
    expect(mid.h).toBeCloseTo((1080 + 540) / 2, 10);
  });

  it("holds the first/last windows outside the path's range", () => {
    expect(easedCropWindowAt([START, END], -5)).toEqual({ x: 656, y: 0, w: 608, h: 1080 });
    expect(easedCropWindowAt([START, END], 99)).toEqual({ x: 808, y: 270, w: 304, h: 540 });
  });
});

describe("buildFfmpegArgs with a cropWindowPath", () => {
  it("takes precedence over cropPath, cropWindow, and the offset schedule", () => {
    const { args } = buildFfmpegArgs(
      { ...ROW, crop_offset: "0=left; 1=right" },
      {
        crf: 19,
        preset: "medium",
        audioBitrate: "copy",
        outdir: "out",
        dims: [1920, 1080],
        cropWindowPath: [START, END],
        cropPath: [{ t: 0, x: 100 }],
        cropWindow: { x: 0, y: 0, w: 608, h: 1080 },
      },
    );
    const vf = vfOf(args);
    expect(vf).toContain("eval=frame");
    expect(vf).toContain(`crop=${TARGET_W}:${TARGET_H}:x='`);
    // The usual static scale stage is replaced (the eased path lands at the
    // output size directly) and the other framing forms are ignored.
    expect(vf).not.toContain(`scale=${TARGET_W}:${TARGET_H}:flags=lanczos`);
    expect(vf).not.toContain("crop=608:1080:x="); // no eased-x / schedule crop
    expect(vf.endsWith("setsar=1")).toBe(true);
  });

  it("applies the content_crop working region before the animated stages", () => {
    const { args } = buildFfmpegArgs(
      { ...ROW, content_crop: "1440:1080:240:0" },
      {
        crf: 19,
        preset: "medium",
        audioBitrate: "copy",
        outdir: "out",
        dims: [1920, 1080],
        cropWindowPath: [
          { t: 0, x: 0, y: 0, w: 1440, h: 1080 },
          { ...END, x: 700 },
        ],
      },
    );
    const vf = vfOf(args);
    expect(vf.startsWith("crop=1440:1080:240:0,")).toBe(true);
  });
});

describe("animated punch-in renders correctly (REAL ffmpeg)", () => {
  // The empirical core of #163: render a 2s synthetic source through
  // buildFfmpegArgs with a START→END push, then compare frames against static
  // punch-in renders of each endpoint. PSNR > 30 dB at the matching endpoint
  // (residual difference is scale-order only), and the midpoint must be FAR
  // from both — the window really moves. Skipped never: ffmpeg is a hard test
  // dependency in this repo (see croppath.test.ts).
  const dir = mkdtempSync(join(tmpdir(), "footlight-push-"));
  const src = join(dir, "src.mp4");

  function ff(args: string[]): string {
    const out = execFileSync("ffmpeg", ["-hide_banner", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out;
  }

  function psnrAt(a: string, b: string, frame: number): number {
    // The psnr summary lands on stderr even on success, so spawnSync (which
    // captures stderr regardless of exit code) rather than execFileSync.
    const r = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-i",
        a,
        "-i",
        b,
        "-filter_complex",
        `[0:v]select='eq(n,${frame})'[a];[1:v]select='eq(n,${frame})'[b];[a][b]psnr`,
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8" },
    );
    const m = /average:([0-9.]+|inf)/.exec(r.stderr ?? "");
    expect(m, `psnr output missing: ${r.stderr}`).not.toBeNull();
    return m![1] === "inf" ? 99 : Number(m![1]);
  }

  it("matches the static endpoints and moves in between", () => {
    // 10 fps × 2 s = 20 frames; the push completes at t=1.5 (frame 15).
    ff([
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1920x1080:duration=2:rate=10",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "12",
      "-pix_fmt",
      "yuv420p",
      "-y",
      src,
    ]);

    const { args, outPath } = buildFfmpegArgs(
      { ...ROW, source_file: src, out_name: "anim.mp4" },
      {
        crf: 12,
        preset: "ultrafast",
        audioBitrate: "copy",
        outdir: dir,
        dims: [1920, 1080],
        cropWindowPath: [START, END],
      },
    );
    ff(args);
    expect(existsSync(outPath)).toBe(true);

    // Output dims are the standard 1080×1920.
    const dims = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        outPath,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(dims).toBe("1080,1920");

    // Static endpoint renders (the render's own punch-in path).
    const startOut = join(dir, "start.mp4");
    const endOut = join(dir, "end.mp4");
    ff([
      "-loglevel",
      "error",
      "-i",
      src,
      "-vf",
      `crop=${START.w}:${START.h}:${START.x}:${START.y},scale=1080:1920:flags=lanczos,setsar=1`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "12",
      "-pix_fmt",
      "yuv420p",
      "-y",
      startOut,
    ]);
    ff([
      "-loglevel",
      "error",
      "-i",
      src,
      "-vf",
      `crop=${END.w}:${END.h}:${END.x}:${END.y},scale=1080:1920:flags=lanczos,setsar=1`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "12",
      "-pix_fmt",
      "yuv420p",
      "-y",
      endOut,
    ]);

    const firstVsStart = psnrAt(outPath, startOut, 0);
    const lastVsEnd = psnrAt(outPath, endOut, 19);
    const midVsStart = psnrAt(outPath, startOut, 8);
    const midVsEnd = psnrAt(outPath, endOut, 8);

    // Endpoints match their static renders; the midpoint matches neither.
    expect(firstVsStart).toBeGreaterThan(30);
    expect(lastVsEnd).toBeGreaterThan(30);
    expect(midVsStart).toBeLessThan(25);
    expect(midVsEnd).toBeLessThan(25);
  }, 120_000);
});
