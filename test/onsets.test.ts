// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Onset detection (issue #164) — the pure half of the In/Out beat-snap feature:
 * `onsetEnvelope` (fine per-frame RMS over the 8 kHz mono PCM the loudness pass
 * already decodes) and `detectOnsets` (half-wave-rectified envelope difference +
 * adaptive threshold). Everything here is synthetic-signal based — data in,
 * data out, no files, no subprocess — mirroring the detectSwells test style.
 *
 * The fixtures marked "pinned" are HAND-MIRRORED by the native Rust backend's
 * tests (app/src-tauri/src/main.rs `onset_envelope_*`) — keep them in sync.
 */

import { describe, it, expect } from "vitest";

import {
  ONSET_FRAME_SEC,
  ONSET_MIN_GAP_SEC,
  onsetEnvelope,
  detectOnsets,
} from "../src/core.js";

/** Frames per second of the onset envelope (50 at the default 0.02s frame). */
const FPS = Math.round(1 / ONSET_FRAME_SEC);

/**
 * Synthetic 8 kHz mono PCM: a deterministic low "noise" floor with short loud
 * click bursts at the given times. No RNG — a fixed-amplitude alternating
 * floor keeps the test reproducible while still exercising non-zero quiet RMS.
 */
function clicksOnNoiseFloor(
  durationSec: number,
  clickTimes: number[],
  { floorAmp = 0.01, clickAmp = 0.8, clickLenSamples = 80, sampleRate = 8000 } = {},
): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = i % 2 === 0 ? floorAmp : -floorAmp;
  for (const t of clickTimes) {
    const start = Math.round(t * sampleRate);
    for (let i = start; i < Math.min(n, start + clickLenSamples); i++) {
      samples[i] = i % 2 === 0 ? clickAmp : -clickAmp;
    }
  }
  return samples;
}

describe("onsetEnvelope", () => {
  it("emits one RMS frame per ONSET_FRAME_SEC, dropping a trailing partial frame", () => {
    // 8000 Hz × 0.02 s = 160 samples/frame; 1.01 s → 50 full frames (+ partial).
    const samples = new Float32Array(Math.round(8000 * 1.01)).fill(0.5);
    expect(onsetEnvelope(samples)).toHaveLength(50);
  });

  it("max-normalizes to 0..1 with the loudest frame exactly 1", () => {
    const env = onsetEnvelope(clicksOnNoiseFloor(2, [1.0]));
    expect(Math.max(...env)).toBe(1);
    for (const v of env) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // The click frame (t=1.0 → frame 50) is the maximum.
    expect(env[50]).toBe(1);
  });

  it("returns [] for empty input and all-zeros for silence", () => {
    expect(onsetEnvelope(new Float32Array(0))).toEqual([]);
    expect(onsetEnvelope(new Float32Array(8000))).toEqual(new Array(50).fill(0));
  });

  // PINNED fixture — mirrored by the Rust test `onset_envelope_pinned_fixture`
  // in app/src-tauri/src/main.rs. sampleRate 200 → 4 samples/frame, so
  // [1,1,0,0] → RMS √0.5, [1,1,1,1] → RMS 1; normalized + 4-decimal rounding
  // → [0.7071, 1].
  it("pinned: per-frame RMS, normalized and rounded to 4 decimals (rate 200)", () => {
    const samples = new Float32Array([1, 1, 0, 0, 1, 1, 1, 1]);
    expect(onsetEnvelope(samples, 200)).toEqual([0.7071, 1]);
  });

  // PINNED fixture — mirrored by `onset_envelope_silence_and_partial` (Rust).
  it("pinned: silence stays zeros; a partial trailing frame is dropped (rate 200)", () => {
    expect(onsetEnvelope(new Float32Array([0, 0, 0, 0, 0, 0]), 200)).toEqual([0]);
  });
});

describe("detectOnsets", () => {
  it("finds clicks on a noise floor at the right times (end to end from PCM)", () => {
    const clicks = [1.0, 2.5, 4.0];
    const onsets = detectOnsets(onsetEnvelope(clicksOnNoiseFloor(5, clicks)));
    expect(onsets).toHaveLength(3);
    onsets.forEach((t, i) => {
      // Within ±2 frames of the actual hit (smoothing biases ≤1 frame early).
      expect(Math.abs(t - clicks[i]!)).toBeLessThanOrEqual(2 * ONSET_FRAME_SEC + 1e-9);
    });
    // Ascending order.
    for (let i = 1; i < onsets.length; i++) expect(onsets[i]!).toBeGreaterThan(onsets[i - 1]!);
  });

  it("finds a sustained note attack (a step, not just an impulse)", () => {
    // Quiet floor for 2s, then a sustained loud level: exactly one onset at ~2s.
    const env = new Array<number>(4 * FPS).fill(0.1);
    for (let i = 2 * FPS; i < env.length; i++) env[i] = 0.9;
    const onsets = detectOnsets(env);
    expect(onsets).toHaveLength(1);
    expect(Math.abs(onsets[0]! - 2)).toBeLessThanOrEqual(2 * ONSET_FRAME_SEC + 1e-9);
  });

  it("ignores a slow crescendo (the rise never beats the adaptive threshold)", () => {
    // A linear ramp 0→1 over 5s: per-frame rise ≈ 0.004, well under the floor.
    const n = 5 * FPS;
    const env = new Array<number>(n);
    for (let i = 0; i < n; i++) env[i] = i / (n - 1);
    expect(detectOnsets(env)).toEqual([]);
  });

  it("ignores silence and a flat envelope", () => {
    expect(detectOnsets(new Array<number>(5 * FPS).fill(0))).toEqual([]);
    expect(detectOnsets(new Array<number>(5 * FPS).fill(0.6))).toEqual([]);
  });

  it("never fires on decays — only energy rises count", () => {
    // Loud start that steps DOWN at 1s and decays after: no onsets at all
    // (d[0] is pinned to 0, so a loud first frame is not an onset either).
    const env = new Array<number>(3 * FPS).fill(0.9);
    for (let i = 1 * FPS; i < env.length; i++) env[i] = 0.9 * Math.exp(-(i - FPS) / FPS);
    expect(detectOnsets(env)).toEqual([]);
  });

  it("merges hits closer than ONSET_MIN_GAP_SEC (keeps the earlier one)", () => {
    // Two clicks 60ms apart (< the 100ms gap) → one onset; the pair 500ms later
    // is far enough to count separately.
    const onsets = detectOnsets(onsetEnvelope(clicksOnNoiseFloor(3, [1.0, 1.06, 1.6])));
    expect(onsets).toHaveLength(2);
    expect(Math.abs(onsets[0]! - 1.0)).toBeLessThanOrEqual(2 * ONSET_FRAME_SEC + 1e-9);
    expect(Math.abs(onsets[1]! - 1.6)).toBeLessThanOrEqual(2 * ONSET_FRAME_SEC + 1e-9);
    expect(onsets[1]! - onsets[0]!).toBeGreaterThanOrEqual(ONSET_MIN_GAP_SEC);
  });

  it("returns [] for degenerate inputs", () => {
    expect(detectOnsets([])).toEqual([]);
    expect(detectOnsets([0.5, 0.9])).toEqual([]);
    expect(detectOnsets([0.1, 0.9, 0.9], 0)).toEqual([]);
  });

  it("reports times in ms-rounded seconds on the frame grid", () => {
    const onsets = detectOnsets(onsetEnvelope(clicksOnNoiseFloor(2, [1.0])));
    expect(onsets).toHaveLength(1);
    expect(onsets[0]).toBe(Number(onsets[0]!.toFixed(3)));
  });
});
