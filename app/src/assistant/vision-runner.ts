// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The real `VisionRunner` (SPEC §6.7) — the backend half of the assistant's two
 * VISION tools, wired to the platform seam.
 *
 * The orchestrator (`src/assistant/orchestrator.ts`) stays pure by INJECTING a
 * `VisionRunner`: it asks for a subject box at one frame (`suggestCropForFrame`)
 * or a set of located samples across a shot (`trackSubject`), and never touches
 * ffmpeg or the network itself. This class supplies the real thing for the app by
 * REUSING the existing `platform.track` path — the very same CLI `track` command
 * (frame extraction in Node + the vision model's normalized boxes) that powers
 * the editor's Auto-track. So there is exactly ONE pixel-tracking code path, and
 * both the web dev server and the native Tauri shell already implement it
 * identically; nothing new is added to either backend.
 *
 *  - `suggestCropForFrame` is a single-sample track at time `t`: extract one
 *    frame, ask the vision model for the subject's box, return it. The
 *    orchestrator inverts that box into an engine-valid `crop_offset`.
 *  - `trackSubject` plans sample times across the clip window (the SAME
 *    `planSampleTimes` the editor uses), tracks them, and returns the raw
 *    `TrackSample[]`; the orchestrator runs them through `samplesToCropPath`
 *    (one-euro smooth → deadzone → velocity limit → eased keyframes).
 *
 * Single shot only (SPEC §6.9): `trackSubject` eases WITHIN one continuous shot —
 * cuts are the hard-switch schedule's job. BYOK & opt-in: the live (Gemini) path
 * needs `ctx.apiKey`; pass `mock` to run the deterministic offline tracker.
 */

import { planSampleTimes } from "@track";
import type { AssistantContext, VisionRunner } from "../../../src/assistant/orchestrator.js";
import type { Box } from "@studio";
import type { TrackSample } from "@provider-types";
import type { FootlightPlatform, TrackRequest } from "../platform/types.js";

/** How densely `trackSubject` samples the shot before the adaptive smoother. */
const DEFAULT_TRACK_INTERVAL_SEC = 0.5;

/** Knobs for the real runner — mostly the offline/BYOK toggle and sample density. */
export interface RealVisionRunnerOpts {
  /** Run the deterministic offline MockTracker (no network, no key). Default false. */
  mock?: boolean;
  /** Seconds between planned `trackSubject` samples (before adaptive refinement). */
  intervalSec?: number;
}

/**
 * The production `VisionRunner`: both tools resolve to one `platform.track` call,
 * so the pixel work runs in whichever backend the platform selected (web dev
 * server or native Tauri) with no second implementation to keep in sync.
 */
export class RealVisionRunner implements VisionRunner {
  private readonly platform: FootlightPlatform;
  private readonly mock: boolean;
  private readonly intervalSec: number;

  constructor(platform: FootlightPlatform, opts: RealVisionRunnerOpts = {}) {
    this.platform = platform;
    this.mock = opts.mock ?? false;
    this.intervalSec = opts.intervalSec ?? DEFAULT_TRACK_INTERVAL_SEC;
  }

  /**
   * Propose a 9:16 crop for ONE frame: a single-sample `platform.track` at `t`.
   * The track command extracts that one frame and asks the vision model for the
   * subject's box (in working-region px). Throws when the model returns no box
   * for the frame — the orchestrator catches it, DROPS the proposal, and notes
   * the miss in `warn` rather than failing the whole turn.
   */
  async suggestCropForFrame(
    args: { t: number; subjectHint?: string },
    ctx: AssistantContext,
  ): Promise<Box> {
    const samples = await this.platform.track(
      this.trackRequest(ctx, [args.t], args.subjectHint),
    );
    // The single requested sample may be omitted on a detection miss; take the
    // first located box (track returns at most one for one sample time).
    const hit = samples.find((s) => !!s && !!s.box);
    if (!hit) {
      throw new Error(
        `suggestCropForFrame: the vision model located no subject at t=${args.t}s`,
      );
    }
    return hit.box;
  }

  /**
   * Track a subject across the shot: plan sample times over the clip window with
   * the SAME `planSampleTimes` the editor's Auto-track uses (uniform interval +
   * a sample just after each in-range scene cut), track them, and return the raw
   * located samples. The orchestrator builds the eased crop path from them via
   * `samplesToCropPath` — this stays a single continuous shot (SPEC §6.9).
   */
  async trackSubject(
    args: { subjectHint: string },
    ctx: AssistantContext,
  ): Promise<TrackSample[]> {
    const shotEnd = clipLength(ctx);
    const sampleTimes = planSampleTimes({
      shotStart: 0,
      shotEnd,
      intervalSec: this.intervalSec,
      // Scene cuts are clip-relative; re-base them onto the In point so a cut
      // inside the shot forces a fresh detection just after it.
      sceneCuts: rebaseSceneCuts(ctx),
    });
    return this.platform.track(this.trackRequest(ctx, sampleTimes, args.subjectHint));
  }

  /**
   * Map an `AssistantContext` + sample times into a platform `TrackRequest`.
   * Frames are extracted from `startSec + t` (the In point offsets every sample),
   * while the returned/sample times stay clip-relative — exactly the convention
   * `planSampleTimes` and `samplesToCropPath` expect.
   */
  private trackRequest(
    ctx: AssistantContext,
    sampleTimes: number[],
    subjectHint?: string,
  ): TrackRequest {
    const req: TrackRequest = {
      sourcePath: requireSource(ctx),
      region: { width: ctx.region.width, height: ctx.region.height },
      sampleTimes,
      mock: this.mock,
      startSec: ctx.inSec ?? 0,
    };
    if (subjectHint && subjectHint.trim()) req.subjectHint = subjectHint;
    // BYOK: forward the key for the live provider; MockTracker ignores it.
    if (ctx.apiKey) req.apiKey = ctx.apiKey;
    return req;
  }
}

/** The shot length to plan samples over: In→Out when known, else source duration. */
function clipLength(ctx: AssistantContext): number {
  if (
    ctx.inSec !== undefined &&
    ctx.outSec !== undefined &&
    ctx.outSec > ctx.inSec
  ) {
    return ctx.outSec - ctx.inSec;
  }
  if (ctx.duration !== undefined && ctx.duration > 0) return ctx.duration;
  throw new Error(
    "trackSubject: need In/Out or a source duration to bound the shot",
  );
}

/**
 * Re-base scene cuts onto the clip's In point (cuts in `AssistantContext` are
 * clip-relative to the source; `planSampleTimes` wants them relative to the shot
 * start, which is the In point). Drops anything outside the shot.
 */
function rebaseSceneCuts(ctx: AssistantContext): number[] | undefined {
  if (!ctx.sceneCuts || ctx.sceneCuts.length === 0) return undefined;
  const inSec = ctx.inSec ?? 0;
  return ctx.sceneCuts.map((c) => c - inSec).filter((c) => c > 0);
}

/** The source path the vision runner reads frames from; required for either tool. */
function requireSource(ctx: AssistantContext): string {
  const src = ctx.source?.trim();
  if (!src) {
    throw new Error("vision runner: AssistantContext.source is required");
  }
  return src;
}
