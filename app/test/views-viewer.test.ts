// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DIRECT unit tests for views/viewer.ts (#125 Phase 5) — the view is built via
 * `buildViewer(store, deps)` with a REAL EditorStore and the production framing
 * wrappers (editor-framing's currentRegion/contentOrigin), NOT through
 * mountEditor. Covered:
 *
 *  - initCropBox seeding (landscape full-height 9:16 vs taller-than-9:16);
 *  - the crop-box pointer gestures on the #overlay: MOVE (fresh objects through
 *    store.set, clamped into the working region, vertical only once punched
 *    in), corner RESIZE (delegated to editor-crop's aspect-locked resizeCrop —
 *    asserted by reusing it, never restating its math), the dblclick reset, the
 *    hover cursor affordances, and track ownership freezing the box;
 *  - the content-box gestures in content mode: move / edge-resize / draw-fresh,
 *    all clamped to the frame;
 *  - nudgeCrop (Alt+arrows seam);
 *  - the REACTIVE repaints: a recording 2D-context stub (jsdom has no canvas)
 *    proves framing keys repaint the overlay + preview, caption keys repaint
 *    only the preview, unrelated keys repaint nothing, ghost previews stroke
 *    dashed boxes (content-origin-offset), and the preview zoom tag tracks the
 *    punch-in;
 *  - the smaller view seams: video mode, showFrame/showFrameError, stage time,
 *    drop/loaded classes, preview toggle persistence, safe-area guides, and the
 *    onboarding Browse/paste wiring.
 *
 * displayScale stays 1 under jsdom (no layout, no img load event), so overlay
 * offsetX/offsetY map 1:1 to source pixels — same assumption as
 * editor-crop-drag.test.ts, asserted on the seeded box geometry.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GhostPreview } from "@assistant-types";
import { createEditorStore, type EditorState } from "../src/editor-store.js";
import { currentRegion, contentOrigin } from "../src/editor-framing.js";
import { resizeCrop, MIN_CROP_H } from "../src/editor-crop.js";
import { installDomShims, resetHarness } from "./helpers/editor-harness.js";
import { firePointer } from "./helpers/pointer.js";

installDomShims();

// ---- recording 2D context stub -------------------------------------------
// installDomShims nulls getContext (fine for suites that never assert paints);
// here the painting IS the behavior under test, so swap in a per-canvas
// recording stub: every method is a vi.fn, state-property writes are accepted.
type CtxStub = Record<string, ReturnType<typeof vi.fn>>;
const ctxByCanvas = new Map<HTMLCanvasElement, CtxStub>();

function makeCtxStub(): CtxStub {
  const ctx: CtxStub = {} as CtxStub;
  for (const f of [
    "clearRect",
    "fillRect",
    "strokeRect",
    "setLineDash",
    "beginPath",
    "moveTo",
    "lineTo",
    "stroke",
    "save",
    "restore",
    "translate",
    "rotate",
    "fillText",
    "strokeText",
    "drawImage",
  ]) {
    ctx[f] = vi.fn();
  }
  ctx["measureText"] = vi.fn(() => ({ width: 50 }));
  return ctx;
}

HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  let ctx = ctxByCanvas.get(this);
  if (!ctx) {
    ctx = makeCtxStub();
    ctxByCanvas.set(this, ctx);
  }
  return ctx;
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

// Import AFTER the shims/stubs above are installed.
const { buildViewer } = await import("../src/views/viewer.js");

// 1920×1080 source → initCropBox seeds the centered full-height 9:16 box
// (608 = roundEven(1080 · 9/16); maxX = 1312; centered x = 656).
const DIMS = { width: 1920, height: 1080 };
const FULL = { x: 656, y: 0, w: 608, h: 1080 };
const REGION = { x0: 0, y0: 0, x1: 1920, y1: 1080 };

