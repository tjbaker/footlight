// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `tauriPlatform` (app/src/platform/tauri.ts) — the native
 * backend that fulfils every `FootlightPlatform` capability with a Tauri
 * `invoke` of a Rust `#[tauri::command]`. The `@tauri-apps/*` packages are
 * mocked (they are dynamically imported inside each method, which vitest
 * intercepts the same as static imports), so these run offline under plain
 * node with no webview. Each case asserts the EXACT command name + serialized
 * args — especially the render options' null/false defaulting, where `0` and
 * `false` must survive (`?? null`, not `|| null`) — and that invoke rejections
 * propagate for the strict methods while listUserFonts swallows to `[]`.
 *
 * The closing describe asserts render-option PARITY with `webPlatform`: one
 * logical RenderOptions object must serialize to the same logical option set
 * on both backends (Tauri invoke args vs the dev-server query string).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  RenderOptions,
  TrackRequest,
  HistoryEntry,
  SessionData,
} from "../src/platform/types.js";

const { invokeMock, convertFileSrcMock, saveMock, openMock, openUrlMock } = vi.hoisted(
  () => ({
    invokeMock: vi.fn(),
    convertFileSrcMock: vi.fn((p: string) => `asset://localhost${p}`),
    saveMock: vi.fn(),
    openMock: vi.fn(),
    openUrlMock: vi.fn(),
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: convertFileSrcMock,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock, open: openMock }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));

import { tauriPlatform } from "../src/platform/tauri.js";
import { webPlatform } from "../src/platform/web.js";

beforeEach(() => {
  invokeMock.mockReset();
  convertFileSrcMock.mockClear();
  saveMock.mockReset();
  openMock.mockReset();
  openUrlMock.mockReset();
});

describe("extractFrame", () => {
  it("invokes extract_frame and wraps the temp path as a cache-busted asset URL", async () => {
    invokeMock.mockResolvedValue("/tmp/footlight-frame.jpg");

    const out = await tauriPlatform.extractFrame("/clips/My Show.mp4", 12.5);

    expect(invokeMock).toHaveBeenCalledWith("extract_frame", {
      source: "/clips/My Show.mp4",
      t: 12.5,
    });
    expect(convertFileSrcMock).toHaveBeenCalledWith("/tmp/footlight-frame.jpg");
    // Cache-buster keyed on BOTH t and source, so switching clips at the same t
    // still produces a fresh URL.
    expect(out).toBe(
      `asset://localhost/tmp/footlight-frame.jpg?v=12.5&s=${encodeURIComponent(
        "/clips/My Show.mp4",
      )}`,
    );
  });

  it("propagates an invoke rejection", async () => {
    invokeMock.mockRejectedValue(new Error("ffmpeg missing"));
    await expect(tauriPlatform.extractFrame("/v.mp4", 1)).rejects.toThrow(
      "ffmpeg missing",
    );
  });
});

describe("probe / scenes / loudness / track", () => {
  it("probe invokes the probe command with the source", async () => {
    const result = { width: 1920, height: 1080, duration: 42, cropdetect: null };
    invokeMock.mockResolvedValue(result);
    expect(await tauriPlatform.probe("/v.mp4")).toEqual(result);
    expect(invokeMock).toHaveBeenCalledWith("probe", { source: "/v.mp4" });
  });

  it("scenes invokes the scenes command and returns the timestamps", async () => {
    invokeMock.mockResolvedValue([1.2, 8.4]);
    expect(await tauriPlatform.scenes("/v.mp4")).toEqual([1.2, 8.4]);
    expect(invokeMock).toHaveBeenCalledWith("scenes", { source: "/v.mp4" });
  });

  it("loudness invokes the loudness command", async () => {
    // The native backend returns all three envelopes (display/detect/onset).
    const result = { display: [0, 1], detect: [0.5], onsetEnvelope: [0.1, 1, 0.1] };
    invokeMock.mockResolvedValue(result);
    expect(await tauriPlatform.loudness("/v.mp4")).toEqual(result);
    expect(invokeMock).toHaveBeenCalledWith("loudness", { source: "/v.mp4" });
  });

  it("track wraps the request under a `req` key", async () => {
    const req: TrackRequest = {
      sourcePath: "/v.mp4",
      region: { width: 1920, height: 1080 },
      sampleTimes: [0, 1],
      mock: true,
    };
    const samples = [{ t: 0, box: { x: 1, y: 2, w: 3, h: 4 } }];
    invokeMock.mockResolvedValue(samples);
    expect(await tauriPlatform.track(req)).toEqual(samples);
    expect(invokeMock).toHaveBeenCalledWith("track", { req });
  });

  it("propagates invoke rejections", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    await expect(tauriPlatform.probe("/v.mp4")).rejects.toThrow("boom");
    await expect(tauriPlatform.scenes("/v.mp4")).rejects.toThrow("boom");
  });
});

