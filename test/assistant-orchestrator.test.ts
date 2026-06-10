// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  runAssistantTurn,
  type AssistantContext,
  type AssistantModel,
  type VisionRunner,
} from "../src/assistant/orchestrator.js";
import { MockAssistant, MockVisionRunner } from "../src/assistant/mock.js";

const ctx: AssistantContext = {
  region: { width: 1920, height: 1080 },
  inSec: 2,
  outSec: 8,
  duration: 30,
  sceneCuts: [4],
  swells: [{ t: 5, label: "quiet → loud" }],
  models: {
    assistant: { provider: "gemini", model: "gemini-2.5-flash" },
    vision: { provider: "gemini", model: "gemini-2.5-flash" },
  },
  apiKey: "test-key",
};

const mock = new MockAssistant();
const vision = new MockVisionRunner();
const run = (message: string) => runAssistantTurn(mock, vision, { message, context: ctx });

describe("orchestrator + MockAssistant (deterministic intents)", () => {
  it('"trim the tail" -> a trim commit', async () => {
    const r = await run("trim the tail");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.commit).toEqual({ kind: "trim", outSec: 7 });
  });

  it('"track the guitarist" -> an eased crop path + a swell citation', async () => {
    const r = await run('track "the guitarist"');
    const c = r.actions[0]!.commit;
    expect(c.kind).toBe("trackSubject");
    if (c.kind === "trackSubject") expect(c.cropPath.length).toBeGreaterThan(0);
    expect(r.grounding.some((g) => g.kind === "swell")).toBe(true);
    expect(r.grounding.every((g) => g.kind !== ("audio" as never))).toBe(true);
  });

  it('"center the crop" -> a suggestCropForFrame offset + pillarbox warning', async () => {
    const r = await run("center the crop");
    const c = r.actions[0]!.commit;
    expect(c.kind).toBe("suggestCropForFrame");
    if (c.kind === "suggestCropForFrame") expect(typeof c.cropOffset).toBe("string");
    expect(r.warn).toMatch(/pillarbox/i);
  });

  it('"detect the scenes" -> detectScenes', async () => {
    const r = await run("detect the scenes");
    expect(r.actions[0]!.commit).toEqual({ kind: "detectScenes" });
  });

  it('"render it" -> render only STAGES (never auto-encodes)', async () => {
    const r = await run("render it");
    expect(r.actions[0]!.commit).toEqual({ kind: "render" });
  });

  it("an unrecognized message -> prose, no actions", async () => {
    const r = await run("hello there");
    expect(r.actions).toHaveLength(0);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("threads token usage through and attaches an estimated cost", async () => {
    const r = await run("set in and out");
    expect(r.usage).toBeDefined();
    expect(r.usage!.totalTokens).toBe(r.usage!.promptTokens + r.usage!.outputTokens);
    // gemini-2.5-flash is a known model, so a positive dollar estimate is attached.
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("omits the dollar estimate when the assistant model price is unknown", async () => {
    const unknown: AssistantContext = {
      ...ctx,
      models: { ...ctx.models, assistant: { provider: "gemini", model: "mystery-9000" } },
    };
    const r = await runAssistantTurn(mock, vision, { message: "set in and out", context: unknown });
    expect(r.usage).toBeDefined(); // tokens still surface
    expect(r.costUsd).toBeUndefined(); // but no invented dollar figure
  });
});

describe("orchestrator robustness", () => {
  const scripted = (
    ...toolCalls: { name: string; args: Record<string, unknown> }[]
  ): AssistantModel => ({
    name: "scripted",
    async turn() {
      return { text: "ok", toolCalls: toolCalls as never };
    },
  });

  it("materializes multiple proposals in one turn, in order", async () => {
    const model = scripted(
      { name: "setInOut", args: { inSec: 1, outSec: 3 } },
      { name: "trim", args: { outSec: 2 } },
    );
    const r = await runAssistantTurn(model, vision, { message: "", context: ctx });
    expect(r.actions.map((a) => a.commit.kind)).toEqual(["setInOut", "trim"]);
  });

  it("drops a vision proposal that fails and notes it in warn", async () => {
    const throwing: VisionRunner = {
      async suggestCropForFrame() {
        throw new Error("frame extract failed");
      },
      async trackSubject() {
        throw new Error("no subject");
      },
    };
    const model = scripted({ name: "suggestCropForFrame", args: { t: 2 } });
    const r = await runAssistantTurn(model, throwing, { message: "", context: ctx });
    expect(r.actions).toHaveLength(0);
    expect(r.warn).toMatch(/Skipped 1 proposal/);
  });

  it("drops an invalid deterministic call (out <= in) without failing the turn", async () => {
    const model = scripted(
      { name: "setInOut", args: { inSec: 5, outSec: 5 } }, // invalid
      { name: "detectScenes", args: {} }, // valid
    );
    const r = await runAssistantTurn(model, vision, { message: "", context: ctx });
    expect(r.actions.map((a) => a.commit.kind)).toEqual(["detectScenes"]);
    expect(r.warn).toMatch(/Skipped 1 proposal/);
  });
});
