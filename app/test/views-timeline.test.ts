// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DIRECT unit tests for views/timeline.ts (#125 Phase 5) — the view is built
 * via `buildTimeline(store, deps)` with a REAL EditorStore and spy deps
 * (seek / extractFrame / onDetectScenes), NOT through mountEditor. The track
 * is pinned to a fixed 1000×40 rect (helpers/rect.ts) so the time↔pixel map
 * is `t = clientX / 1000 * duration`. Covered:
 *
 *  - the REACTIVE track painting through `store.set`: ruler ticks, the RMS
 *    waveform (placeholder bars, level→height/colour mapping, the loading
 *    shimmer via `setWaveLoading`), scene-cut markers + count chip, onset
 *    ticks, swell chips (and their run-up seek), and the playhead/bubble;
 *  - the PULL seams assistant commits drive explicitly: `renderRegion` /
 *    `renderKf` (In/Out + keyframe writes alone repaint nothing — that
 *    asymmetry IS the contract) and `renderGhosts` (dashed region + diamonds);
 *  - onset snap: the toggle's persistence, `snapT`, and snap-at-RELEASE on
 *    In-edge and region drags (never mid-drag — asserted);
 *  - cut jumps (`jumpCut` + the prev/next buttons), the Detect-scenes button;
 *  - marker selection (`setSelectedMarker` classes) + `nudgeMarker` clamping;
 *  - the hover affordances: the edge `ew-resize` cursor, and the hover thumb's
 *    debounced + 0.5s-quantized `extractFrame` (fake timers), its supersede-
 *    on-move behaviour, and its hide on drag/pointerleave.
 *
 * Deliberately NOT re-pinned here: the basic drag-trim/click-seek interactions
 * (region drag sets In→Out, plain click seeks, edge drags move one marker) —
 * editor-timeline-drag.test.ts already pins those end-to-end through
 * mountEditor; this suite only adds what that one can't see (store patches at
 * the view seam + the snap-on-release semantics). jsdom-unreachable and
 * therefore skipped: real layout/pixel rendering (rects are stubbed) and the
 * hover thumbnail's <img> load.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LOUDNESS_BUCKETS } from "@core";
import { messages } from "../src/i18n/index.js";
import { createEditorStore, type EditorState } from "../src/editor-store.js";
import { installDomShims, resetHarness, buttonByText } from "./helpers/editor-harness.js";
import { firePointer } from "./helpers/pointer.js";
import { stubRect } from "./helpers/rect.js";

installDomShims();
// Import AFTER the shims above are installed.
const { buildTimeline } = await import("../src/views/timeline.js");

const m = messages.editor;
const TRACK_W = 1000;

/**
 * Build the view on a fresh store, then `store.set` the source state so the
 * REACTIVE repaint path (not just the build-time paint) is what's exercised.
 */
function makeTimeline(patch: Partial<EditorState> = {}) {
  const store = createEditorStore();
  const seek = vi.fn();
  const extractFrame = vi.fn(async () => "data:image/png;base64,AAAA");
  const onDetectScenes = vi.fn();
  const view = buildTimeline(store, { seek, extractFrame, onDetectScenes });
  document.body.append(view.element);
  store.set({
    source: "/abs/clip.mp4",
    dims: { width: 1920, height: 1080 },
    duration: 30,
    ...patch,
  });
  const track = view.element.querySelector<HTMLElement>(".fl-tl-track")!;
  stubRect(track, TRACK_W, 40);
  return { store, view, track, seek, extractFrame, onDetectScenes };
}

