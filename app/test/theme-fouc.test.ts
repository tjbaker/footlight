// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Guards the theme flash-of-dark (FOUC) fix. style.css makes :root the DARK
 * palette and [data-theme="light"] the override, so the first paint is dark
 * unless data-theme is stamped synchronously. A deferred module script (which is
 * how the app boots) runs too late, so each HTML entry point must carry an inline
 * pre-paint script that sets data-theme BEFORE the module loads. These tests fail
 * if that script is removed, reordered after the module, or stops mirroring the
 * settings.ts theme contract (footlight.theme key, light default, system→OS).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const html = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

for (const page of ["index.html", "activity.html"]) {
  describe(`theme FOUC guard — ${page}`, () => {
    const src = html(page);
    const moduleIdx = src.indexOf('<script type="module"');
    // The inline (non-module) bootstrap is the first <script> without type=module.
    const inlineIdx = src.indexOf("<script>");

    it("has an inline pre-paint <script> in <head>", () => {
      expect(inlineIdx).toBeGreaterThanOrEqual(0);
      expect(src.indexOf("</head>")).toBeGreaterThan(inlineIdx);
    });

    it("runs the inline script BEFORE the deferred module (so it beats first paint)", () => {
      expect(moduleIdx).toBeGreaterThanOrEqual(0);
      expect(inlineIdx).toBeLessThan(moduleIdx);
    });

    it("mirrors the settings.ts theme contract (key, default, system→OS, data-theme)", () => {
      const inline = src.slice(inlineIdx, src.indexOf("</script>", inlineIdx));
      expect(inline).toContain("footlight.theme"); // same persisted key
      expect(inline).toContain("data-theme"); // stamps the resolved theme
      expect(inline).toContain("prefers-color-scheme"); // resolves System → OS
      expect(inline).toContain('"light"'); // light is the default/fallback
    });
  });
}
