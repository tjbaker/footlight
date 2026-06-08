// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `assistant/cost.ts` — the PURE token → USD estimate. No network,
 * no pricing endpoint exists; cost is always tokens × a maintained rate table.
 */

import { describe, it, expect } from "vitest";
import { priceForModel, estimateCostUsd, GEMINI_PRICES } from "../src/assistant/cost.js";
import type { Usage } from "../src/assistant/types.js";

const usage = (promptTokens: number, outputTokens: number): Usage => ({
  promptTokens,
  outputTokens,
  totalTokens: promptTokens + outputTokens,
});

describe("priceForModel", () => {
  it("resolves an exact model id", () => {
    expect(priceForModel("gemini-2.5-flash")).toEqual(GEMINI_PRICES["gemini-2.5-flash"]);
  });

  it("resolves a versioned/preview id by longest-prefix match", () => {
    expect(priceForModel("gemini-2.5-flash-preview-05-20")).toEqual(
      GEMINI_PRICES["gemini-2.5-flash"],
    );
  });

  it("prefers the longer -lite prefix over the plain -flash one", () => {
    expect(priceForModel("gemini-2.5-flash-lite-preview")).toEqual(
      GEMINI_PRICES["gemini-2.5-flash-lite"],
    );
  });

  it("returns null for an unknown model", () => {
    expect(priceForModel("some-other-model")).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("computes input×rate + output×rate / 1e6", () => {
    // 1,000,000 in @ $0.30/M + 1,000,000 out @ $2.50/M = $2.80
    expect(estimateCostUsd(usage(1_000_000, 1_000_000), "gemini-2.5-flash")).toBeCloseTo(2.8, 10);
  });

  it("handles a realistic small turn (stills-heavy prompt)", () => {
    // 2000 in @ $0.30/M + 60 out @ $2.50/M = 0.0006 + 0.00015 = 0.00075
    expect(estimateCostUsd(usage(2000, 60), "gemini-2.5-flash")).toBeCloseTo(0.00075, 10);
  });

  it("returns null (no dollar figure) for an unknown model", () => {
    expect(estimateCostUsd(usage(1000, 100), "mystery-model")).toBeNull();
  });
});