const leftPct = (el: Element): number => Number.parseFloat((el as HTMLElement).style.left);

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reactive track painting", () => {
  it("a duration change paints 5 ruler ticks; duration 0 clears them", () => {
    const { store, view } = makeTimeline();
    const labels = () =>
      Array.from(view.element.querySelectorAll(".fl-tl-tick .fl-tl-label")).map(
        (l) => l.textContent,
      );
    expect(labels()).toEqual(["0:00", "0:06", "0:12", "0:18", "0:24"]);
    const ticks = view.element.querySelectorAll<HTMLElement>(".fl-tl-tick");
    expect(Array.from(ticks).map(leftPct)).toEqual([0, 20, 40, 60, 80]);
    store.set({ duration: 0 });
    expect(labels()).toEqual([]);
  });

  it("paints placeholder bars without loudness, level-mapped bars with it", () => {
    const { store, view } = makeTimeline();
    const wave = view.element.querySelector<HTMLElement>(".fl-tl-wave")!;
    // No data yet → LOUDNESS_BUCKETS flat 8% placeholder bars.
    expect(wave.children).toHaveLength(LOUDNESS_BUCKETS);
    expect((wave.children[0] as HTMLElement).style.height).toBe("8%");

    store.set({ loudness: [0, 0.45, 1] });
    const bars = Array.from(wave.children) as HTMLElement[];
    expect(bars).toHaveLength(3);
    // Height = 10% + L·82% with L floored at 0.06; colour lerps muted→orange.
    // The view writes toFixed(1) heights; CSSOM drops the trailing ".0" on read-back.
    expect(bars.map((b) => b.style.height)).toEqual(["14.9%", "46.9%", "92%"]);
    expect(bars[2]!.style.background.replace(/\s/g, "")).toBe("rgb(255,122,69)");
    expect(bars[0]!.style.background).not.toBe(bars[2]!.style.background);

    store.set({ loudness: [] }); // empty array → back to the placeholder
    expect(wave.children).toHaveLength(LOUDNESS_BUCKETS);
  });

  it("setWaveLoading toggles the shimmer class and repaints", () => {
    const { view } = makeTimeline();
    const wave = view.element.querySelector<HTMLElement>(".fl-tl-wave")!;
    view.setWaveLoading(true);
    expect(wave.classList.contains("loading")).toBe(true);
    view.setWaveLoading(false);
    expect(wave.classList.contains("loading")).toBe(false);
  });

  it("scene cuts paint full-height markers and update the cuts chip", () => {
    const { store, view } = makeTimeline();
    store.set({ sceneCuts: [3, 15] });
    const cuts = view.element.querySelectorAll(".fl-tl-cut");
    expect(cuts).toHaveLength(2);
    expect(leftPct(cuts[0]!)).toBeCloseTo(10, 6);
    expect(leftPct(cuts[1]!)).toBeCloseTo(50, 6);
    expect(view.element.querySelector(".fl-rdchip:not(.swell) .val")!.textContent).toBe("2");
  });

  it("with duration unknown, cuts paint no markers but the chip still counts", () => {
    const { store, view } = makeTimeline({ duration: 0 });
    store.set({ sceneCuts: [3, 15] });
    expect(view.element.querySelectorAll(".fl-tl-cut")).toHaveLength(0);
    expect(view.element.querySelector(".fl-rdchip:not(.swell) .val")!.textContent).toBe("2");
  });

  it("onsets paint ticks along the track (none while duration is unknown)", () => {
    const { store, view } = makeTimeline({ duration: 0 });
    store.set({ onsets: [6, 12] });
    expect(view.element.querySelectorAll(".fl-tl-onset")).toHaveLength(0);
    store.set({ duration: 30 });
    const ticks = view.element.querySelectorAll(".fl-tl-onset");
    expect(ticks).toHaveLength(2);
    expect(leftPct(ticks[0]!)).toBeCloseTo(20, 6);
  });

  it("swells paint a chip + mark each; the chip seeks ~0.4s before the rise", () => {
    const { store, view, seek } = makeTimeline();
    store.set({
      swells: [
        { t: 10, label: "swell" },
        { t: 0.2, label: "early" },
      ],
    });
    const chips = view.element.querySelectorAll<HTMLButtonElement>(".fl-suggest");
    expect(chips).toHaveLength(2);
    expect(view.element.querySelectorAll(".fl-tl-suggest-mark")).toHaveLength(2);
    expect(view.element.querySelector(".fl-rdchip.swell .val")!.textContent).toBe("2");
    expect(leftPct(chips[0]!)).toBeCloseTo(100 / 3, 6);
    chips[0]!.click();
    expect(seek).toHaveBeenLastCalledWith(9.6);
    chips[1]!.click();
    expect(seek).toHaveBeenLastCalledWith(0); // clamped at the source start
  });

  it("the playhead tracks t with its ms bubble, hiding while duration is unknown", () => {
    const { store, view } = makeTimeline();
    const head = view.element.querySelector<HTMLElement>(".fl-tl-playhead")!;
    store.set({ t: 15 });
    expect(head.style.display).toBe("block");
    expect(leftPct(head)).toBeCloseTo(50, 6);
    expect(view.element.querySelector(".fl-tl-bubble")!.textContent).toBe("0:15.000");
    store.set({ duration: 0 });
    expect(head.style.display).toBe("none");
  });
});

