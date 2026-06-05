// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * AI-assistant contract types (SPEC §6.7) — pure and browser-safe.
 *
 * The assistant is control-first: it PROPOSES, the proposal PREVIEWS on the
 * canvas as a ghost, and nothing mutates until the human ACCEPTs. So every
 * proposed action carries three separable parts:
 *   - `display`  — the mono "proposed action" readout the user sees,
 *   - `ghost`    — what previews on the viewer/timeline (no state change),
 *   - `commit`   — the typed mutation applied to editor state on Accept.
 * Keeping them separate is what lets a proposal render without mutating and lets
 * "Step" apply one at a time. `render` only ever STAGES — it never auto-fires.
 *
 * Grounding: the model sees STILLS + project state, never audio. Every proposal
 * that locates a moment cites the REAL signals it used (loudness swells, scene
 * cuts, specific stills) and must never imply it heard audio.
 */

import type { Box } from "../manifest.js";
import type { CropPathKeyframe } from "../core.js";

/** The assistant's tool surface (mirrors SPEC §6.7). */
export type ToolName =
  | "setInOut"
  | "addCropKeyframe"
  | "setContentCrop"
  | "detectScenes"
  | "suggestCropForFrame"
  | "trackSubject"
  | "trim"
  | "render";

/**
 * A real signal a proposal is grounded in. NEVER `"audio"` — the model only
 * sees stills + state, so it cites the loudness swells / scene cuts / stills it
 * actually used (e.g. "matched 'piano comes in' -> loudness swell @ 01:08").
 */
export interface Grounding {
  kind: "swell" | "scene-cut" | "still";
  /** Clip-relative time the signal refers to (seconds). */
  t: number;
  /** Human-readable detail, e.g. "loudness swell @ 01:08". */
  detail?: string;
  /** Subject box for a `"still"` citation, in working-region px. */
  box?: Box;
}

/**
 * What a proposal previews on the canvas (dashed ghosts) WITHOUT mutating state.
 * Absent fields simply don't draw; non-visual tools (`detectScenes`, `render`)
 * carry no ghost.
 */
export interface GhostPreview {
  /** In/Out region ghost on the timeline (clip-relative seconds). */
  region?: { inSec: number; outSec: number };
  /** Crop-keyframe diamond ghost. */
  keyframe?: { t: number; x: number };
  /** 9:16 crop-box ghost on the viewer (working-region px). */
  crop?: Box;
  /** Content-crop ghost, `W:H:X:Y`. */
  contentCrop?: string;
  /** Eased crop-path ghost on the timeline (from `trackSubject`). */
  path?: Array<{ t: number; x: number }>;
}

/**
 * The typed mutation a proposal applies to editor state on Accept. A
 * discriminated union over the tool surface so the editor's `applyXxx` entry
 * points can switch on `kind` exhaustively.
 */
export type CommitOp =
  | { kind: "setInOut"; inSec: number; outSec: number }
  | { kind: "addCropKeyframe"; t: number; x: number }
  | { kind: "setContentCrop"; contentCrop: string }
  | { kind: "detectScenes" }
  | { kind: "suggestCropForFrame"; t: number; cropOffset: string }
  | { kind: "trackSubject"; cropPath: CropPathKeyframe[] }
  | { kind: "trim"; outSec: number }
  /** Stages the queue for render; the real `platform.render` stays behind the manual button. */
  | { kind: "render" };

/** One proposed action: how it reads, how it previews, what it commits. */
export interface ProposedAction {
  /** Mono readout, e.g. `{ fn: "setInOut", detail: "01:02.0 -> 01:16.8" }`. */
  display: { fn: ToolName; detail: string };
  /** Canvas/timeline preview; omitted for non-visual tools. */
  ghost?: GhostPreview;
  /** The state mutation applied on Accept. */
  commit: CommitOp;
}

/** One assistant turn: prose + grounded citations + proposed (preview-only) actions. */
export interface AssistantReply {
  /** Short natural-language explanation. */
  text: string;
  /** The real signals the proposals are grounded in (never audio). */
  grounding: Grounding[];
  /** Optional caveat (inferring; or "can't see colored-banner pillarbox"). */
  warn?: string;
  /** Proposed actions — preview-only until the human Accepts / Steps / Discards. */
  actions: ProposedAction[];
}
