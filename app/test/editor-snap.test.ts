// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for editor-snap.ts (#164) — the pure onset-snap math behind the
 * timeline's Snap toggle: nearest-onset binary search with the ±window cutoff,
 * the cut-before-the-beat tie-break, and the snap-or-passthrough wrapper.
 */

import { describe, it, expect } from "vitest";

import { nearestOnset, snapToOnset, ONSET_SNAP_WINDOW_SEC } from "../src/editor-snap.js";

const ONSETS = [1.0, 2.5, 4.0, 10.0];

describe("nearestOnset", () => {
  it("finds the closest onset on either side of t", () => {
    expect(nearestOnset(ONSETS, 2.4)).toBe(2.5);
    expect(nearestOnset(ONSETS, 2.6)).toBe(2.5);
    expect(nearestOnset(ONSETS, 1.05)).toBe(1.0);
  });

  it("returns null when nothing is inside the window", () => {
    expect(nearestOnset(ONSETS, 6.0)).toBeNull(); // 2s from either neighbour
    expect(nearestOnset(ONSETS, 4.0 + ONSET_SNAP_WINDOW_SEC + 0.001)).toBeNull();
    expect(nearestOnset([], 1.0)).toBeNull();
  });

  it("accepts distances up to the window and honors a custom window", () => {
    // Just inside the default window (an exact-boundary check would be
    // floating-point fragile: 4.0 + 0.15 lands a hair above 0.15 away).
    expect(nearestOnset(ONSETS, 4.0 + ONSET_SNAP_WINDOW_SEC - 1e-6)).toBe(4.0);
    expect(nearestOnset(ONSETS, 4.4, 0.5)).toBe(4.0);
    expect(nearestOnset(ONSETS, 4.4, 0.1)).toBeNull();
  });

  it("breaks an exact tie toward the EARLIER onset (cut before the beat)", () => {
    // 1.75 is equidistant from 1.0 and 2.5 (0.75 each) — outside the default
    // window, so use a wide one to expose the tie-break.
    expect(nearestOnset([1.0, 2.5], 1.75, 1)).toBe(1.0);
  });

  it("handles edges and degenerate inputs", () => {
    expect(nearestOnset(ONSETS, 0.9)).toBe(1.0); // before the first onset
    expect(nearestOnset(ONSETS, 10.1)).toBe(10.0); // after the last onset
    expect(nearestOnset(ONSETS, Number.NaN)).toBeNull();
    expect(nearestOnset(ONSETS, 1.0, Number.NaN)).toBeNull();
    expect(nearestOnset([3.0], 3.0)).toBe(3.0); // exact hit, single onset
  });
});

describe("snapToOnset", () => {
  it("snaps inside the window and passes t through outside it", () => {
    expect(snapToOnset(2.45, ONSETS)).toBe(2.5);
    expect(snapToOnset(6.0, ONSETS)).toBe(6.0);
    expect(snapToOnset(7.123, [])).toBe(7.123);
  });
});
