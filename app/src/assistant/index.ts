// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The assistant FRONTEND seam (SPEC §6.7) — the thin factory the coming dock UI
 * calls to run a turn.
 *
 * Both halves of the assistant are browser-safe and run in the FRONTEND: the
 * `GeminiAssistant` model (fetch-only reasoning / tool-use) and the orchestrator
 * (pure). The only thing that must reach the outside world is pixel work, and
 * that already lives behind the platform via `RealVisionRunner` (which reuses
 * `platform.track`). So wiring an assistant is just: pick the resolved models,
 * construct the model adapter for the chosen provider, and pair it with the real
 * vision runner. `runAssistantTurn` then drives one turn end-to-end.
 *
 * BYOK & opt-in (SPEC §6.7): the key travels on `AssistantContext.apiKey` per
 * turn (sourced from the platform secret store by the UI), never baked in here.
 * Keep this thin — there is no UI in this module; the dock owns presentation.
 */

import { resolveModels, type ModelSelection, type ModelRef } from "@model";
import type { AssistantReply } from "@assistant-types";
import { GeminiAssistant } from "../../../src/assistant/gemini.js";
import {
  runAssistantTurn,
  type AssistantModel,
  type AssistantTurnRequest,
  type ConversationMessage,
  type VisionRunner,
} from "../../../src/assistant/orchestrator.js";
import type { FootlightPlatform } from "../platform/types.js";
import { platform as defaultPlatform } from "../platform/index.js";
import { RealVisionRunner } from "./vision-runner.js";

export type { AssistantReply, AssistantTurnRequest, ConversationMessage };

/** Options for `createAssistant` — model selection plus the offline/BYOK toggle. */
export interface CreateAssistantOpts {
  /** The Settings model selection (assistant model, optional separate vision model). */
  selection: ModelSelection;
  /** Platform to run pixel work against; defaults to the runtime-selected one. */
  platform?: FootlightPlatform;
  /** Run the deterministic offline tracker (no network, no key) for the vision tools. */
  mock?: boolean;
}

/**
 * A wired assistant: the model adapter + vision runner + a one-call `turn`
 * helper. The dock UI constructs this once per model selection and calls `turn`
 * for each user message, threading prior turns as `history`.
 */
export interface Assistant {
  readonly model: AssistantModel;
  readonly vision: VisionRunner;
  /** Run one turn end-to-end (model proposes → orchestrator materializes previews). */
  turn(req: AssistantTurnRequest): Promise<AssistantReply>;
}

/**
 * Construct the assistant model adapter for a resolved provider. Gemini is the
 * only one implemented today (mirrors `makeTracker` in providers/index.ts);
 * other providers slot in here behind the same `AssistantModel` contract. Throws
 * loudly for an unknown provider so a misconfiguration never silently no-ops.
 */
export function makeAssistantModel(model: ModelRef): AssistantModel {
  switch (model.provider) {
    case "gemini":
      return new GeminiAssistant({ model: model.model });
    default:
      throw new Error(
        `makeAssistantModel: no assistant provider for "${model.provider}" ` +
          `(only "gemini" is implemented today)`,
      );
  }
}

/**
 * Wire `GeminiAssistant` + the real `VisionRunner` for the selected models. The
 * model resolution rule (`vision ?? assistant`) is applied here so the dock
 * never has to know whether the user split vision onto a cheaper model.
 */
export function createAssistant(opts: CreateAssistantOpts): Assistant {
  const models = resolveModels(opts.selection);
  const platform = opts.platform ?? defaultPlatform;
  const model = makeAssistantModel(models.assistant);
  const vision = new RealVisionRunner(
    platform,
    opts.mock !== undefined ? { mock: opts.mock } : {},
  );
  return {
    model,
    vision,
    turn: (req) => runAssistantTurn(model, vision, req),
  };
}