describe("render option serialization", () => {
  it("defaults every option to null (strings/numbers) or false (booleans) when opts is omitted", async () => {
    invokeMock.mockResolvedValue({ ok: true, log: "" });

    await tauriPlatform.render("[]");

    expect(invokeMock).toHaveBeenCalledWith("render", {
      manifestJson: "[]",
      outdir: null,
      crf: null,
      preset: null,
      audioBitrate: null,
      dryRun: false,
      burnCaptions: false,
      captionFont: null,
      captionColor: null,
      captionOutlineColor: null,
      captionBold: false,
      captionItalic: false,
      captionUnderline: false,
      captionShadow: false,
      captionBox: false,
      captionBoxColor: null,
      captionAngle: null,
    });
  });

  it("preserves 0 and false (`?? null`, not `|| null`)", async () => {
    invokeMock.mockResolvedValue({ ok: true, log: "" });

    await tauriPlatform.render("[]", {
      crf: 0, // a valid (lossless) CRF — must NOT collapse to null
      captionAngle: 0, // 0° is an explicit value — must NOT collapse to null
      dryRun: false,
      captionBold: false,
    });

    const args = invokeMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(args.crf).toBe(0);
    expect(args.captionAngle).toBe(0);
    expect(args.dryRun).toBe(false);
    expect(args.captionBold).toBe(false);
    // Untouched options still take their defaults.
    expect(args.preset).toBeNull();
    expect(args.burnCaptions).toBe(false);
  });

  it("passes a full option set through verbatim", async () => {
    invokeMock.mockResolvedValue({ ok: false, log: "err" });

    const out = await tauriPlatform.render('[{"in":"0","out":"5"}]', {
      outdir: "/out dir",
      crf: 19,
      preset: "medium",
      audioBitrate: "256k",
      dryRun: true,
      burnCaptions: true,
      captionFont: "Inter",
      captionColor: "#ffffff",
      captionOutlineColor: "#000000",
      captionBold: true,
      captionItalic: true,
      captionUnderline: true,
      captionShadow: true,
      captionBox: true,
      captionBoxColor: "#112233",
      captionAngle: -12,
    });

    expect(out).toEqual({ ok: false, log: "err" });
    expect(invokeMock).toHaveBeenCalledWith("render", {
      manifestJson: '[{"in":"0","out":"5"}]',
      outdir: "/out dir",
      crf: 19,
      preset: "medium",
      audioBitrate: "256k",
      dryRun: true,
      burnCaptions: true,
      captionFont: "Inter",
      captionColor: "#ffffff",
      captionOutlineColor: "#000000",
      captionBold: true,
      captionItalic: true,
      captionUnderline: true,
      captionShadow: true,
      captionBox: true,
      captionBoxColor: "#112233",
      captionAngle: -12,
    });
  });

  it("propagates an invoke rejection", async () => {
    invokeMock.mockRejectedValue(new Error("render exploded"));
    await expect(tauriPlatform.render("[]")).rejects.toThrow("render exploded");
  });
});

describe("outdir helpers", () => {
  it("defaultOutdir invokes default_outdir with no args", async () => {
    invokeMock.mockResolvedValue("/Users/me/Movies/footlight");
    expect(await tauriPlatform.defaultOutdir()).toBe("/Users/me/Movies/footlight");
    expect(invokeMock).toHaveBeenCalledWith("default_outdir", {});
  });

  it("checkOutdir passes the dir, mapping an empty string to null", async () => {
    invokeMock.mockResolvedValue({ ok: true, resolved: "/abs/clips" });
    expect(await tauriPlatform.checkOutdir("clips")).toEqual({
      ok: true,
      resolved: "/abs/clips",
    });
    expect(invokeMock).toHaveBeenCalledWith("check_outdir", { outdir: "clips" });

    await tauriPlatform.checkOutdir("");
    expect(invokeMock).toHaveBeenLastCalledWith("check_outdir", { outdir: null });
  });
});