/** Build the view on a real store, wired exactly like editor.ts wires it. */
function makeViewer(patch: Partial<EditorState> = {}) {
  const store = createEditorStore();
  store.set({ dims: { ...DIMS }, duration: 30, ...patch });
  const onBrowse = vi.fn();
  const onFocusPath = vi.fn();
  const view = buildViewer(store, {
    currentRegion: () => currentRegion(store.state),
    contentOrigin: () => contentOrigin(store.state),
    supportsFilePicker: true,
    onBrowse,
    onFocusPath,
  });
  const overlay = view.element.querySelector<HTMLCanvasElement>("#overlay")!;
  const previewCanvas = view.element.querySelector<HTMLCanvasElement>(".fl-preview-canvas")!;
  return { store, view, overlay, previewCanvas, onBrowse, onFocusPath };
}

/** Three-step drag on the overlay in source px (displayScale stays 1). */
function dragOverlay(
  overlay: HTMLCanvasElement,
  from: [number, number],
  to: [number, number],
): void {
  firePointer(overlay, "pointerdown", { offsetX: from[0], offsetY: from[1] });
  firePointer(overlay, "pointermove", { offsetX: to[0], offsetY: to[1] });
  firePointer(overlay, "pointerup", { offsetX: to[0], offsetY: to[1] });
}

beforeEach(() => {
  resetHarness();
  ctxByCanvas.clear();
});

describe("initCropBox", () => {
  it("seeds the centered full-height 9:16 box + full-frame content box (landscape)", () => {
    const { store, view } = makeViewer();
    view.initCropBox();
    expect(store.state.cropBox).toEqual(FULL);
    expect(store.state.contentBox).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(store.state.displayScale).toBe(1); // jsdom: no layout → 1:1 px mapping
  });

  it("seeds full width with a centered crop height for a taller-than-9:16 source", () => {
    const { store, view } = makeViewer({ dims: { width: 1080, height: 2400 } });
    view.initCropBox();
    // ch = roundEven(1080 / (9/16)) = 1920, y = floor((2400 − 1920) / 2) = 240.
    expect(store.state.cropBox).toEqual({ x: 0, y: 240, w: 1080, h: 1920 });
  });

  it("is a no-op before dims are known", () => {
    const { store, view } = makeViewer({ dims: null });
    view.initCropBox();
    expect(store.state.cropBox).toBeNull();
  });
});

describe("crop-box MOVE drag", () => {
  it("pans horizontally via store.set with a FRESH box object", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    const before = store.state.cropBox!;
    const changedKeys: string[] = [];
    store.onChange((c) => changedKeys.push(...c));
    dragOverlay(overlay, [960, 540], [1160, 540]); // interior press, +200 px
    expect(store.state.cropBox).toEqual({ ...FULL, x: 856 });
    expect(store.state.cropBox).not.toBe(before); // fresh object, not in-place x writes
    expect(changedKeys).toContain("cropBox");
  });

  it("clamps to the working-region edges", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    dragOverlay(overlay, [960, 540], [9000, 540]);
    expect(store.state.cropBox!.x).toBe(1920 - FULL.w); // right edge: maxX = 1312
    dragOverlay(overlay, [1920 - FULL.w / 2, 540], [-9000, 540]);
    expect(store.state.cropBox!.x).toBe(0); // left edge
  });

  it("ignores vertical movement while the box is still full height", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    dragOverlay(overlay, [960, 540], [960, 900]);
    expect(store.state.cropBox!.y).toBe(0);
  });

  it("does nothing after pointerup (the drag has ended)", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    dragOverlay(overlay, [960, 540], [1160, 540]);
    firePointer(overlay, "pointermove", { offsetX: 100, offsetY: 540 });
    expect(store.state.cropBox!.x).toBe(856); // unchanged — no active drag
  });

  it("does nothing before dims are known", () => {
    const { store, overlay } = makeViewer({ dims: null });
    dragOverlay(overlay, [960, 540], [1160, 540]);
    expect(store.state.cropBox).toBeNull();
  });
});

