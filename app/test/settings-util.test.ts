// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure helpers extracted from settings.ts (settings-util.ts):
 * the USD cost estimates (derived from the shared `priceForModel` rate table), the
 * chat-stills budget clamp, and the theme-string resolution. No DOM/storage here —
 * the localStorage reads + `data-theme` writes stay in settings.ts.
 */

import { describe, it, expect } from "vitest";
import {
  perFrameUsd,
  perRequestUsd,
  clampChatStillsBudget,
  resolveThemeMode,
  DEFAULT_CHAT_STILLS,
  CHAT_STILLS_MAX,
} from "../src/settings-util.js";

describe("perFrameUsd / perRequestUsd (USD cost estimates)", () => {
  it("prices a known model from the shared rate table", () => {
    // gemini-3.5-flash: inputPerM 1.5, outputPerM 9.0 (GEMINI_PRICES).
    // perFrame = 258 * 1.5 / 1e6 ; perReq = (2500*1.5 + 1500*9.0) / 1e6
    expect(perFrameUsd("gemini-3.5-flash")).toBeCloseTo(0.000387, 9);
    expect(perRequestUsd("gemini-3.5-flash")).toBeCloseTo(0.01725, 9);
  });

  it("returns 0 for an unpriced / unknown model", () => {
    expect(perFrameUsd("no-such-model")).toBe(0);
    expect(perRequestUsd("no-such-model")).toBe(0);
  });
});

describe("clampChatStillsBudget", () => {
  it("falls back to the default for a non-number / non-finite / absent value", () => {
    expect(clampChatStillsBudget(undefined)).toBe(DEFAULT_CHAT_STILLS);
    expect(clampChatStillsBudget(NaN)).toBe(DEFAULT_CHAT_STILLS);
    expect(clampChatStillsBudget(Infinity)).toBe(DEFAULT_CHAT_STILLS);
    expect(clampChatStillsBudget("4")).toBe(DEFAULT_CHAT_STILLS);
  });

  it("clamps below 0 up to 0 and above the max down to the ceiling", () => {
    expect(clampChatStillsBudget(-5)).toBe(0);
    expect(clampChatStillsBudget(CHAT_STILLS_MAX + 7)).toBe(CHAT_STILLS_MAX);
  });

  it("rounds a fractional in-range value", () => {
    expect(clampChatStillsBudget(3.4)).toBe(3);
    expect(clampChatStillsBudget(3.6)).toBe(4);
    expect(clampChatStillsBudget(6)).toBe(6);
  });
});

describe("resolveThemeMode", () => {
  it("defaults to light for null or a garbage value", () => {
    expect(resolveThemeMode(null)).toBe("light");
    expect(resolveThemeMode("nonsense")).toBe("light");
    expect(resolveThemeMode("")).toBe("light");
    expect(resolveThemeMode("light")).toBe("light");
  });

  it("preserves dark and system", () => {
    expect(resolveThemeMode("dark")).toBe("dark");
    expect(resolveThemeMode("system")).toBe("system");
  });
});
