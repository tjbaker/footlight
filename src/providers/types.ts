// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Footlight vision-provider interface (SPEC §6.7 / §6.9).
 *
 * The subject-tracking math in `track.ts` is provider-agnostic: it asks an
 * implementation of `VisionTracker` to locate the subject at a set of
 * timestamps and gets back bounding boxes in working-region pixels. Gemini is
 * the reference implementation (per-frame inline images + normalized boxes); a
 * deterministic `MockTracker` backs the tests. Anything obeying this contract
 * plugs in — opt-in and BYOK, so no provider runs without the user's own key.
 */

import type { Box, Dims } from "../studio.js";
import type { ModelRef } from "../model.js";

/** A located subject at a clip-relative time. `box` is in SOURCE/working-region pixels. */
export interface TrackSample {
  /** Clip-relative time in seconds. */
  t: number;
  /** Subject bounding box in working-region pixels. */
  box: Box;
}

/** One pre-extracted frame handed to an image-based provider. */
export interface TrackFrame {
  /** Clip-relative time of the frame (seconds), matching a requested sample time. */
  t: number;
  /** Base64-encoded image bytes (no `data:` prefix). */
  dataBase64: string;
  /** MIME type, e.g. `image/jpeg`. */
  mimeType: string;
}

/** A request to locate a subject at specific times within one shot. */
export interface TrackRequest {
  /** Path (or URL/handle) to the source video the provider should read. */
  sourcePath: string;
  /** Working region (post `content_crop`) the returned boxes must be expressed in. */
  region: Dims;
  /** Clip-relative seconds at which to locate the subject. */
  sampleTimes: number[];
  /** Natural-language subject anchor, e.g. "the person playing guitar". */
  subjectHint?: string;
  /** BYOK API key. Required — providers never ship a key. */
  apiKey: string;
  /**
   * The resolved provider + model to use for the pixel work (the `vision` half
   * of `resolveModels`). Optional today so existing call sites keep working; the
   * `makeTracker` factory selects the provider from `model.provider`.
   */
  model?: ModelRef;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
  /**
   * Source-seconds offset of the shot's In point. Frames are extracted from
   * `startSec + sampleTime`, while the returned/sample times stay clip-relative.
   * Defaults to 0.
   */
  startSec?: number;
  /** Optional `W:H:X:Y` content crop applied during frame extraction. */
  contentCrop?: string;
  /**
   * Pre-extracted frames for image-based providers (one per sample time). The
   * Node `track` command populates these via ffmpeg so the browser-safe provider
   * never touches the filesystem; image providers (Gemini) read them directly.
   */
  frames?: TrackFrame[];
}

/**
 * A vision provider that locates a subject across time. Implementations should
 * return one box per requested time on a BEST-EFFORT basis: on a detection miss
 * they may OMIT that time (the smoother bridges gaps via easing). They must not
 * invent boxes for frames where the subject is absent.
 */
export interface VisionTracker {
  /** Stable identifier, e.g. "gemini" / "mock". */
  readonly name: string;
  /** Locate the subject at each `req.sampleTimes`; returns samples (may be fewer than requested). */
  track(req: TrackRequest): Promise<TrackSample[]>;
}
