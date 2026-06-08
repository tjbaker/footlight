// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure helpers in autotrack.ts: `easedCropXAt` (the
 * smoothstep crop-path x evaluator that mirrors `buildEasedCropX` for the live
 * preview overlay) and the localStorage-backed settings round-trip
 * (`loadAutoTrackSettings` / `saveAutoTrackSettings`). Invariants that matter:
 * the eased x holds the first/last keyframe outside the time range, hits exact
 * keyframe x's, and stays bracketed by the surrounding x's between them; the
 * settings round-trip preserves values, falls back to defaults when absent, and
 * rejects out-of-range / wrong-typed fields.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { CropPathKeyframe } from "@core";

// Minimal in-memory localStorage shim so the settings helpers run under node
// (no jsdom). Backed by a Map; only the methods the helpers touch are provided.
const store = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string): void => {
    store.set(k, String(v));
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
  clear: (): void => {
    store.clear();
  },
  key: (i: number): string | null => [...store.keys()][i] ?? null,
  get length(): number {
    return store.size;
  },
};
(globalThis as unknown as { localStorage: typeof localStorageMock }).localStorage =
  localStorageMock;

// Import AFTER the mock is installed so module-eval-time access (if any) is safe.
const {
  easedCropXAt,
  loadAutoTrackSettings,
  saveAutoTrackSettings,
  DEFAULT_AUTOTRACK,
} = await import("../src/autotrack.js");

const kf = (t: number, x: number): CropPathKeyframe => ({ t, x });

