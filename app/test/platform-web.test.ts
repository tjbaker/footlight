// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `webPlatform` (app/src/platform/web.ts) — the dev/browser
 * backend that fulfils every `FootlightPlatform` capability with a `fetch` to
 * the Node dev server on http://localhost:8787. These tests stub `fetch` (and,
 * for the secret shim, `localStorage`) so they run offline under plain node (no
 * jsdom): each case asserts the EXACT url / method / body the method sends and
 * that the response is parsed into the right shape. Error paths assert the
 * documented behaviour — throw for the strict methods, swallow-to-default for
 * the best-effort ones (listFonts, checkOutdir, getSecret env probe).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  ProbeResult,
  LoudnessResult,
  TrackRequest,
  TrackSample,
  HistoryEntry,
  SessionData,
  FontInfo,
} from "../src/platform/types.js";

const BASE = "http://localhost:8787";
const SECRET_PREFIX = "footlight.secret.";

// --- Map-backed localStorage shim (mirrors autotrack.test.ts) --------------
const store = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string): void => {
    store.set(k, String(v));
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
  clear: (): void => {
    store.clear();
  },
  key: (i: number): string | null => [...store.keys()][i] ?? null,
  get length(): number {
    return store.size;
  },
};
(globalThis as unknown as { localStorage: typeof localStorageMock }).localStorage =
  localStorageMock;

// Import AFTER the localStorage mock is installed.
const { webPlatform } = await import("../src/platform/web.js");

/** A minimal Response stand-in covering the fields webPlatform reads. */
type FakeResponse = {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  blob?: () => Promise<Blob>;
};

function ok(body: Partial<FakeResponse>): FakeResponse {
  return { ok: true, status: 200, ...body };
}

function fail(status: number, text = "boom"): FakeResponse {
  return { ok: false, status, text: async () => text };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetch(impl: (url: string, init?: RequestInit) => FakeResponse): void {
  fetchMock = vi.fn(async (url: unknown, init?: unknown) =>
    impl(String(url), init as RequestInit | undefined),
  );
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
}

/** The (url, init) the last fetch call was made with. */
function lastCall(): { url: string; init: RequestInit | undefined } {
  const args = fetchMock.mock.calls.at(-1)!;
  return { url: String(args[0]), init: args[1] as RequestInit | undefined };
}

beforeEach(() => {
  store.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probe", () => {
  it("GETs /probe with the encoded source and parses ProbeResult", async () => {
    const result: ProbeResult = {
      width: 1920,
      height: 1080,
      duration: 42.5,
      cropdetect: "1920:800:0:140",
    };
    mockFetch(() => ok({ json: async () => result }));

    const out = await webPlatform.probe("/clips/My Show.mp4");

    expect(out).toEqual(result);
    expect(lastCall().url).toBe(
      `${BASE}/probe?source=${encodeURIComponent("/clips/My Show.mp4")}`,
    );
    // GET => no explicit init.
    expect(lastCall().init).toBeUndefined();
  });

  it("throws with the status and body text when the response is not ok", async () => {
    mockFetch(() => fail(500, "ffprobe missing"));
    await expect(webPlatform.probe("/x.mp4")).rejects.toThrow(
      /probe failed \(500\): ffprobe missing/,
    );
  });
});

describe("scenes", () => {
  it("GETs /scenes and returns the number[] timestamps", async () => {
    mockFetch(() => ok({ json: async () => [1.2, 8.4, 15.0] }));
    const out = await webPlatform.scenes("/a b.mp4");
    expect(out).toEqual([1.2, 8.4, 15.0]);
    expect(lastCall().url).toBe(
      `${BASE}/scenes?source=${encodeURIComponent("/a b.mp4")}`,
    );
  });

  it("throws on a non-ok response", async () => {
    mockFetch(() => fail(404));
    await expect(webPlatform.scenes("/x.mp4")).rejects.toThrow(/scenes failed \(404\)/);
  });
});

describe("loudness", () => {
  it("GETs /loudness and parses the three envelopes", async () => {
    const result: LoudnessResult = {
      display: [0, 0.5, 1],
      detect: [0.1, 0.2],
      onsetEnvelope: [0.1, 1, 0.1],
    };
    mockFetch(() => ok({ json: async () => result }));
    const out = await webPlatform.loudness("/song.mp4");
    expect(out).toEqual(result);
    expect(lastCall().url).toBe(
      `${BASE}/loudness?source=${encodeURIComponent("/song.mp4")}`,
    );
  });

  it("throws on a non-ok response", async () => {
    mockFetch(() => fail(500));
    await expect(webPlatform.loudness("/x.mp4")).rejects.toThrow(/loudness failed/);
  });
});

describe("extractFrame", () => {
  it("GETs /frame with source+t and returns a created object URL for the blob", async () => {
    const blob = new Blob(["jpegbytes"], { type: "image/jpeg" });
    mockFetch(() => ok({ blob: async () => blob }));
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:fake-url");

    const out = await webPlatform.extractFrame("/v.mp4", 12.5);

    expect(out).toBe("blob:fake-url");
    expect(createSpy).toHaveBeenCalledWith(blob);
    expect(lastCall().url).toBe(
      `${BASE}/frame?source=${encodeURIComponent("/v.mp4")}&t=${encodeURIComponent("12.5")}`,
    );
  });

  it("throws on a non-ok response", async () => {
    mockFetch(() => fail(500, "no such frame"));
    await expect(webPlatform.extractFrame("/v.mp4", 1)).rejects.toThrow(
      /frame failed \(500\): no such frame/,
    );
  });
});

describe("track", () => {
  it("POSTs /track with JSON body and parses TrackSample[]", async () => {
    const req: TrackRequest = {
      sourcePath: "/v.mp4",
      region: { width: 1920, height: 1080 },
      sampleTimes: [0, 1, 2],
      mock: true,
    };
    const samples: TrackSample[] = [{ t: 0, box: { x: 1, y: 2, w: 3, h: 4 } }];
    mockFetch(() => ok({ json: async () => samples }));

    const out = await webPlatform.track(req);

    expect(out).toEqual(samples);
    const { url, init } = lastCall();
    expect(url).toBe(`${BASE}/track`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init?.body as string)).toEqual(req);
  });

  it("throws on a non-ok response", async () => {
    mockFetch(() => fail(500, "no key"));
    await expect(
      webPlatform.track({
        sourcePath: "/v.mp4",
        region: { width: 1, height: 1 },
        sampleTimes: [],
      }),
    ).rejects.toThrow(/track failed \(500\): no key/);
  });
});

