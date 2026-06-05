// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Assistant tool registry (SPEC §6.7) — pure and browser-safe.
 *
 * Two surfaces:
 *   - `TOOLS` — the function-call SCHEMAS the orchestrator hands the model.
 *   - builders — turn a model's tool call (or a vision result) into a typed
 *     `ProposedAction` (display + ghost + commit), reusing the engine/studio crop
 *     math so every proposed `x`/offset is engine-valid by construction.
 *
 * The tools split three ways:
 *   - deterministic (args alone fully determine the commit): `setInOut`,
 *     `addCropKeyframe`, `setContentCrop`, `trim`, `detectScenes`, `render` —
 *     handled by `interpretTool`.
 *   - vision (the commit depends on a model's pixel result): `suggestCropForFrame`,
 *     `trackSubject` — the orchestrator runs the vision call, then calls
 *     `buildSuggestCropAction` / `buildTrackSubjectAction` with the result.
 */

import { TARGET_AR, parseContentCrop, type CropPathKeyframe } from "../core.js";
import { cropBoxToOffset, roundEven, type Box, type Dims } from "../studio.js";
import { samplesToCropPath } from "../track.js";
import type { TrackSample } from "../providers/types.js";
import type { ProposedAction, ToolName } from "./types.js";

/** Minimal JSON-schema fragment describing a tool's parameters (for function-calling). */
export interface JsonSchema {
  type: "object";
  properties: Record<
    string,
    { type: "number" | "string" | "boolean"; description: string }
  >;
  required: string[];
  additionalProperties: false;
}

/** A tool the assistant may call: name, prose description, and a param schema. */
export interface ToolSpec {
  name: ToolName;
  description: string;
  paramSchema: JsonSchema;
}

const obj = (
  properties: JsonSchema["properties"],
  required: string[],
): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

/** The full tool surface, in a stable order. */
export const TOOLS: readonly ToolSpec[] = [
  {
    name: "setInOut",
    description: "Set the clip's In and Out points (clip-relative seconds). Out must be after In.",
    paramSchema: obj(
      {
        inSec: { type: "number", description: "In point, seconds from the start of the source." },
        outSec: { type: "number", description: "Out point, seconds. Must be greater than inSec." },
      },
      ["inSec", "outSec"],
    ),
  },
  {
    name: "addCropKeyframe",
    description:
      "Add a crop keyframe at a clip-relative time. x is the 9:16 window's left edge in working-region pixels; it is clamped into frame.",
    paramSchema: obj(
      {
        t: { type: "number", description: "Clip-relative time of the keyframe, seconds." },
        x: { type: "number", description: "Crop window x (left edge) in working-region pixels." },
      },
      ["t", "x"],
    ),
  },
  {
    name: "setContentCrop",
    description:
      "Set the content crop that strips letterbox/pillarbox bars before the 9:16 crop. Format W:H:X:Y in source pixels.",
    paramSchema: obj(
      { contentCrop: { type: "string", description: "Content region as W:H:X:Y." } },
      ["contentCrop"],
    ),
  },
  {
    name: "detectScenes",
    description: "Detect scene cuts in the source so crop-schedule switches can align to them.",
    paramSchema: obj({}, []),
  },
  {
    name: "suggestCropForFrame",
    description:
      "Ask the vision model to propose a 9:16 crop for the frame at time t. Cannot see colored/blurred pillarbox.",
    paramSchema: obj(
      {
        t: { type: "number", description: "Clip-relative time of the frame to analyze, seconds." },
        subjectHint: { type: "string", description: "Optional subject description, e.g. 'the guitarist'." },
      },
      ["t"],
    ),
  },
  {
    name: "trackSubject",
    description:
      "Track a moving subject across one continuous shot and build an eased crop path. Single shot only (no cuts inside).",
    paramSchema: obj(
      { subjectHint: { type: "string", description: "Subject to follow, e.g. 'the person playing guitar'." } },
      ["subjectHint"],
    ),
  },
  {
    name: "trim",
    description: "Adjust only the Out point (trim the tail) to a clip-relative time in seconds.",
    paramSchema: obj(
      { outSec: { type: "number", description: "New Out point, seconds." } },
      ["outSec"],
    ),
  },
  {
    name: "render",
    description: "Stage the queue for render. Never encodes on its own — the human confirms render manually.",
    paramSchema: obj({}, []),
  },
] as const;

/** Tools whose commit is fully determined by their args (no vision result needed). */
export const DETERMINISTIC_TOOLS: ReadonlySet<ToolName> = new Set([
  "setInOut",
  "addCropKeyframe",
  "setContentCrop",
  "detectScenes",
  "trim",
  "render",
]);

/** Lookup a tool spec by name. */
export const TOOL_BY_NAME: ReadonlyMap<ToolName, ToolSpec> = new Map(
  TOOLS.map((t) => [t.name, t]),
);

// ---- crop math (mirrors the engine / studio exactly) ----

/** Fixed 9:16 crop width for a landscape region: `even(round(height * 9/16))`. */
function cropWidth(region: Dims): number {
  const w = Math.round(region.height * TARGET_AR);
  return w - (w % 2);
}

/**
 * Clamp a crop-window x into frame the SAME way the engine + `cropBoxToOffset`
 * do: even-round, then bound to `[0, region.width - cropWidth]`.
 */
export function clampCropX(x: number, region: Dims): number {
  const maxX = region.width - cropWidth(region);
  const xe = roundEven(x);
  return Math.max(0, Math.min(xe, maxX));
}

// ---- helpers ----

function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`tool arg "${key}" must be a finite number (got ${JSON.stringify(v)})`);
  }
  return v;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`tool arg "${key}" must be a non-empty string`);
  }
  return v;
}

