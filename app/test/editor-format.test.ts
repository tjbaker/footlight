// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the display-formatting helpers extracted from editor.ts
 * (editor-format.ts): clip duration from manifest timestamps, the tiny-USD cost
 * formatter, ghost-preview selection for pending assistant actions, and the
 * history modal's clock/day/framing-mode labels. The label tests compare
 * against the active i18n catalog (the module is locale-aware by design), so
 * they hold under any catalog the test env resolves.
 */

import { describe, it, expect } from "vitest";
import {
  clipDur,
  fmtUsd,
  ghostsFrom,
  fmtClockTime,
  dayLabel,
  offsetMode,
} from "../src/editor-format.js";
import { messages } from "../src/i18n/index.js";
import type { ClipSpec } from "@manifest";
import type { ProposedAction } from "@assistant-types";

const m = messages.editor;

/** A minimal valid clip spec to splat overrides onto. */
function spec(over: Partial<ClipSpec> = {}): ClipSpec {
  return { source_file: "a.mp4", in_point: "0", out_point: "1", ...over };
}

describe("clipDur", () => {
  it("parses engine timestamps (plain seconds and mm:ss forms)", () => {
    expect(clipDur(spec({ in_point: "5", out_point: "12.5" }))).toBe(7.5);
    expect(clipDur(spec({ in_point: "0:05", out_point: "1:02" }))).toBe(57);
  });

  it("clamps a negative window to 0", () => {
    expect(clipDur(spec({ in_point: "10", out_point: "5" }))).toBe(0);
  });

  it("returns 0 for unparseable timestamps", () => {
    expect(clipDur(spec({ in_point: "nope", out_point: "5" }))).toBe(0);
  });
});

describe("fmtUsd (tiny-cost formatter)", () => {
  it("uses 2 decimals from a dollar up", () => {
    expect(fmtUsd(1)).toBe("$1.00");
    expect(fmtUsd(12.5)).toBe("$12.50");
  });

  it("uses 4 decimals under a dollar (fractions of a cent)", () => {
    expect(fmtUsd(0.0042)).toBe("$0.0042");
    expect(fmtUsd(0.5)).toBe("$0.5000");
  });
});

describe("ghostsFrom (pending-action previews)", () => {
  // Only `.ghost` is read; display/commit are irrelevant here.
  const act = (ghost?: ProposedAction["ghost"]): ProposedAction =>
    ({ display: { fn: "setInOut", detail: "" }, ghost, commit: {} }) as unknown as ProposedAction;

  it("keeps the ghosts from `from` onward, dropping ghost-less actions", () => {
    const g1 = { keyframe: { t: 1, x: 100 } };
    const g2 = { region: { inSec: 0, outSec: 2 } };
    const actions = [act(g1), act(undefined), act(g2)];
    expect(ghostsFrom(actions, 0)).toEqual([g1, g2]);
    expect(ghostsFrom(actions, 1)).toEqual([g2]);
    expect(ghostsFrom(actions, 3)).toEqual([]);
  });
});

describe("fmtClockTime", () => {
  it("formats a wall-clock time with hour + 2-digit minutes", () => {
    const ts = new Date(2026, 0, 15, 14, 5).getTime();
    const out = fmtClockTime(ts);
    expect(out).toContain("05"); // the 2-digit minute survives any locale
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("dayLabel", () => {
  it("labels today and yesterday from the catalog", () => {
    const now = Date.now();
    expect(dayLabel(now)).toBe(m.history.today);
    expect(dayLabel(now - 86400000)).toBe(m.history.yesterday);
  });

  it("labels an older day as its short month + day", () => {
    const old = new Date(2026, 0, 15, 12, 0).getTime();
    expect(dayLabel(old)).toBe(
      new Date(old).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(dayLabel(old)).not.toBe(m.history.today);
  });
});

describe("offsetMode (framing-mode pill)", () => {
  it("an AI crop path wins as 'track'", () => {
    expect(offsetMode(spec({ cropPath: [{ t: 0, x: 100 }] }))).toEqual({
      label: m.history.modeTrack,
      ghost: false,
    });
  });

  it("a punch-in window comes next", () => {
    expect(offsetMode(spec({ cropWindow: { x: 0, y: 0, w: 304, h: 540 } }))).toEqual({
      label: m.history.modePunchIn,
      ghost: false,
    });
  });

  it("a schedule string reads as 'keyframes'", () => {
    expect(offsetMode(spec({ crop_offset: "0=center; 14.5=440" }))).toEqual({
      label: m.history.modeKeyframes,
      ghost: false,
    });
  });

  it("a fixed offset is shown verbatim, ghosted", () => {
    expect(offsetMode(spec({ crop_offset: "left" }))).toEqual({ label: "left", ghost: true });
  });

  it("no offset at all falls back to the default-offset label, ghosted", () => {
    expect(offsetMode(spec())).toEqual({ label: m.framing.defaultOffset, ghost: true });
  });
});
