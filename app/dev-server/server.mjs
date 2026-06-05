// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Footlight dev backend. A node:http server (port 8787) that gives the web
 * frontend the same capabilities the native Tauri shell will: it shells out to
 * ffmpeg / ffprobe for frame extraction, probing and scene detection, and to the
 * existing footlight CLI for rendering. Node built-ins plus Footlight's own pure
 * command builders (dist/core.js) — so the ffmpeg/ffprobe args and parsers here
 * are the SAME ones the CLI uses, not a hand-copied second definition. Run
 * `npm run build` first so dist/ exists.
 *
 * Endpoints:
 *   GET  /frame?source=<path>&t=<sec>  -> image/jpeg  (single accurate frame)
 *   GET  /probe?source=<path>          -> JSON {width,height,duration,cropdetect}
 *   GET  /scenes?source=<path>         -> JSON number[]  (scene-cut seconds)
 *   GET  /loudness?source=<path>       -> JSON number[]  (normalized 0..1 envelope)
 *   POST /track    (body = track request JSON)     -> JSON TrackSample[]
 *   POST /render   (body = manifest JSON, ?outdir=) -> JSON {ok, log}
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { writeFile, readFile, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

// Shared, pure ffmpeg/ffprobe command builders + parsers — ONE definition used
// by the CLI, the engine, and this dev server (compiled to dist/ by `npm run
// build`). Keeps the two backends from drifting apart.
import {
  frameExtractArgs,
  ffprobeStreamArgs,
  parseProbe,
  cropdetectArgs,
  parseCropdetect,
  scenesArgs,
  parseScenes,
  loudnessCombinedArgs,
  parseEbur128Momentary,
  bucketLufs,
  bucketLoudness,
  LOUDNESS_BUCKETS,
} from "../../dist/core.js";

const PORT = 8787;
const __dirname = dirname(fileURLToPath(import.meta.url));
// The existing CLI lives at footlight/bin/footlight.js, two levels up from
// app/dev-server/.
const CLI_PATH = resolve(__dirname, "..", "..", "bin", "footlight.js");
// Repo root (footlight/), two levels up from app/dev-server/. Relative render
// outdirs resolve here — NOT against this server's cwd (which is app/) — so GUI
// renders land in the project-root clips/ alongside the CLI's own output.
const REPO_ROOT = resolve(__dirname, "..", "..");
// Persisted render history lives at the repo root, mirroring where GUI renders
// land (the project-root clips/). The frontend owns capping/ordering.
const HISTORY_PATH = resolve(REPO_ROOT, ".footlight-history.json");
// Persisted working session (project) lives alongside the history file at the
// repo root. Restored on next launch; null when missing or malformed.
const SESSION_PATH = resolve(REPO_ROOT, ".footlight-session.json");

/** Spawn a command, collecting stdout/stderr. Resolves even on non-zero exit. */
function run(command, args, { collectStdoutBinary = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    let stderr = "";
    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        code,
        stdout: collectStdoutBinary
          ? Buffer.concat(stdoutChunks)
          : Buffer.concat(stdoutChunks).toString(),
        stderr,
      });
    });
  });
}

/** Permissive CORS for localhost dev. */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(text);
}

/**
 * GET /frame — extract one frame at t. We use ffmpeg INPUT-seek (-ss before
 * -i): combined with `-frames:v 1` this decodes from the nearest keyframe up to
 * t and emits the displayed frame, which is the frame-accurate-seek approach
 * the prototype demonstrates (accuracy comes from seeking per displayed frame).
 */
async function handleFrame(source, t, res) {
  const result = await run("ffmpeg", frameExtractArgs(source, Number(t)), {
    collectStdoutBinary: true,
  });
  if (result.code !== 0 || result.stdout.length === 0) {
    sendText(res, 500, `frame extraction failed: ${result.stderr || "no output"}`);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": result.stdout.length,
    "Cache-Control": "no-store",
  });
  res.end(result.stdout);
}

/** GET /probe — dimensions + duration via ffprobe, plus a cropdetect hint. */
async function handleProbe(source, res) {
  const probe = await run("ffprobe", ffprobeStreamArgs(source));
  if (probe.code !== 0) {
    sendText(res, 500, `ffprobe failed: ${probe.stderr}`);
    return;
  }
  let info;
  try {
    info = parseProbe(probe.stdout);
  } catch {
    sendText(res, 500, `ffprobe returned unparseable output`);
    return;
  }

  // cropdetect suggestion — black bars only.
  const cd = await run("ffmpeg", cropdetectArgs(source));
  sendJson(res, 200, { ...info, cropdetect: parseCropdetect(cd.stderr) });
}

