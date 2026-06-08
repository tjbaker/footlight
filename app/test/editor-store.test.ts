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