describe("easedCropXAt", () => {
  it("returns 0 for an empty path", () => {
    expect(easedCropXAt([], 5)).toBe(0);
  });

  it("returns the single keyframe's x for a one-keyframe path (any t)", () => {
    const path = [kf(2, 440)];
    expect(easedCropXAt(path, -10)).toBe(440);
    expect(easedCropXAt(path, 2)).toBe(440);
    expect(easedCropXAt(path, 99)).toBe(440);
  });

  it("clamps to the first x before the first keyframe", () => {
    const path = [kf(1, 100), kf(3, 500)];
    expect(easedCropXAt(path, 0)).toBe(100);
    expect(easedCropXAt(path, -5)).toBe(100);
  });

  it("clamps to the last x after the last keyframe", () => {
    const path = [kf(1, 100), kf(3, 500)];
    expect(easedCropXAt(path, 3)).toBe(500);
    expect(easedCropXAt(path, 50)).toBe(500);
  });

  it("returns the exact x at an interior keyframe time", () => {
    const path = [kf(0, 0), kf(2, 300), kf(4, 900)];
    expect(easedCropXAt(path, 2)).toBe(300);
  });

  it("eases to the smoothstep midpoint (s=0.5) at the segment midpoint", () => {
    // p = 0.5 → s = 0.5*0.5*(3-2*0.5) = 0.5, so exactly halfway in x too.
    const path = [kf(0, 0), kf(4, 400)];
    expect(easedCropXAt(path, 2)).toBeCloseTo(200, 10);
  });

  it("stays strictly bracketed by the surrounding x's between keyframes", () => {
    const path = [kf(0, 100), kf(10, 700)];
    for (const t of [0.5, 1, 2.5, 5, 7.5, 9, 9.9]) {
      const x = easedCropXAt(path, t);
      expect(x).toBeGreaterThanOrEqual(100);
      expect(x).toBeLessThanOrEqual(700);
    }
  });

  it("is monotonic across a monotonic increasing path", () => {
    const path = [kf(0, 0), kf(5, 300), kf(10, 800)];
    let prev = -Infinity;
    for (let t = 0; t <= 10; t += 0.5) {
      const x = easedCropXAt(path, t);
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
  });

  it("sorts unsorted keyframes by time before evaluating", () => {
    const sorted = [kf(0, 0), kf(2, 300), kf(4, 900)];
    const shuffled = [kf(4, 900), kf(0, 0), kf(2, 300)];
    for (const t of [-1, 0, 1, 2, 3, 4, 5]) {
      expect(easedCropXAt(shuffled, t)).toBeCloseTo(easedCropXAt(sorted, t), 10);
    }
  });

  it("handles duplicate-time keyframes without NaN, returning a bracketed x", () => {
    // Two keyframes share t=2. The first matching segment (0→2) resolves the
    // exact endpoint before the zero-duration (2→2) segment is reached, so the
    // result is finite and one of the keyframe x's at that time (here 100).
    const path = [kf(0, 0), kf(2, 100), kf(2, 500), kf(4, 900)];
    const x = easedCropXAt(path, 2);
    expect(Number.isFinite(x)).toBe(true);
    expect([100, 500]).toContain(x);
  });
});

describe("loadAutoTrackSettings / saveAutoTrackSettings", () => {
  beforeEach(() => {
    store.clear();
  });

  it("returns a copy of the defaults when nothing is persisted", () => {
    const out = loadAutoTrackSettings();
    expect(out).toEqual(DEFAULT_AUTOTRACK);
    // A fresh object, not the shared default instance.
    expect(out).not.toBe(DEFAULT_AUTOTRACK);
  });

  it("round-trips saved settings through localStorage", () => {
    const settings = { subjectHint: "the guitarist", mock: true, intervalSec: 1.5 };
    saveAutoTrackSettings(settings);
    expect(loadAutoTrackSettings()).toEqual(settings);
  });

  it("never persists a stray apiKey field into the blob", () => {
    saveAutoTrackSettings({
      subjectHint: "x",
      mock: false,
      intervalSec: 0.5,
      // @ts-expect-error — legacy field must not be written back.
      apiKey: "secret-should-not-persist",
    });
    const raw = localStorageMock.getItem("footlight.autotrack")!;
    expect(raw).not.toContain("secret-should-not-persist");
    expect(JSON.parse(raw)).not.toHaveProperty("apiKey");
  });

  it("falls back to the default intervalSec for a non-positive or non-numeric value", () => {
    localStorageMock.setItem(
      "footlight.autotrack",
      JSON.stringify({ subjectHint: "a", mock: true, intervalSec: 0 }),
    );
    expect(loadAutoTrackSettings().intervalSec).toBe(DEFAULT_AUTOTRACK.intervalSec);

    localStorageMock.setItem(
      "footlight.autotrack",
      JSON.stringify({ subjectHint: "a", mock: true, intervalSec: -3 }),
    );
    expect(loadAutoTrackSettings().intervalSec).toBe(DEFAULT_AUTOTRACK.intervalSec);

    localStorageMock.setItem(
      "footlight.autotrack",
      JSON.stringify({ intervalSec: "fast" }),
    );
    expect(loadAutoTrackSettings().intervalSec).toBe(DEFAULT_AUTOTRACK.intervalSec);
  });

  it("preserves a valid positive intervalSec", () => {
    localStorageMock.setItem(
      "footlight.autotrack",
      JSON.stringify({ subjectHint: "", mock: false, intervalSec: 2.25 }),
    );
    expect(loadAutoTrackSettings().intervalSec).toBe(2.25);
  });

  it("coerces a non-string subjectHint and non-boolean mock to safe defaults", () => {
    localStorageMock.setItem(
      "footlight.autotrack",
      JSON.stringify({ subjectHint: 42, mock: "yes", intervalSec: 1 }),
    );
    const out = loadAutoTrackSettings();
    expect(out.subjectHint).toBe("");
    expect(out.mock).toBe(false); // only strict `true` enables mock
  });

  it("treats mock as enabled only for a strict boolean true", () => {
    localStorageMock.setItem(
      "footlight.autotrack",
      JSON.stringify({ subjectHint: "", mock: true, intervalSec: 1 }),
    );
    expect(loadAutoTrackSettings().mock).toBe(true);
  });

  it("returns the defaults when the stored blob is malformed JSON", () => {
    localStorageMock.setItem("footlight.autotrack", "{not valid json");
    expect(loadAutoTrackSettings()).toEqual(DEFAULT_AUTOTRACK);
  });
});
