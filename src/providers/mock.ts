// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic mock vision tracker (SPEC §6.9 tests).
 *
 * No network, no files: the "subject" glides left -> right across the working
 * region over the shot, with a small high-frequency jitter layered on top so
 * tests exercise the one-euro smoothing / deadzone / velocity limit and the
 * smoothstep easing without any real detector. Pure jitter is a deterministic
 * function of `t`, so runs are reproducible.
 */

import type { Box, Dims } from "../manifest.js";
import type { TrackSample, TrackRequest, VisionTracker } from "./types.js";

export interface MockTrackerOpts {
  /** Working region the boxes live in. Defaults to 1920x1080. */
  region?: Dims;
  /** Shot bounds used to normalize t -> progress. Defaults to [0, 3]. */
  shotStart?: number;
  shotEnd?: number;
  /** Subject box size in px. Defaults to 200x600. */
  boxW?: number;
  boxH?: number;
  /** Peak jitter amplitude in px added to the center. Defaults to 18. */
  jitterPx?: number;
  /** Drop a sample to simulate a detector miss when (index % missEvery)===0. 0 disables. */
  missEvery?: number;
}

/**
 * Deterministic tracker. The subject's center sweeps from 15% to 85% of the
 * region width as t goes shotStart -> shotEnd (a believable cross-stage move),
 * plus a fixed-frequency sinusoidal jitter so successive samples wobble.
 */
export class MockTracker implements VisionTracker {
  readonly name = "mock";
  private readonly o: Required<MockTrackerOpts>;

  constructor(opts: MockTrackerOpts = {}) {
    const region = opts.region ?? { width: 1920, height: 1080 };
    this.o = {
      region,
      shotStart: opts.shotStart ?? 0,
      shotEnd: opts.shotEnd ?? 3,
      boxW: opts.boxW ?? 200,
      boxH: opts.boxH ?? 600,
      jitterPx: opts.jitterPx ?? 18,
      missEvery: opts.missEvery ?? 0,
    };
  }

  /** Box at one time — exposed so tests can compute the expected trend. */
  boxAt(t: number): Box {
    const { region, shotStart, shotEnd, boxW, boxH, jitterPx } = this.o;
    const span = shotEnd - shotStart || 1;
    const p = Math.max(0, Math.min(1, (t - shotStart) / span));
    // Smooth left->right sweep across the central 70% of the frame.
    const centerX = region.width * (0.15 + 0.7 * p);
    // Deterministic high-frequency jitter (no randomness).
    const jitter = jitterPx * Math.sin(t * 37.0);
    const cx = centerX + jitter;
    const cy = region.height / 2;
    return {
      x: cx - boxW / 2,
      y: cy - boxH / 2,
      w: boxW,
      h: boxH,
    };
  }

  async track(req: TrackRequest): Promise<TrackSample[]> {
    const out: TrackSample[] = [];
    const times = [...req.sampleTimes].sort((a, b) => a - b);
    times.forEach((t, i) => {
      if (this.o.missEvery > 0 && i % this.o.missEvery === 0 && i !== 0) {
        return; // simulate a detector miss
      }
      out.push({ t, box: this.boxAt(t) });
    });
    return out;
  }
}