describe("render", () => {
  it("POSTs the manifest as the raw body with no query string when no opts", async () => {
    mockFetch(() => ok({ json: async () => ({ ok: true, log: "done" }) }));
    const manifest = '[{"in":"0","out":"5"}]';

    const out = await webPlatform.render(manifest);

    expect(out).toEqual({ ok: true, log: "done" });
    const { url, init } = lastCall();
    expect(url).toBe(`${BASE}/render`); // no `?`
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(manifest); // raw passthrough, not re-stringified
  });

  it("maps render options into the query string", async () => {
    mockFetch(() => ok({ json: async () => ({ ok: true, log: "" }) }));

    await webPlatform.render("[]", {
      outdir: "out dir",
      crf: 19,
      preset: "medium",
      audioBitrate: "256k",
      dryRun: true,
      burnCaptions: true,
      captionFont: "Inter",
      captionAngle: 0, // != null, so it must be emitted
    });

    const u = new URL(lastCall().url);
    expect(u.pathname).toBe("/render");
    const p = u.searchParams;
    expect(p.get("outdir")).toBe("out dir");
    expect(p.get("crf")).toBe("19");
    expect(p.get("preset")).toBe("medium");
    expect(p.get("audioBitrate")).toBe("256k");
    expect(p.get("dryRun")).toBe("1");
    expect(p.get("burnCaptions")).toBe("1");
    expect(p.get("captionFont")).toBe("Inter");
    expect(p.get("captionAngle")).toBe("0");
  });
});

describe("checkOutdir", () => {
  it("GETs /check-outdir with the encoded dir and parses OutdirCheck", async () => {
    mockFetch(() => ok({ json: async () => ({ ok: true, resolved: "/abs/clips" }) }));
    const out = await webPlatform.checkOutdir("clips");
    expect(out).toEqual({ ok: true, resolved: "/abs/clips" });
    expect(lastCall().url).toBe(
      `${BASE}/check-outdir?outdir=${encodeURIComponent("clips")}`,
    );
  });

  it("returns a not-reachable OutdirCheck when fetch rejects", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const out = await webPlatform.checkOutdir("clips");
    expect(out).toEqual({
      ok: false,
      resolved: "clips",
      error: "the dev backend is not reachable",
    });
  });
});

