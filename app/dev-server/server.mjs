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
 *   GET  /check-outdir   (?outdir=<path>) -> JSON {ok, resolved, error?}
 *   GET  /fonts          (?dir=<path>) -> JSON FontInfo[] (fontconfig families,
 *                                         or a scanned user fonts folder)
 *
 * Running `node dev-server/server.mjs` starts the server on PORT; importing the
 * module does NOT — tests build their own instance via `createDevServer()`
 * (optionally overriding the cli/repo-root/history/session paths) and listen on
 * an ephemeral port.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, constants as fsConstants } from "node:fs";
import { writeFile, readFile, mkdtemp, stat, readdir, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, isAbsolute, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// Shared, pure ffmpeg/ffprobe command builders + parsers — ONE definition used
// by the CLI, the engine, and this dev server (compiled to dist/ by `npm run
// build`). Keeps the two backends from drifting apart.
import {
  frameExtractArgs,
  frameExtractTailArgs,
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
// Persisted render history and working session live at the repo root (next to
// where GUI renders land); see the defaults in `createRequestListener`.

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
  let result = await run("ffmpeg", frameExtractArgs(source, Number(t)), {
    collectStdoutBinary: true,
  });
  // An exact-time seek at/after EOF (seek to the clip end, or the final sampled
  // still) decodes no frame, so the mjpeg encoder fails with no packets. Fall
  // back to the last available frame instead of surfacing a failure.
  if (result.code !== 0 || result.stdout.length === 0) {
    result = await run("ffmpeg", frameExtractTailArgs(source), {
      collectStdoutBinary: true,
    });
  }
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
async function handleTrack(body, res, cliPath) {
  const dir = await mkdtemp(join(tmpdir(), "footlight-"));
  const reqPath = join(dir, "track-request.json");
  await writeFile(reqPath, body, "utf8");

  const result = await run("node", [cliPath, "track", reqPath]);
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
async function handleRender(body, opts, res, { cliPath, repoRoot }) {
  const dir = await mkdtemp(join(tmpdir(), "footlight-"));
  // .json extension so the CLI auto-detects the JSON manifest path (not CSV).
  const manifestPath = join(dir, "manifest.json");
  await writeFile(manifestPath, body, "utf8");

  // Resolve a relative outdir against the repo root, not this server's cwd
  // (app/), so renders land in the project-root clips/. An absolute outdir is
  // honored as-is.
  const outDir = isAbsolute(opts.outdir || "clips")
    ? opts.outdir
    : resolve(repoRoot, opts.outdir || "clips");
  // Render flags from Settings -> CLI. --outdir is appended LAST so the log's
  // trailing `--outdir <dir>` still parses cleanly on the client.
  const args = [cliPath, "render", manifestPath];
  if (opts.crf) args.push("--crf", String(opts.crf));
  if (opts.preset) args.push("--preset", opts.preset);
  if (opts.audioBitrate) args.push("--audio-bitrate", opts.audioBitrate);
  if (opts.dryRun) args.push("--dry-run");
  if (opts.burnCaptions) args.push("--burn-captions");
  if (opts.captionFont) args.push("--caption-font", opts.captionFont);
  if (opts.captionColor) args.push("--caption-color", opts.captionColor);
  if (opts.captionOutlineColor) args.push("--caption-outline-color", opts.captionOutlineColor);
  if (opts.captionBold) args.push("--caption-bold");
  if (opts.captionItalic) args.push("--caption-italic");
  if (opts.captionUnderline) args.push("--caption-underline");
  if (opts.captionShadow) args.push("--caption-shadow");
  if (opts.captionBox) args.push("--caption-box");
  if (opts.captionBoxColor) args.push("--caption-box-color", opts.captionBoxColor);
  if (opts.captionAngle != null) args.push("--caption-angle", String(opts.captionAngle));
  args.push("--outdir", outDir);
  const result = await run("node", args);
  const log = `$ node ${args.join(" ")}\n\n${result.stdout}${result.stderr}`;
  sendJson(res, 200, { ok: result.code === 0, log });
}

/** A short, user-facing reason for a filesystem error (no raw errno/stack). */
export function friendlyFsError(err) {
  switch (err?.code) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EROFS":
      return "the drive is read-only";
    case "ENOTDIR":
      return "part of the path is not a folder";
    case "ENOENT":
      return "the parent folder does not exist";
    case "ENOSPC":
      return "the disk is full";
    default:
      return "it could not be created";
  }
}

/**
 * GET /check-outdir — resolve `outdir` exactly like /render does (relative paths
 * against the repo root), create it if missing, and confirm it's writable. Returns
 * {ok, resolved, error?} so the GUI can warn before a render instead of surfacing
 * a raw EACCES mid-run (issue #58).
 */
async function handleCheckOutdir(outdir, res, repoRoot) {
  const resolved = isAbsolute(outdir || "clips")
    ? outdir || "clips"
    : resolve(repoRoot, outdir || "clips");
  try {
    await mkdir(resolved, { recursive: true });
    // create_dir on an EXISTING read-only dir succeeds, so probe writability too.
    await access(resolved, fsConstants.W_OK);
    sendJson(res, 200, { ok: true, resolved });
  } catch (err) {
    sendJson(res, 200, { ok: false, resolved, error: friendlyFsError(err) });
  }
}

/** GET /history — the persisted render history; [] if missing or malformed. */
async function handleLoadHistory(res, historyPath) {
  let entries = [];
  try {
    entries = JSON.parse(await readFile(historyPath, "utf8"));
  } catch {
    // Missing file or unparseable JSON — start fresh.
    entries = [];
  }
  sendJson(res, 200, entries);
}

/** POST /history — persist the full history array from the body's `entries`. */
async function handleSaveHistory(body, res, historyPath) {
  const entries = JSON.parse(body).entries;
  await writeFile(historyPath, JSON.stringify(entries), "utf8");
  sendJson(res, 200, { ok: true });
}

/** GET /session — the persisted working session; null if missing or malformed. */
async function handleLoadSession(res, sessionPath) {
  let data = null;
  try {
    data = JSON.parse(await readFile(sessionPath, "utf8"));
  } catch {
    // Missing file or unparseable JSON — no session to restore.
    data = null;
  }
  sendJson(res, 200, data);
}

/** POST /session — persist the working session from the body's `data`. */
async function handleSaveSession(body, res, sessionPath) {
  const data = JSON.parse(body).data;
  await writeFile(sessionPath, JSON.stringify(data), "utf8");
  sendJson(res, 200, { ok: true });
}

/** Font file extensions we scan for in a user fonts folder. */
const FONT_EXTS = new Set([".ttf", ".otf", ".ttc"]);
/** Sensible caps so a pathological directory can't wedge the dev server. */
export const FONT_SCAN_MAX_DEPTH = 8;
export const FONT_SCAN_MAX_FILES = 5000;

/**
 * Recursively collect font-file paths under `dir`, bounded by depth/count.
 * Best-effort: unreadable sub-directories are skipped silently.
 */
export async function collectFontFiles(dir, depth, acc) {
  if (depth > FONT_SCAN_MAX_DEPTH || acc.length >= FONT_SCAN_MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip.
  }
  for (const entry of entries) {
    if (acc.length >= FONT_SCAN_MAX_FILES) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFontFiles(full, depth + 1, acc);
    } else if (entry.isFile() && FONT_EXTS.has(extname(entry.name).toLowerCase())) {
      acc.push(full);
    }
  }
}

/**
 * Scan a user fonts folder for `*.ttf`/`*.otf`/`*.ttc`, resolving each file's
 * real family via `fc-scan` (falling back to the filename stem). Returns a
 * sorted, deduped (by `family+path`) FontInfo[]. A missing/unreadable dir yields
 * `[]` with HTTP 200. The native Tauri backend uses font-kit instead.
 */
async function handleUserFonts(res, dir) {
  const files = [];
  await collectFontFiles(dir, 0, files);

  const byKey = new Map();
  for (const file of files) {
    let family = "";
    try {
      const scan = await run("fc-scan", [`--format=%{family[0]}\n`, file]);
      if (scan.code === 0) family = scan.stdout.split("\n")[0]?.trim() || "";
    } catch {
      // fc-scan not on PATH — fall back to the filename stem below.
    }
    if (!family) family = basename(file, extname(file));
    if (!family) continue;
    const key = `${family} ${file}`;
    if (byKey.has(key)) continue;
    byKey.set(key, { family, path: file });
  }
  const fonts = [...byKey.values()].sort((a, b) =>
    a.family.toLowerCase().localeCompare(b.family.toLowerCase()),
  );
  sendJson(res, 200, fonts);
}

/**
 * GET /fonts — installed font families via `fc-list` (fontconfig), as a sorted,
 * deduped FontInfo[] (`{family, path}`). With an optional `?dir=<path>` it scans
 * that folder instead (see `handleUserFonts`). Best-effort: if `fc-list` is
 * missing or errors we return `[]` with HTTP 200 so the picker falls back to
 * free-text — never a hard failure. The native Tauri backend uses font-kit.
 */
async function handleFonts(res) {
  let result;
  try {
    result = await run("fc-list", ["--format=%{family[0]}\t%{file}\n"]);
  } catch {
    // fc-list not on PATH (e.g. bare macOS without fontconfig) — graceful empty.
    return sendJson(res, 200, []);
  }
  if (result.code !== 0) {
    return sendJson(res, 200, []);
  }
  // Dedupe by family, keeping the first file path seen for each.
  const byFamily = new Map();
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [family, file] = line.split("\t");
    const fam = (family || "").trim();
    if (!fam || byFamily.has(fam)) continue;
    const path = (file || "").trim();
    byFamily.set(fam, path ? { family: fam, path } : { family: fam });
  }
  const fonts = [...byFamily.values()].sort((a, b) =>
    a.family.toLowerCase().localeCompare(b.family.toLowerCase()),
  );
  sendJson(res, 200, fonts);
}

