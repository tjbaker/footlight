// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Footlight render engine — Node-only I/O.
 *
 * Batch-converts 16:9 source videos into clean 9:16 vertical clips via ffmpeg.
 * For each clip the pipeline runs: [optional content-crop] -> cut (in->out) ->
 * crop to 9:16 -> scale to 1080x1920 -> encode H.264 MP4. No captions or
 * branding are burned in; clips are exported clean for per-platform captioning
 * later.
 *
 * The pure, browser-safe transforms (timestamp/crop parsing, `computeCrop`,
 * the `buildFfmpegArgs` argument builder, target constants, etc.) live in
 * `./core.js`. This module holds ONLY the parts that touch the filesystem or
 * spawn subprocesses — `probeDimensions` (ffprobe) and `run` (spawn) — and
 * re-exports the core symbols so existing `import { ... } from "./engine.js"`
 * call sites keep working unchanged.
 *
 * The render logic began as a port of an earlier CSV-driven Python batch script.
 */

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

import { ffprobeStreamArgs, parseProbe, ffmpegListHasFilter } from "./core.js";

export * from "./core.js";

/**
 * Whether this machine's ffmpeg advertises a given filter (e.g. `subtitles` /
 * `ass`, the libass-backed filters captions need). Runs `ffmpeg -filters` and
 * parses it with the pure `ffmpegListHasFilter`. Rejects only if ffmpeg can't be
 * spawned at all (let the caller decide what that means).
 */
export async function ffmpegHasFilter(name: string): Promise<boolean> {
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-filters"], {
    allowFailure: true,
  });
  return ffmpegListHasFilter(stdout, name);
}

/** Probe (width, height) of a video's first video stream via ffprobe. */
export async function probeDimensions(path: string): Promise<[number, number]> {
  const { stdout } = await run("ffprobe", ffprobeStreamArgs(path));
  let probe: ReturnType<typeof parseProbe>;
  try {
    probe = parseProbe(stdout);
  } catch {
    throw new Error(`ffprobe returned unparseable output for ${path}`);
  }
  if (!probe.width || !probe.height) {
    throw new Error(`no video stream found in ${path}`);
  }
  return [probe.width, probe.height];
}

/** Result of running a subprocess. */
export interface RunResult {
  /** Exit code. A signal-killed child gets the shell convention `128 + signo`. */
  code: number;
  /** Set only when the child was killed by a signal (OOM killer, `kill`, …). */
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
}

/** "exited 1" / "killed by SIGKILL" — how a failed child ended, for messages. */
export function describeExit(result: Pick<RunResult, "code" | "signal">): string {
  return result.signal ? `killed by ${result.signal}` : `exited ${result.code}`;
}

/**
 * Spawn a subprocess, collecting stdout/stderr. Rejects on non-zero exit (or
 * death by signal) unless `allowFailure` is set, in which case the resolved
 * result carries the exit code / signal for the caller to inspect.
 */
export function run(
  command: string,
  args: string[],
  opts: { allowFailure?: boolean; inheritStdio?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: opts.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      // Node reports `code === null` when the child died by signal. That is a
      // failure (a killed ffmpeg leaves a truncated MP4), never a clean exit.
      const result: RunResult =
        code === null
          ? { code: 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0), stdout, stderr }
          : { code, stdout, stderr };
      if (code === null && signal) result.signal = signal;
      if (result.code !== 0 && !opts.inheritStdio && !opts.allowFailure) {
        reject(new Error(`${command} ${describeExit(result)}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve(result);
    });
  });
}
