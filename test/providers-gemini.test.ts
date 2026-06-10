// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the live Gemini VISION provider (`GeminiTracker`).
 *
 * OFFLINE & BYOK: the live provider is never run in tests — instead we mock the
 * global `fetch`, supply a fake key, and exercise request-building and response
 * parsing only. `boxFromGemini` is pure (no fetch). The `track` path is driven
 * by canned `generateContent` responses; no network is ever touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GeminiTracker } from "../src/providers/gemini.js";
import type { TrackRequest } from "../src/providers/types.js";

/** A working region of a standard 16:9 source. */
const REGION = { width: 1920, height: 1080 };

/** A minimal valid request; spread overrides on top. */
function req(over: Partial<TrackRequest> = {}): TrackRequest {
  return {
    sourcePath: "x",
    region: REGION,
    sampleTimes: [0, 1],
    apiKey: "k",
    frames: [
      { t: 0, mimeType: "image/jpeg", dataBase64: "AAAA" },
      { t: 1, mimeType: "image/jpeg", dataBase64: "BBBB" },
    ],
    ...over,
  };
}

/** Build a canned Gemini `generateContent` response whose candidate text is `text`. */
function geminiResponse(text: string): unknown {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

/** A fetch mock that resolves a successful JSON response. */
function okFetch(json: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => json,
  });
}

describe("GeminiTracker.boxFromGemini (pure, no network)", () => {
  it("maps a centered normalized box to centered region pixels", () => {
    // [ymin, xmin, ymax, xmax] = [400, 250, 600, 750] (0..1000).
    // x: 250/1000*1920=480 .. 750/1000*1920=1440 -> w=960
    // y: 400/1000*1080=432 .. 600/1000*1080=648  -> h=216
    expect(GeminiTracker.boxFromGemini([400, 250, 600, 750], REGION)).toEqual({
      x: 480,
      y: 432,
      w: 960,
      h: 216,
    });
  });

  it("maps a top-left corner box to origin-anchored pixels", () => {
    // [0, 0, 200, 100]: x 0..192, y 0..216.
    expect(GeminiTracker.boxFromGemini([0, 0, 200, 100], REGION)).toEqual({
      x: 0,
      y: 0,
      w: 192,
      h: 216,
    });
  });

  it("orders swapped corners so w/h stay non-negative", () => {
    // xmin>xmax and ymin>ymax: same span as [0,0,200,100] but reversed.
    expect(GeminiTracker.boxFromGemini([200, 100, 0, 0], REGION)).toEqual({
      x: 0,
      y: 0,
      w: 192,
      h: 216,
    });
  });

  it("clamps out-of-range coordinates into the region", () => {
    // xmax=1200 (>1000) clamps to width; xmin=-50 clamps to 0.
    expect(GeminiTracker.boxFromGemini([-50, -50, 1200, 1200], REGION)).toEqual({
      x: 0,
      y: 0,
      w: 1920,
      h: 1080,
    });
  });
});

