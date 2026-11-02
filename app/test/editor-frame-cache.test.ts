// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's frame cache (`actions.extractCached`, #278): concurrent misses
 * for one source@time share ONE extraction, a failed extraction isn't cached,
 * and an evicted blob URL is revoked. `extractCached` touches only the
 * platform, so the actions are built with the shared mock platform and inert
 * view stubs. No full mount is needed.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { platformMocks, mockPlatform } from "./helpers/platform-mock.js";
import { installDomShims, resetHarness, flush } from "./helpers/editor-harness.js";
import { deferred } from "./helpers/deferred.js";

installDomShims();
const { createEditorActions } = await import("../src/editor-actions.js");
const { createEditorStore } = await import("../src/editor-store.js");

/** The actions with only the store + platform live; the views are never reached. */
function buildActions(): ReturnType<typeof createEditorActions> {
  const inert = {} as never;
  return createEditorActions({
    store: createEditorStore(),
    platform: mockPlatform,
    viewer: inert,
    timeline: inert,
    transport: inert,
    inspector: inert,
    topbar: inert,
    setOutput: () => undefined,
    setOutDir: () => undefined,
  });
}

describe("extractCached — the editor frame cache (#278)", () => {
  beforeEach(() => {
    resetHarness();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("concurrent misses for the same frame share one extraction", async () => {
    const actions = buildActions();
    const d = deferred<string>();
    platformMocks.extractFrame.mockImplementation(() => d.promise);

    const a = actions.extractCached("/abs/a.mp4", 1.5);
    const b = actions.extractCached("/abs/a.mp4", 1.5);
    expect(platformMocks.extractFrame).toHaveBeenCalledTimes(1);

    d.resolve("blob:one");
    expect(await a).toBe("blob:one");
    expect(await b).toBe("blob:one");
    // A later hit is served from the cache too.
    expect(await actions.extractCached("/abs/a.mp4", 1.5)).toBe("blob:one");
    expect(platformMocks.extractFrame).toHaveBeenCalledTimes(1);
  });

  it("a failed extraction isn't cached: the next ask retries", async () => {
    const actions = buildActions();
    platformMocks.extractFrame
      .mockRejectedValueOnce(new Error("ffmpeg died"))
      .mockResolvedValueOnce("blob:retry");

    await expect(actions.extractCached("/abs/a.mp4", 2)).rejects.toThrow("ffmpeg died");
    await flush();
    expect(await actions.extractCached("/abs/a.mp4", 2)).toBe("blob:retry");
    expect(platformMocks.extractFrame).toHaveBeenCalledTimes(2);
  });

  it("revokes the blob URL of the entry it evicts", async () => {
    const actions = buildActions();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    platformMocks.extractFrame.mockImplementation(async (_s: string, t: number) => `blob:${t}`);

    for (let t = 0; t < 96; t++) await actions.extractCached("/abs/a.mp4", t);
    expect(revoke).not.toHaveBeenCalled();

    await actions.extractCached("/abs/a.mp4", 96); // the 97th entry evicts t=0
    await flush();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:0");
  });
});
