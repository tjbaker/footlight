// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's persisted preferences, lifted out of editor.ts (#125) so they can
 * be unit-tested in isolation. Everything here is a thin, fail-soft localStorage
 * round-trip — no DOM, no platform: each read falls back to a sane default when
 * the key is missing, the JSON is garbage, or localStorage itself is unavailable
 * (private mode etc.), and each write swallows quota/availability errors.
 */

import type { RenderOptions } from "./platform/types.js";

/**
 * The assistant model the user picked in Settings → AI & models (persisted under
 * `footlight.ai` as `{ provider, model }`), defaulting to Gemini 3.5 Flash. Read
 * fresh per turn so a change in Settings takes effect without a reload.
 */
export function assistantSelection(): { assistantModel: { provider: string; model: string } } {
  let assistantModel = { provider: "gemini", model: "gemini-3.5-flash" };
  try {
    const raw = localStorage.getItem("footlight.ai");
    if (raw) {
      const p = JSON.parse(raw) as { provider?: unknown; model?: unknown };
      if (typeof p.provider === "string" && typeof p.model === "string") {
        assistantModel = { provider: p.provider, model: p.model };
      }
    }
  } catch {
    /* fall back to the default */
  }
  return { assistantModel };
}

/**
 * Render flags from Settings → Rendering (persisted under `footlight.render`).
 * Caption STYLE is per-clip now (carried on each `ClipSpec.caption` in the
 * manifest); only the render-wide `burnCaptions` on/off switch lives here.
 */
export function renderOptions(outdir: string): RenderOptions {
  const opts: RenderOptions = { outdir };
  try {
    const raw = localStorage.getItem("footlight.render");
    if (raw) {
      const p = JSON.parse(raw) as {
        crf?: unknown;
        preset?: unknown;
        audio?: unknown;
        bitrate?: unknown;
        dryRun?: unknown;
        burnCaptions?: unknown;
      };
      if (typeof p.crf === "number") opts.crf = p.crf;
      if (typeof p.preset === "string") opts.preset = p.preset;
      if (p.audio === "reencode" && typeof p.bitrate === "string") opts.audioBitrate = p.bitrate;
      if (p.dryRun === true) opts.dryRun = true;
      if (p.burnCaptions === true) opts.burnCaptions = true;
    }
  } catch {
    /* fall back to the engine's own defaults */
  }
  return opts;
}

// Persist the chosen output folder so it survives reloads (best effort).
const OUTDIR_KEY = "footlight.outdir";

/**
 * The persisted output folder, or `""` when the user has never chosen one — the
 * caller then seeds the platform default (native: a folder in ~/Movies) via
 * `platform.defaultOutdir()`. (Returning `""` here, not `"clips"`, is what lets a
 * fresh native install adopt a real home-dir folder instead of a relative path
 * next to the app bundle — issue #58.)
 */
export function loadOutdir(): string {
  try {
    return localStorage.getItem(OUTDIR_KEY) || "";
  } catch {
    return "";
  }
}

export function saveOutdir(value: string): void {
  try {
    const v = value.trim();
    if (v) localStorage.setItem(OUTDIR_KEY, v);
  } catch {
    /* localStorage unavailable (private mode etc.) — non-fatal. */
  }
}

// Live 9:16 output-preview visibility (persisted; default on).
const PREVIEW_KEY = "footlight.preview";

export function loadPreviewPref(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== "off";
  } catch {
    return true;
  }
}

export function savePreviewPref(on: boolean): void {
  try {
    localStorage.setItem(PREVIEW_KEY, on ? "on" : "off");
  } catch {
    /* non-fatal */
  }
}

// Recent source paths (most-recent-first), shown as a datalist on the path field.
const RECENTS_KEY = "footlight.recents";
const RECENTS_CAP = 10;

export function loadRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushRecent(path: string): void {
  const p = path.trim();
  if (!p) return;
  try {
    const next = [p, ...loadRecents().filter((x) => x !== p)].slice(0, RECENTS_CAP);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* non-fatal */
  }
}

// ---- Theme (light default, persisted) ----
const THEME_KEY = "footlight.theme";

export function saveTheme(t: "light" | "dark"): void {
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* non-fatal */
  }
}