/** GET /scenes — scene-cut timestamps (seconds). */
async function handleScenes(source, res) {
  const result = await run("ffmpeg", scenesArgs(source));
  sendJson(res, 200, parseScenes(result.stderr));
}

/**
 * GET /loudness — the timeline's two envelopes from ONE ffmpeg pass: `display`
 * (perceptual ebur128 momentary LUFS, parsed from stderr → `bucketLufs`) for the
 * bars, and `detect` (raw-energy RMS from the mono f32le PCM on stdout →
 * `bucketLoudness`) for the swell detector. The ebur128 filter passes audio
 * through, so both come out of the same decode.
 */
async function handleLoudness(source, res) {
  const result = await run("ffmpeg", loudnessCombinedArgs(source), { collectStdoutBinary: true });
  const momentary = parseEbur128Momentary(result.stderr);
  if (result.code !== 0 && momentary.length === 0 && result.stdout.length === 0) {
    sendText(res, 500, `loudness failed: ${result.stderr || "no output"}`);
    return;
  }
  // RMS from the PCM stdout (Buffer byteOffset may be non-zero; floor to whole floats).
  const buf = result.stdout;
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  sendJson(res, 200, {
    display: bucketLufs(momentary, LOUDNESS_BUCKETS),
    detect: bucketLoudness(samples, LOUDNESS_BUCKETS),
  });
}

const VIDEO_TYPES = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

/**
 * GET /video — stream the source file with HTTP Range support so the preview
 * <video> element can play (with audio) and seek. Mirrors the native asset
 * protocol the Tauri backend uses.
 */
async function handleVideo(source, req, res) {
  let info;
  try {
    info = await stat(source);
  } catch {
    sendText(res, 404, "source not found");
    return;
  }
  const total = info.size;
  const ext = (source.split(".").pop() || "").toLowerCase();
  const type = VIDEO_TYPES[ext] || "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": type,
    });
    createReadStream(source, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": total,
      "Accept-Ranges": "bytes",
      "Content-Type": type,
    });
    createReadStream(source).pipe(res);
  }
}

/**
 * POST /track — write the request to a temp .json, shell the footlight CLI's
 * `track` command, and return its stdout (a TrackSample[] JSON). The CLI prints
 * ONLY the samples to stdout, so we parse and forward that. Errors (bad key,
 * unsupported provider, etc.) land on stderr with a non-zero exit.
 */
async function handleTrack(body, res) {
  const dir = await mkdtemp(join(tmpdir(), "footlight-"));
  const reqPath = join(dir, "track-request.json");
  await writeFile(reqPath, body, "utf8");

  const result = await run("node", [CLI_PATH, "track", reqPath]);
  if (result.code !== 0) {
    sendText(res, 500, `track failed: ${result.stderr || result.stdout || "no output"}`);
    return;
  }
  let samples;
  try {
    samples = JSON.parse(result.stdout);
  } catch {
    sendText(res, 500, `track returned unparseable output: ${result.stdout}`);
    return;
  }
  sendJson(res, 200, samples);
}

/** POST /render — write manifest to a temp .json, invoke footlight CLI render. */
async function handleRender(body, opts, res) {
  const dir = await mkdtemp(join(tmpdir(), "footlight-"));
  // .json extension so the CLI auto-detects the JSON manifest path (not CSV).
  const manifestPath = join(dir, "manifest.json");
  await writeFile(manifestPath, body, "utf8");

  // Resolve a relative outdir against the repo root, not this server's cwd
  // (app/), so renders land in the project-root clips/. An absolute outdir is
  // honored as-is.
  const outDir = isAbsolute(opts.outdir || "clips")
    ? opts.outdir
    : resolve(REPO_ROOT, opts.outdir || "clips");
  // Render flags from Settings -> CLI. --outdir is appended LAST so the log's
  // trailing `--outdir <dir>` still parses cleanly on the client.
  const args = [CLI_PATH, "render", manifestPath];
  if (opts.crf) args.push("--crf", String(opts.crf));
  if (opts.preset) args.push("--preset", opts.preset);
  if (opts.audioBitrate) args.push("--audio-bitrate", opts.audioBitrate);
  if (opts.dryRun) args.push("--dry-run");
  if (opts.burnCaptions) args.push("--burn-captions");
  if (opts.captionFont) args.push("--caption-font", opts.captionFont);
  args.push("--outdir", outDir);
  const result = await run("node", args);
  const log = `$ node ${args.join(" ")}\n\n${result.stdout}${result.stderr}`;
  sendJson(res, 200, { ok: result.code === 0, log });
}