describe("renderRegion / renderKf — the explicit (non-reactive) seams", () => {
  it("In/Out writes alone repaint nothing; renderRegion() paints the region", () => {
    const { store, view } = makeTimeline();
    const region = view.element.querySelector<HTMLElement>(".fl-tl-region:not(.ghost)")!;
    store.set({ inPoint: 6, outPoint: 18 });
    expect(region.style.display).toBe("none"); // the editor's refreshIO drives this
    view.renderRegion();
    expect(region.style.display).toBe("block");
    expect(leftPct(region)).toBeCloseTo(20, 6);
    expect(Number.parseFloat(region.style.width)).toBeCloseTo(40, 6);
  });

  it("an invalid window (Out ≤ In, or no In) hides the region", () => {
    const { store, view } = makeTimeline();
    store.set({ inPoint: 6, outPoint: 18 });
    view.renderRegion();
    store.set({ outPoint: 6 });
    view.renderRegion();
    const region = view.element.querySelector<HTMLElement>(".fl-tl-region:not(.ghost)")!;
    expect(region.style.display).toBe("none");
  });

  it("renderKf places a diamond at In + t per keyframe; none without an In point", () => {
    const { store, view } = makeTimeline();
    store.set({
      keyframes: [
        { t: 1, offset: "480" },
        { t: 4, offset: "640" },
      ],
    });
    view.renderKf();
    expect(view.element.querySelectorAll(".fl-tl-kf:not(.ghost)")).toHaveLength(0); // no In yet
    store.set({ inPoint: 6 });
    view.renderKf();
    const kfs = view.element.querySelectorAll(".fl-tl-kf:not(.ghost)");
    expect(kfs).toHaveLength(2);
    expect(leftPct(kfs[0]!)).toBeCloseTo((7 / 30) * 100, 6);
    expect(leftPct(kfs[1]!)).toBeCloseTo((10 / 30) * 100, 6);
  });
});

