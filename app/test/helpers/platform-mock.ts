// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The ONE mocked `FootlightPlatform` for editor jsdom tests — previously
 * copy-pasted into every editor-*.test.ts harness. Each capability is a
 * vi.fn with the harness default; tests import `platformMocks` to override
 * per-case (`platformMocks.loadHistory.mockResolvedValue(...)`) and call
 * `resetPlatformMocks()` in their beforeEach to restore the defaults.
 *
 * Wire it up with the async-factory form (the documented way to share a mock
 * module without vi.hoisted):
 *
 *   vi.mock("../src/platform/index.js", async () =>
 *     (await import("./helpers/platform-mock.js")).platformModule);
 */

import { vi } from "vitest";
import type { FootlightPlatform } from "../../src/platform/types.js";

function defaults() {
  return {
    extractFrame: async () => "data:image/png;base64,AAAA",
    probe: async () => ({
      width: 1920,
      height: 1080,
      duration: 30,
      cropdetect: null as string | null,
    }),
    scenes: async () => [] as number[],
    loudness: async () => ({
      display: [] as number[],
      detect: [] as number[],
      onsets: [] as number[],
    }),
    track: async () => [],
    listFonts: async () => [],
    listUserFonts: async () => [],
    render: async () => ({ ok: true, log: "" }),
    exportCover: async () => true,
    defaultOutdir: async () => "/tmp/out",
    checkOutdir: async () => ({ ok: true, resolved: "/tmp/out" }),
    exportTextFile: async () => false,
    openExternal: async () => undefined,
    pickSourceFile: async () => null,
    pickDirectory: async () => null,
    videoSrc: async () => "blob:x",
    loadHistory: async () => [],
    saveHistory: async () => undefined,
    loadSession: async () => null,
    saveSession: async () => undefined,
    getSecret: async () => null,
    setSecret: async () => undefined,
    deleteSecret: async () => undefined,
  };
}

type Defaults = ReturnType<typeof defaults>;

/** Every platform capability as a vi.fn, pre-loaded with the harness default. */
export const platformMocks = Object.fromEntries(
  Object.entries(defaults()).map(([k, impl]) => [k, vi.fn(impl as (...a: never[]) => unknown)]),
) as { [K in keyof Defaults]: ReturnType<typeof vi.fn<Defaults[K]>> };

/** Restore every capability to its default implementation and clear calls. */
export function resetPlatformMocks(): void {
  const d = defaults();
  for (const k of Object.keys(d) as Array<keyof Defaults>) {
    platformMocks[k].mockReset();
    platformMocks[k].mockImplementation(d[k] as never);
  }
}

/** The module shape `vi.mock("../src/platform/index.js", …)` factories return. */
export const platformModule = {
  platform: { platformName: "web" as const, supportsFilePicker: false, ...platformMocks },
  platformName: "web" as const,
  isTauri: () => false,
};

/** The mocked platform as the interface the views take — the one sanctioned
 *  place for the mock→interface cast, so a capability the mock never stubs
 *  surfaces here instead of in per-suite double-casts. */
export const mockPlatform = platformModule.platform as unknown as FootlightPlatform;
