// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * jsdom flow test for the Export-cover button (#166): clicking it hands the
 * platform the source, the playhead t, a spec carrying the CURRENT framing
 * (addClip's precedence), and the engine-derived `_cover.png` name. Uses the
 * shared editor harness.
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
  mountLoaded,
} from "./helpers/editor-harness.js";

installDomShims();
const { mountEditor } = await import("../src/editor.js");

describe("Export cover (UI flow)", () => {
  beforeEach(() => {
    resetHarness();
  });

  it("does nothing (but reports) without a loaded source", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
    await flush();

    buttonByText(root, /export cover/i).click();
    await flush();
    expect(platformMocks.exportCover).not.toHaveBeenCalled();
  });

  it("hands the platform the playhead t, the active framing, and the cover name", async () => {
    const root = await mountLoaded(mountEditor);

    buttonByText(root, /export cover/i).click();
    await flush();

    expect(platformMocks.exportCover).toHaveBeenCalledTimes(1);
    const [source, t, spec, name] = platformMocks.exportCover.mock.calls[0]! as unknown as [
      string,
      number,
      Record<string, unknown>,
      string,
    ];
    expect(source).toBe("/abs/path/to/clip.mp4");
    expect(t).toBe(0); // playhead at load
    expect(spec.source_file).toBe("/abs/path/to/clip.mp4");
    expect(spec.crop_offset).toBe("center"); // default framing
    expect(name.endsWith("_cover.png")).toBe(true);
    expect(name).toContain("clip");
  });
});
