// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Footlight commands: the pure ffmpeg/ffprobe argument builders and the parsers
 * for their output (probe, frame extraction, cropdetect, scenes, the loudness
 * pass, and the `ffmpeg -filters` listing check).
 *
 * Browser-safe like `core.ts` (no Node built-in imports), which re-exports
 * everything here so existing `core.js` / `engine.js` / `@core` imports keep
 * working.
 */

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe command builders + output parsers (SPEC §6).
//
// One pure definition of each auxiliary command (frame extraction, probe,
// cropdetect, scenes) so the Node CLI (`cli.ts`), the engine (`engine.ts`), and
// the web dev backend (`app/dev-server/server.mjs`) all share it instead of
// hand-rolling the same arg arrays and regexes. Pure (string in, string[]/value
// out) so they stay browser-safe and unit-testable.
//
// The native Rust backend (`app/src-tauri/src/main.rs`) mirrors these commands
// by hand — it cannot import TS — so keep it in sync when the args/thresholds
// here change.
// ---------------------------------------------------------------------------

/** Scene-detection threshold for ffmpeg's `scene` filter (0..1). */
export const SCENE_THRESHOLD = 0.4;

/**
 * ffprobe args for a source's first video stream: width, height (+ container
 * duration). Pair with `parseProbe`.
 */
export function ffprobeStreamArgs(source: string): string[] {
  return [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:format=duration",
    "-of",
    "json",
    source,
  ];
}

/** Parse `ffprobeStreamArgs` JSON stdout into dimensions + duration (0 if absent). */
export function parseProbe(stdout: string): { width: number; height: number; duration: number } {
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number }>;
    format?: { duration?: string | number };
  };
  const stream = parsed.streams?.[0] ?? {};
  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    duration: Number(parsed.format?.duration) || 0,
  };
}

/**
 * Seconds before EOF that `frameExtractTailArgs` grabs the last frame from. An
 * exact-time seek that lands at/after the final frame decodes NOTHING (input-seek
 * past the last frame drops every frame), so the mjpeg encoder opens with no
 * packet and the whole command fails — this is the EOF fallback's seek distance.
 */
export const FRAME_TAIL_SEEK_SEC = 0.2;

/** Shared tail of a single-frame MJPEG-on-stdout command (everything after seek). */
function frameExtractArgsWithSeek(
  seek: string[],
  source: string,
  opts: { contentCrop?: string; maxWidth?: number },
): string[] {
  const filters: string[] = [];
  if (opts.contentCrop) filters.push(`crop=${opts.contentCrop}`);
  if (opts.maxWidth && opts.maxWidth > 0) {
    // Only shrink (never upscale); -2 keeps height even for the JPEG encoder.
    filters.push(`scale='min(${Math.round(opts.maxWidth)},iw)':-2`);
  }
  const vf = filters.length ? ["-vf", filters.join(",")] : [];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...seek,
    "-i",
    source,
    ...vf,
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-c:v",
    "mjpeg",
    "-q:v",
    "3",
    "-",
  ];
}

/**
 * ffmpeg args to extract ONE frame at `t` seconds as MJPEG on stdout. Accuracy
 * comes from INPUT-seek (`-ss` before `-i`): it decodes from the nearest
 * keyframe up to `t` and emits the displayed frame.
 *
 * If `t` is at/after the source's end (e.g. seeking to the very end, or the final
 * sampled still), this decodes nothing and the command FAILS — callers should
 * fall back to `frameExtractTailArgs`, which grabs the last available frame.
 *
 * `opts.contentCrop` (`W:H:X:Y`) crops to the working region first; `opts.maxWidth`
 * downscales the long edge (keeping even dimensions) — both used by image-based
 * subject tracking to keep the frame in working-region space and the payload small.
 */
export function frameExtractArgs(
  source: string,
  t: number,
  opts: { contentCrop?: string; maxWidth?: number } = {},
): string[] {
  const seek = Number.isFinite(t) ? t : 0;
  return frameExtractArgsWithSeek(["-ss", String(seek)], source, opts);
}

/**
 * Fallback for `frameExtractArgs`: grab the LAST decodable frame by seeking
 * relative to EOF (`-sseof -FRAME_TAIL_SEEK_SEC`). Use this when an exact-time
 * extraction yields no frame because the requested time was at/past the end —
 * seeking from EOF always lands on a real frame, so the preview/still shows the
 * clip's final frame instead of erroring.
 */