describe("renderGhosts — assistant proposal previews", () => {
  it("draws a dashed region for a proposed In/Out and clears with the set", () => {
    const { view } = makeTimeline();
    const ghost = view.element.querySelector<HTMLElement>(".fl-tl-region.ghost")!;
    view.renderGhosts([{ region: { inSec: 3, outSec: 9 } }]);
    expect(ghost.style.display).toBe("block");
    expect(leftPct(ghost)).toBeCloseTo(10, 6);
    expect(Number.parseFloat(ghost.style.width)).toBeCloseTo(20, 6);
    view.renderGhosts([]);
    expect(ghost.style.display).toBe("none");
  });

  it("hides the region ghost for a degenerate proposal (out ≤ in)", () => {
    const { view } = makeTimeline();
    view.renderGhosts([{ region: { inSec: 9, outSec: 9 } }]);
    expect(view.element.querySelector<HTMLElement>(".fl-tl-region.ghost")!.style.display).toBe(
      "none",
    );
  });

  it("draws keyframe/path diamonds at In + t, only once an In point exists", () => {
    const { store, view } = makeTimeline();
    const ghosts = [
      { keyframe: { t: 1, x: 480 } },
      {
        path: [
          { t: 0, x: 0 },
          { t: 2, x: 50 },
        ],
      },
    ];
    view.renderGhosts(ghosts);
    expect(view.element.querySelectorAll(".fl-tl-kf.ghost")).toHaveLength(0); // no In yet
    store.set({ inPoint: 6 });
    view.renderGhosts(ghosts);
    const ds = view.element.querySelectorAll(".fl-tl-kf.ghost");
    expect(ds).toHaveLength(3);
    expect(Array.from(ds).map(leftPct)).toEqual([
      expect.closeTo((7 / 30) * 100, 6),
      expect.closeTo((6 / 30) * 100, 6),
      expect.closeTo((8 / 30) * 100, 6),
    ]);
  });
});

describe("onset snap", () => {
  it("snapT passes through while OFF; the toggle persists and arms it", () => {
    const { view } = makeTimeline({ onsets: [2.5] });
    expect(view.snapT(2.45)).toBe(2.45); // default OFF — assistive, opt-in
    const snapBtn = buttonByText(view.element, m.timeline.snapLabel);
    expect(snapBtn.classList.contains("on")).toBe(false);
    snapBtn.click();
    expect(snapBtn.classList.contains("on")).toBe(true);
    expect(localStorage.getItem("footlight.snap")).toBe("on");
    expect(view.snapT(2.45)).toBe(2.5);
    expect(view.snapT(10)).toBe(10); // nothing within ±150ms
    snapBtn.click();
    expect(localStorage.getItem("footlight.snap")).toBe("off");
    expect(view.snapT(2.45)).toBe(2.45);
  });

  it("the persisted pref seeds the next build ON", () => {
    localStorage.setItem("footlight.snap", "on");
    const { view } = makeTimeline({ onsets: [4] });
    expect(buttonByText(view.element, m.timeline.snapLabel).classList.contains("on")).toBe(true);
    expect(view.snapT(4.1)).toBe(4);
  });

  it("a region drag snaps BOTH ends at release only, never mid-drag", () => {
    localStorage.setItem("footlight.snap", "on");
    const { store, track } = makeTimeline({ onsets: [6.05, 17.9] });
    firePointer(track, "pointerdown", { clientX: 200 }); // anchor 6s
    firePointer(track, "pointermove", { clientX: 600 }); // 18s
    expect(store.state.inPoint).toBe(6); // mid-drag: the hand's point, unsnapped
    expect(store.state.outPoint).toBe(18);
    firePointer(track, "pointerup", { clientX: 600 });
    expect(store.state.inPoint).toBe(6.05); // release: magnetized to the onsets
    expect(store.state.outPoint).toBe(17.9);
  });

  it("an In-edge drag snaps only the In point at release", () => {
    localStorage.setItem("footlight.snap", "on");
    const { store, track } = makeTimeline({ onsets: [9.06], inPoint: 6, outPoint: 18 });
    firePointer(track, "pointerdown", { clientX: 200 }); // on the In edge (6s → 200px)
    firePointer(track, "pointermove", { clientX: 300 }); // In → 9s
    firePointer(track, "pointerup", { clientX: 300 });
    expect(store.state.inPoint).toBe(9.06);
    expect(store.state.outPoint).toBe(18); // untouched by an "in" drag
  });

  it("with snap OFF a release leaves the points exactly where they were put", () => {
    const { store, track } = makeTimeline({ onsets: [6.05, 17.9] });
    firePointer(track, "pointerdown", { clientX: 200 });
    firePointer(track, "pointermove", { clientX: 600 });
    firePointer(track, "pointerup", { clientX: 600 });
    expect(store.state.inPoint).toBe(6);
    expect(store.state.outPoint).toBe(18);
  });
});