describe("dialogs (export / pickers)", () => {
  it("exportTextFile saves via the dialog then writes through write_text_file", async () => {
    saveMock.mockResolvedValue("/chosen/queue.json");
    invokeMock.mockResolvedValue(undefined);

    const out = await tauriPlatform.exportTextFile("queue.json", '{"a":1}');

    expect(out).toBe(true);
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "queue.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    expect(invokeMock).toHaveBeenCalledWith("write_text_file", {
      path: "/chosen/queue.json",
      content: '{"a":1}',
    });
  });

  it("exportTextFile resolves false (and writes nothing) when the dialog is cancelled", async () => {
    saveMock.mockResolvedValue(null);
    expect(await tauriPlatform.exportTextFile("queue.json", "{}")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("exportCover saves via a PNG dialog then runs export_cover with the spec", async () => {
    saveMock.mockResolvedValue("/chosen/x_cover.png");
    invokeMock.mockResolvedValue(undefined);
    const spec = {
      source_file: "/v/show.mp4",
      in_point: "10.000",
      out_point: "20.000",
      crop_offset: "center",
    } as Parameters<typeof tauriPlatform.exportCover>[2];

    const out = await tauriPlatform.exportCover("/v/show.mp4", 12.5, spec, "x_cover.png");

    expect(out).toBe(true);
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "x_cover.png",
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    expect(invokeMock).toHaveBeenCalledWith("export_cover", {
      source: "/v/show.mp4",
      t: 12.5,
      spec,
      outPath: "/chosen/x_cover.png",
    });
  });

  it("exportCover resolves false (and runs nothing) when the dialog is cancelled", async () => {
    saveMock.mockResolvedValue(null);
    const spec = { source_file: "/v.mp4", in_point: "0", out_point: "1" };
    expect(
      await tauriPlatform.exportCover(
        "/v.mp4",
        0,
        spec as Parameters<typeof tauriPlatform.exportCover>[2],
        "c.png",
      ),
    ).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("pickSourceFile opens a single-file video dialog and returns the path", async () => {
    openMock.mockResolvedValue("/movies/show.mp4");
    expect(await tauriPlatform.pickSourceFile()).toBe("/movies/show.mp4");
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      title: "Choose a source video",
      filters: [
        { name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "m4v", "avi"] },
      ],
    });
  });

  it("pickSourceFile returns null on cancel", async () => {
    openMock.mockResolvedValue(null);
    expect(await tauriPlatform.pickSourceFile()).toBeNull();
  });

  it("pickDirectory opens a directory dialog and returns the path (null on cancel)", async () => {
    openMock.mockResolvedValue("/movies/out");
    expect(await tauriPlatform.pickDirectory()).toBe("/movies/out");
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: true,
      title: "Choose an output folder for clips",
    });

    openMock.mockResolvedValue(null);
    expect(await tauriPlatform.pickDirectory()).toBeNull();
  });

  it("declares native file-picker support", () => {
    expect(tauriPlatform.supportsFilePicker).toBe(true);
  });
});

describe("openExternal / videoSrc", () => {
  it("openExternal delegates to the opener plugin", async () => {
    openUrlMock.mockResolvedValue(undefined);
    await tauriPlatform.openExternal("https://example.com");
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
  });

  it("videoSrc wraps the source with the asset protocol", async () => {
    expect(await tauriPlatform.videoSrc("/v.mp4")).toBe("asset://localhost/v.mp4");
    expect(convertFileSrcMock).toHaveBeenCalledWith("/v.mp4");
  });
});

describe("history / session persistence", () => {
  const entries = [{ id: "a", ts: 1, spec: {}, outdir: "clips" }] as unknown as HistoryEntry[];
  const data: SessionData = { source: "/v.mp4", outdir: "clips", clips: [], savedAt: 9 };

  it("loadHistory / saveHistory invoke the matching commands", async () => {
    invokeMock.mockResolvedValue(entries);
    expect(await tauriPlatform.loadHistory()).toEqual(entries);
    expect(invokeMock).toHaveBeenCalledWith("load_history", {});

    invokeMock.mockResolvedValue(undefined);
    await tauriPlatform.saveHistory(entries);
    expect(invokeMock).toHaveBeenLastCalledWith("save_history", { entries });
  });

  it("loadSession / saveSession invoke the matching commands", async () => {
    invokeMock.mockResolvedValue(data);
    expect(await tauriPlatform.loadSession()).toEqual(data);
    expect(invokeMock).toHaveBeenCalledWith("load_session", {});

    invokeMock.mockResolvedValue(undefined);
    await tauriPlatform.saveSession(data);
    expect(invokeMock).toHaveBeenLastCalledWith("save_session", { data });
  });
});

describe("secrets (OS keychain commands)", () => {
  it("get/set/delete map to the keyring commands with the key as account name", async () => {
    invokeMock.mockResolvedValue("sk-123");
    expect(await tauriPlatform.getSecret("gemini")).toBe("sk-123");
    expect(invokeMock).toHaveBeenCalledWith("get_secret", { key: "gemini" });

    invokeMock.mockResolvedValue(undefined);
    await tauriPlatform.setSecret("gemini", "sk-456");
    expect(invokeMock).toHaveBeenLastCalledWith("set_secret", {
      key: "gemini",
      value: "sk-456",
    });

    await tauriPlatform.deleteSecret("gemini");
    expect(invokeMock).toHaveBeenLastCalledWith("delete_secret", { key: "gemini" });
  });

  it("propagates a keychain failure", async () => {
    invokeMock.mockRejectedValue(new Error("keychain locked"));
    await expect(tauriPlatform.getSecret("gemini")).rejects.toThrow("keychain locked");
  });
});

