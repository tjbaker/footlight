// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * jsdom flow test for the animated punch-in controls (#163): capturing the
 * drawn box as the push's start and end emits a two-keyframe `cropWindowPath`
 * (the render's highest framing precedence) spanning the clip, with the
 * "center" fallback offset. Uses the shared editor harness.
 */

/** @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/platform/index.js", async () =>
  (await import("./helpers/platform-mock.js")).platformModule);

import { platformMocks } from "./helpers/platform-mock.js";
import {
  installDomShims,
  resetHarness,
  flush,
  buttonByText,
  mountLoadAndWindow,
} from "./helpers/editor-harness.js";

installDomShims();
const { mountEditor } = await import("../src/editor.js");

describe("animated punch-in (UI flow)", () => {
  beforeEach(() => {
    resetHarness();
  });

  it("capturing start + end emits a two-keyframe cropWindowPath spanning the clip", async () => {
    const root = await mountLoadAndWindow(mountEditor);

    // Capture the default drawn box as both endpoints (a valid A→A push).
    buttonByText(root, "Set start").click();
    buttonByText(root, "Set end").click();
    await flush();

    buttonByText(root, /add clip/i).click();
    await flush();
    buttonByText(root, /render/i).click();
    await flush();

    expect(platformMocks.render).toHaveBeenCalledTimes(1);
    const clips = JSON.parse(platformMocks.render.mock.calls[0]![0] as string) as Array<{
      cropWindowPath?: Array<{ t: number; x: number; y: number; w: number; h: number }>;
      crop_offset?: string;
    }>;
    const path = clips[0]!.cropWindowPath!;
    expect(path).toHaveLength(2);
    expect(path[0]!.t).toBe(0);
    expect(path[1]!.t).toBeCloseTo(0.5, 1); // spans the In→Out window
    expect(path[0]!.w).toBeGreaterThan(0);
    expect(clips[0]!.crop_offset).toBe("center"); // the stripped-path fallback
  });
});
