// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Assistant orchestrator (SPEC §6.7) — pure and browser-safe.
 *
 * Drives ONE assistant turn: ask the model (an injected `AssistantModel`) for
 * prose + tool-call PROPOSALS, then materialize each proposal into a
 * preview-only `ProposedAction`. Deterministic tools resolve via `interpretTool`;
 * the two vision tools run an injected `VisionRunner` (frames + the vision model,
 * supplied by the backend) and use the manifest/track builders. **Nothing mutates
 * editor state** — every action is a proposal the human Accepts / Steps /
 * Discards, and `render` only ever stages. Both the model and the vision runner
 * are injected so this file stays pure and testable (see `MockAssistant` /
 * `MockVisionRunner`); the network/ffmpeg lives behind those seams.
 */

import type { Box, Dims } from "../manifest.js";
import type { ResolvedModels } from "../model.js";
import type { TrackSample } from "../providers/types.js";
import type { AssistantReply, Grounding, ProposedAction, ToolName } from "./types.js";
import {
  TOOLS,
  DETERMINISTIC_TOOLS,
  interpretTool,
  buildSuggestCropAction,
  buildTrackSubjectAction,
  type ToolSpec,
} from "./tools.js";

/** A single tool call the model proposes (a PROPOSAL, never an execution). */
export interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
}

/** What a model adapter returns for one turn: prose + grounded tool-call proposals. */
export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  /** Real signals cited (swells / scene cuts / stills; NEVER audio). */
  grounding?: Grounding[];
  /** Optional caveat the model surfaced (inferring; can't see colored-banner pillarbox). */
  warn?: string;
}

/**
 * Project state the model is grounded in — STILLS + state, never audio. Carries
 * what the model and the vision runner need; the orchestrator itself only reads
 * `region` (crop math) and passes the rest through to the vision runner.
 */
export interface AssistantContext {
  /** Working region (post content-crop) for crop math. */
  region: Dims;
  /** Source path/handle, for frame extraction by the vision runner. */
  source?: string;
  /** Clip In/Out and duration (clip-relative seconds). */
  inSec?: number;
  outSec?: number;
  duration?: number;
  /** Detected scene cuts (clip-relative seconds) the model may align to. */
  sceneCuts?: number[];
  /** Suggested loudness swells the model may cite as grounding. */
  swells?: Array<{ t: number; label?: string }>;
  /** Resolved assistant + vision models (one-vs-two already collapsed). */
  models: ResolvedModels;
  /** BYOK key (opt-in; providers never ship one). */
  apiKey: string;
  /**
   * The read-only "framing brain" base system prompt (`prompts/base.md`),
   * prepended to every turn so the model actually carries the domain expertise.
   * Optional so tests and the offline mock can omit it.
   */
  basePrompt?: string;
  /**
   * The editor's append-only framing-preferences overlay (Settings → AI). It is
   * composed ON TOP OF `basePrompt` — it refines, never replaces, the safety
   * guidance. Empty/whitespace is treated as absent.
   */
  userOverlay?: string;
}

/** A prior conversation turn (for multi-turn context). */
export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

/** One request to the assistant: the user's intent + grounded context. */
export interface AssistantTurnRequest {
  message: string;
  context: AssistantContext;
  history?: ConversationMessage[];
  signal?: AbortSignal;
}

/** The LLM adapter (Gemini / Claude / Mock): one turn -> prose + tool-call proposals. */
export interface AssistantModel {
  readonly name: string;
  turn(req: {
    message: string;
    tools: readonly ToolSpec[];
    context: AssistantContext;
    history?: ConversationMessage[];
    signal?: AbortSignal;
  }): Promise<ModelTurn>;
}

/**
 * Materializes the two VISION tools. Injected (like `VisionTracker`) so the
 * orchestrator stays pure; the real implementation extracts frames and calls the
 * vision model in the backend.
 */
export interface VisionRunner {
  /** Propose a 9:16 crop for one frame -> a subject box in working-region px. */
  suggestCropForFrame(args: { t: number; subjectHint?: string }, ctx: AssistantContext): Promise<Box>;
  /** Track a subject across the shot -> located samples (fed to `samplesToCropPath`). */
  trackSubject(args: { subjectHint: string }, ctx: AssistantContext): Promise<TrackSample[]>;
}

/**
 * Run ONE assistant turn. Asks the model for prose + tool-call proposals, then
 * turns each into a preview-only `ProposedAction`. A proposal that fails to
 * materialize (bad args, vision error) is DROPPED and noted in `warn` rather than
 * failing the whole turn — the rest of the reply still renders.
 */
export async function runAssistantTurn(
  model: AssistantModel,
  vision: VisionRunner,
  req: AssistantTurnRequest,
): Promise<AssistantReply> {
  const turn = await model.turn({
    message: req.message,
    tools: TOOLS,
    context: req.context,
    history: req.history,
    signal: req.signal,
  });

  const actions: ProposedAction[] = [];
  const failures: string[] = [];

  for (const call of turn.toolCalls) {
    try {
      actions.push(await materialize(call, vision, req.context));
    } catch (err) {
      failures.push(`${call.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let warn = turn.warn;
  if (failures.length) {
    const note = `Skipped ${failures.length} proposal(s): ${failures.join("; ")}`;
    warn = warn ? `${warn} ${note}` : note;
  }

  const grounding: Grounding[] = turn.grounding ?? [];
  return warn !== undefined
    ? { text: turn.text, grounding, warn, actions }
    : { text: turn.text, grounding, actions };
}

/** Turn one proposed tool call into a `ProposedAction` (deterministic or vision). */
async function materialize(
  call: ToolCall,
  vision: VisionRunner,
  ctx: AssistantContext,
): Promise<ProposedAction> {
  if (DETERMINISTIC_TOOLS.has(call.name)) {
    return interpretTool(call.name, call.args, { region: ctx.region });
  }
  if (call.name === "suggestCropForFrame") {
    const t = numArg(call.args, "t");
    const hint = optStr(call.args, "subjectHint");
    const box = await vision.suggestCropForFrame(
      hint !== undefined ? { t, subjectHint: hint } : { t },
      ctx,
    );
    return buildSuggestCropAction(t, box, ctx.region);
  }
  if (call.name === "trackSubject") {
    const subjectHint = reqStr(call.args, "subjectHint");
    const samples = await vision.trackSubject({ subjectHint }, ctx);
    return buildTrackSubjectAction(samples, ctx.region);
  }
  throw new Error(`unknown tool "${call.name}"`);
}

function numArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`"${key}" must be a finite number`);
  }
  return v;
}
function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return v;
}
function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
