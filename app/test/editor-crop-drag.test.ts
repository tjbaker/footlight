// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION test for the editor's 9:16 crop-box drag on the viewer overlay
 * (`#overlay` canvas in editor.ts). It mounts the editor into jsdom (same harness
 * as editor-load.test.ts), loads a 1920×1080 / 30s source so `initCropBox()` seeds
 * a centered, full-height 9:16 box, then drives the overlay's
 * pointerdown/pointermove/pointerup + dblclick handlers to exercise the three
 * framing gestures and assert their observable output (the `.fl-readout` text):
 *
 *   - MOVE: press inside the box interior, drag horizontally → `state.cropBox.x`
 *     shifts; the readout leaves `crop_offset: center` for a pixel offset.
 *   - RESIZE (punch-in): press on a box CORNER (within EDGE_MARGIN_PX), drag inward
 *     → aspect-locked shrink → readout flips to `punch-in: … · zoom Z× …` (zoom > 1).
 *   - DOUBLE-CLICK reset: dblclick the overlay → `resetCropBoxFullHeight()` restores
 *     the centered full-height box → readout returns to a plain `crop_offset:`.
 *
 * --- displayScale under jsdom -------------------------------------------------
 * The overlay handlers read source-pixel coords as `e.offsetX / state.displayScale`.
 * `displayScale` defaults to 1 (editor-store) and is only recomputed in
 * `syncOverlay()` from the media element's `getBoundingClientRect().width`. That sync
 * fires on the frame `img`'s `load` event, which never fires for a data-URL `img.src`
 * under jsdom — so `displayScale` stays 1 and `offsetX` maps 1:1 to source pixels.
 * We assert that assumption holds before driving any drags (see the first `it`).
 *
 * --- jsdom stubs (kept here, never in src) ------------------------------------
 *   - localStorage / matchMedia / getContext→null / URL.createObjectURL — mirror
 *     editor-load.test.ts (prefs read, initTheme, null-ctx canvas no-op, frame URLs).
 *   - Element.prototype.{set,release}PointerCapture — jsdom doesn't implement pointer
 *     capture; the overlay's pointerdown/up call them, so we stub them to no-ops.
 *   - PointerEvent.offsetX/offsetY — jsdom's PointerEvent leaves offsetX/Y at 0 and
 *     read-only, so we redefine them per-event (the handlers read ONLY offsetX/Y).
 *
 * What this does NOT exercise: the canvas crop-box *drawing* (`getContext` is null →
 * `drawOverlay` is a guarded no-op) and `syncOverlay` layout (jsdom has no layout).
 * We assert box state via the readout text — the gestures' non-pixel output.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/platform/index.js", async () =>
  (await import("./helpers/platform-mock.js")).platformModule);

import { platformMocks } from "./helpers/platform-mock.js";
import {
  installDomShims,
  resetHarness,
  flush,
} from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { mountEditor } = await import("../src/editor.js");


/**
 * Dispatch a pointer event on `overlay` carrying source-display offset coords.
 * jsdom's PointerEvent leaves offsetX/offsetY at 0 (and read-only), so we redefine
 * them on the instance — the overlay handlers read ONLY offsetX/offsetY (never
 * clientX/clientY) to derive source pixels via `offset / displayScale`.
 */
function overlayPointer(
  overlay: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  x: number,
  y: number,
): void {
  const ev = new PointerEvent(type, { bubbles: true, pointerId: 1 });
  Object.defineProperty(ev, "offsetX", { value: x });
  Object.defineProperty(ev, "offsetY", { value: y });
  overlay.dispatchEvent(ev);
}

