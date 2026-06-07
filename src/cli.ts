// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Footlight CLI.
 *
 * Commands:
 *   footlight render <manifest.csv|.json> [--outdir clips] [--crf 19]
 *                    [--preset medium] [--audio-bitrate copy] [--dry-run]
 *   footlight probe  <source>    # dims + cropdetect suggestion (black bars only)
 *   footlight scenes <source>    # detected scene-cut timestamps (seconds)
 *   footlight track  <request.json>  # locate a subject; print TrackSample[] JSON
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCsv } from "./csv.js";
import {
  buildFfmpegArgs,
  buildCaptionAss,
  probeDimensions,
  ffmpegHasFilter,
  run,
  cropdetectArgs,
  parseCropdetect,
  scenesArgs,
  parseScenes,
  frameExtractArgs,
  SCENE_THRESHOLD,
  type ClipRow,
  type CropPathKeyframe,
  type CropWindowSpec,
  DEFAULT_RENDER_OPTIONS,
} from "./engine.js";
import type { ClipSpec } from "./manifest.js";
import type { Dims } from "./manifest.js";
import type { TrackSample, TrackFrame, VisionTracker } from "./providers/types.js";
import { GeminiTracker } from "./providers/gemini.js";
import { MockTracker } from "./providers/mock.js";

/** Parsed CLI arguments: positionals plus a flag map. */
interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

/**
 * Tiny argument parser. Recognizes `--flag value`, `--flag=value`, and boolean
 * `--flag`. The set of flags that take values is passed in so booleans like
 * `--dry-run` are not mistaken for value-flags.
 */
