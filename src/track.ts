// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Footlight subject-tracking math (SPEC §6.9) — pure and browser-safe.
 *
 * This module turns a moving subject within a SINGLE continuous shot into a
 * smooth, eased crop path (`CropPathKeyframe[]`) that feeds `buildEasedCropX` /
 * `buildFfmpegArgs({ cropPath })` in `core.ts`. It does NOT call any vision API
 * itself — detection is injected via a `VisionTracker` (see `providers/`), so
 * this file has NO `node:` imports and runs unchanged in the browser/Tauri
 * frontend.
 *
 * Pipeline (SPEC §6.9):
 *   planSampleTimes  -> when to ask the tracker (fixed interval, cut-anchored)
 *   [tracker]        -> a box per sample time (injected; mock or Gemini)
 *   refineByMotion   -> ADAPTIVE: extra sample times where the box moved a lot
 *   samplesToCropPath-> raw crop x -> one-euro smoothing -> deadzone ->
 *                       velocity limit -> eased keyframes
 *
 * Everything stays WITHIN A SINGLE SHOT: callers bound [shotStart, shotEnd] to
 * one shot (scene cuts seed extra samples but the path itself never crosses a
 * cut — that is the hard-switch schedule's job, §3.3).
 */

import { TARGET_AR, type CropPathKeyframe } from "./core.js";
import type { Box, Dims } from "./studio.js";
import type { TrackSample, VisionTracker } from "./providers/types.js";

/** Round to the nearest even integer (H.264 needs even crop dimensions). */
function even(n: number): number {
  const i = Math.round(n);
  return i - (i % 2);
}

/** Horizontal center of a box in working-region pixels. */
function boxCenterX(box: Box): number {
  return box.x + box.w / 2;
}

/**
 * Plan the timestamps at which to ask the tracker to locate the subject.
 *
 * Uniform samples across [shotStart, shotEnd] every `intervalSec`, ALWAYS
 * including both endpoints, plus a sample just after each scene cut that falls
 * strictly inside the shot (cut-anchored, SPEC §6.9 — force a fresh detection
 * right after a cut). Times are deduped (to ~1ms) and sorted ascending.
 *
 * This is the FIXED-interval pass; `refineByMotion` adds the adaptive samples
 * once boxes are known.
 */
export function planSampleTimes(opts: {
  shotStart: number;
  shotEnd: number;
  intervalSec: number;
  /** Absolute (clip-relative) scene-cut times; a sample is forced just after each in-range cut. */
  sceneCuts?: number[];
  /** Offset added after each cut so we sample inside the new shot, not on the boundary. Default 0.05s. */
  cutEpsilon?: number;
}): number[] {
  const { shotStart, shotEnd } = opts;
  if (!(shotEnd > shotStart)) {
    throw new Error(
      `planSampleTimes: shotEnd (${shotEnd}) must be greater than shotStart (${shotStart})`,
    );
  }
  const interval = opts.intervalSec;
  if (!(interval > 0)) {
    throw new Error(`planSampleTimes: intervalSec must be > 0, got ${interval}`);
  }
  const eps = opts.cutEpsilon ?? 0.05;

  const times: number[] = [shotStart, shotEnd];
  // Uniform interior samples. Guard the loop count so a tiny interval over a
  // long shot cannot wedge; the eased renderer tolerates dense keyframes.
  const span = shotEnd - shotStart;
  const n = Math.floor(span / interval);
  for (let i = 1; i <= n; i++) {
    times.push(shotStart + i * interval);
  }
  // Cut-anchored samples: just AFTER each in-range cut.
  for (const cut of opts.sceneCuts ?? []) {
    const t = cut + eps;
    if (t > shotStart && t < shotEnd) {
      times.push(t);
    }
  }
  return dedupSort(times);
}

/** Dedup (to millisecond precision) and sort ascending. */
function dedupSort(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || Math.abs(t - last) > 1e-3) {
      out.push(t);
    }
  }
  return out;
}

/**
 * ADAPTIVE pass (SPEC §6.9 — densify where motion is high). Given the samples
 * already located, return ADDITIONAL timestamps (segment midpoints) between any
 * two consecutive samples whose box-CENTER moved more than `motionThresholdPx`,
 * provided the segment is at least `minGapSec` wide (so we never request samples
 * closer together than that). Returns ONLY the new times, sorted; callers merge
 * them, re-track, and may iterate (coarse-then-refine).
 */
