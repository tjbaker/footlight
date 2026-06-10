// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEasedCropX, TARGET_AR, type CropPathKeyframe } from "../src/core.js";
import type { Dims } from "../src/manifest.js";
import {
  planSampleTimes,
  refineByMotion,
  OneEuroFilter,
  boxCenterToCropX,
  samplesToCropPath,
  trackToCropPath,
} from "../src/track.js";
import type { TrackSample } from "../src/providers/types.js";
import { MockTracker } from "../src/providers/mock.js";
import { GeminiTracker } from "../src/providers/gemini.js";

const REGION: Dims = { width: 1920, height: 1080 };
function even(n: number): number {
  const i = Math.round(n);
  return i - (i % 2);
}
const CW = even(REGION.height * TARGET_AR); // 608
const MAX_X = REGION.width - CW; // 1312

describe("planSampleTimes", () => {
  it("includes both endpoints and spaces by interval", () => {
    const ts = planSampleTimes({ shotStart: 0, shotEnd: 10, intervalSec: 2 });
    expect(ts[0]).toBe(0);
    expect(ts[ts.length - 1]).toBe(10);
    expect(ts).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("includes endpoints even when interval does not divide the span", () => {
    const ts = planSampleTimes({ shotStart: 0, shotEnd: 5, intervalSec: 2 });
    // 0,2,4 interior + 5 endpoint
    expect(ts).toEqual([0, 2, 4, 5]);
  });

  it("forces a cut-anchored sample just after each in-range scene cut", () => {
    const ts = planSampleTimes({
      shotStart: 0,
      shotEnd: 10,
      intervalSec: 5,
      sceneCuts: [3, 12], // 12 is out of range and ignored
      cutEpsilon: 0.05,
    });
    expect(ts).toContain(3.05);
    // out-of-range cut not present
    expect(ts.some((t) => t > 11)).toBe(false);
    // still sorted + deduped
    const sorted = [...ts].sort((a, b) => a - b);
    expect(ts).toEqual(sorted);
  });

  it("dedups coincident times", () => {
    const ts = planSampleTimes({
      shotStart: 0,
      shotEnd: 4,
      intervalSec: 2,
      sceneCuts: [2 - 0.05], // cut+eps == 2, collides with interior sample
    });
    const counts = new Map<number, number>();
    for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const c of counts.values()) expect(c).toBe(1);
  });

  it("throws on non-positive span or interval", () => {
    expect(() => planSampleTimes({ shotStart: 5, shotEnd: 5, intervalSec: 1 })).toThrow();
    expect(() => planSampleTimes({ shotStart: 0, shotEnd: 5, intervalSec: 0 })).toThrow();
  });
});

describe("refineByMotion", () => {
  const mk = (t: number, cx: number): TrackSample => ({
    t,
    box: { x: cx - 50, y: 0, w: 100, h: 100 },
  });

  it("adds a midpoint where motion exceeds the threshold", () => {
    const samples = [mk(0, 100), mk(2, 400)]; // moved 300px
    const extra = refineByMotion(samples, { motionThresholdPx: 80, minGapSec: 0.5 });
    expect(extra).toEqual([1]);
  });

  it("adds nothing when motion is below threshold", () => {
    const samples = [mk(0, 100), mk(2, 120)]; // moved 20px
    const extra = refineByMotion(samples, { motionThresholdPx: 80, minGapSec: 0.5 });
    expect(extra).toEqual([]);
  });

  it("respects minGapSec: never splits a gap below 2*minGap", () => {
    const samples = [mk(0, 100), mk(0.6, 900)]; // big move but gap 0.6 < 2*0.5
    const extra = refineByMotion(samples, { motionThresholdPx: 80, minGapSec: 0.5 });
    expect(extra).toEqual([]);
  });
});

describe("OneEuroFilter", () => {
  it("reduces successive-diff variance vs the raw jittered signal", () => {
    const filter = new OneEuroFilter({ minCutoff: 0.5, beta: 0.0 });
    const raw: number[] = [];
    const smoothed: number[] = [];
    // Linear trend + alternating jitter, sampled at 30fps.
    for (let i = 0; i < 90; i++) {
      const t = i / 30;
      const value = 100 + 10 * i + (i % 2 === 0 ? 25 : -25);
      raw.push(value);
      smoothed.push(filter.filter(value, t));
    }
    const variance = (xs: number[]) => {
      const diffs: number[] = [];
      for (let i = 1; i < xs.length; i++) diffs.push(xs[i]! - xs[i - 1]!);
      const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      return diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length;
    };
    expect(variance(smoothed)).toBeLessThan(variance(raw));
  });

  it("tracks the underlying trend (ends near the true line)", () => {
    const filter = new OneEuroFilter({ minCutoff: 1.0, beta: 0.01 });
    let last = 0;
    for (let i = 0; i < 120; i++) {
      const t = i / 30;
      const trueVal = 100 + 8 * i;
      const value = trueVal + (i % 2 === 0 ? 15 : -15);
      last = filter.filter(value, t);
    }
    const trueEnd = 100 + 8 * 119;
    // Within a small fraction of the full sweep.
    expect(Math.abs(last - trueEnd)).toBeLessThan(60);
  });

  it("handles irregular timestamps without throwing or NaN", () => {
    const filter = new OneEuroFilter();
    const times = [0, 0.1, 0.13, 0.9, 0.9, 1.5];
    for (const t of times) {
      const out = filter.filter(t * 100, t);
      expect(Number.isFinite(out)).toBe(true);
    }
  });
});

describe("boxCenterToCropX", () => {
  it("centers the crop window on the subject center", () => {
    // Subject centered at region center -> crop x = (W - cw)/2.
    const box = { x: REGION.width / 2 - 50, y: 0, w: 100, h: 100 };
    expect(boxCenterToCropX(box, REGION)).toBe(Math.round(MAX_X / 2));
  });

  it("clamps at the left edge", () => {
    const box = { x: 0, y: 0, w: 20, h: 100 }; // center near 10px
    expect(boxCenterToCropX(box, REGION)).toBe(0);
  });

  it("clamps at the right edge", () => {
    const box = { x: REGION.width - 20, y: 0, w: 20, h: 100 };
    expect(boxCenterToCropX(box, REGION)).toBe(MAX_X);
  });
});

describe("samplesToCropPath", () => {
  it("returns [] when no boxes survive", () => {
    expect(samplesToCropPath([], REGION)).toEqual([]);
  });

  it("anchors the first keyframe and produces sorted t", () => {
    const samples: TrackSample[] = [
      { t: 2, box: { x: 800, y: 0, w: 100, h: 100 } },
      { t: 0, box: { x: 100, y: 0, w: 100, h: 100 } },
    ];
    const path = samplesToCropPath(samples, REGION, { deadzonePx: 0, maxVelPxPerSec: 1e9 });
    expect(path.map((k) => k.t)).toEqual([0, 2]);
  });

  it("velocity limit caps the per-keyframe jump", () => {
    // Teleport from left to right in 1s; cap at 100 px/s -> only +100 allowed.
    const samples: TrackSample[] = [
      { t: 0, box: { x: 0, y: 0, w: 10, h: 10 } },
      { t: 1, box: { x: REGION.width - 10, y: 0, w: 10, h: 10 } },
    ];
    const path = samplesToCropPath(samples, REGION, {
      deadzonePx: 0,
      maxVelPxPerSec: 100,
      smoothing: { minCutoff: 100, beta: 0 }, // effectively pass-through
    });
    expect(path[1]!.x - path[0]!.x).toBeLessThanOrEqual(100);
  });

  it("deadzone holds x for sub-threshold wiggle", () => {
    const samples: TrackSample[] = [
      { t: 0, box: { x: 900, y: 0, w: 100, h: 100 } },
      { t: 1, box: { x: 905, y: 0, w: 100, h: 100 } }, // tiny move
    ];
    const path = samplesToCropPath(samples, REGION, {
      deadzonePx: 50,
      maxVelPxPerSec: 1e9,
      smoothing: { minCutoff: 100, beta: 0 },
    });
    expect(path[1]!.x).toBe(path[0]!.x);
  });
});

describe("end-to-end: MockTracker -> path -> eased expr -> ffmpeg", () => {
  it("plan -> mock -> samplesToCropPath yields a smooth, monotonic-ish path", async () => {
    const tracker = new MockTracker({ region: REGION, shotStart: 0, shotEnd: 3 });
    const path = await trackToCropPath(tracker, {
      sourcePath: "mock.mp4",
      region: REGION,
      shotStart: 0,
      shotEnd: 3,
      intervalSec: 0.25,
      apiKey: "unused-by-mock",
      subjectHint: "the performer",
    });

    expect(path.length).toBeGreaterThan(3);

    // No single step jumps wildly (smoothing + velocity limit keep steps small).
    let maxStep = 0;
    for (let i = 1; i < path.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(path[i]!.x - path[i - 1]!.x));
    }
    expect(maxStep).toBeLessThan(200);

    // Overall trend is left -> right (subject sweeps that way in the mock).
    expect(path[path.length - 1]!.x).toBeGreaterThan(path[0]!.x);

    // Mostly non-decreasing despite jitter (smoothing tames the wiggle):
    // count decreasing steps, expect them to be a small minority.
    let decreasing = 0;
    for (let i = 1; i < path.length; i++) {
      if (path[i]!.x < path[i - 1]!.x - 1) decreasing++;
    }
    expect(decreasing).toBeLessThan(path.length / 3);

    // x stays in valid crop range.
    for (const k of path) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x).toBeLessThanOrEqual(MAX_X);
    }
  });

  it("feeds the path to buildEasedCropX and ffmpeg renders 1080x1920", async () => {
    const tracker = new MockTracker({ region: REGION, shotStart: 0, shotEnd: 3 });
    const path: CropPathKeyframe[] = await trackToCropPath(tracker, {
      sourcePath: "mock.mp4",
      region: REGION,
      shotStart: 0,
      shotEnd: 3,
      intervalSec: 0.25,
      apiKey: "unused-by-mock",
    });

    const expr = buildEasedCropX(path);
    expect(expr.length).toBeGreaterThan(0);
    // A multi-keyframe path uses the eased smoothstep form.
    expect(expr).toContain("clip(");
    expect(expr).toContain("3-2*");

    const dir = mkdtempSync(join(tmpdir(), "footlight-track-"));
    const out = join(dir, "track.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1920x1080:duration=3",
        "-vf",
        `crop=${CW}:1080:x='${expr}':y=0,scale=1080:1920`,
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
    // runner (same allowance as croppath.test.ts's render check).
  }, 30_000);
});

describe("GeminiTracker.boxFromGemini (no network)", () => {
  it("maps normalized [ymin,xmin,ymax,xmax] (0..1000) to region pixels", () => {
    // Centered half-size box: x 250..750, y 250..750 of 0..1000.
    const box = GeminiTracker.boxFromGemini([250, 250, 750, 750], REGION);
    expect(box.x).toBeCloseTo(REGION.width * 0.25, 5);
    expect(box.w).toBeCloseTo(REGION.width * 0.5, 5);
    expect(box.y).toBeCloseTo(REGION.height * 0.25, 5);
    expect(box.h).toBeCloseTo(REGION.height * 0.5, 5);
  });

  it("clamps out-of-range coords and normalizes swapped corners", () => {
    const box = GeminiTracker.boxFromGemini([1200, 900, -50, 100], REGION);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.w).toBeGreaterThanOrEqual(0);
    expect(box.h).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(REGION.width + 1e-6);
    expect(box.y + box.h).toBeLessThanOrEqual(REGION.height + 1e-6);
  });
});