/** GET /history — the persisted render history; [] if missing or malformed. */
async function handleLoadHistory(res) {
  let entries = [];
  try {
    entries = JSON.parse(await readFile(HISTORY_PATH, "utf8"));
  } catch {
    // Missing file or unparseable JSON — start fresh.
    entries = [];
  }
  sendJson(res, 200, entries);
}

/** POST /history — persist the full history array from the body's `entries`. */
async function handleSaveHistory(body, res) {
  const entries = JSON.parse(body).entries;
  await writeFile(HISTORY_PATH, JSON.stringify(entries), "utf8");
  sendJson(res, 200, { ok: true });
}

/** GET /session — the persisted working session; null if missing or malformed. */
async function handleLoadSession(res) {
  let data = null;
  try {
    data = JSON.parse(await readFile(SESSION_PATH, "utf8"));
  } catch {
    // Missing file or unparseable JSON — no session to restore.
    data = null;
  }
  sendJson(res, 200, data);
}

/** POST /session — persist the working session from the body's `data`. */
async function handleSaveSession(body, res) {
  const data = JSON.parse(body).data;
  await writeFile(SESSION_PATH, JSON.stringify(data), "utf8");
  sendJson(res, 200, { ok: true });
}

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/frame") {
      const source = url.searchParams.get("source");
      const t = url.searchParams.get("t") || "0";
      if (!source) return sendText(res, 400, "missing source");
      return await handleFrame(source, t, res);
    }

    if (req.method === "GET" && url.pathname === "/probe") {
      const source = url.searchParams.get("source");
      if (!source) return sendText(res, 400, "missing source");
      return await handleProbe(source, res);
    }

    if (req.method === "GET" && url.pathname === "/scenes") {
      const source = url.searchParams.get("source");
      if (!source) return sendText(res, 400, "missing source");
      return await handleScenes(source, res);
    }

    if (req.method === "GET" && url.pathname === "/loudness") {
      const source = url.searchParams.get("source");
      if (!source) return sendText(res, 400, "missing source");
      return await handleLoudness(source, res);
    }

    if (req.method === "GET" && url.pathname === "/video") {
      const source = url.searchParams.get("source");
      if (!source) return sendText(res, 400, "missing source");
      return await handleVideo(source, req, res);
    }

    if (req.method === "POST" && url.pathname === "/track") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      return await handleTrack(body, res);
    }

    if (req.method === "POST" && url.pathname === "/render") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      const opts = {
        outdir: url.searchParams.get("outdir") || undefined,
        crf: url.searchParams.get("crf") || undefined,
        preset: url.searchParams.get("preset") || undefined,
        audioBitrate: url.searchParams.get("audioBitrate") || undefined,
        dryRun: url.searchParams.get("dryRun") === "1",
        burnCaptions: url.searchParams.get("burnCaptions") === "1",
        captionFont: url.searchParams.get("captionFont") || undefined,
      };
      return await handleRender(body, opts, res);
    }

    if (req.method === "GET" && url.pathname === "/history") {
      return await handleLoadHistory(res);
    }

    if (req.method === "POST" && url.pathname === "/history") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      return await handleSaveHistory(body, res);
    }

    if (req.method === "GET" && url.pathname === "/session") {
      return await handleLoadSession(res);
    }

    if (req.method === "POST" && url.pathname === "/session") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      return await handleSaveSession(body, res);
    }

    sendText(res, 404, "not found");
  } catch (err) {
    // Log the detail server-side; return a generic message so error internals
    // (stack/paths) aren't exposed to the client (CodeQL js/stack-trace-exposure).
    console.error("dev backend request failed:", err);
    sendText(res, 500, "internal error");
  }
});

server.listen(PORT, () => {
  console.log(`Footlight dev backend listening on http://localhost:${PORT}`);
  console.log(`  CLI: ${CLI_PATH}`);
});
