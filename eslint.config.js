// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
// One flat config lints BOTH packages (engine + app) from the root — eslint is
// a root devDependency only; `npm run lint` covers everything. Rules stay at
// `recommended` (correctness, not style — Prettier owns formatting). Type-aware
// linting is deliberately off: tsc strict already runs in CI for both packages,
// and parse-only keeps the lint fast and tsconfig-independent.

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "coverage/",
      "node_modules/",
      "app/dist/",
      "app/coverage/",
      "app/node_modules/",
      "app/src-tauri/",
      "bin/",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The repo's deliberate fail-soft pattern: `catch { /* why */ }` blocks
      // that degrade to a default. The comment documents the intent.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `_`-prefixed params/vars are the conventional "intentionally unused"
      // (exhaustiveness guards, ignored callback args).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // The dev server is plain Node ESM (dependency-free by design).
    files: ["app/dev-server/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
);