function parseArgs(argv: string[], valueFlags: Set<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      if (valueFlags.has(name)) {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new Error(`--${name} requires a value`);
        }
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

const USAGE = `footlight — 16:9 -> 9:16 vertical clip batcher

Usage:
  footlight render <manifest.csv|.json> [--outdir clips] [--crf 19] [--preset medium]
                                  [--audio-bitrate copy|256k] [--dry-run]
                                  [--burn-captions [--caption-font <path|name>]
                                   [--caption-color #RRGGBB] [--caption-outline-color #RRGGBB]
                                   [--caption-bold] [--caption-italic] [--caption-underline]]
  footlight probe  <source>         dims + cropdetect suggestion (black bars only)
  footlight scenes <source>         detected scene-cut timestamps (seconds)
  footlight track  <request.json>   locate a subject; print TrackSample[] JSON to stdout

A .json manifest is an array of clip specs; a clip may carry an eased "cropPath"
([{t,x},...]) that takes precedence over crop_offset. CSV manifests are unchanged.`;

/** Entry point. Returns a process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "render":
      return cmdRender(rest);
    case "probe":
      return cmdProbe(rest);
    case "scenes":
      return cmdScenes(rest);
    case "track":
      return cmdTrack(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return command === undefined ? 1 : 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

/**
 * One render item: the manifest row (CSV row OR JSON clip spec) plus an
 * optional eased crop path. The CSV path leaves `cropPath` undefined; the JSON
 * path may set it, in which case the engine renders the smoothstep `x='…'`
 * expression and it takes precedence over `crop_offset`.
 */
interface RenderItem {
  row: ClipRow;
  cropPath?: CropPathKeyframe[];
  cropWindow?: CropWindowSpec;
}

/** `footlight render` — read a CSV or JSON manifest, build + run ffmpeg per row. */
async function cmdRender(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(
    argv,
    new Set([
      "outdir",
      "crf",
      "preset",
      "audio-bitrate",
      "caption-font",
      "caption-color",
      "caption-outline-color",
    ]),
  );

  const manifestPath = positionals[0];
  if (!manifestPath) {
    console.error("render: missing <manifest.csv|.json>\n\n" + USAGE);
    return 1;
  }

  const outdir = String(flags.get("outdir") ?? "clips");
  const crf = flags.has("crf") ? Number(flags.get("crf")) : DEFAULT_RENDER_OPTIONS.crf;
  const preset = String(flags.get("preset") ?? DEFAULT_RENDER_OPTIONS.preset);
  const audioBitrate = String(flags.get("audio-bitrate") ?? DEFAULT_RENDER_OPTIONS.audioBitrate);
  const dryRun = flags.get("dry-run") === true;

  // Captions (SPEC §6.5): off unless --burn-captions. --caption-font takes a
  // file path (.ttf/.otf, or anything with a path separator) → an embedded
  // font dir for libass, otherwise a fontconfig family name.
  const burnCaptions = flags.get("burn-captions") === true;
  const captionFontArg = flags.has("caption-font") ? String(flags.get("caption-font")) : "";
  const looksLikePath = /[\\/]/.test(captionFontArg) || /\.(ttf|otf|ttc)$/i.test(captionFontArg);
  const captionFontFile = looksLikePath ? captionFontArg : undefined;
  // For a font FILE, resolve its real family — filename != family for many fonts,
  // and libass matches the ASS Fontname against the fonts it loads from fontsdir,
  // so the stem alone would silently miss. Best-effort via fc-scan; the engine
  // falls back to the file stem when it's unavailable.
  let captionFontName = !looksLikePath && captionFontArg ? captionFontArg : undefined;
  if (captionFontFile && !captionFontName) {
    captionFontName = resolveFontFamily(captionFontFile);
  }
  // Caption style (libass): fill/outline colour (#RRGGBB) + bold/italic/underline.
  const captionColor = flags.has("caption-color") ? String(flags.get("caption-color")) : undefined;
  const captionOutlineColor = flags.has("caption-outline-color")
    ? String(flags.get("caption-outline-color"))
    : undefined;
  const captionBold = flags.get("caption-bold") === true;
  const captionItalic = flags.get("caption-italic") === true;
  const captionUnderline = flags.get("caption-underline") === true;

  if (Number.isNaN(crf)) {
    console.error("render: --crf must be a number");
    return 1;
  }

  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (err) {
    console.error(`render: cannot read ${manifestPath}: ${errMsg(err)}`);
    return 1;
  }

  // A .json manifest is an array of clip specs (with optional cropPath); any
  // other extension is parsed as the unchanged CSV manifest.
  let items: RenderItem[];
  try {
    items = manifestPath.toLowerCase().endsWith(".json")
      ? parseJsonManifest(text)
      : (parseCsv(text) as ClipRow[]).map((row) => ({ row }));
  } catch (err) {
    console.error(`render: ${errMsg(err)}`);
    return 1;
  }

  if (items.length === 0) {
    console.error("No rows in manifest.");
    return 1;
  }

  // Captions preflight (SPEC §6.5): captions are burned in via libass's
  // `subtitles` filter, which exists only when ffmpeg is built with libass.
  // Check once up front and fail with an actionable message rather than letting
  // every clip die on a cryptic "No such filter".
  if (burnCaptions) {
    try {
      if (!(await ffmpegHasFilter("subtitles"))) {
        console.error(
          'render: --burn-captions needs an ffmpeg built with libass, but yours has no "subtitles" filter.\n' +
            "  Install one (macOS: brew install homebrew-ffmpeg/ffmpeg/ffmpeg) or drop --burn-captions.",
        );
        return 1;
      }
    } catch {
      // ffmpeg couldn't be run at all — let the per-clip probe report that.
    }
  }

  mkdirSync(outdir, { recursive: true });

  let failures = 0;
  for (let i = 0; i < items.length; i++) {
    const { row, cropPath } = items[i]!;
    const label = `[${i + 1}/${items.length}]`;

    // Per-clip caption ASS document (SPEC §6.5). When captions are on and the
    // row has a hook/title, `buildCaptionAss` returns an ASS document; write it
    // to a unique temp file and hand its path to the engine, which appends a
    // `subtitles=filename='…'` filter. The file is always removed below.
    let captionAssPath: string | undefined;
    if (burnCaptions) {
      const ass = buildCaptionAss(row, {
        crf,
        preset,
        audioBitrate,
        burnCaptions,
        ...(captionFontFile ? { captionFontFile } : {}),
        ...(captionFontName ? { captionFontName } : {}),
        ...(captionColor ? { captionColor } : {}),
        ...(captionOutlineColor ? { captionOutlineColor } : {}),
        captionBold,
        captionItalic,
        captionUnderline,
      });
      if (ass !== null) {
        const path = join(tmpdir(), `footlight_cap_${i}_${process.pid}.ass`);
        try {
          writeFileSync(path, ass, "utf8");
          captionAssPath = path;
        } catch (err) {
          console.error(`${label} SKIP — cannot write caption file: ${errMsg(err)}`);
          failures++;
          continue;
        }
      }
    }

    try {
      let built;
      try {
        const source = (row.source_file ?? "").trim();
        if (!source) {
          throw new Error("source_file is empty");
        }
        if (!existsSync(source)) {
          throw new Error(`source_file not found: ${source}`);
        }
        const dims = await probeDimensions(source);
        built = buildFfmpegArgs(row, {
          outdir,
          crf,
          preset,
          audioBitrate,
          dims,
          cropPath,
          cropWindow: items[i]!.cropWindow,
          burnCaptions,
          ...(captionAssPath ? { captionAssPath } : {}),
          ...(captionFontFile ? { captionFontFile } : {}),
          ...(captionFontName ? { captionFontName } : {}),
        });
      } catch (err) {
        console.error(`${label} SKIP — ${errMsg(err)}`);
        failures++;
        continue;
      }

      if (dryRun) {
        console.log(`${label} ffmpeg ${built.args.join(" ")}`);
        continue;
      }

      console.log(`${label} ${built.outPath}`);
      const result = await run("ffmpeg", built.args, { inheritStdio: true });
      if (result.code !== 0) {
        console.error(`${label} FAILED — ffmpeg exit ${result.code}`);
        failures++;
      }
    } finally {
      if (captionAssPath) {
        try {
          unlinkSync(captionAssPath);
        } catch {
          // Best-effort cleanup; ignore if it's already gone.
        }
      }
    }
  }

  const done = items.length - failures;
  const tail = failures ? `, ${failures} failed/skipped` : "";
  console.log(`\nDone: ${done}/${items.length} clips${tail}`);
  return failures ? 1 : 0;
}

/**
 * Parse a JSON manifest (array of `ClipSpec`) into render items. Each spec maps
 * to a `ClipRow` for the engine; a `cropPath` (eased {t,x} keyframes) is carried
 * separately so `buildFfmpegArgs` renders the smoothstep expression and it takes
 * precedence over `crop_offset`. Throws on a non-array or malformed shape.
 */
function parseJsonManifest(text: string): RenderItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${errMsg(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("JSON manifest must be an array of clip specs");
  }
  return parsed.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`clip [${i}] is not an object`);
    }
    const spec = raw as ClipSpec;
    if (typeof spec.source_file !== "string" || !spec.source_file.trim()) {
      throw new Error(`clip [${i}] missing source_file`);
    }
    if (typeof spec.in_point !== "string" || typeof spec.out_point !== "string") {
      throw new Error(`clip [${i}] missing in_point/out_point`);
    }
    const row: ClipRow = {
      source_file: spec.source_file,
      in_point: spec.in_point,
      out_point: spec.out_point,
    };
    if (spec.crop_offset !== undefined) row.crop_offset = spec.crop_offset;
    if (spec.content_crop !== undefined) row.content_crop = spec.content_crop;
    if (spec.out_name !== undefined) row.out_name = spec.out_name;
    if (spec.notes !== undefined) row.notes = spec.notes;
    if (spec.hook !== undefined) row.hook = spec.hook;
    if (spec.title !== undefined) row.title = spec.title;
    if (spec.text_position !== undefined) row.text_position = spec.text_position;

    let cropPath: CropPathKeyframe[] | undefined;
    if (spec.cropPath !== undefined) {
      if (!Array.isArray(spec.cropPath)) {
        throw new Error(`clip [${i}] cropPath must be an array of {t,x}`);
      }
      cropPath = spec.cropPath.map((kf, k) => {
        const t = Number((kf as { t?: unknown })?.t);
        const x = Number((kf as { x?: unknown })?.x);
        if (!Number.isFinite(t) || !Number.isFinite(x)) {
          throw new Error(`clip [${i}] cropPath[${k}] needs numeric t and x`);
        }
        return { t, x };
      });
    }

    let cropWindow: CropWindowSpec | undefined;
    if (spec.cropWindow !== undefined) {
      const raw = spec.cropWindow as Partial<Record<keyof CropWindowSpec, unknown>>;
      const x = Number(raw.x);
      const y = Number(raw.y);
      const w = Number(raw.w);
      const h = Number(raw.h);
      if (![x, y, w, h].every((n) => Number.isFinite(n))) {
        throw new Error(`clip [${i}] cropWindow needs numeric x, y, w, h`);
      }
      cropWindow = { x, y, w, h };
    }

    return { row, cropPath, cropWindow };
  });
}

