// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Vitest config for the render engine + CLI (root package). Tests live in
 * `test/` and import the pure modules under `src/` by relative path. Coverage is
 * v8-based and reports on ALL of `src/` (not just imported files) so untested
 * modules show as 0% — an honest picture of where we are. Run: `npm run coverage`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Entry points / type-only modules with no meaningful branch logic to cover.
      exclude: ["src/cli.ts", "src/**/types.ts", "src/**/index.ts"],
      // Console (`text`/`text-summary`) + `cobertura` (coverage/cobertura-coverage.xml)
      // for the Codecov upload in CI. No HTML report — console + Codecov suffice.
      reporter: ["text", "text-summary", "cobertura"],
      reportsDirectory: "coverage",
    },
  },
});