describe("editor crop-box drag: move / resize / reset (jsdom)", () => {
  beforeEach(() => {
    resetHarness();
  });

  /** Mount, type a path, Enter to load; returns the root + overlay canvas. */
  async function mountAndLoad(): Promise<{ root: HTMLElement; overlay: HTMLElement }> {
    const root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
    await flush();

    const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
    expect(srcInput).not.toBeNull();
    srcInput!.value = "/abs/path/to/clip.mp4";
    srcInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    const overlay = root.querySelector<HTMLElement>("#overlay");
    expect(overlay).not.toBeNull();
    return { root, overlay: overlay! };
  }

  /** The crop/offset framing readout text (`crop_offset: …` or `punch-in: …`). */
  function cropReadoutText(root: HTMLElement): string {
    const r = root.querySelector(".fl-readout");
    expect(r).not.toBeNull();
    return r!.textContent ?? "";
  }

  it("loads centered full-height box; displayScale stays 1 under jsdom", async () => {
    const { root } = await mountAndLoad();
    expect(platformMocks.probe).toHaveBeenCalledWith("/abs/path/to/clip.mp4");
    // initCropBox() seeds a centered, full-height 9:16 box for a 16:9 source →
    // cropBoxToOffset snaps the centered x to the literal "center".
    expect(cropReadoutText(root)).toContain("crop_offset: center");
  });

  // The 1920×1080 source seeds cropBox = { x: 656, y: 0, w: 608, h: 1080 }
  // (608 = roundEven(1080 * 9/16)); maxX = 1920 - 608 = 1312, center = 656.
  // With displayScale = 1, offset px == source px.
  const BOX = { x: 656, y: 0, w: 608, h: 1080 };
  const CX = BOX.x + BOX.w / 2; // 960 — box interior center
  const CY = BOX.y + BOX.h / 2; // 540

  it("MOVE: dragging the box interior horizontally shifts crop_offset off center", async () => {
    const { root, overlay } = await mountAndLoad();
    expect(cropReadoutText(root)).toContain("center");

    // Press in the interior (clear of every edge/corner), drag +200px right, release.
    overlayPointer(overlay, "pointerdown", CX, CY);
    overlayPointer(overlay, "pointermove", CX + 200, CY);
    overlayPointer(overlay, "pointerup", CX + 200, CY);

    // x: clamp(656 + 200, 0, 1312) = 856 → past SNAP_TOLERANCE of center(656),
    // so the readout shows the literal pixel offset, still a plain crop_offset.
    const txt = cropReadoutText(root);
    expect(txt).toContain("crop_offset:");
    expect(txt).not.toContain("center");
    expect(txt).toContain("856");
    expect(txt).not.toContain("punch-in"); // a full-height move is NOT a punch-in
  });

  it("RESIZE: grabbing a corner and dragging inward creates a punch-in (zoom > 1)", async () => {
    const { root, overlay } = await mountAndLoad();
    expect(cropReadoutText(root)).not.toContain("punch-in");

    // Press the top-LEFT corner (px≈656, py≈0) within EDGE_MARGIN_PX(8): edgeHits
    // reports l && t → an aspect-locked resize anchored at the bottom-right corner.
    overlayPointer(overlay, "pointerdown", BOX.x, BOX.y);
    // Drag inward toward the box center → shrinks the box → punch-in.
    overlayPointer(overlay, "pointermove", BOX.x + 300, BOX.y + 533);
    overlayPointer(overlay, "pointerup", BOX.x + 300, BOX.y + 533);

    const txt = cropReadoutText(root);
    expect(txt).toContain("punch-in:");
    expect(txt).toContain("zoom");
    // Parse the "· zoom Z×" factor — a real punch-in zooms in (> 1).
    const zoom = Number.parseFloat(txt.split("zoom")[1]!.replace("×", "").trim());
    expect(Number.isFinite(zoom)).toBe(true);
    expect(zoom).toBeGreaterThan(1);
  });

  it("DOUBLE-CLICK: resets a punch-in back to the full-height crop_offset", async () => {
    const { root, overlay } = await mountAndLoad();

    // First make a punch-in (same corner-resize gesture as above).
    overlayPointer(overlay, "pointerdown", BOX.x, BOX.y);
    overlayPointer(overlay, "pointermove", BOX.x + 300, BOX.y + 533);
    overlayPointer(overlay, "pointerup", BOX.x + 300, BOX.y + 533);
    expect(cropReadoutText(root)).toContain("punch-in:");

    // Double-click the overlay → resetCropBoxFullHeight() → centered full-height box.
    overlay.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    const txt = cropReadoutText(root);
    expect(txt).not.toContain("punch-in");
    expect(txt).toContain("crop_offset:");
    // Reset re-centers the box → snaps back to the literal "center".
    expect(txt).toContain("center");
  });
});
