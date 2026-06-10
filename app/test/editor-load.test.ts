// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION test for the editor's source-load + In/Out marking flow — the
 * biggest untested chunk of editor.ts. It mounts the whole editor into jsdom
 * (same harness as editor-mount.test.ts), types a path into the source field,
 * triggers `load()` (Enter on the path input), lets the async probe settle, and
 * asserts the editor reflects the loaded source (dims/duration readout, crop box
 * init, stage leaving its empty state, play enabled). It then marks In and Out
 * at two different playhead times via the `I`/`O` keyboard shortcuts and asserts
 * the In/Out readout reflects them and they're ordered.
 *
 * jsdom stubs (kept here, never in src) mirror editor-mount.test.ts:
 *   - `globalThis.localStorage` — Map-backed shim (prefs read at mount).
 *   - `window.matchMedia` — `initTheme()` calls it on boot; jsdom lacks it.
 *   - `HTMLCanvasElement.getContext` → null — the stage/overlay canvases call it;
 *     the editor's draw helpers guard `if (!ctx) return`, so null is a safe no-op.
 *   - `URL.createObjectURL` / `revokeObjectURL` — `setT`/frame plumbing touches
 *     them; jsdom doesn't implement them. Benign stubs.
 *
 * The `platform` module is mocked wholesale (no ffmpeg / dev-server reached), but
 * unlike the smoke test `probe` resolves to a real-ish 1920×1080/30s source so
 * `load()` runs its full success path.
 *
 * What this test does NOT exercise under jsdom (and why):
 *   - The canvas overlay / crop-box *drawing*. `getContext` is null, and the
 *     `img.load` event that triggers `syncOverlay`/`drawOverlay` never fires for a
 *     data-URL `img.src` in jsdom. We assert the crop-box *state* + readout text
 *     instead (the load path's observable, non-pixel output).
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
  pressKey,
} from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { mountEditor } = await import("../src/editor.js");



describe("editor source-load + In/Out flow (jsdom)", () => {
  beforeEach(() => {
    resetHarness();
  });

  async function mountAndLoad(): Promise<{ root: HTMLElement; srcInput: HTMLInputElement }> {
    const root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
    await flush();

    // The source path field is the .mono text input inside the .fl-field.path.
    const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
    expect(srcInput).not.toBeNull();
    srcInput!.value = "/abs/path/to/clip.mp4";

    // Trigger load() the same way the editor does: Enter on the path input.
    srcInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    return { root, srcInput: srcInput! };
  }

  it("loads a source: probe is called and the dims/duration readout updates", async () => {
    const { root } = await mountAndLoad();

    expect(platformMocks.probe).toHaveBeenCalledWith("/abs/path/to/clip.mp4");

    // dimsLine swaps "Not loaded." for the readgrid carrying dims + duration + AR.
    const readgrid = root.querySelector(".fl-readgrid");
    expect(readgrid).not.toBeNull();
    expect(readgrid!.textContent).toContain("1920×1080");
    expect(readgrid!.textContent).toContain("30.00s");
    // 1920/1080 ≈ 1.778 (the AR cell).
    expect(readgrid!.textContent).toContain("1.778");
  });

  it("leaves the empty state and enables playback after load", async () => {
    const { root } = await mountAndLoad();

    const stage = root.querySelector(".fl-stage");
    expect(stage).not.toBeNull();
    expect(stage!.classList.contains("empty")).toBe(false);

    const playBtn = root.querySelector<HTMLButtonElement>(".fl-play");
    expect(playBtn).not.toBeNull();
    expect(playBtn!.disabled).toBe(false);
  });

  it("initializes a 9:16 crop box: the framing readout leaves its placeholder", async () => {
    const { root } = await mountAndLoad();

    // cropReadout starts as "crop_offset: (load a source)"; load() → initCropBox()
    // → refreshCropReadout() replaces it with a real crop_offset readout.
    const cropReadout = root.querySelector(".fl-readout");
    expect(cropReadout).not.toBeNull();
    expect(cropReadout!.textContent).not.toContain("load a source");
    expect(cropReadout!.textContent).toContain("crop_offset");
  });

  it("marks In then Out at two different times; readout reflects an ordered window", async () => {
    const { root } = await mountAndLoad();

    // The In/Out readout cells are <div>s carrying an `.idot.{in,out}` dot, a
    // `.k` key label, and the `.v` value span. (The Set In/Out buttons also
    // carry an `.idot`, but their cell has no `.v` child — filter to the readout.)
    const valForDot = (cls: string): HTMLElement | null => {
      for (const dot of root.querySelectorAll<HTMLElement>(`.idot.${cls}`)) {
        const v = dot.parentElement?.querySelector<HTMLElement>(".v");
        if (v) return v;
      }
      return null;
    };
    const inVal = valForDot("in");
    const outVal = valForDot("out");
    expect(inVal).not.toBeNull();
    expect(outVal).not.toBeNull();
    expect(inVal!.textContent).toBe("—");
    expect(outVal!.textContent).toBe("—");

    // Playhead starts at t=0 → mark In there (the `I` shortcut sets inPoint=t and
    // selects the In marker so arrow keys would nudge it).
    pressKey("i");
    await flush();
    expect(inVal!.textContent).toBe("0.000s");

    // Esc clears the selected marker so Shift+ArrowRight *seeks the playhead*
    // (rather than nudging the just-set In point) — advance to a later time.
    pressKey("Escape");
    for (let i = 0; i < 5; i++) {
      pressKey("ArrowRight", { shiftKey: true });
      await flush(2);
    }
    // Mark Out at the later time.
    pressKey("o");
    await flush();

    // Out parses to a real, later timestamp than In.
    const inSec = Number.parseFloat(inVal!.textContent!.replace("s", ""));
    const outSec = Number.parseFloat(outVal!.textContent!.replace("s", ""));
    expect(Number.isFinite(inSec)).toBe(true);
    expect(Number.isFinite(outSec)).toBe(true);
    expect(outSec).toBeGreaterThan(inSec);
    expect(outSec).toBeCloseTo(0.5, 3);

    // The transport "in→out" chip reflects the window duration (out − in).
    const ioChipVal = root.querySelector<HTMLElement>(".fl-rdchip .val");
    expect(ioChipVal).not.toBeNull();
    expect(ioChipVal!.textContent).toBe(`${(outSec - inSec).toFixed(3)}s`);
  });
});
