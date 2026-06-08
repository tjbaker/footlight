// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure chat-still planner (editor-chat.ts) lifted out of
 * editor.ts. It decides WHICH timestamps the assistant samples for its still
 * strip — windowed to In→Out (or the whole source), cut-aware, thinned to budget.
 */

import { describe, it, expect } from "vitest";
import { planChatStillTimes } from "../src/editor-chat.js";

const plan = (over: Partial<Parameters<typeof planChatStillTimes>[0]> = {}) =>
  planChatStillTimes({
    budget: 4,
    inPoint: null,
    outPoint: null,
    duration: 100,
    sceneCuts: [],
    ...over,
  });

describe("planChatStillTimes", () => {
  it("returns [] when the budget is off or there's no positive window", () => {
    expect(plan({ budget: 0 })).toEqual([]);
    expect(plan({ duration: 0 })).toEqual([]);
  });

  it("never returns more than the budget", () => {
    expect(plan({ budget: 4, duration: 600 }).length).toBeLessThanOrEqual(4);
    expect(plan({ budget: 2, duration: 600 }).length).toBeLessThanOrEqual(2);
  });

  it("samples within the In→Out window when one is set", () => {
    const times = plan({ budget: 4, inPoint: 30, outPoint: 50, duration: 100 });
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(30);
      expect(t).toBeLessThanOrEqual(50);
    }
  });

  it("samples across the whole source when no window is set", () => {
    const times = plan({ budget: 4, duration: 100 });
    expect(times.length).toBeGreaterThan(0);
    expect(Math.max(...times)).toBeGreaterThan(50); // reaches into the back half
  });

  it("ignores a degenerate window (out <= in) and falls back to the source", () => {
    const times = plan({ budget: 4, inPoint: 60, outPoint: 40, duration: 100 });
    expect(times.length).toBeGreaterThan(0);
    expect(Math.max(...times)).toBeGreaterThan(60); // used the full 0..100, not 60..40
  });

  it("returns sorted, de-duplicated timestamps", () => {
    const times = plan({ budget: 4, duration: 600 });
    expect([...times]).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });
});
