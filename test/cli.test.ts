// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * CLI plumbing tests for the JSON manifest render path and the `track`
 * subcommand. These run the compiled CLI via `bin/footlight.js` in a child
 * process (so they exercise argument parsing, stdout/stderr separation, and
 * exit codes exactly as a user would), plus a direct unit check of the JSON
 * manifest round-trip through `serializeManifestJSON`.
 *
 * NO NETWORK: the track tests use the offline MockTracker (`mock: true`). The
 * render dry-run tests never spawn ffmpeg (they assert on the printed command).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  serializeManifestJSON,
  type ClipSpec,
} from "../src/manifest.js";
import { computeCrop } from "../src/engine.js";
import type { TrackSample } from "../src/providers/types.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const BIN = join(here, "..", "bin", "footlight.js");

/** Run the CLI; returns {stdout, stderr, code}. Never throws on non-zero exit. */
function runCli(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });
    return { stdout, stderr: "", code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: e.status ?? 1,
    };
  }
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "footlight-cli-"));

// Tests that shell out to the built CLI rely on dist/ being current.
beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: join(here, ".."), stdio: "ignore" });
});

describe("serializeManifestJSON round-trip", () => {
  it("parses back deep-equal, including cropPath", () => {
    const clips: ClipSpec[] = [
      {
        source_file: "downloads/a.mp4",
        in_point: "00:00:10",
        out_point: "00:00:25",
        crop_offset: "center",
        notes: "fixed crop",
      },
      {
        source_file: "downloads/b.mp4",
        in_point: "5",
        out_point: "20",
        content_crop: "1800:1010:60:35",
        out_name: "tracked.mp4",
        cropPath: [
          { t: 0, x: 100 },
          { t: 7.5, x: 540 },
          { t: 15, x: 980 },
        ],
      },
    ];
    const json = serializeManifestJSON(clips);
    expect(JSON.parse(json)).toEqual(clips);
  });

  it("emits pretty JSON with a trailing newline", () => {
    const json = serializeManifestJSON([
      { source_file: "x.mp4", in_point: "0", out_point: "1" },
    ]);
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain("\n  "); // two-space indented
  });
});

