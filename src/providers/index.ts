// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Vision-provider factory + barrel (SPEC §6.7).
 *
 * `makeTracker` turns a resolved `ModelRef` into the concrete `VisionTracker`
 * for that provider, so call sites and request types never change when a
 * provider is added — only this switch grows. Gemini is the only provider
 * implemented today (BYOK, opt-in); Anthropic / OpenAI slot in here behind the
 * same `VisionTracker` contract. The deterministic `MockTracker` is for
 * tests/offline and is constructed directly, not via the factory.
 */

import type { ModelRef } from "../model.js";
import type { VisionTracker } from "./types.js";
import { GeminiTracker } from "./gemini.js";

/**
 * Construct the vision tracker for a resolved model. Throws for a provider with
 * no implementation yet, so a misconfiguration fails loudly rather than silently
 * tracking with the wrong model.
 */
export function makeTracker(model: ModelRef): VisionTracker {
  switch (model.provider) {
    case "gemini":
      return new GeminiTracker({ model: model.model });
    default:
      throw new Error(
        `makeTracker: no vision provider for "${model.provider}" ` +
          `(only "gemini" is implemented today)`,
      );
  }
}

export type { VisionTracker, TrackSample, TrackRequest, TrackFrame } from "./types.js";
export { GeminiTracker } from "./gemini.js";
export { MockTracker } from "./mock.js";
