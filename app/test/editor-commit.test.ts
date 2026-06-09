// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for editor-commit.ts — the assistant's pure commit transitions
 * (#125 Phase 2). Each CommitOp kind is checked for its state delta, its
 * ordered effect list, and its applied/staged flags; the guard cases (no In
 * point yet) must skip without touching state. The content-crop / crop-offset
 * round-trips are asserted against `specToEditorState` itself so this suite
 * never hardcodes the manifest restorer's box math.
 */

import { describe, it, expect } from "vitest";

import { specToEditorState } from "@manifest";
import type { CommitOp } from "@assistant-types";
import { applyCommitToState, type CommitEffect } from "../src/editor-commit.js";
import { createInitialEditorState, type EditorState } from "../src/editor-store.js";

const DIMS = { width: 1920, height: 1080 };

function loadedState(): EditorState {
  const s = createInitialEditorState();
  s.source = "/v/show.mp4";
  s.dims = { ...DIMS };
  s.duration = 120;
  return s;
}

function kinds(effects: CommitEffect[]): string[] {
  return effects.map((e) => e.kind);
}

describe("applyCommitToState", () => {
  it("setInOut clamps into [0, duration], orders Out after In, and seeks to In", () => {
    const s = loadedState();
    const res = applyCommitToState(s, { kind: "setInOut", inSec: -2, outSec: 500 });
    expect(s.inPoint).toBe(0);
    expect(s.outPoint).toBe(120);
    expect(res).toMatchObject({ applied: true, staged: false });
    expect(kinds(res.effects)).toEqual(["refreshIO", "seekToIn"]);
  });

  it("trim clamps the new Out to [In, duration]", () => {
    const s = loadedState();
    s.inPoint = 10;
    s.outPoint = 30;
    const res = applyCommitToState(s, { kind: "trim", outSec: 5 });
    expect(s.outPoint).toBe(10); // floored at In
    expect(kinds(res.effects)).toEqual(["refreshIO"]);
  });

  it("trim without an In point is skipped untouched", () => {
    const s = loadedState();
    const res = applyCommitToState(s, { kind: "trim", outSec: 5 });
    expect(res).toEqual({ applied: false, staged: false, effects: [] });
    expect(s.outPoint).toBeNull();
  });

  it("setContentCrop round-trips the spec through the manifest restorer", () => {
    const s = loadedState();
    const res = applyCommitToState(s, { kind: "setContentCrop", contentCrop: "1800:1010:60:34" });
    const expected = specToEditorState(
      { source_file: s.source, in_point: "0", out_point: "0", content_crop: "1800:1010:60:34" },
      s.dims!,
    );
    expect(s.contentBox).toEqual(expected.contentBox);
    expect(s.contentMode).toBe(expected.contentMode);
    expect(kinds(res.effects)).toEqual([
      "refreshContentReadout",
      "refreshCropReadout",
      "drawOverlay",
    ]);
  });

  it("detectScenes only requests the detection effect", () => {
    const s = loadedState();
    const res = applyCommitToState(s, { kind: "detectScenes" });
    expect(res).toEqual({ applied: true, staged: false, effects: [{ kind: "detectScenes" }] });
  });

  it("addCropKeyframe stores the working-region x as an integer offset keyframe", () => {
    const s = loadedState();
    s.inPoint = 0;
    const res = applyCommitToState(s, { kind: "addCropKeyframe", t: 1.2345, x: 410.6 });
    expect(s.keyframes).toEqual([{ t: 1.235, offset: "411" }]);
    expect(kinds(res.effects)).toEqual(["refreshKeyframes"]);
  });

  it("addCropKeyframe without an In point is skipped", () => {
    const s = loadedState();
    const res = applyCommitToState(s, { kind: "addCropKeyframe", t: 1, x: 400 });
    expect(res.applied).toBe(false);
    expect(s.keyframes).toEqual([]);
  });

  it("suggestCropForFrame clears any track path and sets the box from the offset", () => {
    const s = loadedState();
    s.cropPath = [{ t: 0, x: 100 }];
    const res = applyCommitToState(s, { kind: "suggestCropForFrame", t: 3, cropOffset: "640" });
    const expected = specToEditorState(
      { source_file: s.source, in_point: "0", out_point: "0", crop_offset: "640" },
      s.dims!,
    );
    expect(s.cropPath).toBeNull();
    expect(s.cropBox).toEqual(expected.cropBox);
    expect(kinds(res.effects)).toEqual(["refreshCropReadout", "drawOverlay", "refreshIO"]);
  });

  it("trackSubject adopts the eased path and reports its keyframe count", () => {
    const s = loadedState();
    const res = applyCommitToState(s, {
      kind: "trackSubject",
      cropPath: [
        { t: 0, x: 100 },
        { t: 2, x: 300 },
      ],
    });
    expect(s.cropPath).toEqual([
      { t: 0, x: 100 },
      { t: 2, x: 300 },
    ]);
    expect(res.effects[0]).toEqual({ kind: "trackStatus", count: 2 });
    expect(kinds(res.effects)).toEqual(["trackStatus", "drawOverlay", "refreshIO"]);
  });

  it("render stages without touching state (never auto-fires)", () => {
    const s = loadedState();
    const before = JSON.parse(JSON.stringify(s));
    const res = applyCommitToState(s, { kind: "render" });
    expect(res).toEqual({ applied: true, staged: true, effects: [{ kind: "stagedRender" }] });
    expect(JSON.parse(JSON.stringify(s))).toEqual(before);
  });

  it("an unknown commit kind is skipped", () => {
    const s = loadedState();
    const res = applyCommitToState(s, { kind: "warpTime" } as unknown as CommitOp);
    expect(res).toEqual({ applied: false, staged: false, effects: [] });
  });
});