/** `footlight probe` — print dims and a cropdetect (black-bar) suggestion. */
async function cmdProbe(argv: string[]): Promise<number> {
  const { positionals } = parseArgs(argv, new Set());
  const source = positionals[0];
  if (!source) {
    console.error("probe: missing <source>");
    return 1;
  }

  let dims: [number, number];
  try {
    dims = await probeDimensions(source);
  } catch (err) {
    console.error(`probe: ${errMsg(err)}`);
    return 1;
  }
  console.log(`dimensions: ${dims[0]}x${dims[1]}`);

  // cropdetect writes its analysis to stderr; surface the last suggested crop=
  // region. This catches BLACK BARS ONLY.
  const result = await run("ffmpeg", cropdetectArgs(source), { allowFailure: true });
  const suggestion = parseCropdetect(result.stderr);
  if (suggestion) {
    console.log(`cropdetect suggestion: crop=${suggestion}`);
  } else {
    console.log("cropdetect suggestion: none (no black bars detected)");
  }
  console.log(
    "note: cropdetect catches BLACK BARS ONLY — colored/blurred-banner " +
      "pillarboxing is invisible to it. Verify framing on the actual pixels.",
  );
  return 0;
}

/** `footlight scenes` — print detected scene-cut timestamps in seconds. */
async function cmdScenes(argv: string[]): Promise<number> {
  const { positionals } = parseArgs(argv, new Set());
  const source = positionals[0];
  if (!source) {
    console.error("scenes: missing <source>");
    return 1;
  }

  // showinfo prints pts_time for each frame that passes the scene filter.
  const result = await run("ffmpeg", scenesArgs(source), { allowFailure: true });
  const times = parseScenes(result.stderr);

  if (times.length === 0) {
    console.log(`No scene cuts detected (threshold ${SCENE_THRESHOLD}).`);
    return 0;
  }
  console.log(`Detected ${times.length} scene cut(s) (seconds):`);
  for (const t of times) {
    console.log(t.toFixed(3));
  }
  return 0;
}

