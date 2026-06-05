// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// `@core` / `@manifest` alias the existing browser-safe pure modules in the
// parent repo's `src/`. `server.fs.allow` is widened to the repo root so Vite's
// dev server is permitted to read those files from outside the app dir.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("../src/core.ts", import.meta.url)),
      "@manifest": fileURLToPath(new URL("../src/manifest.ts", import.meta.url)),
      "@track": fileURLToPath(new URL("../src/track.ts", import.meta.url)),
      // Browser-safe TYPE-only import (TrackSample). NOT providers/gemini.ts —
      // the Gemini network call runs in the backend via the CLI, never here.
      "@provider-types": fileURLToPath(
        new URL("../src/providers/types.ts", import.meta.url),
      ),
      // Pure, browser-safe model selection + assistant contract/tools, for the
      // coming AI-assistant UI. The orchestrator's network call runs in the
      // backend (like the tracker), never in these modules.
      "@model": fileURLToPath(new URL("../src/model.ts", import.meta.url)),
      "@assistant-types": fileURLToPath(
        new URL("../src/assistant/types.ts", import.meta.url),
      ),
      "@assistant-tools": fileURLToPath(
        new URL("../src/assistant/tools.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    fs: {
      // Allow serving files from the parent repo (where src/core.ts lives).
      allow: [repoRoot],
    },
  },
  // Tauri expects a relative base so the bundled assets resolve under the
  // app's webview origin.
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // Multi-page: the main UI + the separate Activity window (Tauri).
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        activity: fileURLToPath(new URL("activity.html", import.meta.url)),
      },
    },
  },
});
