// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for editor-push.ts (#163) — the pure push helpers. They delegate to
 * `cropBoxToWindow` and `easedCropWindowAt`, so these tests pin the DELEGATION
 * (same results as calling the underlying helpers directly) plus the push's
 * own rules: both endpoints required, t spans [0, duration], the preview box
 * re-adds the content origin.
 */

import { describe, it, expect } from "vitest";

import { cropBoxToWindow } from "@manifest";
import { easedCropWindowAt } from "@core";
import {
  boxToRegionWindow,
  pushKeyframes,
  pushPreviewBox,
  describePush,
} from "../src/editor-push.js";

const REGION = { width: 1920, height: 1080 };
const BOX = { x: 700, y: 100, w: 405, h: 720 };

describe("boxToRegionWindow", () => {
  it("matches cropBoxToWindow directly when no content crop is active", () => {
    expect(boxToRegionWindow(BOX, null, REGION)).toEqual(cropBoxToWindow(BOX, REGION));
  });

  it("shifts by the content origin first when one is active", () => {
    const origin = { x: 240, y: 60 };
    expect(boxToRegionWindow(BOX, origin, { width: 1440, height: 960 })).toEqual(
      cropBoxToWindow({ ...BOX, x: BOX.x - 240, y: BOX.y - 60 }, { width: 1440, height: 960 }),
    );
  });
});

describe("pushKeyframes", () => {
  const start = { x: 656, y: 0, w: 608, h: 1080 };
  const end = { x: 808, y: 270, w: 304, h: 540 };

  it("returns null until BOTH endpoints are captured", () => {
    expect(pushKeyframes({ start: null, end: null }, 10)).toBeNull();
    expect(pushKeyframes({ start, end: null }, 10)).toBeNull();
    expect(pushKeyframes({ start: null, end }, 10)).toBeNull();
  });

  it("spans the clip: start at t=0, end at the duration", () => {
    expect(pushKeyframes({ start, end }, 12.5)).toEqual([
      { t: 0, ...start },
      { t: 12.5, ...end },
    ]);
  });

  it("floors a degenerate duration so the keyframes never coincide", () => {
    const kfs = pushKeyframes({ start, end }, 0)!;
    expect(kfs[1]!.t).toBeGreaterThan(0);
  });
});

describe("pushPreviewBox", () => {
  const kfs = [
    { t: 0, x: 656, y: 0, w: 608, h: 1080 },
    { t: 2, x: 808, y: 270, w: 304, h: 540 },
  ];

  it("is easedCropWindowAt with the content origin re-added", () => {
    const eased = easedCropWindowAt(kfs, 1);
    expect(pushPreviewBox(kfs, 1, null)).toEqual({
      x: eased.x,
      y: eased.y,
      w: eased.w,
      h: eased.h,
    });
    const shifted = pushPreviewBox(kfs, 1, { x: 240, y: 60 });
    expect(shifted.x).toBeCloseTo(eased.x + 240, 10);
    expect(shifted.y).toBeCloseTo(eased.y + 60, 10);
  });
});

describe("describePush", () => {
  it("formats the captured endpoints compactly", () => {
    expect(describePush({ start: null, end: null })).toBe("— → —");
    expect(
      describePush({
        start: { x: 0, y: 0, w: 608, h: 1080 },
        end: { x: 0, y: 0, w: 304, h: 540 },
      }),
    ).toBe("608×1080 → 304×540");
  });
});
