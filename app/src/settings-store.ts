// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings persistence (#270): the small `localStorage` blobs behind every
 * non-secret preference, and the light / dark / system theme. The keys reuse
 * the ones the editor already reads (`footlight.theme`, `footlight.outdir`) so
 * the two stay in sync. The BYOK key never lands here — it lives in the OS
 * keychain (settings-ai-key.ts).
 */

import { type ThemeMode, clampChatStillsBudget, resolveThemeMode } from "./settings-util.js";

// ---- persisted preferences (localStorage; key reuse noted above) ----

export type Timecode = "smpte" | "frames";
export type AudioMode = "copy" | "reencode";

export const THEME_KEY = "footlight.theme"; // shared with the editor's top-bar toggle
export const OUTDIR_KEY = "footlight.outdir"; // shared with the editor's destination field
export const TIMECODE_KEY = "footlight.timecode";
export const AUTOSAVE_KEY = "footlight.autosave";
export const RENDER_KEY = "footlight.render"; // { crf, preset, audio, bitrate, dryRun, burnCaptions }
export const FONTS_DIR_KEY = "footlight.fontsDir"; // plain string: a folder of user .ttf/.otf fonts
export const AI_KEY = "footlight.ai"; // { provider, model }

export const PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;
export type Preset = (typeof PRESETS)[number];

export interface RenderPrefs {
  crf: number;
  preset: Preset;
  audio: AudioMode;
  bitrate: string; // "192k" | "256k" | "320k"
  dryRun: boolean;
  /**
   * Burn captions into the exported video (off by default — a clean export is
   * the default). The caption content/position/style comes from the clip; this
   * is the render-wide opt-in to render them at all.
   */
  burnCaptions: boolean;
}

export const DEFAULT_RENDER: RenderPrefs = {
  crf: 19,
  preset: "medium",
  audio: "copy",
  bitrate: "256k",
  dryRun: false,
  burnCaptions: false,
};

export interface AiPrefs {
  provider: string; // "gemini" | "claude" | "openai"
  model: string;
  /**
   * Append-only "framing preferences" overlay composed ON TOP of the read-only
   * base prompt (never replaces it). Optional; whitespace-only is treated as
   * absent. Capped at OVERLAY_MAX_CHARS.
   */
  overlay?: string;
  /**
   * How many stills the chat assistant samples + sends per turn so it can SEE the
   * footage (issue #40). 0 = state-only (no frames). Bounded by CHAT_STILLS_MAX.
   */
  chatStills?: number;
}

export const DEFAULT_AI: AiPrefs = { provider: "gemini", model: "gemini-3.5-flash" };

/** The per-turn chat-stills budget (0 = off), clamped to a sane range. */
export function loadChatStillsBudget(): number {
  const prefs = readJson<AiPrefs>(AI_KEY, DEFAULT_AI);
  return clampChatStillsBudget(prefs.chatStills);
}

/**
 * Hard cap on the overlay length. Not a security boundary (the overlay is the
 * user's own input on their own machine + key) — it just keeps a runaway paste
 * from bloating every turn's tokens. The real safety boundary is structural: the
 * base prompt is read-only, the operational/safety preamble is always composed
 * LAST, and nothing the model proposes mutates state without a human Accept.
 */
export const OVERLAY_MAX_CHARS = 2000;

/** The editor's saved framing-preferences overlay (trimmed; "" when unset). */
export function loadAssistantOverlay(): string {
  const prefs = readJson<AiPrefs>(AI_KEY, DEFAULT_AI);
  return (prefs.overlay ?? "").trim();
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage unavailable — non-fatal. */
  }
}

export function readStr(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStr(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-fatal */
  }
}

// ---- theme (light / dark / system) ----

let systemThemeMql: MediaQueryList | null = null;
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

function osPrefersDark(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function loadThemeMode(): ThemeMode {
  return resolveThemeMode(readStr(THEME_KEY, "light"));
}

/** Resolve a mode to a concrete light|dark, write `data-theme`, and (for System)
 *  install a `prefers-color-scheme` listener so the root follows the OS live. */
function applyThemeMode(mode: ThemeMode): void {
  // Tear down any prior System listener; re-installed below only when needed.
  if (systemThemeMql && systemThemeListener) {
    systemThemeMql.removeEventListener("change", systemThemeListener);
    systemThemeMql = null;
    systemThemeListener = null;
  }
  const resolve = (): "light" | "dark" =>
    mode === "system" ? (osPrefersDark() ? "dark" : "light") : mode;
  document.documentElement.setAttribute("data-theme", resolve());
  if (mode === "system" && typeof window.matchMedia === "function") {
    systemThemeMql = window.matchMedia("(prefers-color-scheme: dark)");
    systemThemeListener = () => document.documentElement.setAttribute("data-theme", resolve());
    systemThemeMql.addEventListener("change", systemThemeListener);
  }
}

/**
 * Apply the persisted theme on startup. Called once from app boot so the
 * System mode's media listener is live even before Settings is opened, and the
 * root carries the resolved `data-theme`.
 */
export function initTheme(): void {
  applyThemeMode(loadThemeMode());
}

export function persistThemeMode(mode: ThemeMode): void {
  writeStr(THEME_KEY, mode);
  applyThemeMode(mode);
}
