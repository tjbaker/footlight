// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Onset-snap math for the timeline (issue #164) — the pure half of "snap In/Out
 * to the beat". Given the onset list `detectOnsets` derives from the source's
 * fine RMS envelope, these helpers find the nearest onset within a small window
 * so drag-release / keying can magnetize a point to the musical hit.
 *
 * Control-first: snapping is assistive and opt-in. The CALLER applies it only
 * at decision moments (drag release, I/O keying) — never on every mousemove —
 * and only when the user turned the toggle on, so a deliberately-placed point
 * is never moved behind the user's back. Pure: numbers in, numbers out.
 */

/** Max distance (seconds) a point may be pulled to an onset. Small on purpose:
 *  beyond ~±150 ms the user clearly meant a different moment than the hit. */
export const ONSET_SNAP_WINDOW_SEC = 0.15;

/**
 * The onset nearest to `t` within `±windowSec`, or null when none qualifies.
 * `onsets` must be ascending (as `detectOnsets` returns them); binary search,
 * ties break toward the earlier onset (cut-before-the-beat side).
 */
export function nearestOnset(
  onsets: number[],
  t: number,
  windowSec = ONSET_SNAP_WINDOW_SEC,
): number | null {
  if (onsets.length === 0 || !Number.isFinite(t) || !(windowSec >= 0)) return null;
  // First index with onset >= t.
  let lo = 0;
  let hi = onsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < onsets.length ? onsets[lo]! : null;
  const before = lo > 0 ? onsets[lo - 1]! : null;
  const dAfter = after != null ? after - t : Infinity;
  const dBefore = before != null ? t - before : Infinity;
  const best = dBefore <= dAfter ? before : after;
  const dist = Math.min(dBefore, dAfter);
  return best != null && dist <= windowSec ? best : null;
}

/**
 * `t` snapped to the nearest onset within the window, or `t` unchanged when no
 * onset is close enough. The caller still clamps/rounds the result into its
 * valid In/Out range.
 */
export function snapToOnset(
  t: number,
  onsets: number[],
  windowSec = ONSET_SNAP_WINDOW_SEC,
): number {
  return nearestOnset(onsets, t, windowSec) ?? t;
}