describe("crop-box corner RESIZE (punch-in)", () => {
  it("routes a top-left corner grab through the aspect-locked resizeCrop", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    dragOverlay(overlay, [FULL.x, FULL.y], [FULL.x + 300, FULL.y + 533]);
    // Same inputs the handler derives: corner edges {l,t}, full-frame region.
    const expected = resizeCrop(
      FULL.x + 300,
      FULL.y + 533,
      FULL,
      { l: true, r: false, t: true, b: false },
      REGION,
    );
    expect(store.state.cropBox).toEqual(expected);
    expect(expected.h).toBeLessThan(1080); // a real punch-in
    // 9:16 aspect lock holds (even-rounded).
    expect(Math.abs(expected.w / expected.h - 9 / 16)).toBeLessThan(0.01);
  });

  it("clamps the punch-in at MIN_CROP_H", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    dragOverlay(overlay, [FULL.x, FULL.y], [FULL.x + FULL.w - 1, FULL.h - 1]);
    expect(store.state.cropBox!.h).toBe(MIN_CROP_H);
  });

  it("a punched-in box then pans vertically too, clamped to the region", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    dragOverlay(overlay, [FULL.x, FULL.y], [FULL.x + 300, FULL.y + 533]);
    const b = store.state.cropBox!;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    dragOverlay(overlay, [cx, cy], [cx, cy - 200]);
    expect(store.state.cropBox!.y).toBe(Math.max(0, b.y - 200));
    dragOverlay(overlay, [cx, store.state.cropBox!.y + b.h / 2], [cx, 9000]);
    expect(store.state.cropBox!.y).toBe(1080 - b.h); // clamped at the bottom edge
  });

  it("dblclick resets a punch-in to the centered full-height box", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    dragOverlay(overlay, [FULL.x, FULL.y], [FULL.x + 300, FULL.y + 533]);
    expect(store.state.cropBox!.h).toBeLessThan(1080);
    overlay.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(store.state.cropBox).toEqual(FULL);
  });
});

describe("track ownership freezes the crop box", () => {
  const TRACK = {
    cropPath: [
      { t: 0, x: 100 },
      { t: 1, x: 200 },
    ],
    inPoint: 0,
    outPoint: 5,
  };

  it("pointer drags and nudges are ignored while a cropPath owns the framing", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    store.set(TRACK);
    dragOverlay(overlay, [960, 540], [1160, 540]);
    expect(store.state.cropBox).toEqual(FULL);
    view.nudgeCrop(50, 0);
    expect(store.state.cropBox).toEqual(FULL);
    overlay.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(store.state.cropBox).toEqual(FULL); // reset is for hand-framing only
  });

  it("the hover cursor offers no affordance over a tracked box", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    store.set(TRACK);
    firePointer(overlay, "pointermove", { offsetX: 960, offsetY: 540 });
    expect(overlay.style.cursor).toBe("default");
  });
});

describe("hover cursor affordances", () => {
  it("signals move inside, diagonal resize on corners, default outside", () => {
    const { view, overlay } = makeViewer();
    view.initCropBox();
    firePointer(overlay, "pointermove", { offsetX: 960, offsetY: 540 });
    expect(overlay.style.cursor).toBe("move");
    firePointer(overlay, "pointermove", { offsetX: FULL.x, offsetY: 0 });
    expect(overlay.style.cursor).toBe("nwse-resize"); // top-left
    firePointer(overlay, "pointermove", { offsetX: FULL.x + FULL.w, offsetY: 0 });
    expect(overlay.style.cursor).toBe("nesw-resize"); // top-right
    firePointer(overlay, "pointermove", { offsetX: 100, offsetY: 540 });
    expect(overlay.style.cursor).toBe("default");
  });

  it("content mode: edges/interior of the content box, crosshair on empty space", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    store.set({ contentMode: true, contentBox: { x: 100, y: 100, w: 800, h: 600 } });
    firePointer(overlay, "pointermove", { offsetX: 500, offsetY: 400 });
    expect(overlay.style.cursor).toBe("move");
    firePointer(overlay, "pointermove", { offsetX: 900, offsetY: 400 });
    expect(overlay.style.cursor).toBe("ew-resize"); // right edge
    firePointer(overlay, "pointermove", { offsetX: 500, offsetY: 100 });
    expect(overlay.style.cursor).toBe("ns-resize"); // top edge
    firePointer(overlay, "pointermove", { offsetX: 100, offsetY: 100 });
    expect(overlay.style.cursor).toBe("nwse-resize"); // top-left corner
    firePointer(overlay, "pointermove", { offsetX: 1500, offsetY: 900 });
    expect(overlay.style.cursor).toBe("crosshair"); // empty area → draw fresh
  });
});

