// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the Node subprocess layer of `src/engine.ts` — `run`,
 * `probeDimensions`, and `ffmpegHasFilter`. `node:child_process` is mocked so no
 * real ffmpeg/ffprobe is ever spawned: each test wires up a controllable fake
 * child (an EventEmitter with EventEmitter stdout/stderr) and drives its lifecycle
 * by hand (`emit("data", …)` then `emit("close", code)` / `emit("error", …)`).
 *
 * Lives in its own file (not `engine.test.ts`) so the module-level
 * `vi.mock("node:child_process")` only governs these subprocess tests and leaves
 * the pure golden-case tests in `engine.test.ts` untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";

import { run, probeDimensions, ffmpegHasFilter } from "../src/engine.js";

/**
 * A fake child process whose stdout/stderr are EventEmitters and whose own
 * `close`/`error` events drive the `run` promise. `run` attaches its listeners
 * synchronously, so a test resolves the promise by emitting AFTER calling `run`.
 */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("run", () => {
  it("resolves with captured stdout/stderr on a zero exit", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const p = run("ffprobe", ["-version"]);
    child.stdout.emit("data", Buffer.from("hello "));
    child.stdout.emit("data", Buffer.from("world"));
    child.stderr.emit("data", Buffer.from("a warning"));
    child.emit("close", 0);

    await expect(p).resolves.toEqual({
      code: 0,
      stdout: "hello world",
      stderr: "a warning",
    });
  });

  it("passes inheritStdio through to spawn's stdio option", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const p = run("ffmpeg", ["-y"], { inheritStdio: true });
    child.emit("close", 0);
    await p;

    expect(spawn).toHaveBeenCalledWith("ffmpeg", ["-y"], { stdio: "inherit" });
  });

  it("defaults to piped stdio (ignore in, pipe out/err) when not inheriting", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const p = run("ffprobe", []);
    child.emit("close", 0);
    await p;

    expect(spawn).toHaveBeenCalledWith("ffprobe", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("rejects on a non-zero exit, message carrying command + code + stderr", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const p = run("ffprobe", ["bad"]);
    child.stderr.emit("data", Buffer.from("No such file"));
    child.emit("close", 3);

    await expect(p).rejects.toThrow(/ffprobe exited 3: No such file/);
  });

  it("falls back to stdout in the error message when stderr is empty", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const p = run("ffprobe", ["bad"]);
    child.stdout.emit("data", Buffer.from("some stdout detail"));
    child.emit("close", 1);

    await expect(p).rejects.toThrow(/ffprobe exited 1: some stdout detail/);
  });

  it("resolves (carrying the non-zero code) when allowFailure is set", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const p = run("ffmpeg", ["-filters"], { allowFailure: true });
    child.stdout.emit("data", Buffer.from("filters list"));
    child.emit("close", 5);

    await expect(p).resolves.toEqual({
      code: 5,
      stdout: "filters list",
      stderr: "",
    });
  });

  it("resolves on close when inheritStdio is set even with a non-zero code", async () => {
    // inheritStdio leaves stdout/stderr unpiped, so nothing is captured there;
    // the non-zero-exit rejection is suppressed for inherited stdio.
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const p = run("ffmpeg", ["-y"], { inheritStdio: true });
    child.emit("close", 2);

    await expect(p).resolves.toEqual({ code: 2, stdout: "", stderr: "" });
  });

  it("treats a null exit code as 0", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const p = run("ffprobe", []);
    child.emit("close", null);

    await expect(p).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("rejects with the child's error when it emits 'error'", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const boom = new Error("spawn ENOENT");
    const p = run("ffprobe", []);
    child.emit("error", boom);

    await expect(p).rejects.toBe(boom);
  });
});

describe("probeDimensions", () => {
  it("resolves [width, height] from valid ffprobe JSON", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const json = JSON.stringify({
      streams: [{ width: 1920, height: 1080 }],
      format: { duration: "12.5" },
    });

    const p = probeDimensions("clip.mp4");
    child.stdout.emit("data", Buffer.from(json));
    child.emit("close", 0);

    await expect(p).resolves.toEqual([1920, 1080]);
  });

  it("throws 'unparseable' when stdout is not valid JSON", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const p = probeDimensions("clip.mp4");
    child.stdout.emit("data", Buffer.from("not json at all"));
    child.emit("close", 0);

    await expect(p).rejects.toThrow(/unparseable output for clip\.mp4/);
  });

  it("throws 'no video stream' when the JSON has no width/height", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const json = JSON.stringify({ streams: [{}], format: { duration: "3" } });
    const p = probeDimensions("audio-only.mp4");
    child.stdout.emit("data", Buffer.from(json));
    child.emit("close", 0);

    await expect(p).rejects.toThrow(/no video stream found in audio-only\.mp4/);
  });
});

describe("ffmpegHasFilter", () => {
  it("resolves true when 'ffmpeg -filters' lists the filter", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const filters = [
      "Filters:",
      " T.. ass               V->V       Render ASS subtitles onto input video.",
      " T.. subtitles         V->V       Render text subtitles onto input video.",
    ].join("\n");

    const p = ffmpegHasFilter("subtitles");
    child.stdout.emit("data", Buffer.from(filters));
    child.emit("close", 0);

    await expect(p).resolves.toBe(true);
  });

  it("resolves false when the filter is not listed", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const filters = [
      "Filters:",
      " ... scale             V->V       Scale the input video size.",
    ].join("\n");

    const p = ffmpegHasFilter("subtitles");
    child.stdout.emit("data", Buffer.from(filters));
    child.emit("close", 0);

    await expect(p).resolves.toBe(false);
  });

  it("still reports correctly via allowFailure when ffmpeg exits non-zero", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const filters = " T.. ass               V->V       Render ASS subtitles onto input video.";

    const p = ffmpegHasFilter("ass");
    child.stdout.emit("data", Buffer.from(filters));
    child.emit("close", 1); // non-zero, but allowFailure inside ffmpegHasFilter

    await expect(p).resolves.toBe(true);
  });
});