describe("render JSON manifest (dry-run)", () => {
  it("renders an eased x='...' smoothstep expression for a cropPath clip", () => {
    const dir = tmp();
    // A real (zero-byte placeholder is not enough — ffprobe runs). Use a tiny
    // generated source so probeDimensions succeeds.
    const src = join(dir, "src.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=2",
      "-frames:v", "30", src,
    ]);

    const manifest: ClipSpec[] = [
      {
        source_file: src,
        in_point: "0",
        out_point: "2",
        cropPath: [
          { t: 0, x: 200 },
          { t: 1, x: 800 },
          { t: 2, x: 400 },
        ],
      },
    ];
    const manifestPath = join(dir, "m.json");
    writeFileSync(manifestPath, serializeManifestJSON(manifest));

    const { stdout, code } = runCli([
      "render", manifestPath, "--outdir", join(dir, "out"), "--dry-run",
    ]);
    expect(code).toBe(0);

    // crop W/H from computeCrop over the 1920x1080 working region.
    const base = computeCrop(1920, 1080, "center");
    expect(stdout).toContain(`crop=${base.cw}:${base.ch}:x='`);
    // Eased smoothstep structural substrings.
    expect(stdout).toContain("clip((t-");
    expect(stdout).toContain("(3-2*("); // smoothstep s = p*p*(3-2*p)
    expect(stdout).toContain("if(lt(t,"); // multi-segment nesting boundary (3+ keyframes)
    expect(stdout).toContain(`:y=${base.y}`);
  });

  it("falls back to crop_offset when no cropPath is present", () => {
    const dir = tmp();
    const src = join(dir, "src.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=2",
      "-frames:v", "30", src,
    ]);

    const manifest: ClipSpec[] = [
      { source_file: src, in_point: "0", out_point: "2", crop_offset: "right" },
    ];
    const manifestPath = join(dir, "m.json");
    writeFileSync(manifestPath, serializeManifestJSON(manifest));

    const { stdout, code } = runCli([
      "render", manifestPath, "--outdir", join(dir, "out"), "--dry-run",
    ]);
    expect(code).toBe(0);

    // 'right' => fixed positional crop at x=maxX, NOT an eased expression.
    const c = computeCrop(1920, 1080, "right");
    expect(stdout).toContain(`crop=${c.cw}:${c.ch}:${c.x}:${c.y}`);
    expect(stdout).not.toContain("x='"); // no eased/scheduled expression
  });

  it("fades: emits fade/afade filters, forces the AAC re-encode, and logs the note", () => {
    const dir = tmp();
    const src = join(dir, "src.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=2",
      "-frames:v", "30", src,
    ]);

    const manifest: ClipSpec[] = [
      {
        source_file: src,
        in_point: "0",
        out_point: "2",
        crop_offset: "center",
        fade_in: 0.25,
        fade_out: 0.5,
      },
    ];
    const manifestPath = join(dir, "m.json");
    writeFileSync(manifestPath, serializeManifestJSON(manifest));

    const { stdout, code } = runCli([
      "render", manifestPath, "--outdir", join(dir, "out"), "--dry-run",
    ]);
    expect(code).toBe(0);

    // Video fades last in -vf; matching afades in -af.
    expect(stdout).toContain("fade=t=in:st=0:d=0.250");
    expect(stdout).toContain("fade=t=out:st=1.500:d=0.500");
    expect(stdout).toContain("-af afade=t=in:st=0:d=0.250,afade=t=out:st=1.500:d=0.500");
    // THE AUDIO RULE: default --audio-bitrate copy is overridden, audibly noted.
    expect(stdout).toContain("-c:a aac -b:a 256k");
    expect(stdout).not.toContain("-c:a copy");
    expect(stdout).toContain("note: fades need an audio re-encode");
  });

  it("fades: a real (non-dry-run) faded render encodes and the output has AAC audio", () => {
    const dir = tmp();
    const src = join(dir, "src.mp4");
    // A tiny real source WITH an audio track (the fade rule re-encodes audio).
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src,
    ]);

    const manifest: ClipSpec[] = [
      {
        source_file: src,
        in_point: "0",
        out_point: "1.5",
        crop_offset: "center",
        out_name: "fade_smoke",
        fade_in: 0.25,
        fade_out: 0.25,
      },
    ];
    const manifestPath = join(dir, "m.json");
    writeFileSync(manifestPath, serializeManifestJSON(manifest));

    const outdir = join(dir, "out");
    const { stdout, code } = runCli([
      "render", manifestPath, "--outdir", outdir, "--crf", "35", "--preset", "ultrafast",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("note: fades need an audio re-encode");

    // The rendered file exists and its audio stream is AAC (re-encoded, not copied).
    const codec = execFileSync(
      "ffprobe",
      [
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name", "-of", "csv=p=0",
        join(outdir, "fade_smoke.mp4"),
      ],
      { encoding: "utf8" },
    ).trim();
    expect(codec).toBe("aac");
  });

  it("errors on a malformed JSON manifest", () => {
    const dir = tmp();
    const manifestPath = join(dir, "bad.json");
    writeFileSync(manifestPath, JSON.stringify({ not: "an array" }));
    const { code, stderr } = runCli(["render", manifestPath, "--dry-run"]);
    expect(code).toBe(1);
    expect(stderr).toContain("must be an array");
  });
});