describe("content-box gestures (content mode)", () => {
  const CONTENT = { x: 100, y: 100, w: 800, h: 600 };
  function makeContent() {
    const made = makeViewer();
    made.view.initCropBox();
    made.store.set({ contentMode: true, contentBox: { ...CONTENT } });
    return made;
  }

  it("MOVE: interior drag shifts the box, clamped to the frame", () => {
    const { store, overlay } = makeContent();
    dragOverlay(overlay, [500, 400], [600, 450]);
    expect(store.state.contentBox).toEqual({ x: 200, y: 150, w: 800, h: 600 });
    dragOverlay(overlay, [700, 450], [9000, 450]);
    expect(store.state.contentBox!.x).toBe(1920 - 800); // clamped right
  });

  it("RESIZE: dragging the right edge grows the box; floors at 4 px", () => {
    const { store, overlay } = makeContent();
    dragOverlay(overlay, [900, 400], [1000, 400]); // right edge → wider
    expect(store.state.contentBox).toEqual({ x: 100, y: 100, w: 900, h: 600 });
    dragOverlay(overlay, [1000, 400], [50, 400]); // collapse past the left side
    expect(store.state.contentBox!.w).toBe(4); // min width floor
  });

  it("RESIZE: a corner grab moves both edges, clamped to the frame", () => {
    const { store, overlay } = makeContent();
    dragOverlay(overlay, [100, 100], [50, 60]); // top-left corner outward
    expect(store.state.contentBox).toEqual({ x: 50, y: 60, w: 850, h: 640 });
    dragOverlay(overlay, [50, 60], [-500, -500]);
    expect(store.state.contentBox).toEqual({ x: 0, y: 0, w: 900, h: 700 });
  });

  it("DRAW: a press on empty space starts a fresh box in either direction", () => {
    const { store, overlay } = makeContent();
    firePointer(overlay, "pointerdown", { offsetX: 1200, offsetY: 800 });
    expect(store.state.contentBox).toEqual({ x: 1200, y: 800, w: 0, h: 0 });
    firePointer(overlay, "pointermove", { offsetX: 1400, offsetY: 900 });
    expect(store.state.contentBox).toEqual({ x: 1200, y: 800, w: 200, h: 100 });
    firePointer(overlay, "pointermove", { offsetX: 1000, offsetY: 700 }); // up-left
    expect(store.state.contentBox).toEqual({ x: 1000, y: 700, w: 200, h: 100 });
    firePointer(overlay, "pointermove", { offsetX: 9000, offsetY: 9000 });
    firePointer(overlay, "pointerup", { offsetX: 9000, offsetY: 9000 });
    // Clamped to the frame dimensions.
    expect(store.state.contentBox!.w).toBeLessThanOrEqual(1920);
    expect(store.state.contentBox!.h).toBeLessThanOrEqual(1080);
  });
});

describe("nudgeCrop", () => {
  it("shifts x by dx through a fresh store patch, clamped to the region", () => {
    const { store, view } = makeViewer();
    view.initCropBox();
    const before = store.state.cropBox!;
    view.nudgeCrop(10, 0);
    expect(store.state.cropBox!.x).toBe(FULL.x + 10);
    expect(store.state.cropBox).not.toBe(before);
    view.nudgeCrop(99999, 0);
    expect(store.state.cropBox!.x).toBe(1920 - FULL.w);
  });

  it("ignores dy while full height; applies it once punched in", () => {
    const { store, view } = makeViewer();
    view.initCropBox();
    view.nudgeCrop(0, 10);
    expect(store.state.cropBox!.y).toBe(0);
    store.set({ cropBox: { x: 500, y: 300, w: 308, h: 548 } });
    view.nudgeCrop(0, -10);
    expect(store.state.cropBox!.y).toBe(290);
  });
});

