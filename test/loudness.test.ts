// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  LOUDNESS_BUCKETS,
  LUFS_FLOOR,
  LUFS_CEIL,
  loudnessArgs,
  bucketLoudness,
  loudnessEbur128Args,
  loudnessCombinedArgs,
  parseEbur128Momentary,
  lufsToNormalized,
  bucketLufs,
  detectSwells,
} from "../src/core.js";

describe("loudnessArgs", () => {
  it("decodes mono f32le PCM at 8kHz to stdout", () => {
    const a = loudnessArgs("in.mp4");
    expect(a).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "in.mp4",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "f32le",
      "-",
    ]);
  });
});

describe("bucketLoudness", () => {
  it("returns exactly `buckets` values", () => {
    const samples = new Float32Array(1000).map((_, i) => Math.sin(i));
    expect(bucketLoudness(samples, 50)).toHaveLength(50);
    expect(bucketLoudness(samples, LOUDNESS_BUCKETS)).toHaveLength(LOUDNESS_BUCKETS);
  });

  it("normalizes so the max value is exactly 1 (a rising ramp)", () => {
    // A ramp 0..1: later windows have higher RMS, so the LAST bucket is the max.
    const n = 8000;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = i / n;
    const out = bucketLoudness(samples, 80);
    const max = Math.max(...out);
    expect(max).toBeCloseTo(1, 10);
    // Monotonic non-decreasing for a ramp (RMS rises with the window's values).
    for (let b = 1; b < out.length; b++) {
      expect(out[b]!).toBeGreaterThanOrEqual(out[b - 1]! - 1e-9);
    }
    // Last bucket is the loud end, first is the quiet end.
    expect(out[out.length - 1]).toBeCloseTo(1, 10);
    expect(out[0]!).toBeLessThan(out[out.length - 1]!);
  });

  it("returns all zeros for empty input or all-silence", () => {
    expect(bucketLoudness(new Float32Array(0), 10)).toEqual(new Array(10).fill(0));
    expect(bucketLoudness(new Float32Array(500), 10)).toEqual(new Array(10).fill(0));
  });

  it("keeps every normalized value within 0..1", () => {
    const n = 4000;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin(i / 3) * (i / n);
    const out = bucketLoudness(samples, 64);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("loudnessEbur128Args", () => {
  it("runs ebur128 momentary metadata at verbose level, discarding A/V", () => {
    const a = loudnessEbur128Args("in.mp4");
    expect(a).toEqual([
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "verbose",
      "-i",
      "in.mp4",
      "-af",
      "ebur128=metadata=1",
      "-f",
      "null",
      "-",
    ]);
  });
});

describe("loudnessCombinedArgs", () => {
  it("emits mono f32le PCM on stdout while ebur128 logs LUFS (one pass)", () => {
    const a = loudnessCombinedArgs("in.mp4");
    expect(a).toEqual([
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "verbose",
      "-i",
      "in.mp4",
      "-af",
      "ebur128=metadata=1",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "f32le",
      "-",
    ]);
  });
});

describe("parseEbur128Momentary", () => {
  // ffmpeg prints momentary loudness as `M:-22.4` (no space) at verbose level.
  const log = [
    "[Parsed_ebur128_0 @ 0x1] t: 0.0999  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS",
    "[Parsed_ebur128_0 @ 0x1] t: 0.1999  TARGET:-23 LUFS    M: -22.4 S:-30.1      I: -25.0 LUFS",
    "[Parsed_ebur128_0 @ 0x1] t: 0.2999  TARGET:-23 LUFS    M:-9.5 S:-12.0        I: -18.0 LUFS",
    "some unrelated verbose line without the field",
  ].join("\n");

  it("extracts every M: value in order, handling the no-space format", () => {
    expect(parseEbur128Momentary(log)).toEqual([-120.7, -22.4, -9.5]);
  });

  it("maps -inf / nan readings to -Infinity (silence / startup)", () => {
    const out = parseEbur128Momentary("M:-inf x\nM:nan y\nM:-12.0 z");
    expect(out[0]).toBe(Number.NEGATIVE_INFINITY);
    expect(out[1]).toBe(Number.NEGATIVE_INFINITY);
    expect(out[2]).toBe(-12.0);
  });

  it("returns [] when there are no M: lines", () => {
    expect(parseEbur128Momentary("no fields here\nSummary:\n  I: -16 LUFS")).toEqual([]);
  });
});

describe("lufsToNormalized", () => {
  it("maps the floor to 0 and the ceiling to 1", () => {
    expect(lufsToNormalized(LUFS_FLOOR)).toBe(0);
    expect(lufsToNormalized(LUFS_CEIL)).toBe(1);
  });

  it("maps the midpoint to ~0.5 and clamps out-of-range", () => {
    expect(lufsToNormalized((LUFS_FLOOR + LUFS_CEIL) / 2)).toBeCloseTo(0.5, 10);
    expect(lufsToNormalized(0)).toBe(1); // above ceiling
    expect(lufsToNormalized(-100)).toBe(0); // below floor
  });

  it("treats non-finite readings as silence (0)", () => {
    expect(lufsToNormalized(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(lufsToNormalized(NaN)).toBe(0);
  });
});

describe("bucketLufs", () => {
  it("returns exactly `buckets` values, averaging normalized levels", () => {
    // Two windows: first all at the ceiling (→1), second all at the floor (→0).
    const lufs = [LUFS_CEIL, LUFS_CEIL, LUFS_FLOOR, LUFS_FLOOR];
    expect(bucketLufs(lufs, 2)).toEqual([1, 0]);
    expect(bucketLufs(lufs, LOUDNESS_BUCKETS)).toHaveLength(LOUDNESS_BUCKETS);
  });

  it("skips non-finite readings; an all-silence window is 0", () => {
    const lufs = [
      Number.NEGATIVE_INFINITY,
      LUFS_CEIL,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    // window 0 = [-inf, ceil] → only the ceiling counts → 1; window 1 = all -inf → 0.
    expect(bucketLufs(lufs, 2)).toEqual([1, 0]);
  });

  it("is an absolute scale — quiet material never reaches 1", () => {
    const quiet = new Array<number>(20).fill(-25); // mid-low LUFS throughout
    const out = bucketLufs(quiet, 4);
    for (const v of out) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("returns zeros for empty input and [] for non-positive buckets", () => {
    expect(bucketLufs([], 5)).toEqual(new Array(5).fill(0));
    expect(bucketLufs([-10, -20], 0)).toEqual([]);
  });
});

describe("detectSwells", () => {
  // Build a synthetic normalized envelope of `n` buckets with quiet→loud swells
  // at the given bucket centers: low floor (0.1) rising to a high plateau (0.9)
  // over a short ramp, then decaying back down to the floor.
  function envelopeWithSwells(n: number, riseCenters: number[]): number[] {
    const env = new Array<number>(n).fill(0.1);
    for (const c of riseCenters) {
      const rampStart = c - 3;
      // Rise from floor to high across ~3 buckets ending at the center.
      for (let k = 0; k < 6; k++) {
        const idx = rampStart + k;
        if (idx < 0 || idx >= n) continue;
        const v = 0.1 + (0.8 * k) / 5; // 0.1 -> 0.9
        env[idx] = Math.max(env[idx]!, v);
      }
      // Hold a loud plateau for a few buckets after the rise.
      for (let k = 0; k < 4; k++) {
        const idx = c + 3 + k;
        if (idx < 0 || idx >= n) continue;
        env[idx] = 0.9;
      }
      // Decay back to the floor so the next run can start from quiet again.
      for (let k = 0; k < 4; k++) {
        const idx = c + 7 + k;
        if (idx < 0 || idx >= n) continue;
        env[idx] = 0.9 - (0.8 * (k + 1)) / 4;
      }
    }
    return env;
  }

  it("finds exactly two swells at roughly the right times", () => {
    const n = 100;
    const durationSec = 100; // 1 bucket ≈ 1s
    // Two well-separated rises centered at bucket 20 and bucket 70.
    const env = envelopeWithSwells(n, [20, 70]);
    const swells = detectSwells(env, durationSec);
    expect(swells).toHaveLength(2);
    // Each marker should land near its rise (within a couple of buckets ≈ seconds).
    expect(swells[0]!.t).toBeGreaterThan(14);
    expect(swells[0]!.t).toBeLessThan(24);
    expect(swells[1]!.t).toBeGreaterThan(64);
    expect(swells[1]!.t).toBeLessThan(74);
    for (const s of swells) expect(s.label).toBe("quiet → loud");
  });

  it("finds a relative swell in loud, compressed live-music audio", () => {
    // Live-performance envelope: choppy but LOUD throughout (alternating
    // 0.85/0.95 — never near silence), with one genuine macro-dip to ~0.45
    // around bucket 45 that then builds back up to a peak near 1.0. The OLD
    // absolute-threshold detector (needs <0.35→>0.7) missed this entirely; the
    // relative detector should flag the build and ignore the shallow choppiness.
    const n = 100;
    const env = new Array<number>(n);
    for (let i = 0; i < n; i++) env[i] = i % 2 === 0 ? 0.85 : 0.95;
    for (let k = 0; k <= 8; k++) env[40 + k] = 0.85 - (0.4 * k) / 8; // 0.85 → 0.45 dip
    for (let k = 1; k <= 8; k++) env[48 + k] = 0.45 + (0.55 * k) / 8; // 0.45 → 1.0 build
    const swells = detectSwells(env, 100);
    // Exactly the one real build — the 0.1-amplitude choppiness stays under the
    // absolute rise floor and is not flagged.
    expect(swells).toHaveLength(1);
    expect(swells[0]!.t).toBeGreaterThan(40);
    expect(swells[0]!.t).toBeLessThan(58);
  });

  it("finds no swells in a flat envelope", () => {
    const flat = new Array<number>(100).fill(0.4);
    expect(detectSwells(flat, 100)).toHaveLength(0);
  });

  it("finds no swells in pure silence", () => {
    expect(detectSwells(new Array<number>(80).fill(0), 60)).toHaveLength(0);
  });

  it("returns [] for degenerate inputs", () => {
    expect(detectSwells([], 10)).toEqual([]);
    expect(detectSwells([0.5], 10)).toEqual([]);
    expect(detectSwells(envelopeWithSwells(100, [20]), 0)).toEqual([]);
  });
});