describe("cut jumps + Detect scenes", () => {
  it("jumpCut seeks the nearest cut on either side; dead-ends seek nothing", () => {
    const { store, view, seek } = makeTimeline({ sceneCuts: [5, 10, 20] });
    store.set({ t: 10 });
    view.jumpCut(-1);
    expect(seek).toHaveBeenLastCalledWith(5);
    view.jumpCut(1);
    expect(seek).toHaveBeenLastCalledWith(20);
    seek.mockClear();
    store.set({ t: 5 });
    view.jumpCut(-1); // nothing before the first cut
    store.set({ t: 20 });
    view.jumpCut(1); // nothing after the last cut
    expect(seek).not.toHaveBeenCalled();
  });

  it("does nothing with no detected cuts; the buttons drive the same jump", () => {
    const { view, seek, store } = makeTimeline();
    view.jumpCut(1);
    expect(seek).not.toHaveBeenCalled();
    store.set({ sceneCuts: [12], t: 3 });
    view.element.querySelector<HTMLButtonElement>(`[title="${m.timeline.nextCutTitle}"]`)!.click();
    expect(seek).toHaveBeenLastCalledWith(12);
    store.set({ t: 20 });
    view.element.querySelector<HTMLButtonElement>(`[title="${m.timeline.prevCutTitle}"]`)!.click();
    expect(seek).toHaveBeenLastCalledWith(12);
  });

  it("the Detect-scenes button calls the editor's scene-detect action", () => {
    const { view, onDetectScenes } = makeTimeline();
    buttonByText(view.element, m.timeline.detectScenes).click();
    expect(onDetectScenes).toHaveBeenCalledTimes(1);
  });
});

describe("marker selection + keyboard nudge", () => {
  it("setSelectedMarker highlights the chosen edge on the region", () => {
    const { view } = makeTimeline();
    const region = view.element.querySelector<HTMLElement>(".fl-tl-region:not(.ghost)")!;
    view.setSelectedMarker("in");
    expect(region.classList.contains("sel-in")).toBe(true);
    view.setSelectedMarker("out");
    expect(region.classList.contains("sel-in")).toBe(false);
    expect(region.classList.contains("sel-out")).toBe(true);
    view.setSelectedMarker(null);
    expect(region.classList.contains("sel-out")).toBe(false);
  });

  it("nudges the selected marker through the store (clamped) and seeks it", () => {
    const { store, view, seek } = makeTimeline({ inPoint: 6, outPoint: 18 });
    view.setSelectedMarker("in");
    expect(view.nudgeMarker(0.5)).toBe(true);
    expect(store.state.inPoint).toBe(6.5);
    expect(seek).toHaveBeenLastCalledWith(6.5);
    expect(view.nudgeMarker(99)).toBe(true);
    expect(store.state.inPoint).toBe(18); // clamped at Out
    store.set({ inPoint: 6 }); // restore headroom — Out clamps at In, which now sits at 18
    view.setSelectedMarker("out");
    expect(view.nudgeMarker(-0.25)).toBe(true);
    expect(store.state.outPoint).toBe(17.75);
    expect(view.nudgeMarker(99)).toBe(true);
    expect(store.state.outPoint).toBe(30); // clamped at duration
  });

  it("returns false (and seeks nothing) without a selection or without the point", () => {
    const { view, seek } = makeTimeline({ inPoint: null, outPoint: null });
    expect(view.nudgeMarker(0.5)).toBe(false);
    view.setSelectedMarker("in");
    expect(view.nudgeMarker(0.5)).toBe(false); // selected, but no In point exists
    expect(seek).not.toHaveBeenCalled();
  });

  it("a plain click on the track drops the marker selection", () => {
    const { view, track } = makeTimeline({ inPoint: 6, outPoint: 18 });
    view.setSelectedMarker("in");
    firePointer(track, "pointerdown", { clientX: 400 }); // interior, far from both edges
    firePointer(track, "pointerup", { clientX: 400 }); // <3px ⇒ a click, not a drag
    const region = view.element.querySelector<HTMLElement>(".fl-tl-region:not(.ghost)")!;
    expect(region.classList.contains("sel-in")).toBe(false);
  });
});

