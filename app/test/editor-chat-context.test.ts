// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for editor-chat-context.ts — per-turn assistant-context assembly and
 * the sparse still strip (#125 Phase 2). Assembly: required fields verbatim,
 * optional fields only when they carry signal. Stills: planChatStillTimes is
 * exercised for real (it is pure); the frame extractor and fetch are stubbed,
 * so the suite is fully offline and per-frame failures can be scripted.
 */

/** @vitest-environment jsdom */

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  assembleAssistantContext,
  sampleChatStills,
  urlToBase64,
} from "../src/editor-chat-context.js";

const MODELS = { chat: "gemini-3.5-flash" };

function baseInput() {
  return {
    region: { width: 1800, height: 1010 },
    source: "/v/show.mp4",
    models: MODELS,
    apiKey: "k",
    basePrompt: "BRAIN",
    overlay: null as string | null,
    inPoint: null as number | null,
    outPoint: null as number | null,
    duration: 0,
    sceneCuts: [] as number[],
    swells: [] as Array<{ t: number; label: string }>,
    stills: [] as Array<{ t: number; mimeType: string; dataBase64: string }>,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assembleAssistantContext", () => {
  it("carries only the required fields when nothing optional has signal", () => {
    const ctx = assembleAssistantContext(baseInput());
    expect(ctx).toEqual({
      region: { width: 1800, height: 1010 },
      source: "/v/show.mp4",
      models: MODELS,
      apiKey: "k",
      basePrompt: "BRAIN",
    });
  });

  it("includes each optional field exactly when it has signal", () => {
    const stills = [{ t: 1, mimeType: "image/jpeg", dataBase64: "AA==" }];
    const ctx = assembleAssistantContext({
      ...baseInput(),
      overlay: "prefer faces",
      inPoint: 0, // 0 is a real In point — must survive the null check
      outPoint: 12.5,
      duration: 60,
      sceneCuts: [3, 9],
      swells: [{ t: 4, label: "swell" }],
      stills,
    });
    expect(ctx).toMatchObject({
      userOverlay: "prefer faces",
      inSec: 0,
      outSec: 12.5,
      duration: 60,
      sceneCuts: [3, 9],
      swells: [{ t: 4, label: "swell" }],
      stills,
    });
  });

  it("copies sceneCuts instead of aliasing the live state array", () => {
    const cuts = [3, 9];
    const ctx = assembleAssistantContext({ ...baseInput(), sceneCuts: cuts });
    cuts.push(99);
    expect(ctx.sceneCuts).toEqual([3, 9]);
  });
});

describe("sampleChatStills", () => {
  function stubFetchAsJpeg(): void {
    vi.stubGlobal("fetch", async () => ({
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
    }));
  }

  it("extracts one still per planned time and base64-encodes it", async () => {
    stubFetchAsJpeg();
    const extracted: number[] = [];
    const out = await sampleChatStills({
      source: "/v/show.mp4",
      budget: 2,
      inPoint: 0,
      outPoint: 10,
      duration: 60,
      sceneCuts: [],
      extractFrame: async (_s, t) => {
        extracted.push(t);
        return `http://x/frame?t=${t}`;
      },
    });
    expect(extracted.length).toBeGreaterThan(0);
    expect(out).toHaveLength(extracted.length);
    for (const still of out) {
      expect(still.mimeType).toBe("image/jpeg");
      expect(still.dataBase64.length).toBeGreaterThan(0);
    }
  });

  it("returns [] for no source or a zero budget", async () => {
    const extractFrame = vi.fn();
    expect(
      await sampleChatStills({
        source: "",
        budget: 4,
        inPoint: 0,
        outPoint: 10,
        duration: 60,
        sceneCuts: [],
        extractFrame,
      }),
    ).toEqual([]);
    expect(
      await sampleChatStills({
        source: "/v/show.mp4",
        budget: 0,
        inPoint: 0,
        outPoint: 10,
        duration: 60,
        sceneCuts: [],
        extractFrame,
      }),
    ).toEqual([]);
    expect(extractFrame).not.toHaveBeenCalled();
  });

  it("skips frames that fail to extract instead of failing the turn", async () => {
    stubFetchAsJpeg();
    let calls = 0;
    const out = await sampleChatStills({
      source: "/v/show.mp4",
      budget: 2,
      inPoint: 0,
      outPoint: 10,
      duration: 60,
      sceneCuts: [],
      extractFrame: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return "http://x/frame";
      },
    });
    expect(calls).toBeGreaterThan(1);
    expect(out).toHaveLength(calls - 1);
  });
});

describe("urlToBase64", () => {
  it("returns null when fetch fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await urlToBase64("http://x/frame")).toBeNull();
  });

  it("defaults a typeless blob to image/jpeg", async () => {
    vi.stubGlobal("fetch", async () => ({
      blob: async () => new Blob([new Uint8Array([9])]),
    }));
    const enc = await urlToBase64("http://x/frame");
    expect(enc?.mimeType).toBe("image/jpeg");
  });
});