describe("track --mock subcommand", () => {
  it("prints a TrackSample[] with one box per sampleTime, all in-region", () => {
    const dir = tmp();
    const region = { width: 1920, height: 1080 };
    const sampleTimes = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    const req = {
      sourcePath: "downloads/whatever.mp4", // not read by MockTracker
      region,
      sampleTimes,
      subjectHint: "the person playing guitar",
      mock: true,
    };
    const reqPath = join(dir, "req.json");
    writeFileSync(reqPath, JSON.stringify(req));

    const { stdout, stderr, code } = runCli(["track", reqPath]);
    expect(code).toBe(0);
    expect(stderr).toBe("");

    const samples = JSON.parse(stdout) as TrackSample[];
    expect(Array.isArray(samples)).toBe(true);
    expect(samples.length).toBe(sampleTimes.length);

    const times = samples.map((s) => s.t);
    expect(times).toEqual(sampleTimes);

    for (const s of samples) {
      expect(s.box).toBeTruthy();
      // Box center stays within the region; box itself within horizontal bounds.
      expect(s.box.x).toBeGreaterThanOrEqual(0);
      expect(s.box.x + s.box.w).toBeLessThanOrEqual(region.width + 1);
      expect(s.box.y).toBeGreaterThanOrEqual(0);
      expect(s.box.y + s.box.h).toBeLessThanOrEqual(region.height + 1);
    }
  });

  it("honors FOOTLIGHT_TRACK_MOCK=1 without a mock flag or apiKey", () => {
    const dir = tmp();
    const req = {
      sourcePath: "downloads/x.mp4",
      region: { width: 1280, height: 720 },
      sampleTimes: [0, 1, 2],
    };
    const reqPath = join(dir, "req.json");
    writeFileSync(reqPath, JSON.stringify(req));

    const { stdout, code } = runCli(["track", reqPath], {
      env: { FOOTLIGHT_TRACK_MOCK: "1" },
    });
    expect(code).toBe(0);
    const samples = JSON.parse(stdout) as TrackSample[];
    expect(samples.length).toBe(3);
  });

  it("errors clearly when gemini is selected without an apiKey", () => {
    const dir = tmp();
    const req = {
      sourcePath: "downloads/x.mp4",
      region: { width: 1920, height: 1080 },
      sampleTimes: [0, 1],
    };
    const reqPath = join(dir, "req.json");
    writeFileSync(reqPath, JSON.stringify(req));

    const { code, stderr, stdout } = runCli(["track", reqPath]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("apiKey is required");
  });

  it("errors on a missing request file", () => {
    const { code, stderr } = runCli(["track", "/no/such/request.json"]);
    expect(code).toBe(1);
    expect(stderr).toContain("cannot read");
  });
});

describe("render flag validation (issue: fail fast, not per-clip at ffmpeg time)", () => {
  function manifest(): string {
    const dir = tmp();
    // The accept cases reach the per-clip probe even under --dry-run, so the
    // source must really exist (mirrors the dry-run suite above).
    const src = join(dir, "src.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=1",
      "-frames:v", "5", src,
    ]);
    const p = join(dir, "m.csv");
    writeFileSync(
      p,
      `source_file,in_point,out_point,crop_offset\n${src},0,0.1,center\n`,
      "utf8",
    );
    return p;
  }

  it("rejects a --crf outside 0-51 (and non-integers) with a clear error", () => {
    for (const bad of ["52", "-1", "abc", "19.5"]) {
      const { code, stderr } = runCli(["render", manifest(), "--dry-run", "--crf", bad]);
      expect(code, `--crf ${bad}`).toBe(1);
      expect(stderr).toContain("--crf must be an integer 0-51");
    }
  });

  it("rejects an unknown --preset, listing the valid x264 set", () => {
    const { code, stderr } = runCli([
      "render", manifest(), "--dry-run", "--preset", "warpspeed",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--preset must be one of");
    expect(stderr).toContain("ultrafast");
    expect(stderr).toContain("placebo");
  });

  it("accepts the boundary CRFs and every x264 preset name", () => {
    for (const ok of [["--crf", "0"], ["--crf", "51"], ["--preset", "veryslow"]]) {
      const { code, stderr } = runCli(["render", manifest(), "--dry-run", ...ok]);
      expect(code, ok.join(" ")).toBe(0);
      expect(stderr).toBe("");
    }
  });
});