describe("fonts", () => {
  it("listFonts invokes list_fonts", async () => {
    const fonts = [{ family: "Inter", path: "/f/Inter.ttf" }];
    invokeMock.mockResolvedValue(fonts);
    expect(await tauriPlatform.listFonts()).toEqual(fonts);
    expect(invokeMock).toHaveBeenCalledWith("list_fonts", {});
  });

  it("listUserFonts invokes list_fonts_in_dir with the dir", async () => {
    const fonts = [{ family: "Custom", path: "/u/Custom.otf" }];
    invokeMock.mockResolvedValue(fonts);
    expect(await tauriPlatform.listUserFonts("/u")).toEqual(fonts);
    expect(invokeMock).toHaveBeenCalledWith("list_fonts_in_dir", { dir: "/u" });
  });

  it("listUserFonts swallows an invoke failure to [] (best-effort)", async () => {
    invokeMock.mockRejectedValue(new Error("no such dir"));
    expect(await tauriPlatform.listUserFonts("/missing")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Render-option parity with the web backend: one logical RenderOptions object
// must reach both backends as the SAME logical option set. The wire shapes
// differ (invoke args with null/false defaults vs query params that are simply
// omitted), so both are normalized to a common record before comparing.
// ---------------------------------------------------------------------------
describe("render option parity (tauri invoke args vs web query string)", () => {
  type Normalized = Record<string, string | boolean | null>;

  const STRINGISH = [
    "outdir",
    "crf",
    "preset",
    "audioBitrate",
    "captionFont",
    "captionColor",
    "captionOutlineColor",
    "captionBoxColor",
    "captionAngle",
  ] as const;
  const BOOLEAN = [
    "dryRun",
    "burnCaptions",
    "captionBold",
    "captionItalic",
    "captionUnderline",
    "captionShadow",
    "captionBox",
  ] as const;

  function normalizeTauri(args: Record<string, unknown>): Normalized {
    const out: Normalized = {};
    for (const k of STRINGISH) out[k] = args[k] == null ? null : String(args[k]);
    for (const k of BOOLEAN) out[k] = Boolean(args[k]);
    return out;
  }

  function normalizeWeb(params: URLSearchParams): Normalized {
    const out: Normalized = {};
    for (const k of STRINGISH) out[k] = params.get(k);
    for (const k of BOOLEAN) out[k] = params.get(k) === "1";
    return out;
  }

  async function serializeBoth(opts?: RenderOptions): Promise<{
    tauri: Normalized;
    web: Normalized;
  }> {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ ok: true, log: "" });
    await tauriPlatform.render("[]", opts);
    const tauriArgs = invokeMock.mock.calls[0]![1] as Record<string, unknown>;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, log: "" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await webPlatform.render("[]", opts);
    } finally {
      vi.unstubAllGlobals();
    }
    const url = new URL(String(fetchMock.mock.calls[0]![0]));

    return { tauri: normalizeTauri(tauriArgs), web: normalizeWeb(url.searchParams) };
  }

  it("a full option set serializes identically", async () => {
    const { tauri, web } = await serializeBoth({
      outdir: "out dir",
      crf: 19,
      preset: "medium",
      audioBitrate: "copy",
      dryRun: true,
      burnCaptions: true,
      captionFont: "Inter",
      captionColor: "#ffffff",
      captionOutlineColor: "#000000",
      captionBold: true,
      captionItalic: true,
      captionUnderline: true,
      captionShadow: true,
      captionBox: true,
      captionBoxColor: "#112233",
      captionAngle: -12,
    });
    expect(web).toEqual(tauri);
    expect(tauri.captionAngle).toBe("-12"); // and it actually made it through
  });

  it("no options at all serializes identically (all defaults)", async () => {
    const { tauri, web } = await serializeBoth(undefined);
    expect(web).toEqual(tauri);
    expect(tauri.burnCaptions).toBe(false);
    expect(tauri.captionFont).toBeNull();
  });

  it("the falsy-but-meaningful edges agree: captionAngle 0 is sent, false flags are not", async () => {
    const { tauri, web } = await serializeBoth({
      captionAngle: 0,
      dryRun: false,
      captionBold: false,
      burnCaptions: true,
    });
    expect(web).toEqual(tauri);
    expect(tauri.captionAngle).toBe("0"); // 0° must survive on BOTH backends
    expect(tauri.dryRun).toBe(false);
    expect(tauri.burnCaptions).toBe(true);
  });
});
