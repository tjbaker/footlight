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

vi.mock("../src/platform/index.js", async () =>
  (await import("./helpers/platform-mock.js")).platformModule);

import {
  installDomShims,
  resetHarness,
} from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { mountEditor } = await import("../src/editor.js");

describe("mountEditor (jsdom smoke)", () => {
  beforeEach(() => {
    resetHarness();
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