describe("listFonts", () => {
  it("GETs /fonts and returns the FontInfo[]", async () => {
    const fonts: FontInfo[] = [{ family: "Inter", path: "/f/Inter.ttf" }];
    mockFetch(() => ok({ json: async () => fonts }));
    const out = await webPlatform.listFonts();
    expect(out).toEqual(fonts);
    expect(lastCall().url).toBe(`${BASE}/fonts`);
  });

  it("returns [] (best-effort) on a non-ok response", async () => {
    mockFetch(() => fail(500));
    expect(await webPlatform.listFonts()).toEqual([]);
  });

  it("returns [] when fetch throws", async () => {
    mockFetch(() => {
      throw new Error("down");
    });
    expect(await webPlatform.listFonts()).toEqual([]);
  });
});

describe("listUserFonts", () => {
  it("short-circuits to [] for an empty dir without calling fetch", async () => {
    mockFetch(() => ok({ json: async () => [] }));
    const out = await webPlatform.listUserFonts("");
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GETs /fonts?dir= with the encoded dir and parses FontInfo[]", async () => {
    const fonts: FontInfo[] = [{ family: "Custom", path: "/u/Custom.otf" }];
    mockFetch(() => ok({ json: async () => fonts }));
    const out = await webPlatform.listUserFonts("/my fonts");
    expect(out).toEqual(fonts);
    expect(lastCall().url).toBe(
      `${BASE}/fonts?dir=${encodeURIComponent("/my fonts")}`,
    );
  });
});

describe("history round-trip", () => {
  it("loadHistory GETs /history and parses HistoryEntry[]", async () => {
    const entries = [
      { id: "a", ts: 1, spec: {}, outdir: "clips" },
    ] as unknown as HistoryEntry[];
    mockFetch(() => ok({ json: async () => entries }));
    const out = await webPlatform.loadHistory();
    expect(out).toEqual(entries);
    expect(lastCall().url).toBe(`${BASE}/history`);
  });

  it("saveHistory POSTs { entries } as JSON", async () => {
    mockFetch(() => ok({ json: async () => ({}) }));
    const entries = [
      { id: "a", ts: 1, spec: {}, outdir: "clips" },
    ] as unknown as HistoryEntry[];
    await webPlatform.saveHistory(entries);
    const { url, init } = lastCall();
    expect(url).toBe(`${BASE}/history`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ entries });
  });

  it("loadHistory throws on a non-ok response", async () => {
    mockFetch(() => fail(500));
    await expect(webPlatform.loadHistory()).rejects.toThrow(/loadHistory failed/);
  });
});

describe("session round-trip", () => {
  it("loadSession GETs /session and parses SessionData", async () => {
    const data: SessionData = {
      source: "/v.mp4",
      outdir: "clips",
      clips: [],
      savedAt: 123,
    };
    mockFetch(() => ok({ json: async () => data }));
    const out = await webPlatform.loadSession();
    expect(out).toEqual(data);
    expect(lastCall().url).toBe(`${BASE}/session`);
  });

  it("saveSession POSTs { data } as JSON", async () => {
    mockFetch(() => ok({ json: async () => ({}) }));
    const data: SessionData = {
      source: "/v.mp4",
      outdir: "clips",
      clips: [],
      savedAt: 9,
    };
    await webPlatform.saveSession(data);
    const { url, init } = lastCall();
    expect(url).toBe(`${BASE}/session`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ data });
  });

  it("loadSession throws on a non-ok response", async () => {
    mockFetch(() => fail(500));
    await expect(webPlatform.loadSession()).rejects.toThrow(/loadSession failed/);
  });
});

