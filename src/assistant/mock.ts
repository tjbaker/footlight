// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic, offline assistant + vision stand-ins (SPEC §6.7 tests/demo).
 *
 * `MockAssistant` maps a few intent keywords to tool-call proposals (no network,
 * fully reproducible) so the orchestrator — and the propose → ghost → commit UI —
 * can be exercised with no API key. `MockVisionRunner` materializes the two
 * vision tools via the existing `MockTracker`. Neither is wired into production;
 * the real Gemini adapter plugs in behind the same `AssistantModel` /
 * `VisionRunner` interfaces.
 */

import { MockTracker } from "../providers/mock.js";
import { planSampleTimes } from "../track.js";
import type { Box } from "../manifest.js";
import type { TrackSample } from "../providers/types.js";
import type { Grounding } from "./types.js";
import type {
  AssistantContext,
  AssistantModel,
  ModelTurn,
  ToolCall,
  VisionRunner,
} from "./orchestrator.js";

/** Nearest loudness swell to a time, for grounding citations (never audio). */
function nearestSwell(ctx: AssistantContext, t: number): Grounding | undefined {
  const swells = ctx.swells ?? [];
  if (swells.length === 0) return undefined;
  let best = swells[0]!;
  for (const s of swells) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return {
    kind: "swell",
    t: best.t,
    detail: best.label ? `loudness swell "${best.label}" @ ${best.t}s` : `loudness swell @ ${best.t}s`,
  };
}

/** Pull a quoted or trailing subject hint out of the message; default if none. */
function subjectFrom(message: string): string {
  const quoted = message.match(/"([^"]+)"|'([^']+)'/);
  if (quoted) return quoted[1] ?? quoted[2] ?? "the subject";
  const after = message.match(/(?:track|follow)\s+(.+)$/i);
  return after?.[1]?.trim() || "the subject";
}

/**
 * A deterministic offline assistant. Recognizes a handful of intents and returns
 * the matching tool-call proposals; otherwise replies with prose and no actions.
 * It grounds time-locating proposals in the nearest loudness swell when context
 * has them, and warns when it INFERS values the user didn't state.
 */
export class MockAssistant implements AssistantModel {
  readonly name = "mock";

  async turn(req: {
    message: string;
    context: AssistantContext;
  }): Promise<ModelTurn> {
    const m = req.message.toLowerCase();
    const ctx = req.context;
    const toolCalls: ToolCall[] = [];
    const grounding: Grounding[] = [];
    let text = "";
    let warn: string | undefined;

    if (/\btrim\b/.test(m)) {
      const end = ctx.outSec ?? ctx.duration ?? 1;
      const outSec = Math.max(0, end - 1);
      toolCalls.push({ name: "trim", args: { outSec } });
      text = `Trimming the last second — new out at ${outSec}s.`;
    } else if (/\b(track|follow)\b/.test(m)) {
      const subjectHint = subjectFrom(req.message);
      toolCalls.push({ name: "trackSubject", args: { subjectHint } });
      text = `Tracking ${subjectHint} across the shot.`;
      const g = nearestSwell(ctx, ctx.inSec ?? 0);
      if (g) grounding.push(g);
    } else if (/\b(crop|center|reframe|frame)\b/.test(m)) {
      const t = ctx.inSec ?? 0;
      toolCalls.push({ name: "suggestCropForFrame", args: { t } });
      text = `Proposing a crop for the frame at ${t}s.`;
      warn = "I can't see colored-banner pillarbox — verify the framing on the pixels.";
    } else if (/\b(scene|cut|detect)\b/.test(m)) {
      toolCalls.push({ name: "detectScenes", args: {} });
      text = "Detecting scene cuts so we can align crop switches to them.";
    } else if (/\b(render|encode|export)\b/.test(m)) {
      toolCalls.push({ name: "render", args: {} });
      text = "Staging the queue — press Render when you're ready (I won't encode for you).";
    } else if (/\b(clip|in and out|set in|in.?out)\b/.test(m)) {
      const inSec = ctx.inSec ?? 0;
      const outSec = ctx.outSec ?? inSec + 5;
      toolCalls.push({ name: "setInOut", args: { inSec, outSec } });
      text = `Setting the clip to ${inSec}s → ${outSec}s.`;
      warn = "Inferred In/Out from the current clip — adjust as needed.";
      const g = nearestSwell(ctx, inSec);
      if (g) grounding.push(g);
    } else {
      text = "Tell me a moment or a framing and I'll propose it — e.g. \"track the guitarist\" or \"trim the tail.\"";
    }

    return warn !== undefined ? { text, toolCalls, grounding, warn } : { text, toolCalls, grounding };
  }
}

/** Deterministic vision stand-in backed by `MockTracker` (no network/ffmpeg). */
export class MockVisionRunner implements VisionRunner {
  async suggestCropForFrame(args: { t: number }, ctx: AssistantContext): Promise<Box> {
    return new MockTracker({ region: ctx.region }).boxAt(args.t);
  }

  async trackSubject(_args: { subjectHint: string }, ctx: AssistantContext): Promise<TrackSample[]> {
    const shotStart = ctx.inSec ?? 0;
    const shotEnd = ctx.outSec ?? shotStart + 3;
    const tracker = new MockTracker({ region: ctx.region, shotStart, shotEnd });
    const sampleTimes = planSampleTimes({
      shotStart,
      shotEnd,
      intervalSec: 0.75,
      ...(ctx.sceneCuts ? { sceneCuts: ctx.sceneCuts } : {}),
    });
    return tracker.track({
      sourcePath: ctx.source ?? "",
      region: ctx.region,
      sampleTimes,
      apiKey: ctx.apiKey,
    });
  }
}
