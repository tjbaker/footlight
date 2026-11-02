// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Stale-async races in the editor (#264). Each case holds one platform call
 * open on a hand-settled `deferred`, lets a NEWER action land first, then
 * settles the stale call and asserts it changed nothing:
 *   - load(): a slow probe of A resolving after B was picked must not adopt A;
 *   - doScenes(): A's manual scene cuts must not land on B;
 *   - doRender(): clips added mid-render must not be recorded as rendered;
 *   - transport setT(): a failed OLDER frame fetch must not paint its error
 *     over the newer, good frame.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { platformMocks } from "./helpers/platform-mock.js";
import {
  installDomShims,
  resetHarness,
  flush,
  mountLoaded,
  mountLoadAndWindow,
  buttonByText,
} from "./helpers/editor-harness.js";
import { deferred, type Deferred } from "./helpers/deferred.js";
import type { FootlightPlatform, ProbeResult } from "../src/platform/types.js";

type RenderResult = Awaited<ReturnType<FootlightPlatform["render"]>>;

installDomShims();
const { mountEditor } = await import("../src/editor.js");
const { messages } = await import("../src/i18n/index.js");
const m = messages.editor;

/** Type a path into the source field and press Enter (the editor's load trigger). */
function enterSource(root: HTMLElement, path: string): void {
  const input = root.querySelector<HTMLInputElement>(".fl-field.path input")!;
  input.value = path;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

const probeOf = (width: number, height: number, duration: number): ProbeResult => ({
  width,
  height,
  duration,
  cropdetect: null,
});

describe("editor stale async responses (#264)", () => {
  beforeEach(() => {
    resetHarness();
  });

  it("load(): a slow probe of A that resolves after B was picked is dropped", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
    await flush();

    const probes = new Map<string, Deferred<ProbeResult>>();
    platformMocks.probe.mockImplementation((source: string) => {
      const d = deferred<ProbeResult>();
      probes.set(source, d);
      return d.promise;
    });

    enterSource(root, "/abs/a.mp4");
    await flush();
    enterSource(root, "/abs/b.mp4");
    await flush();

    probes.get("/abs/b.mp4")!.resolve(probeOf(1280, 720, 20));
    await flush();
    probes.get("/abs/a.mp4")!.resolve(probeOf(1920, 1080, 30));
    await flush();

    const readgrid = root.querySelector(".fl-readgrid")!.textContent ?? "";
    expect(readgrid).toContain("1280×720");
    expect(readgrid).not.toContain("1920×1080");
    // A's late probe didn't kick off A's background scans either.
    expect(platformMocks.loudness).not.toHaveBeenCalledWith("/abs/a.mp4");
  });

  it("doScenes(): A's cuts are dropped once B has been loaded", async () => {
    const root = await mountLoaded(mountEditor, "/abs/a.mp4");
    const cutsVal = (): string =>
      [...root.querySelectorAll(".fl-rdchip")]
        .find((c) => c.querySelector(".lab")?.textContent === m.timeline.cutsLabel)!
        .querySelector(".val")!.textContent ?? "";

    const manual = deferred<number[]>();
    platformMocks.scenes.mockImplementationOnce(() => manual.promise);
    buttonByText(root, m.timeline.detectScenes).click();
    await flush();

    enterSource(root, "/abs/b.mp4"); // B's own background scan resolves [] (default)
    await flush();
    expect(cutsVal()).toBe("0");

    manual.resolve([5, 10]);
    await flush();
    expect(cutsVal()).toBe("0");
  });

  it("doRender(): records only the clips that were serialized, not ones added mid-render", async () => {
    const root = await mountLoadAndWindow(mountEditor);
    const addCard = root.querySelector<HTMLElement>(".fl-strip-card.add")!;
    addCard.click();
    await flush();

    const render = deferred<RenderResult>();
    platformMocks.render.mockImplementationOnce(() => render.promise);
    root.querySelector<HTMLButtonElement>(".fl-actions .fl-btn.primary")!.click();
    await flush();
    expect(platformMocks.render).toHaveBeenCalledTimes(1);

    addCard.click(); // a second clip queued while the render runs
    await flush();

    render.resolve({ ok: true, log: "done" });
    await flush();

    expect(platformMocks.saveHistory).toHaveBeenCalledTimes(1);
    expect(platformMocks.saveHistory.mock.calls[0]![0]).toHaveLength(1);
  });

  it("setT(): a failed older frame fetch doesn't paint an error over the newer frame", async () => {
    const root = await mountLoaded(mountEditor, "/abs/a.mp4");

    const stale = deferred<string>();
    platformMocks.extractFrame
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(async () => "data:image/png;base64,BBBB");

    enterSource(root, "/abs/a2.mp4"); // load → setT → frame fetch held open
    await flush();
    enterSource(root, "/abs/b.mp4"); // load → setT → newer frame lands
    await flush();
    const img = root.querySelector<HTMLImageElement>(".fl-stage img")!;
    expect(img.src).toContain("BBBB");

    stale.reject(new Error("ffmpeg exploded"));
    await flush();

    const emptyMsg = root.querySelector<HTMLElement>(".fl-stage-center")!;
    expect(emptyMsg.textContent).not.toContain("ffmpeg exploded");
    expect(emptyMsg.style.display).toBe("none");
  });
});
