// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The assistant's commit transitions, lifted out of editor.ts (#125, Phase 2).
 * `applyCommitToState` is the WHOLE state change for one accepted `CommitOp` —
 * the same mutations the editor's closure used to perform inline — plus an
 * ordered list of UI effects for the caller to run (refresh readouts, redraw,
 * seek, kick scene detection…). Splitting the transition from the effects keeps
 * this unit-testable: tests assert the state delta and the effect list; the
 * editor wires each effect kind to its closure-bound function.
 */

import type { CommitOp } from "@assistant-types";
import { specToEditorState } from "@manifest";
import {
  clampInOut,
  clampTrimOut,
  keyframeFromCommit,
  type EditorState,
} from "./editor-store.js";

/** One UI side effect the editor must run after a commit, in list order. */
export type CommitEffect =
  | { kind: "refreshIO" }
  | { kind: "seekToIn" }
  | { kind: "refreshContentReadout" }
  | { kind: "refreshCropReadout" }
  | { kind: "drawOverlay" }
  | { kind: "detectScenes" }
  | { kind: "refreshKeyframes" }
  | { kind: "trackStatus"; count: number }
  | { kind: "stagedRender" };

/** Whether the commit changed state (`applied`), merely STAGED a render
 *  (`staged` — never auto-renders), and the UI effects to run, in order. */
export interface CommitResult {
  applied: boolean;
  staged: boolean;
  effects: CommitEffect[];
}

const SKIPPED: CommitResult = { applied: false, staged: false, effects: [] };

/**
 * Apply ONE accepted commit to the editor state. Anything that can't be cleanly
 * applied (e.g. a trim with no In point) returns `applied: false` so the
 * proposal row reads as skipped.
 */
export function applyCommitToState(state: EditorState, commit: CommitOp): CommitResult {
  switch (commit.kind) {
    case "setInOut": {
      const { inPoint, outPoint } = clampInOut(commit.inSec, commit.outSec, state.duration);
      state.inPoint = inPoint;
      state.outPoint = outPoint;
      return ok([{ kind: "refreshIO" }, { kind: "seekToIn" }]);
    }
    case "trim": {
      if (state.inPoint == null) return SKIPPED;
      state.outPoint = clampTrimOut(commit.outSec, state.inPoint, state.duration);
      return ok([{ kind: "refreshIO" }]);
    }
    case "setContentCrop": {
      // content-crop UI is currently inert in the editor; round-trip the spec
      // string through the manifest restorer so the box + mode are consistent.
      const r = specToEditorState(
        { source_file: state.source, in_point: "0", out_point: "0", content_crop: commit.contentCrop },
        state.dims!,
      );
      state.contentBox = r.contentBox;
      state.contentMode = r.contentMode;
      return ok([
        { kind: "refreshContentReadout" },
        { kind: "refreshCropReadout" },
        { kind: "drawOverlay" },
      ]);
    }
    case "detectScenes": {
      return ok([{ kind: "detectScenes" }]);
    }
    case "addCropKeyframe": {
      if (state.inPoint == null) return SKIPPED;
      // The commit's x is in working-region px; an integer x-pixel offset is a
      // valid `crop_offset` form (clamped into frame by the engine), so store it
      // straight as the keyframe offset.
      state.keyframes.push(keyframeFromCommit(commit.t, commit.x));
      return ok([{ kind: "refreshKeyframes" }]);
    }
    case "suggestCropForFrame": {
      // A single-frame framing suggestion → set the crop box from the proposed
      // offset (overwrites the manual box). The cropPath, if any, still wins at
      // render, so clear it so this fixed offset is what the user sees.
      state.cropPath = null;
      const r = specToEditorState(
        { source_file: state.source, in_point: "0", out_point: "0", crop_offset: commit.cropOffset },
        state.dims!,
      );
      state.cropBox = r.cropBox;
      return ok([
        { kind: "refreshCropReadout" },
        { kind: "drawOverlay" },
        { kind: "refreshIO" },
      ]);
    }
    case "trackSubject": {
      // Same engine as the Track-subject tab: adopt the eased crop path.
      state.cropPath = commit.cropPath.map((k) => ({ t: k.t, x: k.x }));
      return ok([
        { kind: "trackStatus", count: state.cropPath.length },
        { kind: "drawOverlay" },
        { kind: "refreshIO" },
      ]);
    }
    case "render": {
      // STAGE only — never auto-fire. Surface a hint; the manual Render button
      // owns the encode.
      return { applied: true, staged: true, effects: [{ kind: "stagedRender" }] };
    }
    default: {
      // Exhaustiveness guard — a new CommitOp kind lands here until wired.
      const _never: never = commit;
      void _never;
      return SKIPPED;
    }
  }
}

function ok(effects: CommitEffect[]): CommitResult {
  return { applied: true, staged: false, effects };
}