/**
 * Build the request listener with everything path-dependent injectable so tests
 * can point it at a temp CLI / repo root / history / session without touching
 * the real ones. The defaults make `createRequestListener()` behave exactly as
 * the dev server always has.
 */
export function createRequestListener({
  cliPath = CLI_PATH,
  repoRoot = REPO_ROOT,
  historyPath,
  sessionPath,
} = {}) {
  const history = historyPath ?? resolve(repoRoot, ".footlight-history.json");
  const session = sessionPath ?? resolve(repoRoot, ".footlight-session.json");

  return async (req, res) => {
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

      // GET /env-key — the BYOK Gemini key from THIS server's environment
      // (GEMINI_API_KEY / FOOTLIGHT_GEMINI_API_KEY), or "" if unset. Lets `make gui`
      // pick up a key from your shell without pasting it into the GUI. Dev-only.
      if (req.method === "GET" && url.pathname === "/env-key") {
        const key = (process.env.GEMINI_API_KEY || process.env.FOOTLIGHT_GEMINI_API_KEY || "").trim();
        return sendText(res, 200, key);
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
        return await handleTrack(body, res, cliPath);
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
          captionColor: url.searchParams.get("captionColor") || undefined,
          captionOutlineColor: url.searchParams.get("captionOutlineColor") || undefined,
          captionBold: url.searchParams.get("captionBold") === "1",
          captionItalic: url.searchParams.get("captionItalic") === "1",
          captionUnderline: url.searchParams.get("captionUnderline") === "1",
          captionShadow: url.searchParams.get("captionShadow") === "1",
          captionBox: url.searchParams.get("captionBox") === "1",
          captionBoxColor: url.searchParams.get("captionBoxColor") || undefined,
          captionAngle: url.searchParams.get("captionAngle") || undefined,
        };
        return await handleRender(body, opts, res, { cliPath, repoRoot });
      }

      if (req.method === "GET" && url.pathname === "/check-outdir") {
        return await handleCheckOutdir(url.searchParams.get("outdir") || "", res, repoRoot);
      }

      if (req.method === "GET" && url.pathname === "/history") {
        return await handleLoadHistory(res, history);
      }

      if (req.method === "POST" && url.pathname === "/history") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        return await handleSaveHistory(body, res, history);
      }

      if (req.method === "GET" && url.pathname === "/fonts") {
        const dir = url.searchParams.get("dir");
        if (dir) return await handleUserFonts(res, dir);
        return await handleFonts(res);
      }

      if (req.method === "GET" && url.pathname === "/session") {
        return await handleLoadSession(res, session);
      }

      if (req.method === "POST" && url.pathname === "/session") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        return await handleSaveSession(body, res, session);
      }

      sendText(res, 404, "not found");
    } catch (err) {
      // Log the detail server-side; return a generic message so error internals
      // (stack/paths) aren't exposed to the client (CodeQL js/stack-trace-exposure).
      console.error("dev backend request failed:", err);
      sendText(res, 500, "internal error");
    }
  };
}

/** Build (but do not start) the dev server; tests listen on an ephemeral port. */
export function createDevServer(config = {}) {
  return createServer(createRequestListener(config));
}

// Start listening only when executed directly (`node dev-server/server.mjs`,
// i.e. `npm run dev:server`) — importing this module must NOT bind the port.
const runAsScript =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runAsScript) {
  createDevServer().listen(PORT, () => {
    console.log(`Footlight dev backend listening on http://localhost:${PORT}`);
    console.log(`  CLI: ${CLI_PATH}`);
  });
}
