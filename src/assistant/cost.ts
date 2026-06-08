// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Per-turn cost ESTIMATION (SPEC §6.7) — pure and browser-safe.
 *
 * The Gemini API reports exact token *counts* (`usageMetadata`) but never a
 * dollar figure: there is no pricing endpoint. So a USD cost is always a
 * client-side estimate — token counts × a per-model rate table we maintain here.
 * Treat the result as an ESTIMATE: published list rates drift, and the real bill
 * can differ from this for context caching, free-tier, and tiered/flex pricing.
 * The authoritative spend is always the provider's billing dashboard.
 *
 * Rates are USD per 1,000,000 tokens, from Google's published Gemini developer
 * API pricing. Update this table when Google changes prices. An unknown model
 * yields `null` (the UI then shows tokens only, no dollar figure) — better an
 * honest gap than a wrong number.
 */

import type { Usage } from "./types.js";

/** A model's list rate: USD per 1M input vs output tokens. */
export interface ModelPrice {
  /** USD per 1,000,000 input (prompt) tokens. */
  inputPerM: number;
  /** USD per 1,000,000 output (candidate + thinking) tokens. */
  outputPerM: number;
}

/**
 * Published Gemini developer-API list rates (USD / 1M tokens). Keyed by the base
 * model id; a versioned/preview id (e.g. `gemini-2.5-flash-preview-05-20`) matches
 * by longest id prefix, so `-lite` wins over the plain `-flash` entry. ESTIMATE
 * only — keep in sync with https://ai.google.dev/gemini-api/docs/pricing.
 */
export const GEMINI_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gemini-2.5-pro": { inputPerM: 1.25, outputPerM: 10.0 },
  "gemini-2.5-flash": { inputPerM: 0.3, outputPerM: 2.5 },
  "gemini-2.5-flash-lite": { inputPerM: 0.1, outputPerM: 0.4 },
  "gemini-2.0-flash": { inputPerM: 0.1, outputPerM: 0.4 },
  "gemini-2.0-flash-lite": { inputPerM: 0.075, outputPerM: 0.3 },
};

/**
 * Resolve a model id to its rate. Exact match first, then the LONGEST table key
 * that is a prefix of `model` (so `gemini-2.5-flash-lite-preview` matches the
 * `-lite` entry, not the shorter `-flash` one). Returns null when nothing matches.
 */
export function priceForModel(model: string): ModelPrice | null {
  const exact = GEMINI_PRICES[model];
  if (exact) return exact;
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(GEMINI_PRICES)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best ? best.price : null;
}

/**
 * Estimate the USD cost of one turn from its token usage and the assistant model
 * id. Returns null when the model's price is unknown — callers then surface the
 * token counts alone rather than invent a dollar figure.
 */
export function estimateCostUsd(usage: Usage, model: string): number | null {
  const price = priceForModel(model);
  if (!price) return null;
  return (
    (usage.promptTokens * price.inputPerM + usage.outputTokens * price.outputPerM) /
    1_000_000
  );
}
