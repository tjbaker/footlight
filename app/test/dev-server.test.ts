// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the dev backend (app/dev-server/server.mjs) — the dependency-free
 * node:http server behind `webPlatform`. Fully offline: `node:child_process`
 * is mocked, so no real ffmpeg/ffprobe/fc-list/CLI ever runs; every subprocess
 * is a fake child whose exit code / stdout / stderr each case scripts. The
 * server itself is REAL — `createDevServer()` listens on an ephemeral port
 * with its repo root / history / session paths pointed at a temp dir, and the
 * tests drive it over actual HTTP (route dispatch, query parsing, response
 * shapes, and the Range streaming all run for real).
 *
 * The subprocess arg assertions compare against the SAME pure builders the
 * server imports from ../../dist/core.js (frameExtractArgs, ffprobeStreamArgs,
 * scenesArgs, …), pinning the plumbing: handler X spawns binary Y with exactly
 * the shared builder's args for the requested source.
 *
 * NOTE: requires the root package to be built (`npm run build` at the repo
 * root) — server.mjs itself imports ../../dist/core.js.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// Import AFTER the child_process mock is registered (vi.mock is hoisted, but
// keep the order obvious). The module does NOT listen on import — only
// `node dev-server/server.mjs` does.
import {
  createDevServer,
  collectFontFiles,
  friendlyFsError,
  FONT_SCAN_MAX_DEPTH,
  FONT_SCAN_MAX_FILES,
} from "../dev-server/server.mjs";
import {
  ffprobeStreamArgs,
  cropdetectArgs,
  frameExtractArgs,
  frameExtractTailArgs,
  scenesArgs,
  loudnessCombinedArgs,
  coverFrameArgs,
  LOUDNESS_BUCKETS,
} from "../../dist/core.js";

// --- fake child processes ---------------------------------------------------

interface SpawnScript {
  code?: number;
  stdout?: string | Buffer;
  stderr?: string;
  /** Emit a spawn-level error (binary not on PATH) instead of running. */
  error?: Error;
}

function fakeChild(script: SpawnScript): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (script.error) {
      child.emit("error", script.error);
      return;
    }
    const out = script.stdout ?? "";
    if (out.length > 0) {
      child.stdout.emit("data", Buffer.isBuffer(out) ? out : Buffer.from(out));
    }
    if (script.stderr) child.stderr.emit("data", Buffer.from(script.stderr));
    child.emit("close", script.code ?? 0);
  });
  return child;
}

/** Script the spawn mock: `impl(cmd, args)` returns what that process "does". */
function onSpawn(impl: (cmd: string, args: string[]) => SpawnScript): void {
  spawnMock.mockImplementation((cmd: string, args: string[]) =>
    fakeChild(impl(cmd, args)),
  );
}

function spawnCall(n: number): { cmd: string; args: string[] } {
  const call = spawnMock.mock.calls[n]!;
  return { cmd: call[0] as string, args: call[1] as string[] };
}

// --- server under test (ephemeral port, temp repo root) ----------------------

const CLI = "/fake/bin/footlight.js";
let root: string; // injected repo root: relative outdirs resolve here
let historyPath: string;
let sessionPath: string;
let base: string;
let server: ReturnType<typeof createDevServer>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "footlight-devsrv-"));
  historyPath = join(root, "history.json");
  sessionPath = join(root, "session.json");
  server = createDevServer({ cliPath: CLI, repoRoot: root, historyPath, sessionPath });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// --- routing ------------------------------------------------------------------