describe("hover affordances", () => {
  it("offers ew-resize over an In/Out edge and pointer elsewhere", () => {
    const { track } = makeTimeline({ inPoint: 6, outPoint: 18 });
    firePointer(track, "pointermove", { clientX: 201 }); // within 7px of In (200px)
    expect(track.style.cursor).toBe("ew-resize");
    firePointer(track, "pointermove", { clientX: 400 });
    expect(track.style.cursor).toBe("pointer");
  });

  it("the hover thumb debounces a 0.5s-quantized extractFrame and shows the frame", async () => {
    vi.useFakeTimers();
    const { track, extractFrame } = makeTimeline();
    const hover = document.body.querySelector<HTMLElement>(".fl-tl-hover")!;
    expect(hover.style.display).toBe("none");
    firePointer(track, "pointermove", { clientX: 333 }); // t = 9.99s
    expect(hover.style.display).toBe("block");
    expect(hover.querySelector(".fl-tl-hover-t")!.textContent).toBe("0:09.990");
    expect(extractFrame).not.toHaveBeenCalled(); // debounced — not yet
    await vi.advanceTimersByTimeAsync(100);
    expect(extractFrame).toHaveBeenCalledTimes(1);
    expect(extractFrame).toHaveBeenCalledWith("/abs/clip.mp4", 10); // 9.99 → 0.5s grid
    expect(hover.querySelector<HTMLImageElement>(".fl-tl-hover-img")!.src).toContain(
      "data:image/png;base64,AAAA",
    );
  });

  it("a quick second hover supersedes the first fetch (one frame, the last time)", async () => {
    vi.useFakeTimers();
    const { track, extractFrame } = makeTimeline();
    firePointer(track, "pointermove", { clientX: 333 });
    await vi.advanceTimersByTimeAsync(40); // inside the 90ms debounce
    firePointer(track, "pointermove", { clientX: 700 }); // t = 21s
    await vi.advanceTimersByTimeAsync(200);
    expect(extractFrame).toHaveBeenCalledTimes(1);
    expect(extractFrame).toHaveBeenCalledWith("/abs/clip.mp4", 21);
  });

  it("hides on pointerleave and while a drag is the feedback instead", () => {
    const { track } = makeTimeline();
    const hover = document.body.querySelector<HTMLElement>(".fl-tl-hover")!;
    firePointer(track, "pointermove", { clientX: 500 });
    expect(hover.style.display).toBe("block");
    firePointer(track, "pointerleave", { clientX: 500 });
    expect(hover.style.display).toBe("none");
    firePointer(track, "pointerdown", { clientX: 200 });
    firePointer(track, "pointermove", { clientX: 400 }); // dragging
    expect(hover.style.display).toBe("none");
    firePointer(track, "pointerup", { clientX: 400 });
  });

  it("never shows before a source's dims/duration are known", () => {
    const { store, track } = makeTimeline({ dims: null });
    const hover = document.body.querySelector<HTMLElement>(".fl-tl-hover")!;
    firePointer(track, "pointermove", { clientX: 500 });
    expect(hover.style.display).toBe("none");
    // The pointerdown guard also keeps the trimmer inert without a source.
    firePointer(track, "pointerdown", { clientX: 200 });
    firePointer(track, "pointermove", { clientX: 600 });
    firePointer(track, "pointerup", { clientX: 600 });
    expect(store.state.inPoint).toBeNull();
    expect(store.state.outPoint).toBeNull();
  });
});