/** The request shape `footlight track <request.json>` reads from disk. */
interface TrackCliRequest {
  sourcePath: string;
  region: Dims;
  sampleTimes: number[];
  subjectHint?: string;
  /** BYOK; required for the (default) gemini provider unless `mock` is set. */
  apiKey?: string;
  provider?: "gemini";
  /** If true, use the deterministic MockTracker (no network). */
  mock?: boolean;
  /** Source-seconds offset of the shot's In point (frames are read from here). */
  startSec?: number;
  /** Optional `W:H:X:Y` content crop applied during frame extraction. */
  contentCrop?: string;
}

/**
 * `footlight track <request.json>` — read a track request, run the selected
 * vision tracker, and print the resulting `TrackSample[]` as JSON to stdout
 * (and NOTHING else on stdout). Picks `MockTracker` when `mock` is true or
 * `FOOTLIGHT_TRACK_MOCK=1`; otherwise `GeminiTracker`, which requires `apiKey`.
 * All diagnostics go to stderr; errors return a non-zero exit code.
 */
async function cmdTrack(argv: string[]): Promise<number> {
  const { positionals } = parseArgs(argv, new Set());
  const reqPath = positionals[0];
  if (!reqPath) {
    console.error("track: missing <request.json>\n\n" + USAGE);
    return 1;
  }

  let text: string;
  try {
    text = readFileSync(reqPath, "utf8");
  } catch (err) {
    console.error(`track: cannot read ${reqPath}: ${errMsg(err)}`);
    return 1;
  }

  let req: TrackCliRequest;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("request must be a JSON object");
    }
    req = parsed as TrackCliRequest;
  } catch (err) {
    console.error(`track: ${errMsg(err)}`);
    return 1;
  }

  if (typeof req.sourcePath !== "string" || !req.sourcePath.trim()) {
    console.error("track: request.sourcePath is required");
    return 1;
  }
  const region = req.region;
  if (
    !region ||
    typeof region.width !== "number" ||
    typeof region.height !== "number" ||
    !(region.width > 0) ||
    !(region.height > 0)
  ) {
    console.error("track: request.region must be { width>0, height>0 }");
    return 1;
  }
  if (!Array.isArray(req.sampleTimes) || req.sampleTimes.some((t) => !Number.isFinite(t))) {
    console.error("track: request.sampleTimes must be an array of numbers");
    return 1;
  }

  const useMock = req.mock === true || process.env["FOOTLIGHT_TRACK_MOCK"] === "1";
  const startSec = Number.isFinite(req.startSec) ? Number(req.startSec) : 0;

  // BYOK key resolution: an env var (GEMINI_API_KEY, or FOOTLIGHT_GEMINI_API_KEY)
  // takes precedence so scripts/`.env` needn't embed the key in request.json;
  // the request's own apiKey is the fallback.
  const envKey = (
    process.env["GEMINI_API_KEY"] ||
    process.env["FOOTLIGHT_GEMINI_API_KEY"] ||
    ""
  ).trim();
  const apiKey = envKey || (req.apiKey ?? "").trim();

  let tracker: VisionTracker;
  let frames: TrackFrame[] | undefined;
  if (useMock) {
    tracker = new MockTracker({ region });
  } else {
    if (req.provider && req.provider !== "gemini") {
      console.error(`track: unsupported provider ${JSON.stringify(req.provider)}`);
      return 1;
    }
    if (!apiKey) {
      console.error(
        "track: apiKey is required for the gemini provider (BYOK). " +
          "Set GEMINI_API_KEY in the environment, put it in request.apiKey, or set " +
          "request.mock=true (or FOOTLIGHT_TRACK_MOCK=1) to run the offline MockTracker.",
      );
      return 1;
    }
    tracker = new GeminiTracker();
    // Image-based tracking: extract one frame per sample time from the In→Out
    // window (in the working region) and hand them to the provider — done here in
    // Node so the browser-safe provider never touches the filesystem.
    frames = extractTrackFrames(req.sourcePath, startSec, req.sampleTimes, req.contentCrop);
    if (frames.length === 0) {
      console.error(
        "track: could not extract any frames (check the source path, the In/Out " +
          "window, and that ffmpeg is on PATH).",
      );
      return 1;
    }
  }

  let samples: TrackSample[];
  try {
    samples = await tracker.track({
      sourcePath: req.sourcePath,
      region,
      sampleTimes: req.sampleTimes,
      subjectHint: req.subjectHint,
      // MockTracker ignores apiKey; GeminiTracker requires it (checked above).
      apiKey,
      startSec,
      contentCrop: req.contentCrop,
      frames,
    });
  } catch (err) {
    console.error(`track: ${errMsg(err)}`);
    return 1;
  }

  // stdout carries ONLY the TrackSample[] JSON.
  console.log(JSON.stringify(samples));
  return 0;
}

