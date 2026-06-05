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
import { migrateApiKey } from "../../src/secret-migration.js";
import type { FootlightPlatform } from "./platform/types.js";

/**
 * The keychain account name under which the BYOK Gemini key is stored, via the
 * platform `secretStore` (OS keychain natively; a DEV-ONLY localStorage shim on
 * the web build). The key NO LONGER lives in the `footlight.autotrack` blob.
 */
export const GEMINI_API_KEY_SECRET = "footlight.apiKey.gemini";

/**
 * Non-secret tracking knobs, persisted in localStorage. The BYOK API key is
 * deliberately NOT part of this shape any more — it lives in the OS keychain via
 * `secretStore` (see `GEMINI_API_KEY_SECRET`). A legacy `apiKey` field in the
 * stored blob is tolerated on read (for the one-time migration) but never written
 * back; it is migrated out by `migrateLegacyApiKey`.
 */
export interface AutoTrackSettings {
  /** Natural-language subject anchor, e.g. "the person playing guitar". */
  subjectHint: string;
  /** Use the deterministic offline MockTracker (no key, for demo/testing). */
  mock: boolean;
  /** Seconds between sample times handed to the tracker. */
  intervalSec: number;
}

const STORAGE_KEY = "footlight.autotrack";

export const DEFAULT_AUTOTRACK: AutoTrackSettings = {
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
    // Serialize ONLY the non-secret knobs — never the API key.
    const safe: AutoTrackSettings = {
      subjectHint: s.subjectHint,
      mock: s.mock,
      intervalSec: s.intervalSec,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    /* localStorage unavailable (private mode etc.) — non-fatal. */
  }
}

/**
 * One-time first-run migration: pull a legacy inline `apiKey` out of the
 * `footlight.autotrack` blob and into the OS keychain via `secretStore`.
 *
 * Order matters for safety: we only write back the cleaned (key-stripped) blob
 * AFTER `setSecret` resolves, so a locked/unavailable keychain (or any failure)
 * never strips the key from localStorage before it has been safely stored —
 * the key is preserved for the next attempt. A no-op when there is no legacy key.
 */
export async function migrateLegacyApiKey(platform: FootlightPlatform): Promise<void> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return; // localStorage unavailable — nothing to migrate.
  }
  if (!raw) return;

  const { apiKey, remainder } = migrateApiKey(raw);
  if (!apiKey) return; // no inline key to move.

  // Store first; only rewrite the cleaned blob once the secret is safely saved.
  await platform.setSecret(GEMINI_API_KEY_SECRET, apiKey);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remainder));
  } catch {
    /* non-fatal: the secret is stored; the stale inline copy is harmless. */
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
