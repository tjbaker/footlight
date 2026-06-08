// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure logic for the assistant chat dock, lifted out of editor.ts so it can be
 * unit-tested without a DOM/platform. Right now this is the still-strip planner:
 * given the chat-stills budget and the clip window, it decides WHICH timestamps
 * to sample (cut-aware via `planSampleTimes`, then evenly thinned to the budget).
 * The actual frame extraction (platform calls) stays in the editor.
 */

import { planSampleTimes } from "@track";

/** Inputs the still planner reads from editor state (all clip-relative seconds). */
export interface ChatStillPlan {
  /** Per-turn stills budget (0 = off). */
  budget: number;
  /** Clip In point, or null when none is set (→ sample the whole source). */
  inPoint: number | null;
  /** Clip Out point, or null. */
  outPoint: number | null;
  /** Source duration. */
  duration: number;
  /** Detected scene cuts, so sampling can snap to shot boundaries. */
  sceneCuts: number[];
}

/**
 * The timestamps to sample for the chat still strip. Samples across In→Out when a
 * window is set, else the whole source; cut-aware via `planSampleTimes`, then
 * evenly thinned to `budget` (deduped). Returns [] when there's nothing to sample
 * (no budget, no positive window) — the same guards the editor used inline.
 */
export function planChatStillTimes(plan: ChatStillPlan): number[] {
  const { budget, inPoint, outPoint, duration, sceneCuts } = plan;
  if (budget <= 0 || !(duration > 0)) return [];

  let a = 0;
  let b = duration;
  if (inPoint != null && outPoint != null && outPoint > inPoint) {
    a = inPoint;
    b = outPoint;
  }
  if (!(b > a)) return [];

  let times: number[];
  try {
    times = planSampleTimes({ shotStart: a, shotEnd: b, intervalSec: (b - a) / budget, sceneCuts });
  } catch {
    return [];
  }

  if (times.length > budget) {
    const denom = Math.max(1, budget - 1);
    const picked: number[] = [];
    for (let i = 0; i < budget; i++) {
      picked.push(times[Math.round((i * (times.length - 1)) / denom)]!);
    }
    times = [...new Set(picked)];
  }
  return times;
}
