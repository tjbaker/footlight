// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveModels } from "../src/model.js";
import { makeTracker } from "../src/providers/index.js";

describe("resolveModels (one-vs-two model rule)", () => {
  it("uses one multimodal model for both jobs by default", () => {
    const r = resolveModels({ assistantModel: { provider: "gemini", model: "gemini-2.5-flash" } });
    expect(r.assistant).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
    // vision falls back to the assistant model (visionModel ?? assistantModel).
    expect(r.vision).toEqual(r.assistant);
  });

  it("uses a separate vision model only when set", () => {
    const r = resolveModels({
      assistantModel: { provider: "anthropic", model: "claude-x" },
      visionModel: { provider: "gemini", model: "gemini-2.5-flash-lite" },
    });
    expect(r.assistant.provider).toBe("anthropic");
    expect(r.vision).toEqual({ provider: "gemini", model: "gemini-2.5-flash-lite" });
  });
});

describe("makeTracker factory", () => {
  it("builds a Gemini tracker for the gemini provider (no network at construction)", () => {
    const t = makeTracker({ provider: "gemini", model: "gemini-2.5-pro" });
    expect(t.name).toBe("gemini");
  });

  it("throws for an unimplemented provider", () => {
    expect(() => makeTracker({ provider: "openai", model: "gpt-x" })).toThrow(/no vision provider/);
  });
});
