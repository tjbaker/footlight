// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime backend selection. If we are running inside the Tauri webview, use the
 * native backend; otherwise use the localhost dev-server backend. The UI imports
 * only `platform` from here.
 */

import type { FootlightPlatform } from "./types.js";
import { webPlatform } from "./web.js";
import { tauriPlatform } from "./tauri.js";

function isTauri(): boolean {
  // Tauri v2 always injects `__TAURI_INTERNALS__` (the IPC bridge) regardless of
  // the `withGlobalTauri` config; the `__TAURI__` global (full JS API) is only
  // present when `withGlobalTauri` is enabled, which it is NOT here. Detecting on
  // `__TAURI__` alone therefore mis-classifies the native shell as web and
  // silently falls back to the dev-server backend (no native ffmpeg, no file
  // picker). Detect on the internals bridge, keeping `__TAURI__` as a fallback.
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

export const platform: FootlightPlatform = isTauri() ? tauriPlatform : webPlatform;

export const platformName: "tauri" | "web" = isTauri() ? "tauri" : "web";

export type { FootlightPlatform, ProbeResult } from "./types.js";
