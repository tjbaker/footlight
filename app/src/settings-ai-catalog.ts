// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The AI panel's model catalog and its cost formatting (#270).
 */

import { DEFAULT_AI } from "./settings-store.js";

// ---- AI model catalog ----

export interface ModelOpt {
  id: string;
  name: string;
  recommended?: boolean;
  cap: string;
  speed: string;
}
/**
 * Model catalog, keyed by provider. Cost estimates are NOT stored here — they are
 * derived from the SAME per-1M-token rate table the live chat usage readout uses
 * (`assistant/cost.ts`), so Settings and the in-chat cost can never drift. Only
 * Gemini is wired today (the vision/assistant adapters); the Anthropic/OpenAI
 * lists are shown for the provider-agnostic picker and should be confirmed before
 * those providers are implemented.
 */
const MODEL_CATALOG = {
  gemini: [
    // Gemini 3.5 Pro is omitted until it ships (not released yet — selecting it
    // would just fail the API call, and there is no published price). Re-add it
    // here and in assistant/cost.ts GEMINI_PRICES at launch.
    {
      id: "gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      recommended: true,
      cap: "Fast, capable multimodal — the sweet spot for tracking.",
      speed: "fast",
    },
    {
      id: "gemini-3.5-flash-lite",
      name: "Gemini 3.5 Flash-Lite",
      cap: "Cheapest; good for dense sampling.",
      speed: "fastest",
    },
  ],
  // Anthropic / OpenAI have no adapter yet (see IMPLEMENTED_PROVIDERS) — no models listed.
} satisfies Record<string, ModelOpt[]>;

/** Providers with a working adapter today; others are shown but flagged "not yet implemented". */
export const IMPLEMENTED_PROVIDERS = new Set<string>(["gemini"]);

/** Models for a provider; empty for a provider that isn't implemented yet. */
export function modelsFor(provider: string): ModelOpt[] {
  return (MODEL_CATALOG as Record<string, ModelOpt[]>)[provider] ?? [];
}
/** A provider's default model id (recommended, else first, else the global default). */
export function defaultModelFor(provider: string): string {
  const ms = modelsFor(provider);
  return (ms.find((m) => m.recommended) ?? ms[0])?.id ?? DEFAULT_AI.model;
}

// perFrameUsd / perRequestUsd live in settings-util.ts (pure; same `priceForModel`
// rate table the live chat readout uses, so Settings and in-chat cost never drift).

export function fmtUsd(n: number): string {
  return "$" + n.toFixed(4);
}