describe("routing", () => {
  it("404s an unknown path, with permissive CORS headers", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers OPTIONS preflight with 204", async () => {
    const res = await fetch(`${base}/render`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("400s every source-taking GET endpoint when ?source is missing", async () => {
    for (const path of ["/frame", "/probe", "/scenes", "/loudness", "/video"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(400);
      expect(await res.text(), path).toBe("missing source");
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("500s with a generic message when a handler throws (no internals leaked)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Unparseable body -> JSON.parse throws inside the history handler.
    const res = await fetch(`${base}/history`, { method: "POST", body: "not json" });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("internal error");
  });
});

// --- /env-key -------------------------------------------------------------------

describe("GET /env-key", () => {
  it("returns the trimmed GEMINI_API_KEY from the server environment", async () => {
    vi.stubEnv("GEMINI_API_KEY", "  sk-env-key \n");
    const res = await fetch(`${base}/env-key`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("sk-env-key");
  });

  it("returns an empty body when no key is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("FOOTLIGHT_GEMINI_API_KEY", "");
    const res = await fetch(`${base}/env-key`);
    expect(await res.text()).toBe("");
  });
});

// --- /probe ---------------------------------------------------------------------

describe("GET /probe", () => {
  it("runs ffprobe + a cropdetect pass with the shared builders' args", async () => {
    onSpawn((cmd) =>
      cmd === "ffprobe"
        ? {
            stdout: JSON.stringify({
              streams: [{ width: 1920, height: 1080 }],
              format: { duration: "63.5" },
            }),
          }
        : { stderr: "[Parsed_cropdetect] ... crop=1920:800:0:140\n" },
    );

    const res = await fetch(`${base}/probe?source=${encodeURIComponent("/v.mp4")}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      width: 1920,
      height: 1080,
      duration: 63.5,
      cropdetect: "1920:800:0:140",
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnCall(0)).toEqual({ cmd: "ffprobe", args: ffprobeStreamArgs("/v.mp4") });
    expect(spawnCall(1)).toEqual({ cmd: "ffmpeg", args: cropdetectArgs("/v.mp4") });
  });

  it("500s when ffprobe exits non-zero", async () => {
    onSpawn(() => ({ code: 1, stderr: "No such file" }));
    const res = await fetch(`${base}/probe?source=/missing.mp4`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("ffprobe failed: No such file");
    expect(spawnMock).toHaveBeenCalledTimes(1); // never reached cropdetect
  });

  it("500s when ffprobe output is unparseable", async () => {
    onSpawn(() => ({ stdout: "definitely not json" }));
    const res = await fetch(`${base}/probe?source=/v.mp4`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("ffprobe returned unparseable output");
  });
});

// --- /frame ---------------------------------------------------------------------

describe("GET /frame", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  it("returns the extracted jpeg with no-store caching", async () => {
    onSpawn(() => ({ stdout: JPEG }));

    const res = await fetch(`${base}/frame?source=${encodeURIComponent("/v.mp4")}&t=12.5`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnCall(0)).toEqual({ cmd: "ffmpeg", args: frameExtractArgs("/v.mp4", 12.5) });
  });

  it("falls back to the EOF tail frame when the exact seek decodes nothing", async () => {
    let calls = 0;
    onSpawn(() => (++calls === 1 ? { code: 1, stderr: "no frame" } : { stdout: JPEG }));

    const res = await fetch(`${base}/frame?source=/v.mp4&t=999`);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnCall(0).args).toEqual(frameExtractArgs("/v.mp4", 999));
    expect(spawnCall(1).args).toEqual(frameExtractTailArgs("/v.mp4"));
  });

  it("500s when both the exact and tail extractions fail", async () => {
    onSpawn(() => ({ code: 1, stderr: "decode error" }));
    const res = await fetch(`${base}/frame?source=/v.mp4&t=1`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("frame extraction failed: decode error");
  });
});

// --- /scenes --------------------------------------------------------------------

describe("GET /scenes", () => {
  it("parses pts_time markers from ffmpeg stderr (rounded to ms)", async () => {
    onSpawn(() => ({
      stderr:
        "[Parsed_showinfo_2] n: 0 pts_time:1.2 ...\n" +
        "[Parsed_showinfo_2] n: 1 pts_time:8.44444 ...\n",
    }));

    const res = await fetch(`${base}/scenes?source=${encodeURIComponent("/v.mp4")}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([1.2, 8.444]);
    expect(spawnCall(0)).toEqual({ cmd: "ffmpeg", args: scenesArgs("/v.mp4") });
  });

  it("returns [] for a source with no cuts", async () => {
    onSpawn(() => ({ stderr: "" }));
    const res = await fetch(`${base}/scenes?source=/v.mp4`);
    expect(await res.json()).toEqual([]);
  });
});

// --- /loudness ------------------------------------------------------------------

describe("GET /loudness", () => {
  it("returns all three envelopes from one combined ffmpeg pass", async () => {
    // stderr: per-frame momentary LUFS; stdout: mono f32le PCM for the RMS +
    // onset-envelope paths. 480 samples = three 160-sample (0.02s @ 8kHz) onset
    // frames at constant levels 0.1 / 1.0 / 0.1 → RMS [0.1, 1, 0.1] normalized.
    const samples = new Float32Array(480);
    samples.fill(0.1, 0, 160);
    samples.fill(1.0, 160, 320);
    samples.fill(0.1, 320, 480);
    const pcm = Buffer.from(samples.buffer);
    onSpawn(() => ({
      stderr:
        "[Parsed_ebur128_0 @ 0x1] t: 0.1  TARGET:-23 LUFS  M: -22.5 S:-23.0\n" +
        "[Parsed_ebur128_0 @ 0x1] t: 0.2  TARGET:-23 LUFS  M: -20.0 S:-22.0\n",
      stdout: pcm,
    }));

    const res = await fetch(`${base}/loudness?source=${encodeURIComponent("/v.mp4")}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      display: number[];
      detect: number[];
      onsetEnvelope: number[];
    };
    expect(body.display).toHaveLength(LOUDNESS_BUCKETS);
    expect(body.detect).toHaveLength(LOUDNESS_BUCKETS);
    expect(Math.max(...body.display)).toBeGreaterThan(0);
    expect(Math.max(...body.detect)).toBeGreaterThan(0);
    // The fine onset envelope rides along: one frame per ONSET_FRAME_SEC,
    // max-normalized (computed by the same core.ts onsetEnvelope the CLI uses).
    expect(body.onsetEnvelope).toEqual([0.1, 1, 0.1]);
    expect(spawnCall(0)).toEqual({ cmd: "ffmpeg", args: loudnessCombinedArgs("/v.mp4") });
  });

  it("500s only when the pass fails AND yields neither stderr readings nor PCM", async () => {
    onSpawn(() => ({ code: 1, stderr: "" }));
    const res = await fetch(`${base}/loudness?source=/v.mp4`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("loudness failed");
  });
});

// --- /video (Range streaming) ---------------------------------------------------

describe("GET /video", () => {
  const CONTENT = "0123456789ABCDEF"; // 16 bytes
  let video: string;

  beforeAll(async () => {
    video = join(root, "media.mp4");
    await writeFile(video, CONTENT, "utf8");
  });

  it("404s a missing source", async () => {
    const res = await fetch(`${base}/video?source=${encodeURIComponent(join(root, "nope.mp4"))}`);
    expect(res.status).toBe(404);
  });

  it("serves the whole file with Accept-Ranges when no Range is sent", async () => {
    const res = await fetch(`${base}/video?source=${encodeURIComponent(video)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(CONTENT.length));
    expect(await res.text()).toBe(CONTENT);
  });

  it("serves a bounded Range as 206 with the right slice", async () => {
    const res = await fetch(`${base}/video?source=${encodeURIComponent(video)}`, {
      headers: { range: "bytes=2-5" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 2-5/${CONTENT.length}`);
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  it("clamps an open-ended / overlong Range to EOF", async () => {
    const open = await fetch(`${base}/video?source=${encodeURIComponent(video)}`, {
      headers: { range: "bytes=10-" },
    });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe(`bytes 10-15/${CONTENT.length}`);
    expect(await open.text()).toBe("ABCDEF");

    const over = await fetch(`${base}/video?source=${encodeURIComponent(video)}`, {
      headers: { range: "bytes=4-999" },
    });
    expect(over.status).toBe(206);
    expect(over.headers.get("content-range")).toBe(`bytes 4-15/${CONTENT.length}`);
  });

  it("416s an unsatisfiable Range", async () => {
    const res = await fetch(`${base}/video?source=${encodeURIComponent(video)}`, {
      headers: { range: "bytes=9-2" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${CONTENT.length}`);
  });

  it("falls back to application/octet-stream for an unknown extension", async () => {
    const odd = join(root, "media.xyz");
    await writeFile(odd, "x", "utf8");
    const res = await fetch(`${base}/video?source=${encodeURIComponent(odd)}`);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });
});

// --- /track ---------------------------------------------------------------------

describe("POST /track", () => {
  const REQUEST = JSON.stringify({ sourcePath: "/v.mp4", sampleTimes: [0, 1], mock: true });

  it("writes the request to a temp json and shells the CLI's track command", async () => {
    const samples = [{ t: 0, box: { x: 1, y: 2, w: 3, h: 4 } }];
    let writtenBody = "";
    onSpawn((cmd, args) => {
      writtenBody = readFileSync(args[2]!, "utf8");
      return cmd === "node" ? { stdout: JSON.stringify(samples) } : { code: 1 };
    });

    const res = await fetch(`${base}/track`, { method: "POST", body: REQUEST });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(samples);
    const { cmd, args } = spawnCall(0);
    expect(cmd).toBe("node");
    expect(args[0]).toBe(CLI);
    expect(args[1]).toBe("track");
    expect(basename(args[2]!)).toBe("track-request.json");
    expect(writtenBody).toBe(REQUEST); // raw passthrough into the temp file
  });

  it("500s with the CLI stderr on a non-zero exit", async () => {
    onSpawn(() => ({ code: 1, stderr: "track: no API key" }));
    const res = await fetch(`${base}/track`, { method: "POST", body: REQUEST });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("track failed: track: no API key");
  });

  it("500s when the CLI prints unparseable stdout", async () => {
    onSpawn(() => ({ stdout: "warning: not json" }));
    const res = await fetch(`${base}/track`, { method: "POST", body: REQUEST });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("track returned unparseable output");
  });
});

// --- /render --------------------------------------------------------------------

describe("POST /render", () => {
  it("maps every query option onto the CLI flags, --outdir last", async () => {
    let manifestOnDisk = "";
    onSpawn((_cmd, args) => {
      manifestOnDisk = readFileSync(args[2]!, "utf8");
      return { stdout: "rendered 1 clip\n" };
    });
    const manifest = '[{"in":"0","out":"5"}]';
    const q = new URLSearchParams({
      outdir: "out",
      crf: "19",
      preset: "medium",
      audioBitrate: "256k",
      dryRun: "1",
      burnCaptions: "1",
      captionFont: "Inter",
      captionColor: "#ffffff",
      captionOutlineColor: "#000000",
      captionBold: "1",
      captionItalic: "1",
      captionUnderline: "1",
      captionShadow: "1",
      captionBox: "1",
      captionBoxColor: "#112233",
      captionAngle: "0", // 0 degrees is a real value and must be forwarded
    });

    const res = await fetch(`${base}/render?${q}`, { method: "POST", body: manifest });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; log: string };
    expect(body.ok).toBe(true);
    expect(body.log).toContain("$ node");
    expect(body.log).toContain("rendered 1 clip");
    expect(manifestOnDisk).toBe(manifest);

    const { cmd, args } = spawnCall(0);
    expect(cmd).toBe("node");
    expect(args[0]).toBe(CLI);
    expect(args[1]).toBe("render");
    expect(basename(args[2]!)).toBe("manifest.json"); // .json so the CLI takes the JSON path
    expect(args.slice(3)).toEqual([
      "--crf", "19",
      "--preset", "medium",
      "--audio-bitrate", "256k",
      "--dry-run",
      "--burn-captions",
      "--caption-font", "Inter",
      "--caption-color", "#ffffff",
      "--caption-outline-color", "#000000",
      "--caption-bold",
      "--caption-italic",
      "--caption-underline",
      "--caption-shadow",
      "--caption-box",
      "--caption-box-color", "#112233",
      "--caption-angle", "0",
      "--outdir", resolve(root, "out"), // relative outdir resolves against the repo root
    ]);
  });

  it("defaults to <repoRoot>/clips and no extra flags when no options are sent", async () => {
    onSpawn(() => ({ stdout: "ok" }));
    const res = await fetch(`${base}/render`, { method: "POST", body: "[]" });
    expect(res.status).toBe(200);
    const { args } = spawnCall(0);
    expect(args.slice(3)).toEqual(["--outdir", resolve(root, "clips")]);
  });

  it("honors an absolute outdir as-is", async () => {
    onSpawn(() => ({ stdout: "ok" }));
    const abs = join(root, "elsewhere");
    await fetch(`${base}/render?outdir=${encodeURIComponent(abs)}`, {
      method: "POST",
      body: "[]",
    });
    const { args } = spawnCall(0);
    expect(args.slice(-2)).toEqual(["--outdir", abs]);
  });

  it("reports ok:false (still HTTP 200) with the combined log on a failed render", async () => {
    onSpawn(() => ({ code: 2, stdout: "partial\n", stderr: "boom\n" }));
    const res = await fetch(`${base}/render`, { method: "POST", body: "[]" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; log: string };
    expect(body.ok).toBe(false);
    expect(body.log).toContain("partial");
    expect(body.log).toContain("boom");
  });
});

// --- /check-outdir ----------------------------------------------------------------

describe("GET /check-outdir", () => {
  it("creates a relative outdir under the repo root and reports it writable", async () => {
    const res = await fetch(`${base}/check-outdir?outdir=newclips`);
    expect(await res.json()).toEqual({ ok: true, resolved: resolve(root, "newclips") });
    expect((await stat(resolve(root, "newclips"))).isDirectory()).toBe(true);
  });

  it("defaults an empty outdir to <repoRoot>/clips", async () => {
    const res = await fetch(`${base}/check-outdir`);
    expect(await res.json()).toEqual({ ok: true, resolved: resolve(root, "clips") });
  });

  it("reports a friendly error when the path cannot be created", async () => {
    await writeFile(join(root, "blocker"), "i am a file", "utf8");
    const res = await fetch(`${base}/check-outdir?outdir=blocker/sub`);
    const body = (await res.json()) as { ok: boolean; resolved: string; error?: string };
    expect(res.status).toBe(200); // soft failure: the GUI shows the reason
    expect(body.ok).toBe(false);
    expect(body.resolved).toBe(resolve(root, "blocker/sub"));
    expect(body.error).toBe("part of the path is not a folder");
  });
});

describe("friendlyFsError", () => {
  it("maps the common errno codes to user-facing reasons", () => {
    expect(friendlyFsError({ code: "EACCES" })).toBe("permission denied");
    expect(friendlyFsError({ code: "EPERM" })).toBe("permission denied");
    expect(friendlyFsError({ code: "EROFS" })).toBe("the drive is read-only");
    expect(friendlyFsError({ code: "ENOTDIR" })).toBe("part of the path is not a folder");
    expect(friendlyFsError({ code: "ENOENT" })).toBe("the parent folder does not exist");
    expect(friendlyFsError({ code: "ENOSPC" })).toBe("the disk is full");
  });

  it("falls back to a generic reason for unknown or absent codes", () => {
    expect(friendlyFsError({ code: "EWHATEVER" })).toBe("it could not be created");
    expect(friendlyFsError(undefined)).toBe("it could not be created");
  });
});

// --- /history + /session persistence ---------------------------------------------

describe("history and session round-trips", () => {
  it("GET /history yields [] before anything was saved", async () => {
    const res = await fetch(`${base}/history`);
    expect(await res.json()).toEqual([]);
  });

  it("GET /session yields null before anything was saved", async () => {
    const res = await fetch(`${base}/session`);
    expect(await res.json()).toBeNull();
  });

  it("yields the empty defaults again when the persisted file is malformed", async () => {
    await writeFile(historyPath, "{corrupt", "utf8");
    await writeFile(sessionPath, "{corrupt", "utf8");
    expect(await (await fetch(`${base}/history`)).json()).toEqual([]);
    expect(await (await fetch(`${base}/session`)).json()).toBeNull();
  });

  it("POST /history persists entries that GET /history returns", async () => {
    const entries = [{ id: "a", ts: 1, spec: { source: "/v.mp4" }, outdir: "clips" }];
    const post = await fetch(`${base}/history`, {
      method: "POST",
      body: JSON.stringify({ entries }),
    });
    expect(await post.json()).toEqual({ ok: true });
    expect(await (await fetch(`${base}/history`)).json()).toEqual(entries);
  });

  it("POST /session persists data that GET /session returns", async () => {
    const data = { source: "/v.mp4", outdir: "clips", clips: [], savedAt: 99 };
    const post = await fetch(`${base}/session`, {
      method: "POST",
      body: JSON.stringify({ data }),
    });
    expect(await post.json()).toEqual({ ok: true });
    expect(await (await fetch(`${base}/session`)).json()).toEqual(data);
  });
});

// --- /fonts (fc-list / user folder scan) ------------------------------------------

describe("GET /fonts (system, via fc-list)", () => {
  it("dedupes by family and sorts case-insensitively", async () => {
    onSpawn(() => ({
      stdout:
        "zeta\t/f/zeta.ttf\n" +
        "Inter\t/f/Inter.ttf\n" +
        "Inter\t/f/Inter-Bold.ttf\n" + // duplicate family: first path wins
        "NoPath\t\n" +
        "\n",
    }));

    const res = await fetch(`${base}/fonts`);

    expect(await res.json()).toEqual([
      { family: "Inter", path: "/f/Inter.ttf" },
      { family: "NoPath" },
      { family: "zeta", path: "/f/zeta.ttf" },
    ]);
    const { cmd, args } = spawnCall(0);
    expect(cmd).toBe("fc-list");
    expect(args).toEqual(["--format=%{family[0]}\t%{file}\n"]);
  });

  it("returns [] when fc-list is not on PATH (spawn error)", async () => {
    onSpawn(() => ({ error: new Error("spawn fc-list ENOENT") }));
    const res = await fetch(`${base}/fonts`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns [] when fc-list exits non-zero", async () => {
    onSpawn(() => ({ code: 1, stderr: "fontconfig error" }));
    expect(await (await fetch(`${base}/fonts`)).json()).toEqual([]);
  });
});

describe("GET /fonts?dir= (user fonts folder)", () => {
  let fontsDir: string;

  beforeAll(async () => {
    fontsDir = join(root, "userfonts");
    await mkdir(join(fontsDir, "sub"), { recursive: true });
    await writeFile(join(fontsDir, "beta.ttf"), "", "utf8");
    await writeFile(join(fontsDir, "sub", "alpha.otf"), "", "utf8");
    await writeFile(join(fontsDir, "caps.TTC"), "", "utf8"); // extension match is case-insensitive
    await writeFile(join(fontsDir, "readme.txt"), "not a font", "utf8");
  });

  it("scans recursively and resolves each file's family via fc-scan", async () => {
    onSpawn((cmd, args) =>
      cmd === "fc-scan"
        ? { stdout: `Family of ${basename(args[1]!)}\nextra noise\n` }
        : { code: 1 },
    );

    const res = await fetch(`${base}/fonts?dir=${encodeURIComponent(fontsDir)}`);

    expect(await res.json()).toEqual([
      { family: "Family of alpha.otf", path: join(fontsDir, "sub", "alpha.otf") },
      { family: "Family of beta.ttf", path: join(fontsDir, "beta.ttf") },
      { family: "Family of caps.TTC", path: join(fontsDir, "caps.TTC") },
    ]);
    // fc-scan is invoked per font file with the family format string.
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnCall(0).cmd).toBe("fc-scan");
    expect(spawnCall(0).args[0]).toBe("--format=%{family[0]}\n");
  });

  it("falls back to filename stems when fc-scan is unavailable", async () => {
    onSpawn(() => ({ error: new Error("spawn fc-scan ENOENT") }));

    const res = await fetch(`${base}/fonts?dir=${encodeURIComponent(fontsDir)}`);

    expect(await res.json()).toEqual([
      { family: "alpha", path: join(fontsDir, "sub", "alpha.otf") },
      { family: "beta", path: join(fontsDir, "beta.ttf") },
      { family: "caps", path: join(fontsDir, "caps.TTC") },
    ]);
  });

  it("yields [] (HTTP 200) for a missing dir", async () => {
    const res = await fetch(`${base}/fonts?dir=${encodeURIComponent(join(root, "no-such"))}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("collectFontFiles scan bounds", () => {
  it("stops descending below FONT_SCAN_MAX_DEPTH", async () => {
    // depth 0..(MAX+2): a font at every level; only levels 0..MAX may collect.
    const top = await mkdtemp(join(tmpdir(), "footlight-deep-"));
    let dir = top;
    for (let level = 0; level <= FONT_SCAN_MAX_DEPTH + 2; level++) {
      await writeFile(join(dir, `f${level}.ttf`), "", "utf8");
      dir = join(dir, "nest");
      await mkdir(dir);
    }

    const acc: string[] = [];
    await collectFontFiles(top, 0, acc);

    expect(acc).toHaveLength(FONT_SCAN_MAX_DEPTH + 1);
    expect(acc.some((f) => basename(f) === `f${FONT_SCAN_MAX_DEPTH}.ttf`)).toBe(true);
    expect(acc.some((f) => basename(f) === `f${FONT_SCAN_MAX_DEPTH + 1}.ttf`)).toBe(false);
  });

  it("caps the number of collected files at FONT_SCAN_MAX_FILES", async () => {
    const big = await mkdtemp(join(tmpdir(), "footlight-many-"));
    const writes: Promise<void>[] = [];
    for (let i = 0; i < FONT_SCAN_MAX_FILES + 5; i++) {
      writes.push(writeFile(join(big, `font-${i}.ttf`), ""));
    }
    await Promise.all(writes);

    const acc: string[] = [];
    await collectFontFiles(big, 0, acc);

    expect(acc).toHaveLength(FONT_SCAN_MAX_FILES);
  }, 30_000);

  it("treats an unreadable directory as empty (best-effort)", async () => {
    const acc: string[] = [];
    await collectFontFiles(join(root, "does-not-exist"), 0, acc);
    expect(acc).toEqual([]);
  });
});

// --- /cover (issue #166) ----------------------------------------------------------

describe("POST /cover", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PROBE_JSON = JSON.stringify({
    streams: [{ width: 1920, height: 1080 }],
    format: { duration: "30" },
  });
  const spec = {
    source_file: "/v/show.mp4",
    in_point: "10.000",
    out_point: "20.000",
    crop_offset: "0=left; 4=right",
  };

  it("probes the source, runs the shared coverFrameArgs at t, and streams the PNG", async () => {
    onSpawn((cmd) => (cmd === "ffprobe" ? { stdout: PROBE_JSON } : { stdout: PNG }));

    const res = await fetch(`${base}/cover?source=${encodeURIComponent("/v/show.mp4")}&t=15`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);

    expect(spawnCall(0)).toEqual({ cmd: "ffprobe", args: ffprobeStreamArgs("/v/show.mp4") });
    const expected = coverFrameArgs(
      { source_file: "/v/show.mp4", in_point: "10.000", out_point: "20.000", crop_offset: "0=left; 4=right" },
      15,
      { dims: [1920, 1080] },
    );
    expect(spawnCall(1)).toEqual({ cmd: "ffmpeg", args: expected });
  });

  it("400s on a missing source or an unparseable spec body", async () => {
    const noSource = await fetch(`${base}/cover?t=1`, { method: "POST", body: "{}" });
    expect(noSource.status).toBe(400);
    const badJson = await fetch(`${base}/cover?source=/v.mp4&t=1`, {
      method: "POST",
      body: "not json",
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.text()).toContain("not valid JSON");
  });

  it("400s with the engine's message on a bad framing spec", async () => {
    onSpawn((cmd) => (cmd === "ffprobe" ? { stdout: PROBE_JSON } : { stdout: PNG }));
    const res = await fetch(`${base}/cover?source=/v.mp4&t=0`, {
      method: "POST",
      body: JSON.stringify({ ...spec, cropWindow: { x: 0, y: 0, w: 405, h: 2000 } }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("exceeds working region");
  });

  it("500s when ffmpeg fails or emits nothing", async () => {
    onSpawn((cmd) =>
      cmd === "ffprobe" ? { stdout: PROBE_JSON } : { code: 1, stderr: "encode error" },
    );
    const res = await fetch(`${base}/cover?source=/v.mp4&t=1`, {
      method: "POST",
      body: JSON.stringify(spec),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("cover export failed: encode error");
  });
});
