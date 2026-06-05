// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Auto-track helpers: the opt-in "Auto-track subject" panel's UI scaffolding,
 * its persisted settings, and a tiny pure helper that evaluates an eased crop
 * path's x at a given time for the live preview overlay.
 *
 * The heavy lifting (planning sample times, turning samples into a smoothed
 * eased crop path) lives in the browser-safe engine modules `@track`; this file
 * only owns the app-side glue: a settings object backed by `localStorage` and a
 * local smoothstep evaluator that mirrors `buildEasedCropX` so the preview box
 * tracks the subject without going through ffmpeg.
 */

import type { CropPathKeyframe } from "@core";

/** BYOK + tracking knobs, persisted in localStorage for the web/dev build. */
export interface AutoTrackSettings {
  /** BYOK API key. NOTE: localStorage is fine for the dev/web build; the
   *  packaged Tauri app should move this to the OS keychain. */
  apiKey: string;
  /** Natural-language subject anchor, e.g. "the person playing guitar". */
  subjectHint: string;
  /** Use the deterministic offline MockTracker (no key, for demo/testing). */
  mock: boolean;
  /** Seconds between sample times handed to the tracker. */
  intervalSec: number;
}

const STORAGE_KEY = "footlight.autotrack";

export const DEFAULT_AUTOTRACK: AutoTrackSettings = {
  apiKey: "",
  subjectHint: "",
  mock: false,
  intervalSec: 0.75,
};

/** Load persisted settings, falling back to defaults for any missing field. */
export function loadAutoTrackSettings(): AutoTrackSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AUTOTRACK };
    const parsed = JSON.parse(raw) as Partial<AutoTrackSettings>;
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      subjectHint: typeof parsed.subjectHint === "string" ? parsed.subjectHint : "",
      mock: parsed.mock === true,
      intervalSec:
        typeof parsed.intervalSec === "number" && parsed.intervalSec > 0
          ? parsed.intervalSec
          : DEFAULT_AUTOTRACK.intervalSec,
    };
  } catch {
    return { ...DEFAULT_AUTOTRACK };
  }
}

/** Persist settings (best effort; ignores quota/availability errors). */
export function saveAutoTrackSettings(s: AutoTrackSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* localStorage unavailable (private mode etc.) — non-fatal. */
  }
}

/**
 * Evaluate an eased crop path's x at clip-relative time `t`, mirroring the
 * smoothstep easing `buildEasedCropX` emits for ffmpeg (p clamped to [0,1],
 * s = p*p*(3-2p)). Used to draw the live preview crop box as the user scrubs.
 * Holds the first/last keyframe's x outside the path's time range.
 */
export function easedCropXAt(path: CropPathKeyframe[], t: number): number {
  if (path.length === 0) return 0;
  const kfs = [...path].sort((a, b) => a.t - b.t);
  if (kfs.length === 1) return kfs[0]!.x;
  if (t <= kfs[0]!.t) return kfs[0]!.x;
  const last = kfs[kfs.length - 1]!;
  if (t >= last.t) return last.x;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const dt = b.t - a.t;
      if (dt <= 0) return b.x;
      const p = Math.max(0, Math.min(1, (t - a.t) / dt));
      const s = p * p * (3 - 2 * p);
      return a.x + (b.x - a.x) * s;
    }
  }
  return last.x;
}
