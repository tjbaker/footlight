// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildEasedCropX,
  buildFfmpegArgs,
  computeCrop,
  type CropPathKeyframe,
  type ClipRow,
  type BuildOptions,
} from "../src/engine.js";

const DEFAULTS = { crf: 19, preset: "medium", audioBitrate: "copy", outdir: "clips" };

function build(row: ClipRow, dims: [number, number], overrides: Partial<BuildOptions> = {}) {
  return buildFfmpegArgs(row, { ...DEFAULTS, dims, ...overrides });
}

function vfOf(args: string[]): string {
  const i = args.indexOf("-vf");
  return args[i + 1]!;
}

/**
 * Reference smoothstep evaluation of a keyframe path in plain JS — the same
 * math the ffmpeg expression encodes — used to check interpolated values.
 */
function evalEased(kfs: CropPathKeyframe[], t: number): number {
  const k = [...kfs].sort((a, b) => a.t - b.t);
  if (t <= k[0]!.t) return k[0]!.x;
  if (t >= k[k.length - 1]!.t) return k[k.length - 1]!.x;
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i]!;
    const b = k[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const p = (t - a.t) / (b.t - a.t);
      const s = p * p * (3 - 2 * p);
      return a.x + (b.x - a.x) * s;
    }
  }
  return k[k.length - 1]!.x;
}

describe("buildEasedCropX", () => {
  it("single keyframe -> constant x", () => {
    expect(buildEasedCropX([{ t: 0, x: 600 }])).toBe("600");
  });

  it("throws on empty keyframes", () => {
    expect(() => buildEasedCropX([])).toThrow();
  });

  it("two keyframes -> smoothstep expression with correct endpoints", () => {
    const expr = buildEasedCropX([
      { t: 0, x: 0 },
      { t: 3, x: 1312 },
    ]);
    // Contains the smoothstep term (3 - 2*p) and a clamped p over t.
    expect(expr).toContain("3-2*");
    expect(expr).toContain("clip(");
    // Endpoints / delta present.
    expect(expr).toContain("1312");
    expect(expr).toContain("(t-0)/3");
  });

  it("sorts keyframes by t", () => {
    const a = buildEasedCropX([
      { t: 3, x: 1312 },
      { t: 0, x: 0 },
    ]);
    const b = buildEasedCropX([
      { t: 0, x: 0 },
      { t: 3, x: 1312 },
    ]);
    expect(a).toBe(b);
  });

  it("three keyframes -> nested if() with the middle boundary", () => {
    const expr = buildEasedCropX([
      { t: 0, x: 100 },
      { t: 2, x: 800 },
      { t: 5, x: 300 },
    ]);
    expect(expr.startsWith("if(lt(t,2)")).toBe(true);
  });

  it("evalEased reference holds endpoints and eases the midpoint", () => {
    const kfs: CropPathKeyframe[] = [
      { t: 0, x: 0 },
      { t: 3, x: 1312 },
    ];
    // Hold before first / after last.
    expect(evalEased(kfs, -1)).toBe(0);
    expect(evalEased(kfs, 10)).toBe(1312);
    // Midpoint of smoothstep is exactly halfway (s(0.5) = 0.5).
    expect(evalEased(kfs, 1.5)).toBeCloseTo(656, 6);
    // Quarter point eases below linear (s(0.25) = 0.15625).
    expect(evalEased(kfs, 0.75)).toBeCloseTo(1312 * 0.15625, 6);
  });
});

describe("buildFfmpegArgs with cropPath", () => {
  it("emits eased crop x; W/H/y match computeCrop for the region", () => {
    const region = computeCrop(1920, 1080, "center");
    const { args } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "3", crop_offset: "center" },
      [1920, 1080],
      { cropPath: [{ t: 0, x: 0 }, { t: 3, x: 1312 }] },
    );
    const vf = vfOf(args);
    const expr = buildEasedCropX([{ t: 0, x: 0 }, { t: 3, x: 1312 }]);
    expect(vf).toBe(
      `crop=${region.cw}:${region.ch}:x='${expr}':y=${region.y},scale=1080:1920:flags=lanczos,setsar=1`,
    );
  });

  it("cropPath takes precedence over crop_offset schedule", () => {
    const { args } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "3", crop_offset: "0=center; 1.5=440" },
      [1920, 1080],
      { cropPath: [{ t: 0, x: 100 }, { t: 3, x: 900 }] },
    );
    const vf = vfOf(args);
    // No hard-switch schedule artifacts; uses the eased expression.
    expect(vf).not.toContain("if(lt(t,1.500)");
    expect(vf).toContain("clip(");
  });

  it("content_crop still prepends before the eased crop", () => {
    const { args } = build(
      {
        source_file: "clem.mp4",
        in_point: "0",
        out_point: "3",
        crop_offset: "center",
        content_crop: "1800:1010:60:34",
      },
      [1, 1],
      { cropPath: [{ t: 0, x: 0 }, { t: 3, x: 600 }] },
    );
    const region = computeCrop(1800, 1010, "center");
    const expr = buildEasedCropX([{ t: 0, x: 0 }, { t: 3, x: 600 }]);
    expect(vfOf(args)).toBe(
      `crop=1800:1010:60:34,crop=${region.cw}:${region.ch}:x='${expr}':y=${region.y},scale=1080:1920:flags=lanczos,setsar=1`,
    );
  });

  it("empty cropPath falls back to crop_offset", () => {
    const { args } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "3", crop_offset: "center" },
      [1920, 1080],
      { cropPath: [] },
    );
    expect(vfOf(args)).toBe("crop=608:1080:656:0,scale=1080:1920:flags=lanczos,setsar=1");
  });
});

describe("eased expression is valid ffmpeg (real render)", () => {
  it("ffmpeg parses and renders a 1080x1920 file from the eased x expr", () => {
    const expr = buildEasedCropX([
      { t: 0, x: 0 },
      { t: 3, x: 1312 },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "footlight-eased-"));
    const out = join(dir, "eased.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1920x1080:duration=1",
        "-vf",
        `crop=608:1080:x='${expr}':y=0,scale=1080:1920`,
        "-y",
        out,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    expect(existsSync(out)).toBe(true);
    const probe = execFileSync(
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
        out,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(probe).toBe("1080,1920");
    // Real ffmpeg encode: the 5s vitest default is too tight on a loaded CI
    // runner (intermittent timeouts), so give this one a generous budget.
  }, 30_000);
});