export function frameExtractTailArgs(
  source: string,
  opts: { contentCrop?: string; maxWidth?: number } = {},
): string[] {
  return frameExtractArgsWithSeek(["-sseof", String(-FRAME_TAIL_SEEK_SEC)], source, opts);
}

/**
 * ffmpeg args for a cropdetect (BLACK BARS ONLY) probe. cropdetect writes its
 * analysis to stderr; pass that to `parseCropdetect` for the suggestion.
 */
export function cropdetectArgs(source: string): string[] {
  return [
    "-hide_banner",
    "-ss",
    "60",
    "-i",
    source,
    "-vf",
    "cropdetect=limit=24:round=2",
    "-frames:v",
    "300",
    "-f",
    "null",
    "-",
  ];
}

/** Pull the LAST `W:H:X:Y` cropdetect suggestion out of ffmpeg stderr, or null. */
export function parseCropdetect(stderr: string): string | null {
  const matches = [...stderr.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)];
  return matches.length > 0 ? matches[matches.length - 1]![1]! : null;
}

/**
 * ffmpeg args for scene-cut detection. `showinfo` prints a `pts_time:` marker on
 * stderr for each frame passing the scene filter; pass stderr to `parseScenes`.
 */
export function scenesArgs(source: string): string[] {
  return [
    "-hide_banner",
    "-i",
    source,
    "-vf",
    // Downscale to 144p before the scene metric so the per-frame diff is cheap
    // (cut detection is robust to resolution); keeps the scan light enough to run
    // automatically in the background on load.
    `scale=-2:144,select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    "-f",
    "null",
    "-",
  ];
}

/** Parse scene-cut timestamps (seconds, rounded to ms) from ffmpeg stderr. */
export function parseScenes(stderr: string): number[] {
  const times: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    times.push(Number(Number(m[1]).toFixed(3)));
  }
  return times;
}

/**
 * ffmpeg args for the production loudness pass — ONE decode yielding BOTH signals
 * the timeline needs (the `ebur128` analysis filter passes audio through, so we
 * can log LUFS *and* emit PCM from the same run). `-loglevel verbose` is REQUIRED
 * — ebur128 prints only its end-of-run Summary at the default `info` level; the
 * per-frame `[Parsed_ebur128…] t: … M:<LUFS> …` lines (≈10/sec) appear at
 * verbose. `-nostats` keeps the periodic progress line out. `-ac 1 -ar 8000` is
 * plenty for an energy envelope (loudness over time, not fidelity).
 *   • stderr — per-frame momentary LUFS (`parseEbur128Momentary` → `bucketLufs`),
 *     the *perceptual* envelope for the waveform BARS;
 *   • stdout — mono 8 kHz `f32le` PCM (`bucketLoudness`), the raw-energy RMS
 *     envelope fed to the swell DETECTOR (it exposes the musical dips that
 *     perceptually-gated LUFS smooths away on compressed material).
 * Collect stdout as BINARY and stderr as TEXT from the single invocation.
 */
export function loudnessCombinedArgs(source: string): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "verbose",
    "-i",
    source,
    "-af",
    "ebur128=metadata=1",
    "-ac",
    "1",
    "-ar",
    "8000",
    "-f",
    "f32le",
    "-",
  ];
}

/**
 * Parse the per-frame momentary-loudness values (the `M:` field, in LUFS) from
 * ebur128's log text, in time order. ffmpeg prints, per measurement frame, a
 * line like `[Parsed_ebur128_0 @ 0x…] t: 1.2  TARGET:-23 LUFS  M: -22.4 S:…`.
 * Non-finite readings (`-inf`/`nan`, emitted during the initial 400 ms window or
 * over silence) become `-Infinity` so callers can treat them as the floor.
 */
export function parseEbur128Momentary(log: string): number[] {
  const out: number[] = [];
  const re = /\bM:\s*(-?\d+(?:\.\d+)?|-?inf|nan)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const tok = m[1]!.toLowerCase();
    out.push(tok === "nan" || tok.endsWith("inf") ? Number.NEGATIVE_INFINITY : parseFloat(tok));
  }
  return out;
}

/**
 * Whether `ffmpeg -filters` output advertises a filter named `name`. Pure so the
 * caption preflight (which needs the libass-backed `subtitles`/`ass` filter) is
 * testable without a subprocess. Matches the listing line `<flags> <name>
 * <in>-><out> <desc>`, not a stray mention inside a description.
 */
export function ffmpegListHasFilter(filtersOutput: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\S{1,4}\\s+${escaped}\\s+\\S+->\\S+`, "m").test(filtersOutput);
}
