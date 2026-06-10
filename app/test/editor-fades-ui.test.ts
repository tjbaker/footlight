// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * jsdom flow tests for the per-clip fade fields and the loop-seam check
 * (#165): typed fade values reach the emitted render manifest (sparse — no
 * fields when no fades), too-long fades refuse to queue with the i18n error,
 * and the loop-seam toggle reveals the two seam frames. Uses the shared
 * editor harness.
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
  setValue,
  buttonByText,
  mountLoadAndWindow,
} from "./helpers/editor-harness.js";

installDomShims();
const { mountEditor } = await import("../src/editor.js");

/** The two fade number fields, found by their i18n tooltips. */
function fadeInputs(root: HTMLElement): { fadeIn: HTMLInputElement; fadeOut: HTMLInputElement } {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="number"]'));
  const fadeIn = inputs.find((i) => i.title.startsWith("Fade the clip in"));
  const fadeOut = inputs.find((i) => i.title.startsWith("Fade the clip out"));
  expect(fadeIn).toBeTruthy();
  expect(fadeOut).toBeTruthy();
  return { fadeIn: fadeIn!, fadeOut: fadeOut! };
}

async function addAndRender(root: HTMLElement): Promise<void> {
  buttonByText(root, /add clip/i).click();
  await flush();
  buttonByText(root, /render/i).click();
  await flush();
}

describe("per-clip fades (UI flow)", () => {
  beforeEach(() => {
    resetHarness();
  });

  it("typed fades reach the emitted manifest; the audio hint appears", async () => {
    const root = await mountLoadAndWindow(mountEditor);
    const { fadeIn, fadeOut } = fadeInputs(root);

    setValue(fadeIn, "0.2");
    setValue(fadeOut, "0.1");
    const hint = Array.from(root.querySelectorAll<HTMLElement>(".hint")).find((h) =>
      h.textContent?.includes("re-encode"),
    );
    expect(hint).toBeTruthy();
    expect(hint!.style.display).not.toBe("none");

    await addAndRender(root);
    expect(platformMocks.render).toHaveBeenCalledTimes(1);
    const clips = JSON.parse(platformMocks.render.mock.calls[0]![0] as string) as Array<
      Record<string, unknown>
    >;
    expect(clips[0]!.fade_in).toBe(0.2);
    expect(clips[0]!.fade_out).toBe(0.1);
  });

  it("a clip without fades carries neither field", async () => {
    const root = await mountLoadAndWindow(mountEditor);
    await addAndRender(root);
    const clips = JSON.parse(platformMocks.render.mock.calls[0]![0] as string) as Array<
      Record<string, unknown>
    >;
    expect("fade_in" in clips[0]!).toBe(false);
    expect("fade_out" in clips[0]!).toBe(false);
  });

  it("fades longer than the clip refuse to queue with the i18n error", async () => {
    const root = await mountLoadAndWindow(mountEditor);
    const { fadeIn, fadeOut } = fadeInputs(root);
    // The window is 0.5s; 0.4 + 0.4 cannot fit.
    setValue(fadeIn, "0.4");
    setValue(fadeOut, "0.4");

    buttonByText(root, /add clip/i).click();
    await flush();
    expect(root.textContent).toContain("Fades are longer than the clip");
    expect(platformMocks.render).not.toHaveBeenCalled();
  });

  it("the loop-seam toggle reveals the In/Out seam frames", async () => {
    const root = await mountLoadAndWindow(mountEditor);
    buttonByText(root, "Loop seam").click();
    await flush();

    const outImg = root.querySelector<HTMLImageElement>('img[alt="Out frame"]');
    const inImg = root.querySelector<HTMLImageElement>('img[alt="In frame"]');
    expect(outImg).not.toBeNull();
    expect(inImg).not.toBeNull();
    expect(outImg!.src).toContain("data:image/png");
    expect(inImg!.src).toContain("data:image/png");
  });
});