describe("GeminiTracker.track (offline, mocked fetch)", () => {
  beforeEach(() => {
    if (vi.restoreAllMocks) vi.restoreAllMocks();
    else vi.clearAllMocks();
  });
  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it("builds the generateContent request and parses sorted samples", async () => {
    const fetchMock = okFetch(
      geminiResponse(
        JSON.stringify([
          // Deliberately out of order to prove sort-by-t.
          { t: 1, box_2d: [400, 250, 600, 750] },
          { t: 0, box_2d: [0, 0, 200, 100] },
        ]),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const samples = await new GeminiTracker().track(req());

    // Called exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    // URL targets the generateContent endpoint.
    expect(url).toMatch(/:generateContent$/);
    expect(url).toContain("gemini-2.5-pro");

    // Header auth carries the BYOK key.
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("k");
    expect(headers["content-type"]).toBe("application/json");
    expect(init.method).toBe("POST");

    // Body: prompt text part + each frame as an inline_data part.
    const body = JSON.parse(init.body as string);
    const parts = body.contents[0].parts as Array<Record<string, unknown>>;
    expect(parts[0]).toHaveProperty("text");
    expect(String((parts[0] as { text: string }).text)).toContain("box_2d");
    const inline = parts.filter((p) => "inline_data" in p);
    expect(inline).toEqual([
      { inline_data: { mime_type: "image/jpeg", data: "AAAA" } },
      { inline_data: { mime_type: "image/jpeg", data: "BBBB" } },
    ]);

    // Parsed samples: t + box via boxFromGemini, sorted ascending by t.
    expect(samples).toEqual([
      { t: 0, box: { x: 0, y: 0, w: 192, h: 216 } },
      { t: 1, box: { x: 480, y: 432, w: 960, h: 216 } },
    ]);
  });

  it("honors a custom model + apiBase in the URL", async () => {
    const fetchMock = okFetch(geminiResponse("[]"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await new GeminiTracker({
      model: "gemini-flash-x",
      apiBase: "https://proxy.example/v9",
    }).track(req());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://proxy.example/v9/models/gemini-flash-x:generateContent");
  });

  it("throws when apiKey is missing", async () => {
    const fetchMock = okFetch(geminiResponse("[]"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(new GeminiTracker().track(req({ apiKey: "" }))).rejects.toThrow(/apiKey/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when no frames are provided", async () => {
    const fetchMock = okFetch(geminiResponse("[]"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(new GeminiTracker().track(req({ frames: [] }))).rejects.toThrow(/frames/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-ok HTTP response, including the status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "nope",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(new GeminiTracker().track(req())).rejects.toThrow(/HTTP 403/);
  });

  it("returns [] when the response has no/empty candidate text", async () => {
    // No candidates at all.
    globalThis.fetch = okFetch({}) as unknown as typeof fetch;
    expect(await new GeminiTracker().track(req())).toEqual([]);

    // Candidate present but its text part is empty/whitespace.
    globalThis.fetch = okFetch(geminiResponse("   ")) as unknown as typeof fetch;
    expect(await new GeminiTracker().track(req())).toEqual([]);
  });

  it("returns [] when the candidate text is junk / not a JSON array", async () => {
    globalThis.fetch = okFetch(
      geminiResponse("sorry, I can't help with that"),
    ) as unknown as typeof fetch;
    expect(await new GeminiTracker().track(req())).toEqual([]);

    // A JSON object (not an array) is also rejected.
    globalThis.fetch = okFetch(
      geminiResponse('{"t": 0, "box_2d": [0,0,1,1]}'),
    ) as unknown as typeof fetch;
    expect(await new GeminiTracker().track(req())).toEqual([]);
  });

  it("skips items missing t or lacking a 4-element box_2d", async () => {
    globalThis.fetch = okFetch(
      geminiResponse(
        JSON.stringify([
          { box_2d: [0, 0, 200, 100] }, // no t
          { t: 2, box_2d: [0, 0, 100] }, // 3-element box
          { t: 3 }, // no box
          { t: 4, box_2d: "nope" }, // box not an array
          { t: 5, box_2d: [100, 100, 300, 300] }, // the only valid one
        ]),
      ),
    ) as unknown as typeof fetch;

    const samples = await new GeminiTracker().track(req());
    expect(samples).toEqual([
      { t: 5, box: GeminiTracker.boxFromGemini([100, 100, 300, 300], REGION) },
    ]);
  });

  it("tolerates ```json fences / stray prose around the array", async () => {
    globalThis.fetch = okFetch(
      geminiResponse('Here you go:\n```json\n[{"t": 0, "box_2d": [0, 0, 200, 100]}]\n```'),
    ) as unknown as typeof fetch;
    const samples = await new GeminiTracker().track(req());
    expect(samples).toEqual([{ t: 0, box: { x: 0, y: 0, w: 192, h: 216 } }]);
  });
});