/** Format a clip-relative time for the mono readout, trimming trailing zeros. */
function fmtSec(t: number): string {
  return `${Math.round(t * 1000) / 1000}s`;
}

/** Context the deterministic interpreter needs (the working region for crop math). */
export interface ToolContext {
  region: Dims;
}

/**
 * Turn a DETERMINISTIC tool call into a `ProposedAction`. Validates args
 * (e.g. ordered In/Out, a parseable content crop) and clamps any crop x into
 * frame so the resulting commit is engine-valid. Throws for the vision tools
 * (`suggestCropForFrame`, `trackSubject`) — build those from a vision result via
 * `buildSuggestCropAction` / `buildTrackSubjectAction`.
 */
export function interpretTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): ProposedAction {
  switch (name) {
    case "setInOut": {
      const inSec = num(args, "inSec");
      const outSec = num(args, "outSec");
      if (!(outSec > inSec)) {
        throw new Error(`setInOut: outSec (${outSec}) must be greater than inSec (${inSec})`);
      }
      return {
        display: { fn: name, detail: `${fmtSec(inSec)} -> ${fmtSec(outSec)}` },
        ghost: { region: { inSec, outSec } },
        commit: { kind: "setInOut", inSec, outSec },
      };
    }
    case "trim": {
      const outSec = num(args, "outSec");
      return {
        display: { fn: name, detail: `out -> ${fmtSec(outSec)}` },
        commit: { kind: "trim", outSec },
      };
    }
    case "addCropKeyframe": {
      const t = num(args, "t");
      const x = clampCropX(num(args, "x"), ctx.region);
      return {
        display: { fn: name, detail: `t=${fmtSec(t)} x=${x}` },
        ghost: { keyframe: { t, x } },
        commit: { kind: "addCropKeyframe", t, x },
      };
    }
    case "setContentCrop": {
      const contentCrop = str(args, "contentCrop");
      if (!parseContentCrop(contentCrop)) {
        throw new Error(`setContentCrop: "${contentCrop}" is not a valid W:H:X:Y region`);
      }
      return {
        display: { fn: name, detail: contentCrop },
        ghost: { contentCrop },
        commit: { kind: "setContentCrop", contentCrop },
      };
    }
    case "detectScenes":
      return { display: { fn: name, detail: "detect scene cuts" }, commit: { kind: "detectScenes" } };
    case "render":
      return { display: { fn: name, detail: "stage queue for render" }, commit: { kind: "render" } };
    case "suggestCropForFrame":
    case "trackSubject":
      throw new Error(
        `interpretTool: "${name}" is a vision tool — build it from the model result ` +
          `with buildSuggestCropAction / buildTrackSubjectAction`,
      );
  }
}

/**
 * Build the proposal for a `suggestCropForFrame` result: the vision model's
 * subject box -> a `crop_offset` via the SAME inversion the GUI uses
 * (`cropBoxToOffset`), so the suggestion is always an engine-valid offset.
 */
export function buildSuggestCropAction(t: number, box: Box, region: Dims): ProposedAction {
  const cropOffset = cropBoxToOffset(box, region);
  return {
    display: { fn: "suggestCropForFrame", detail: `${fmtSec(t)} -> ${cropOffset}` },
    ghost: { crop: box },
    commit: { kind: "suggestCropForFrame", t, cropOffset },
  };
}

/**
 * Build the proposal for a `trackSubject` result: located samples -> an eased
 * crop path via the existing `samplesToCropPath` pipeline (one-euro smooth ->
 * deadzone -> velocity limit -> eased keyframes). The path is the commit and the
 * timeline ghost.
 */
export function buildTrackSubjectAction(samples: TrackSample[], region: Dims): ProposedAction {
  const cropPath: CropPathKeyframe[] = samplesToCropPath(samples, region);
  return {
    display: { fn: "trackSubject", detail: `${cropPath.length} keyframes` },
    ghost: { path: cropPath.map((k) => ({ t: k.t, x: k.x })) },
    commit: { kind: "trackSubject", cropPath },
  };
}