/**
 * Extract one JPEG frame per clip-relative sample time from the In→Out window of
 * `source` (optionally content-cropped, downscaled), returned base64 for
 * image-based tracking. Frames that fail to extract (e.g. a time past EOF) are
 * skipped — the smoother bridges small gaps.
 */
function extractTrackFrames(
  source: string,
  startSec: number,
  sampleTimes: number[],
  contentCrop?: string,
): TrackFrame[] {
  const frames: TrackFrame[] = [];
  for (const t of sampleTimes) {
    const args = frameExtractArgs(source, startSec + t, { contentCrop, maxWidth: 1024 });
    try {
      const buf = execFileSync("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 });
      if (buf.length > 0) {
        frames.push({ t, dataBase64: buf.toString("base64"), mimeType: "image/jpeg" });
      }
    } catch {
      // Skip frames that fail to extract.
    }
  }
  return frames;
}

/** Best-effort error message extraction. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort: the family name of a font FILE via `fc-scan`, so the burned
 * caption's ASS `Fontname` matches what libass loads from `fontsdir`. Returns
 * undefined when fc-scan is absent/failing — the engine then falls back to the
 * file's stem.
 */
function resolveFontFamily(fontPath: string): string | undefined {
  try {
    const out = execFileSync("fc-scan", ["--format=%{family[0]}", fontPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
