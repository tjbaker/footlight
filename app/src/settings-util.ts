// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure, DOM/storage-free helpers lifted out of `settings.ts` so they can be
 * unit-tested in isolation (Settings itself is one big `openSettings()` surface
 * that touches `document`/`window`/localStorage on import). Nothing here reads
 * the DOM, the keychain, or localStorage — just data in, data out. The cost
 * estimates derive from the same per-1M-token rate table the live chat readout
 * uses (`priceForModel`), so Settings and the in-chat cost can never drift.
 */

import { priceForModel } from "@assistant-cost";

// ---- theme resolution ----

export type ThemeMode = "light" | "dark" | "system";

/**
 * Resolve a stored theme string to a `ThemeMode`. Light is the default for an
 * absent or unrecognized value; "dark"/"system" are preserved. (The actual
 * localStorage read + `data-theme` apply stay in settings.ts.)
 */
export function resolveThemeMode(raw: string | null): ThemeMode {
  return raw === "dark" || raw === "system" ? raw : "light";
}

// ---- chat-stills budget ----

/** Default + ceiling for the per-turn chat-stills budget (cost is per frame). */
export const DEFAULT_CHAT_STILLS = 4;
export const CHAT_STILLS_MAX = 12;

/**
 * Clamp a raw chat-stills budget to a sane range: a non-number/non-finite value
 * falls back to the default; anything else is rounded and bounded to
 * `0..CHAT_STILLS_MAX`. (0 = state-only, no frames.)
 */
export function clampChatStillsBudget(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_CHAT_STILLS;
  return Math.max(0, Math.min(CHAT_STILLS_MAX, Math.round(n)));
}

// ---- cost estimates ----

// Token assumptions behind the Settings cost estimates. Rates come from
// `priceForModel` (assistant/cost.ts) — the same table the live chat readout uses.
const FRAME_INPUT_TOKENS = 258; // ≈ one Gemini image tile per sampled still (input only)
const REQ_INPUT_TOKENS = 2500; // a typical assistant turn: system + message + a few stills
const REQ_OUTPUT_TOKENS = 1500; // ...and its reply (output bills higher than input)

/** Estimated USD to send one sampled still frame to `modelId` (input tokens only). */
export function perFrameUsd(modelId: string): number {
  const p = priceForModel(modelId);
  return p ? (FRAME_INPUT_TOKENS * p.inputPerM) / 1e6 : 0;
}

/** Estimated USD for one assistant chat turn with `modelId` (input + output). */
export function perRequestUsd(modelId: string): number {
  const p = priceForModel(modelId);
  return p ? (REQ_INPUT_TOKENS * p.inputPerM + REQ_OUTPUT_TOKENS * p.outputPerM) / 1e6 : 0;
}