describe("secret shim (localStorage, dev-only)", () => {
  it("setSecret then getSecret round-trips through the prefixed localStorage key", async () => {
    // No fetch needed for a non-gemini key; guard against an accidental call.
    mockFetch(() => ok({ text: async () => "" }));
    await webPlatform.setSecret("openai", "sk-123");
    expect(store.get(`${SECRET_PREFIX}openai`)).toBe("sk-123");
    expect(await webPlatform.getSecret("openai")).toBe("sk-123");
    // Non-gemini key must not probe the dev server.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getSecret returns null for an absent key", async () => {
    mockFetch(() => ok({ text: async () => "" }));
    expect(await webPlatform.getSecret("openai")).toBeNull();
  });

  it("deleteSecret removes the prefixed key", async () => {
    await webPlatform.setSecret("openai", "sk-9");
    await webPlatform.deleteSecret("openai");
    expect(store.has(`${SECRET_PREFIX}openai`)).toBe(false);
    expect(await webPlatform.getSecret("openai")).toBeNull();
  });

  it("getSecret for a gemini key prefers the dev-server /env-key value", async () => {
    store.set(`${SECRET_PREFIX}gemini`, "from-localstorage");
    mockFetch((url) => {
      expect(url).toBe(`${BASE}/env-key`);
      return ok({ text: async () => "  env-gemini-key  \n" });
    });
    expect(await webPlatform.getSecret("gemini")).toBe("env-gemini-key");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("getSecret for a gemini key falls back to localStorage when /env-key is empty", async () => {
    store.set(`${SECRET_PREFIX}gemini`, "ls-gemini");
    mockFetch(() => ok({ text: async () => "   " })); // blank env value
    expect(await webPlatform.getSecret("gemini")).toBe("ls-gemini");
  });

  it("getSecret for a gemini key falls back to localStorage when /env-key fetch throws", async () => {
    store.set(`${SECRET_PREFIX}gemini`, "ls-gemini-2");
    mockFetch(() => {
      throw new Error("dev server down");
    });
    expect(await webPlatform.getSecret("gemini")).toBe("ls-gemini-2");
  });
});

describe("static / no-network capabilities", () => {
  it("defaultOutdir resolves to 'clips'", async () => {
    expect(await webPlatform.defaultOutdir()).toBe("clips");
  });

  it("videoSrc builds the /video URL with the encoded source", async () => {
    expect(await webPlatform.videoSrc("/a b.mp4")).toBe(
      `${BASE}/video?source=${encodeURIComponent("/a b.mp4")}`,
    );
  });

  it("file picker is unsupported and the pickers resolve null", async () => {
    expect(webPlatform.supportsFilePicker).toBe(false);
    expect(await webPlatform.pickSourceFile()).toBeNull();
    expect(await webPlatform.pickDirectory()).toBeNull();
  });
});

describe("exportCover", () => {
  // The cover spec the editor sends — framing fields only matter to the server.
  const spec = {
    source_file: "/v/show.mp4",
    in_point: "10.000",
    out_point: "20.000",
    crop_offset: "center",
  } as Parameters<typeof webPlatform.exportCover>[2];

  it("POSTs the spec JSON to /cover with source+t and downloads the PNG", async () => {
    // The happy path touches the DOM download dance — stub the pieces.
    const clicked: Array<{ href: string; download: string }> = [];
    const fakeAnchor = {
      href: "",
      download: "",
      click(): void {
        clicked.push({ href: this.href, download: this.download });
      },
      remove(): void {},
    };
    (globalThis as Record<string, unknown>).document = {
      createElement: () => fakeAnchor,
      body: { appendChild: () => undefined },
    };
    const urlAny = URL as unknown as Record<string, unknown>;
    const hadCreate = "createObjectURL" in URL;
    urlAny.createObjectURL = () => "blob:cover";
    urlAny.revokeObjectURL = () => undefined;

    try {
      fetchMock.mockResolvedValue(
        ok({ blob: async () => ({ size: 3 }) as unknown as Blob }),
      );
      const saved = await webPlatform.exportCover("/v/show.mp4", 12.5, spec, "x_cover.png");
      expect(saved).toBe(true);

      const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
      expect(url).toBe(
        `${BASE}/cover?source=${encodeURIComponent("/v/show.mp4")}&t=12.5`,
      );
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual(spec);
      expect(clicked).toEqual([{ href: "blob:cover", download: "x_cover.png" }]);
    } finally {
      delete (globalThis as Record<string, unknown>).document;
      if (!hadCreate) delete urlAny.createObjectURL;
    }
  });

  it("throws with the server detail on a non-OK response", async () => {
    fetchMock.mockResolvedValueOnce(fail(400, "bad cover spec"));
    await expect(
      webPlatform.exportCover("/v.mp4", 0, spec, "c.png"),
    ).rejects.toThrow(/cover failed \(400\): bad cover spec/);
  });
});
