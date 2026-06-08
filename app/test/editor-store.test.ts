// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for editor-store.ts — the editor state factory + pure selectors
 * lifted out of the mountEditor() closure (#125 Phase 3). Guards that a fresh
 * state has the right defaults and is independent per call, and that the derived
 * predicates (track ownership, clip window) match the inline logic they replaced.
 */

import { describe, it, expect } from "vitest";
import {
  createInitialEditorState,
  hasActiveTrack,
  isCropInteractive,
  hasClipWindow,
  clipLength,
  clampInOut,
  clampTrimOut,
  keyframeFromCommit,
  DEFAULT_FPS,
  type EditorState,
} from "../src/editor-store.js";

describe("createInitialEditorState", () => {
  it("has the expected empty-workspace defaults", () => {
    const s = createInitialEditorState();
    expect(s.source).toBe("");
    expect(s.dims).toBeNull();
    expect(s.duration).toBe(0);
    expect(s.fps).toBe(DEFAULT_FPS);
    expect(s.inPoint).toBeNull();
    expect(s.outPoint).toBeNull();
    expect(s.cropBox).toBeNull();
    expect(s.cropPath).toBeNull();
    expect(s.contentMode).toBe(false);
    expect(s.textPosition).toBe("bottom");
    expect(s.keyframes).toEqual([]);
    expect(s.clips).toEqual([]);
    expect(s.caption).toMatchObject({ color: "#FFFFFF", outlineColor: "#000000", angle: 0 });
  });

  it("returns an INDEPENDENT state each call (no shared mutable refs)", () => {
    const a = createInitialEditorState();
    const b = createInitialEditorState();
    a.clips.push({ source_file: "x.mp4", in_point: "0", out_point: "1" });
    a.caption.bold = true;
    expect(b.clips).toEqual([]); // not aliased to a.clips
    expect(b.caption.bold).toBe(false); // not aliased to a.caption
  });
});

/** Build a state, overriding just the fields a selector reads. */
const withState = (over: Partial<EditorState>): EditorState => ({
  ...createInitialEditorState(),
  ...over,
});

describe("hasActiveTrack / isCropInteractive", () => {
  it("is false (and crop interactive) with no/empty crop path", () => {
    expect(hasActiveTrack(withState({ cropPath: null }))).toBe(false);
    expect(hasActiveTrack(withState({ cropPath: [] }))).toBe(false);
    expect(isCropInteractive(withState({ cropPath: null }))).toBe(true);
  });

  it("is true (and NOT crop interactive) with a non-empty crop path", () => {
    const s = withState({ cropPath: [{ t: 0, x: 10 }, { t: 1, x: 20 }] });
    expect(hasActiveTrack(s)).toBe(true);
    expect(isCropInteractive(s)).toBe(false);
  });
});

describe("hasClipWindow / clipLength", () => {
  it("needs both In and Out set, forming a positive window", () => {
    expect(hasClipWindow(withState({ inPoint: null, outPoint: null }))).toBe(false);
    expect(hasClipWindow(withState({ inPoint: 5, outPoint: null }))).toBe(false);
    expect(hasClipWindow(withState({ inPoint: 8, outPoint: 8 }))).toBe(false); // zero-length
    expect(hasClipWindow(withState({ inPoint: 8, outPoint: 4 }))).toBe(false); // inverted
    expect(hasClipWindow(withState({ inPoint: 4, outPoint: 8 }))).toBe(true);
  });

  it("clipLength is Out − In for a valid window, else 0", () => {
    expect(clipLength(withState({ inPoint: 4, outPoint: 8 }))).toBe(4);
    expect(clipLength(withState({ inPoint: 8, outPoint: 4 }))).toBe(0);
    expect(clipLength(withState({ inPoint: null, outPoint: 8 }))).toBe(0);
  });
});

describe("clampInOut (setInOut commit math)", () => {
  it("passes a valid window through", () => {
    expect(clampInOut(10, 20, 100)).toEqual({ inPoint: 10, outPoint: 20 });
  });
  it("clamps In to >= 0 and Out to <= duration", () => {
    expect(clampInOut(-5, 20, 100)).toEqual({ inPoint: 0, outPoint: 20 });
    expect(clampInOut(10, 200, 100)).toEqual({ inPoint: 10, outPoint: 100 });
  });
  it("orders the window: Out is pulled up to In when inverted", () => {
    expect(clampInOut(50, 30, 100)).toEqual({ inPoint: 50, outPoint: 50 });
  });
  it("treats duration 0 as unknown (no upper clamp)", () => {
    expect(clampInOut(10, 20, 0)).toEqual({ inPoint: 10, outPoint: 20 });
  });
  it("rounds to milliseconds", () => {
    expect(clampInOut(1.23456, 2.34567, 100)).toEqual({ inPoint: 1.235, outPoint: 2.346 });
  });
});

describe("clampTrimOut (trim commit math)", () => {
  it("clamps Out to [inPoint, duration], ms-rounded", () => {
    expect(clampTrimOut(20, 5, 100)).toBe(20);
    expect(clampTrimOut(200, 5, 100)).toBe(100); // to duration
    expect(clampTrimOut(3, 5, 100)).toBe(5); // up to inPoint
    expect(clampTrimOut(7.6543, 5, 100)).toBe(7.654);
  });
});

describe("keyframeFromCommit (addCropKeyframe math)", () => {
  it("ms-rounds the time and stores x as an integer offset string", () => {
    expect(keyframeFromCommit(1.23456, 440.7)).toEqual({ t: 1.235, offset: "441" });
    expect(keyframeFromCommit(2, -3.4)).toEqual({ t: 2, offset: "-3" });
  });
});
