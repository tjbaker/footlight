// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * SMOKE test for `mountEditor(root)` — the single highest-value DOM test, since
 * mounting exercises a large slice of editor.ts (top bar, stage, inspector,
 * timeline, queue, the floating activity panel) in one go. The bar here is
 * deliberately low: mount the whole editor into a jsdom document with a fully
 * stubbed platform and assert it renders its top-level shell WITHOUT throwing.
 * No deep behavior is asserted.
 *
 * What this test has to stub for jsdom (kept here, never in src):
 *   - `globalThis.localStorage` — a Map-backed shim (editor.ts reads prefs at
 *     mount; jsdom's own storage is fine too, but the shim keeps the test
 *     hermetic and matches the pattern in autotrack.test.ts).
 *   - `window.matchMedia` — `initTheme()` (settings.ts) calls it on boot; jsdom
 *     does not implement it. Returns a benign non-matching MediaQueryList.
 *   - `HTMLCanvasElement.getContext` — the stage overlay + preview canvases call
 *     it; jsdom returns null without the optional `canvas` package, and the
 *     editor's draw code already guards `if (!ctx) return`, so a null stub is
 *     enough (we install one explicitly so the result is deterministic).
 *
 * The `platform` module is mocked wholesale so no ffmpeg/dev-server is touched;
 * every async method resolves benign empty data so the mount's fire-and-forget
 * bootstrap (`restoreSession`, `rebuildFontPicker`) settles with no unhandled
 * rejection.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- localStorage: Map-backed shim (same shape as autotrack.test.ts) ---------
const store = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string): void => {
    store.set(k, String(v));
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
  clear: (): void => {
    store.clear();
  },
  key: (i: number): string | null => [...store.keys()][i] ?? null,
  get length(): number {
    return store.size;
  },
};
(globalThis as unknown as { localStorage: typeof localStorageMock }).localStorage =
  localStorageMock;

// --- window.matchMedia: initTheme() needs it on boot (jsdom lacks it) --------
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// --- HTMLCanvasElement.getContext: jsdom returns undefined; force null --------
// The editor's draw helpers guard `if (!ctx) return`, so a null context is a safe
// no-op that lets the smoke mount proceed without the native `canvas` package.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// --- platform: mocked wholesale (no ffmpeg / dev-server is reached) -----------
// Every async method async-resolves benign empty data so the mount's
// fire-and-forget bootstrap settles cleanly (no unhandled rejection).
vi.mock("../src/platform/index.js", () => {
  const platform = {
    platformName: "web" as const,
    supportsFilePicker: false,
    extractFrame: vi.fn(async () => ""),
    probe: vi.fn(async () => ({
      width: 1920,
      height: 1080,
      duration: 0,
      cropdetect: null,
    })),
    scenes: vi.fn(async () => [] as number[]),
    loudness: vi.fn(async () => ({ display: [] as number[], detect: [] as number[] })),
    track: vi.fn(async () => []),
    listFonts: vi.fn(async () => []),
    listUserFonts: vi.fn(async () => []),
    render: vi.fn(async () => ({ ok: true, log: "" })),
    defaultOutdir: vi.fn(async () => ""),
    checkOutdir: vi.fn(async () => ({ ok: true, resolved: "" })),
    exportTextFile: vi.fn(async () => false),
    openExternal: vi.fn(async () => undefined),
    pickSourceFile: vi.fn(async () => null),
    pickDirectory: vi.fn(async () => null),
    videoSrc: vi.fn(async () => ""),
    loadHistory: vi.fn(async () => []),
    saveHistory: vi.fn(async () => undefined),
    loadSession: vi.fn(async () => null),
    saveSession: vi.fn(async () => undefined),
    getSecret: vi.fn(async () => null),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
  };
  return {
    platform,
    platformName: platform.platformName,
    isTauri: () => false,
  };
});

// Import AFTER the mocks/shims above are installed.
const { mountEditor } = await import("../src/editor.js");

describe("mountEditor (jsdom smoke)", () => {
  beforeEach(() => {
    store.clear();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
  });

  it("mounts the editor shell into a root without throwing", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    expect(() => mountEditor(root)).not.toThrow();

    // Top-level shell is present synchronously.
    const app = root.querySelector(".fl-app");
    expect(app).not.toBeNull();

    // A few of the structural regions mountEditor builds into `.fl-app`.
    expect(app!.querySelector(".fl-topbar")).not.toBeNull();
    expect(app!.querySelector(".fl-main")).not.toBeNull();
    expect(app!.querySelector(".fl-stage")).not.toBeNull();

    // The brand word is rendered into the top bar.
    expect(root.textContent).toContain("Footlight");
  });

  it("settles its async mount bootstrap with no unhandled rejection", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    mountEditor(root);

    // Flush the microtask queue a few times so the fire-and-forget bootstrap
    // (restoreSession → loadSession, rebuildFontPicker → listFonts/listUserFonts)
    // resolves. The mocked platform makes every call a no-op, so the shell stays
    // mounted afterwards.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(root.querySelector(".fl-app")).not.toBeNull();
  });
});
