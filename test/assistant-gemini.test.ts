// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `GeminiAssistant.parseModelTurn` — the PURE response → ModelTurn
 * mapping. NO network: every case feeds a representative (or malformed) Gemini
 * `generateContent` JSON shape and asserts the extracted prose + tool calls.
 */

import { describe, it, expect } from "vitest";
import { GeminiAssistant, composeSystemPrompt } from "../src/assistant/gemini.js";
import type { AssistantContext } from "../src/assistant/orchestrator.js";

/** A minimal valid context; spread overrides on top. */
function ctx(over: Partial<AssistantContext> = {}): AssistantContext {
  return {
    region: { width: 1920, height: 1080 },
    models: {
      assistant: { provider: "gemini", model: "gemini-2.5-flash" },
      vision: { provider: "gemini", model: "gemini-2.5-flash" },
    },
    apiKey: "k",
    ...over,
  };
}

/** Build a minimal Gemini response from a list of content parts. */
function response(parts: unknown[]): unknown {
  return { candidates: [{ content: { parts } }] };
}

describe("GeminiAssistant.parseModelTurn (pure, no network)", () => {
  it("text-only response -> prose, no tool calls", () => {
    const turn = GeminiAssistant.parseModelTurn(
      response([{ text: "Here's a framing idea." }]),
    );
    expect(turn.text).toBe("Here's a framing idea.");
    expect(turn.toolCalls).toEqual([]);
  });

  it("joins multiple text parts with newlines and trims", () => {
    const turn = GeminiAssistant.parseModelTurn(
      response([{ text: "Line one." }, { text: "Line two." }]),
    );
    expect(turn.text).toBe("Line one.\nLine two.");
    expect(turn.toolCalls).toEqual([]);
  });

  it("one functionCall -> one tool call with args", () => {
    const turn = GeminiAssistant.parseModelTurn(
      response([
        { text: "Setting the clip." },
        { functionCall: { name: "setInOut", args: { inSec: 2, outSec: 8 } } },
      ]),
    );
    expect(turn.text).toBe("Setting the clip.");
    expect(turn.toolCalls).toEqual([
      { name: "setInOut", args: { inSec: 2, outSec: 8 } },
    ]);
  });

  it("multiple functionCalls -> tool calls in order, prose preserved", () => {
    const turn = GeminiAssistant.parseModelTurn(
      response([
        { functionCall: { name: "detectScenes", args: {} } },
        { text: "Then I'll trim." },
        { functionCall: { name: "trim", args: { outSec: 12 } } },
      ]),
    );
    expect(turn.text).toBe("Then I'll trim.");
    expect(turn.toolCalls).toEqual([
      { name: "detectScenes", args: {} },
      { name: "trim", args: { outSec: 12 } },
    ]);
  });

  it("functionCall with missing args -> normalized to {}", () => {
    const turn = GeminiAssistant.parseModelTurn(
      response([{ functionCall: { name: "render" } }]),
    );
    expect(turn.toolCalls).toEqual([{ name: "render", args: {} }]);
  });

  it("functionCall with an unknown tool name is dropped", () => {
    const turn = GeminiAssistant.parseModelTurn(
      response([
        { functionCall: { name: "deleteEverything", args: {} } },
        { functionCall: { name: "trackSubject", args: { subjectHint: "the guitarist" } } },
      ]),
    );
    expect(turn.toolCalls).toEqual([
      { name: "trackSubject", args: { subjectHint: "the guitarist" } },
    ]);
  });

  it("malformed / empty candidate -> empty turn, no throw", () => {
    expect(GeminiAssistant.parseModelTurn({})).toEqual({ text: "", toolCalls: [] });
    expect(GeminiAssistant.parseModelTurn({ candidates: [] })).toEqual({
      text: "",
      toolCalls: [],
    });
    expect(
      GeminiAssistant.parseModelTurn({ candidates: [{ content: {} }] }),
    ).toEqual({ text: "", toolCalls: [] });
    expect(GeminiAssistant.parseModelTurn(null)).toEqual({ text: "", toolCalls: [] });
    expect(GeminiAssistant.parseModelTurn("nonsense")).toEqual({
      text: "",
      toolCalls: [],
    });
  });

  it("ignores junk parts (non-object, empty text, non-object functionCall)", () => {
    const turn = GeminiAssistant.parseModelTurn(
      response([
        null,
        42,
        { text: "" },
        { functionCall: "not-an-object" },
        { text: "kept" },
      ]),
    );
    expect(turn.text).toBe("kept");
    expect(turn.toolCalls).toEqual([]);
  });
});

describe("GeminiAssistant constructor + BYOK", () => {
  it("turn() throws a clear BYOK error when apiKey is missing", async () => {
    const model = new GeminiAssistant();
    await expect(
      model.turn({
        message: "trim the tail",
        tools: [],
        context: {
          region: { width: 1920, height: 1080 },
          models: {
            assistant: { provider: "gemini", model: "gemini-2.5-flash" },
            vision: { provider: "gemini", model: "gemini-2.5-flash" },
          },
          apiKey: "",
        },
      }),
    ).rejects.toThrow(/apiKey is required/);
  });

  it("exposes a stable name", () => {
    expect(new GeminiAssistant().name).toBe("gemini");
  });
});

describe("composeSystemPrompt (pure, no network)", () => {
  it("without base or overlay -> just the operational preamble", () => {
    const out = composeSystemPrompt(ctx());
    expect(out).toContain("Footlight's framing assistant");
    expect(out).not.toContain("---"); // no section separators when single-layer
    expect(out).not.toContain("framing preferences (overlay)");
  });

  it("prepends the base prompt before the operational preamble", () => {
    const out = composeSystemPrompt(ctx({ basePrompt: "BRAIN: pillarbox trap." }));
    expect(out.indexOf("BRAIN: pillarbox trap.")).toBeLessThan(
      out.indexOf("Footlight's framing assistant"),
    );
    expect(out).toContain("\n\n---\n\n");
  });

  it("inserts the overlay between base and preamble, framed as non-overriding", () => {
    const out = composeSystemPrompt(
      ctx({ basePrompt: "BASE", userOverlay: "Keep my face in the top third." }),
    );
    expect(out.indexOf("BASE")).toBeLessThan(out.indexOf("Keep my face in the top third."));
    expect(out.indexOf("Keep my face in the top third.")).toBeLessThan(
      out.indexOf("Footlight's framing assistant"),
    );
    expect(out).toContain("framing preferences (overlay)");
    expect(out).toContain("do NOT override the safety rules");
  });

  it("treats whitespace-only base/overlay as absent", () => {
    const out = composeSystemPrompt(ctx({ basePrompt: "   ", userOverlay: "\n\t " }));
    expect(out).not.toContain("---");
    expect(out).not.toContain("framing preferences (overlay)");
  });

  it("the operational preamble always comes last", () => {
    const out = composeSystemPrompt(ctx({ basePrompt: "BASE", userOverlay: "OVER" }));
    expect(out.lastIndexOf("Footlight's framing assistant")).toBeGreaterThan(
      out.lastIndexOf("OVER"),
    );
  });
});