export function refineByMotion(
  samples: TrackSample[],
  opts: { motionThresholdPx: number; minGapSec: number },
): number[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const extra: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const gap = b.t - a.t;
    if (gap < opts.minGapSec * 2) {
      // Splitting would create sub-minGap segments; leave it alone.
      continue;
    }
    const moved = Math.abs(boxCenterX(b.box) - boxCenterX(a.box));
    if (moved > opts.motionThresholdPx) {
      extra.push((a.t + b.t) / 2);
    }
  }
  return dedupSort(extra);
}

/**
 * One-euro filter (Casiez, Roussel & Vogel 2012): an adaptive low-pass that
 * trades latency for jitter based on signal speed — slow movement is smoothed
 * hard (kills detector jitter), fast movement passes through (no lag on real
 * pans). Operates on IRREGULAR timestamps, which adaptive sampling produces.
 *
 *   minCutoff: low-speed cutoff (Hz) — lower = smoother/more lag when still.
 *   beta:      speed coefficient — higher = less lag during fast motion.
 *   dCutoff:   cutoff (Hz) for the derivative estimate.
 */
export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(opts?: { minCutoff?: number; beta?: number; dCutoff?: number }) {
    this.minCutoff = opts?.minCutoff ?? 1.0;
    this.beta = opts?.beta ?? 0.0;
    this.dCutoff = opts?.dCutoff ?? 1.0;
  }

  /** Smoothing factor for cutoff frequency `cutoff` at sample period `dt`. */
  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** Feed a sample at time `t` (seconds); returns the smoothed value. */
  filter(value: number, t: number): number {
    if (this.tPrev === null || this.xPrev === null) {
      this.tPrev = t;
      this.xPrev = value;
      this.dxPrev = 0;
      return value;
    }
    let dt = t - this.tPrev;
    if (!(dt > 0)) {
      // Coincident/regressing timestamp: treat as no time advance, hold prior.
      dt = 1e-6;
    }
    // Estimate + smooth the derivative.
    const dx = (value - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    // Speed-dependent cutoff, then smooth the value.
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const aX = this.alpha(cutoff, dt);
    const xHat = aX * value + (1 - aX) * this.xPrev;

    this.tPrev = t;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }

  /** Reset internal state (e.g. at a shot boundary). */
  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

/**
 * Desired crop x so the subject's horizontal center sits in the MIDDLE of the
 * 9:16 window. Crop width matches the engine's landscape rule
 * (`cw = even(round(region.height * TARGET_AR))`); x is clamped into
 * [0, region.width - cw] so the window never leaves the frame.
 */
export function boxCenterToCropX(box: Box, region: Dims): number {
  const cw = even(region.height * TARGET_AR);
  const maxX = Math.max(0, region.width - cw);
  const centerX = boxCenterX(box);
  let x = Math.round(centerX - cw / 2);
  x = Math.max(0, Math.min(x, maxX));
  return x;
}

/** Smoothing config for `samplesToCropPath`. */
export interface SmoothingOpts {
  minCutoff: number;
  beta: number;
}

/** Defaults tuned for a person moving across a stage at ~30fps detection. */
export const DEFAULT_SMOOTHING: SmoothingOpts = { minCutoff: 0.7, beta: 0.008 };
export const DEFAULT_DEADZONE_PX = 12;
export const DEFAULT_MAX_VEL_PX_PER_SEC = 600;

/**
 * Turn located samples into an eased crop path (SPEC §6.9). Steps, in order:
 *
 *  1. Drop samples with no box (detector miss) — gaps are bridged by the eased
 *     interpolation between the surviving keyframes.
 *  2. Raw desired crop x per sample via `boxCenterToCropX`.
 *  3. One-euro smoothing over the (possibly irregular) sample timestamps to kill
 *     detector jitter without lagging real motion.
 *  4. DEADZONE: if the smoothed x hasn't moved more than `deadzonePx` from the
 *     last EMITTED keyframe's x, hold the old x (suppresses sub-threshold wiggle
 *     so a near-still subject yields a still crop).
 *  5. VELOCITY LIMIT: clamp the per-keyframe change to `maxVelPxPerSec * dt` so
 *     a detector pop can't yank the crop faster than a believable pan.
 *
 * Returns sorted `{ t, x }` keyframes ready for `buildEasedCropX`, which applies
 * the smoothstep easing between them (never raw-linear, SPEC §6.9). The first
 * sample always anchors the path; if zero boxes survive, returns `[]` and the
 * caller should fall back to a fixed `crop_offset`.
 */
export function samplesToCropPath(
  samples: TrackSample[],
  region: Dims,
  opts?: {
    smoothing?: SmoothingOpts;
    deadzonePx?: number;
    maxVelPxPerSec?: number;
  },
): CropPathKeyframe[] {
  const smoothing = opts?.smoothing ?? DEFAULT_SMOOTHING;
  const deadzone = opts?.deadzonePx ?? DEFAULT_DEADZONE_PX;
  const maxVel = opts?.maxVelPxPerSec ?? DEFAULT_MAX_VEL_PX_PER_SEC;

  // 1. Sort and drop misses.
  const located = samples
    .filter((s): s is TrackSample => !!s && !!s.box)
    .sort((a, b) => a.t - b.t);
  if (located.length === 0) {
    return [];
  }

  const filter = new OneEuroFilter({
    minCutoff: smoothing.minCutoff,
    beta: smoothing.beta,
  });

  const out: CropPathKeyframe[] = [];
  let lastEmittedX: number | null = null;
  let lastEmittedT: number | null = null;

  for (const s of located) {
    const rawX = boxCenterToCropX(s.box, region);
    const smoothX = filter.filter(rawX, s.t);

    let x: number;
    if (lastEmittedX === null || lastEmittedT === null) {
      // First keyframe anchors the path exactly at the smoothed value.
      x = Math.round(smoothX);
    } else {
      // 4. Deadzone: ignore sub-threshold wiggle, hold the prior x.
      let target = smoothX;
      if (Math.abs(smoothX - lastEmittedX) <= deadzone) {
        target = lastEmittedX;
      }
      // 5. Velocity limit: cap the move per elapsed time.
      const dt = Math.max(1e-6, s.t - lastEmittedT);
      const maxStep = maxVel * dt;
      const delta = target - lastEmittedX;
      const clamped =
        Math.abs(delta) > maxStep ? Math.sign(delta) * maxStep : delta;
      x = Math.round(lastEmittedX + clamped);
    }

    out.push({ t: s.t, x });
    lastEmittedX = x;
    lastEmittedT = s.t;
  }

  return out;
}

/** Options for the convenience `trackToCropPath` orchestrator. */
export interface TrackToCropPathOpts {
  sourcePath: string;
  region: Dims;
  shotStart: number;
  shotEnd: number;
  intervalSec: number;
  apiKey: string;
  subjectHint?: string;
  sceneCuts?: number[];
  /** Run the adaptive densify pass (one round) after the coarse pass. Default true. */
  adaptive?: boolean;
  motionThresholdPx?: number;
  minGapSec?: number;
  smoothing?: SmoothingOpts;
  deadzonePx?: number;
  maxVelPxPerSec?: number;
  signal?: AbortSignal;
}

/**
 * End-to-end convenience: plan sample times -> ask the injected tracker ->
 * optionally densify by motion and re-track the new times -> build the eased
 * crop path. The tracker is INJECTED (not constructed here) so this stays pure
 * and testable with `MockTracker`; the real Gemini provider plugs in unchanged.
 *
 * This is a single-shot operation (SPEC §6.9): bound [shotStart, shotEnd] to one
 * shot. Result is a human-in-the-loop SUGGESTION — review/edit before render.
 */
export async function trackToCropPath(
  tracker: VisionTracker,
  opts: TrackToCropPathOpts,
): Promise<CropPathKeyframe[]> {
  const baseTimes = planSampleTimes({
    shotStart: opts.shotStart,
    shotEnd: opts.shotEnd,
    intervalSec: opts.intervalSec,
    sceneCuts: opts.sceneCuts,
  });

  const reqBase = {
    sourcePath: opts.sourcePath,
    region: opts.region,
    subjectHint: opts.subjectHint,
    apiKey: opts.apiKey,
    signal: opts.signal,
  };

  let samples = await tracker.track({ ...reqBase, sampleTimes: baseTimes });

  // Adaptive densify (one round): add midpoints where motion is high, re-track.
  if (opts.adaptive !== false) {
    const extra = refineByMotion(samples, {
      motionThresholdPx: opts.motionThresholdPx ?? 80,
      minGapSec: opts.minGapSec ?? 0.5,
    });
    if (extra.length > 0) {
      const more = await tracker.track({ ...reqBase, sampleTimes: extra });
      samples = [...samples, ...more];
    }
  }

  return samplesToCropPath(samples, opts.region, {
    smoothing: opts.smoothing,
    deadzonePx: opts.deadzonePx,
    maxVelPxPerSec: opts.maxVelPxPerSec,
  });
}
