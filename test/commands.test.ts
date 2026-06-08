// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  SCENE_THRESHOLD,
  ffprobeStreamArgs,
  parseProbe,
  frameExtractArgs,
  frameExtractTailArgs,
  cropdetectArgs,
  parseCropdetect,
  scenesArgs,
  parseScenes,
} from "../src/engine.js";

describe("ffprobeStreamArgs / parseProbe", () => {
  it("requests width, height and container duration for the first video stream", () => {
    const a = ffprobeStreamArgs("in.mp4");
    expect(a).toContain("stream=width,height:format=duration");
    expect(a).toContain("v:0");
    expect(a[a.length - 1]).toBe("in.mp4");
  });

  it("parses width/height/duration", () => {
    const out = JSON.stringify({
      streams: [{ width: 1920, height: 1080 }],
      format: { duration: "12.5" },
    });
    expect(parseProbe(out)).toEqual({ width: 1920, height: 1080, duration: 12.5 });
  });

  it("defaults missing fields to 0 (rather than throwing)", () => {
    expect(parseProbe("{}")).toEqual({ width: 0, height: 0, duration: 0 });
  });
});

describe("frameExtractArgs", () => {
  it("INPUT-seeks (-ss before -i) and emits one mjpeg frame to stdout", () => {
    const a = frameExtractArgs("in.mp4", 3.5);
    const ss = a.indexOf("-ss");
    const i = a.indexOf("-i");
    expect(ss).toBeGreaterThanOrEqual(0);
    expect(ss).toBeLessThan(i);
    expect(a[ss + 1]).toBe("3.5");
    expect(a).toContain("mjpeg");
    expect(a[a.length - 1]).toBe("-");
  });

  it("clamps a non-finite time to 0", () => {
    const a = frameExtractArgs("in.mp4", Number.NaN);
    expect(a[a.indexOf("-ss") + 1]).toBe("0");
  });

  it("carries contentCrop + maxWidth into the filter chain", () => {
    const a = frameExtractArgs("in.mp4", 1, { contentCrop: "100:100:0:0", maxWidth: 640 });
    const vf = a[a.indexOf("-vf") + 1];
    expect(vf).toContain("crop=100:100:0:0");
    expect(vf).toContain("scale='min(640,iw)':-2");
  });
});

describe("frameExtractTailArgs (EOF fallback — last decodable frame)", () => {
  it("seeks relative to EOF (-sseof, negative) instead of an absolute -ss", () => {
    const a = frameExtractTailArgs("in.mp4");
    const sseof = a.indexOf("-sseof");
    expect(sseof).toBeGreaterThanOrEqual(0);
    expect(sseof).toBeLessThan(a.indexOf("-i")); // before -i (an input option)
    expect(Number(a[sseof + 1])).toBeLessThan(0); // negative = before the end
    expect(a).not.toContain("-ss"); // not an absolute-time seek
  });

  it("otherwise matches frameExtractArgs (one mjpeg frame to stdout, same opts)", () => {
    const a = frameExtractTailArgs("in.mp4", { contentCrop: "10:10:0:0" });
    expect(a).toContain("mjpeg");
    expect(a[a.length - 1]).toBe("-");
    expect(a[a.indexOf("-vf") + 1]).toContain("crop=10:10:0:0");
  });
});

describe("cropdetectArgs / parseCropdetect", () => {
  it("builds a black-bars-only cropdetect probe", () => {
    expect(cropdetectArgs("in.mp4")).toContain("cropdetect=limit=24:round=2");
  });

  it("returns the LAST crop= suggestion from stderr", () => {
    const stderr = "crop=100:100:0:0\nnoise\ncrop=1080:1920:420:0\n";
    expect(parseCropdetect(stderr)).toBe("1080:1920:420:0");
  });

  it("returns null when no crop= suggestion is present", () => {
    expect(parseCropdetect("no black bars here")).toBeNull();
  });
});

describe("scenesArgs / parseScenes", () => {
  it("downscales to 144p before the shared-threshold scene filter", () => {
    expect(scenesArgs("in.mp4")).toContain(
      `scale=-2:144,select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    );
  });

  it("parses pts_time markers, rounded to milliseconds", () => {
    const stderr = "frame pts_time:14.5001 info\n pts_time:21 end";
    expect(parseScenes(stderr)).toEqual([14.5, 21]);
  });

  it("returns an empty array when there are no cuts", () => {
    expect(parseScenes("no markers")).toEqual([]);
  });
});
