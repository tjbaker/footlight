// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Model selection + resolution (SPEC §6.7) — pure and browser-safe.
 *
 * Today's flagship models are multimodal, so by default ONE model does both
 * jobs: the assistant (reasoning / tool-use) and the vision tools (tracking,
 * per-frame crop suggestions). A power user can opt into a SEPARATE, cheaper
 * vision model. The whole trick is the resolution rule — `visionModel ??
 * assistantModel` — so everything downstream consumes the RESOLVED value and
 * flipping the split on or off is a config change, never a refactor.
 */

/** A specific provider + model to call. */
export interface ModelRef {
  /** Provider id, e.g. `"gemini"` | `"anthropic"` | `"openai"`. */
  provider: string;
  /** Provider-specific model id, e.g. `"gemini-2.5-flash"`. */
  model: string;
}

/**
 * What Settings stores: the assistant model ALWAYS, and a vision override ONLY
 * when the Advanced "separate vision & tracking model" toggle is on.
 */
export interface ModelSelection {
  assistantModel: ModelRef;
  /** Set only when the split toggle is on; otherwise the assistant model is reused. */
  visionModel?: ModelRef;
}

/** The resolved pair every downstream caller consumes. */
export interface ResolvedModels {
  /** Reasoning / tool-use (per-request cost). */
  assistant: ModelRef;
  /** Pixel work — tracking / crop suggestions (per-frame cost). */
  vision: ModelRef;
}

/**
 * Resolve a selection into the assistant + vision pair. Vision falls back to the
 * assistant model unless a separate one is set (the one-vs-two "non-event").
 */
export function resolveModels(sel: ModelSelection): ResolvedModels {
  return {
    assistant: sel.assistantModel,
    vision: sel.visionModel ?? sel.assistantModel,
  };
}