describe("reactive repaints (recording 2D context)", () => {
  it("a cropBox change repaints the overlay (matte + box) and the preview", () => {
    const { store, view, overlay, previewCanvas } = makeViewer();
    view.initCropBox(); // store.set → subscription → drawOverlay (asserted below)
    const octx = ctxByCanvas.get(overlay)!;
    const pctx = ctxByCanvas.get(previewCanvas)!;
    expect(octx["clearRect"]).toHaveBeenCalled();
    expect(octx["strokeRect"]).toHaveBeenCalledWith(FULL.x, FULL.y, FULL.w, FULL.h);
    // Isolate ONE subsequent framing patch → exactly one overlay repaint.
    octx["clearRect"].mockClear();
    octx["strokeRect"].mockClear();
    octx["fillRect"].mockClear();
    pctx["drawImage"].mockClear();
    store.set({ cropBox: { ...FULL, x: 700 } });
    expect(octx["clearRect"]).toHaveBeenCalledTimes(1);
    expect(octx["strokeRect"]).toHaveBeenCalledWith(700, FULL.y, FULL.w, FULL.h);
    expect(octx["fillRect"]).toHaveBeenCalledTimes(4 + 4); // 4 mattes + 4 corner handles
    // The preview drew the source media cropped to the exact box, into 144×256.
    expect(pctx["drawImage"]).toHaveBeenCalledWith(
      expect.anything(),
      700,
      FULL.y,
      FULL.w,
      FULL.h,
      0,
      0,
      144,
      256,
    );
  });

  it("caption keys repaint ONLY the preview; unrelated keys repaint nothing", () => {
    const { store, view, overlay, previewCanvas } = makeViewer();
    view.initCropBox();
    const octx = ctxByCanvas.get(overlay)!;
    const pctx = ctxByCanvas.get(previewCanvas)!;
    octx["clearRect"].mockClear();
    pctx["clearRect"].mockClear();
    pctx["fillText"].mockClear();
    store.set({ hook: "BIG MOMENT" });
    expect(octx["clearRect"]).not.toHaveBeenCalled();
    expect(pctx["clearRect"]).toHaveBeenCalled();
    expect(pctx["fillText"]).toHaveBeenCalled(); // the caption approximation drew
    octx["clearRect"].mockClear();
    pctx["clearRect"].mockClear();
    store.set({ t: 3.2 }); // not a watched key
    expect(octx["clearRect"]).not.toHaveBeenCalled();
    expect(pctx["clearRect"]).not.toHaveBeenCalled();
  });

  it("the preview zoom tag tracks the punch-in factor", () => {
    const { store, view } = makeViewer();
    view.initCropBox();
    const tag = view.element.querySelector(".fl-preview-tag")!;
    expect(tag.textContent).toBe("1.0×"); // full height → no zoom
    store.set({ cropBox: { x: 956, y: 532, w: 308, h: 548 } });
    expect(tag.textContent).toBe("2.0×"); // 1080 / 548 ≈ 1.97
  });

  it("renderGhosts strokes dashed proposal boxes, offset by the content origin", () => {
    const { store, view, overlay } = makeViewer();
    view.initCropBox();
    const octx = ctxByCanvas.get(overlay)!;
    octx["strokeRect"].mockClear();
    const ghosts: GhostPreview[] = [
      { crop: { x: 10, y: 20, w: 90, h: 160 }, contentCrop: "200:300:40:50" },
    ];
    view.renderGhosts(ghosts);
    expect(octx["setLineDash"]).toHaveBeenCalledWith([7, 5]);
    expect(octx["strokeRect"]).toHaveBeenCalledWith(10, 20, 90, 160); // crop ghost
    expect(octx["strokeRect"]).toHaveBeenCalledWith(40, 50, 200, 300); // content ghost (W:H:X:Y)
    // With an active content box, the crop ghost lands offset by its origin.
    store.set({ contentMode: true, contentBox: { x: 100, y: 100, w: 800, h: 600 } });
    octx["strokeRect"].mockClear();
    view.renderGhosts([{ crop: { x: 10, y: 20, w: 90, h: 160 } }]);
    expect(octx["strokeRect"]).toHaveBeenCalledWith(110, 120, 90, 160);
    // Clearing the set stops the ghost strokes.
    octx["strokeRect"].mockClear();
    view.renderGhosts([]);
    expect(octx["strokeRect"]).not.toHaveBeenCalledWith(110, 120, 90, 160);
  });
});

