// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Tests for the runtime backend selection in app/src/platform/index.ts: the
 * module picks `tauriPlatform` when the Tauri webview's globals are present on
 * `window`, else `webPlatform`. Selection happens at MODULE EVALUATION time, so
 * each case resets the module registry and re-imports with the relevant global
 * installed first. Tauri v2 always injects `__TAURI_INTERNALS__` (the IPC
 * bridge); `__TAURI__` only exists with `withGlobalTauri` — index.ts must
 * detect on EITHER (detecting on `__TAURI__` alone mis-classified the native
 * shell as web).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type TauriGlobals = { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
const win = window as unknown as TauriGlobals;

async function importSelection() {
  const [index, tauri, web] = await Promise.all([
    import("../src/platform/index.js"),
    import("../src/platform/tauri.js"),
    import("../src/platform/web.js"),
  ]);
  return { index, tauri, web };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete win.__TAURI_INTERNALS__;
  delete win.__TAURI__;
});

describe("platform selection", () => {
  it("selects the tauri backend when __TAURI_INTERNALS__ (the v2 IPC bridge) is present", async () => {
    win.__TAURI_INTERNALS__ = {};
    const { index, tauri } = await importSelection();
    expect(index.platform).toBe(tauri.tauriPlatform);
    expect(index.platformName).toBe("tauri");
  });

  it("selects the tauri backend on the __TAURI__ fallback (withGlobalTauri)", async () => {
    win.__TAURI__ = {};
    const { index, tauri } = await importSelection();
    expect(index.platform).toBe(tauri.tauriPlatform);
    expect(index.platformName).toBe("tauri");
  });

  it("falls back to the web backend when no Tauri global is present", async () => {
    const { index, web } = await importSelection();
    expect(index.platform).toBe(web.webPlatform);
    expect(index.platformName).toBe("web");
  });
});