describe("live 9:16 preview toggle + guides", () => {
  it("togglePreview flips and persists the pref; off blanks the panel", () => {
    const { view } = makeViewer();
    view.initCropBox();
    expect(view.isPreviewOn()).toBe(true); // default on
    expect(view.togglePreview()).toBe(false);
    expect(localStorage.getItem("footlight.preview")).toBe("off");
    expect(view.element.querySelector(".fl-preview")!.classList.contains("empty")).toBe(true);
    expect(view.togglePreview()).toBe(true);
    expect(localStorage.getItem("footlight.preview")).toBe("on");
    expect(view.isPreviewOn()).toBe(true);
  });

  it("the persisted pref seeds the next build", () => {
    localStorage.setItem("footlight.preview", "off");
    const { view } = makeViewer();
    expect(view.isPreviewOn()).toBe(false);
  });

  it("the guides button toggles the safe-area overlay and redraws", () => {
    const { view, previewCanvas } = makeViewer();
    view.initCropBox();
    const pctx = ctxByCanvas.get(previewCanvas)!;
    const guides = view.element.querySelector<HTMLButtonElement>(".fl-preview-safe")!;
    pctx["strokeRect"].mockClear();
    guides.click();
    expect(guides.classList.contains("on")).toBe(true);
    expect(pctx["strokeRect"]).toHaveBeenCalledTimes(2); // caption zone + button rail
    guides.click();
    expect(guides.classList.contains("on")).toBe(false);
  });
});

describe("media + stage seams", () => {
  it("setVideoMode switches the shown media and reports it", () => {
    const { view } = makeViewer();
    expect(view.isVideoMode()).toBe(false);
    view.setVideoMode(true);
    expect(view.isVideoMode()).toBe(true);
    expect(view.video.style.display).toBe("block");
    view.setVideoMode(false);
    expect(view.isVideoMode()).toBe(false);
    expect(view.video.style.display).toBe("none");
  });

  it("showFrame reveals the img; showFrameError shows the message instead", () => {
    const { view } = makeViewer();
    const img = view.element.querySelector<HTMLImageElement>("#frame")!;
    view.showFrame("data:image/png;base64,AAAA");
    expect(img.src).toContain("data:image/png;base64,AAAA");
    expect(img.style.display).toBe("block");
    view.showFrameError("frame extraction failed");
    const center = view.element.querySelector<HTMLElement>(".fl-stage-center")!;
    expect(center.textContent).toBe("frame extraction failed");
    expect(center.style.display).toBe("block");
  });

  it("setStageTime / setLoaded / setDropActive reflect on the stage DOM", () => {
    const { view } = makeViewer();
    view.setStageTime(1.5);
    expect(view.element.textContent).toContain("t = 1.500s");
    expect(view.element.classList.contains("empty")).toBe(true);
    view.setLoaded();
    expect(view.element.classList.contains("empty")).toBe(false);
    view.setDropActive(true);
    expect(view.element.classList.contains("dropping")).toBe(true);
    view.setDropActive(false);
    expect(view.element.classList.contains("dropping")).toBe(false);
  });

  it("onboarding Browse / paste-hint buttons call the editor's handlers", () => {
    const { view, onBrowse, onFocusPath } = makeViewer();
    view.element.querySelector<HTMLButtonElement>(".fl-drop-browse")!.click();
    expect(onBrowse).toHaveBeenCalledTimes(1);
    view.element.querySelector<HTMLButtonElement>(".fl-drop-paste")!.click();
    expect(onFocusPath).toHaveBeenCalledTimes(1);
  });
});
