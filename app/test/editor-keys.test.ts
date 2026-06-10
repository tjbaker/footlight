// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION test for the editor's global keyboard-shortcut handler (the
 * `window.addEventListener("keydown", …)` switch in editor.ts). It mounts the
 * real editor into a jsdom document (same stubs as editor-mount.test.ts), then
 * dispatches `keydown` events and asserts the OBSERVABLE DOM effect of each
 * binding — the In/Out readout, the playhead time readout, and the presence of
 * the shortcuts modal — rather than poking private state.
 *
 * The handler lives on `window` (not `document`), so events are dispatched on
 * `window`. Bindings split into two tiers:
 *   - work ALWAYS (no source needed): `?` (shortcuts modal) and `a`/`A`
 *     (assistant rail) — both intentionally reachable before a load.
 *   - need a loaded source (guarded by `if (!state.dims) return`): Space, J/K/L,
 *     ←/→, ↑/↓, I/O (+Shift), Q/W, Home/End, [/], S, Escape. We drive a real
 *     load (mocked `platform.probe`) before exercising these.
 *
 * What's asserted vs. skipped (and why):
 *   - I / O           → assert In/Out readout text flips from "—" to "<t>s".
 *   - ← / → / Home    → assert the playhead time readout changes. (End would
 *                       seek to state.duration; Home→0 gives a deterministic
 *                       "0.000s", so we anchor on Home.)
 *   - ?               → assert `.modal.shortcuts` is appended to the body.
 *   - typing in a field → assert the handler IGNORES events whose target is an
 *                       <input> (the form-field guard), so I/O do NOT fire.
 *   - Space / J/K/L   → no-throw only. These enter "video mode" via
 *                       enterVideoMode(), which awaits a `loadedmetadata` event
 *                       jsdom never fires; the calls are fire-and-forget so the
 *                       dispatch returns, but real playback can't be observed in
 *                       jsdom, so we don't assert on it.
 *
 * Stubs (localStorage / matchMedia / canvas getContext→null / platform mock)
 * are copied verbatim from editor-mount.test.ts; see that file for the rationale.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/platform/index.js", async () =>
  (await import("./helpers/platform-mock.js")).platformModule);

import {
  installDomShims,
  resetHarness,
  flush,
} from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { mountEditor } = await import("../src/editor.js");

/** Flush the microtask queue so fire-and-forget async work settles. */

/** Dispatch a keydown on `window` (where the editor's handler is registered). */
function key(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

/** The inspector's In/Out readout cells live in a `.fl-readgrid` cell anchored
 *  by an `.idot.<kind>` dot; the value is the cell's `.v` span. (The editor
 *  renders more than one `.idot.<kind>` — e.g. a compact variant without a `.v`
 *  — so we pick the cell that actually carries a `.v`, i.e. the live readout.) */
function readoutValue(root: Element, kind: "in" | "out"): string {
  for (const dot of root.querySelectorAll(`.idot.${kind}`)) {
    const v = dot.closest("div")?.querySelector(".v");
    if (v) return v.textContent ?? "";
  }
  return "";
}

/** The playhead time readout (`tLabel`) renders as `<t>s` in `.fl-time.tnum`. */
function timeReadout(root: Element): string {
  return root.querySelector(".fl-time.tnum")?.textContent ?? "";
}

/** Drive a real source load the way editor.ts does: type a path, click Load. */
async function loadSource(root: Element): Promise<void> {
  const srcInput = root.querySelector<HTMLInputElement>(
    'input[placeholder="/absolute/path/to/source.mp4"]',
  );
  expect(srcInput).not.toBeNull();
  srcInput!.value = "/tmp/source.mp4";
  const loadBtn = [...root.querySelectorAll("button")].find(
    (b) => b.textContent === "Load",
  );
  expect(loadBtn).toBeTruthy();
  loadBtn!.click();
  await flush();
}

describe("editor keyboard shortcuts (jsdom integration)", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    resetHarness();
    root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
  });

  // ---- bindings that work with NO source loaded -----------------------------

  it("`?` opens the shortcuts modal (no source required)", async () => {
    await flush();
    expect(document.querySelector(".modal.shortcuts")).toBeNull();
    key({ key: "?" });
    expect(document.querySelector(".modal.shortcuts")).not.toBeNull();
  });

  it("`a` toggles the assistant rail without throwing (no source required)", async () => {
    await flush();
    expect(() => key({ key: "a" })).not.toThrow();
  });

  it("does nothing destructive for source-gated keys before a load", async () => {
    await flush();
    // No `state.dims` yet → the handler bails after the `?`/`a` checks. I/O must
    // not flip the still-empty readout.
    key({ key: "i" });
    key({ key: "o" });
    expect(readoutValue(root, "in")).toBe("—");
    expect(readoutValue(root, "out")).toBe("—");
  });

  // ---- bindings that require a loaded source --------------------------------

  describe("with a source loaded", () => {
    beforeEach(async () => {
      await loadSource(root);
    });

    it("`I` sets the In point and `O` sets the Out point (readout flips)", () => {
      expect(readoutValue(root, "in")).toBe("—");
      expect(readoutValue(root, "out")).toBe("—");

      key({ key: "i" });
      key({ key: "o" });

      // Both readouts now show a concrete `<t>s` value, not the em-dash.
      expect(readoutValue(root, "in")).toMatch(/^\d+\.\d{3}s$/);
      expect(readoutValue(root, "out")).toMatch(/^\d+\.\d{3}s$/);
    });

    it("`←` / `→` move the playhead time readout", async () => {
      // Anchor at a known, non-zero time so a left step is observable.
      key({ key: "Home" }); // → 0.000s
      await flush();
      key({ key: "ArrowRight", shiftKey: true }); // +0.1s coarse step
      await flush();
      const afterRight = timeReadout(root);
      expect(afterRight).not.toBe("0.000s");

      key({ key: "ArrowLeft", shiftKey: true }); // back toward 0
      await flush();
      expect(timeReadout(root)).not.toBe(afterRight);
    });

    it("`Home` seeks the playhead to the start (0.000s)", async () => {
      // Move off zero first, then Home.
      key({ key: "ArrowRight", shiftKey: true });
      await flush();
      key({ key: "Home" });
      await flush();
      expect(timeReadout(root)).toBe("0.000s");
    });

    it("`Shift+I` / `Q` jump the playhead back to the In point", async () => {
      key({ key: "Home" }); // playhead at 0
      await flush();
      key({ key: "ArrowRight", shiftKey: true }); // move to ~0.1s
      await flush();
      key({ key: "i" }); // set In at current time (~0.1s)
      const inText = readoutValue(root, "in");
      expect(inText).toMatch(/^\d+\.\d{3}s$/);

      key({ key: "Home" }); // back to 0
      await flush();
      expect(timeReadout(root)).toBe("0.000s");

      key({ key: "I", shiftKey: true }); // go to In
      await flush();
      // Playhead readout now matches the In readout's value.
      expect(timeReadout(root)).toBe(inText);
    });

    it("ignores shortcuts while typing in a form field (the field guard)", () => {
      const srcInput = root.querySelector<HTMLInputElement>(
        'input[placeholder="/absolute/path/to/source.mp4"]',
      )!;
      expect(readoutValue(root, "in")).toBe("—");
      // Dispatch from the <input> as target → handler returns early, no In set.
      srcInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "i", bubbles: true }),
      );
      expect(readoutValue(root, "in")).toBe("—");
    });

    it("does not throw on the remaining transport / nav bindings", async () => {
      // Space and J/K/L enter video mode (enterVideoMode awaits a metadata event
      // jsdom never fires); they're fire-and-forget so dispatch must not throw.
      // We can't observe real playback in jsdom, so this is a no-throw smoke.
      for (const k of [
        " ",
        "j",
        "k",
        "l",
        "J",
        "K",
        "L",
        "ArrowUp",
        "ArrowDown",
        "[",
        "]",
        "q",
        "w",
        "End",
        "Escape",
      ]) {
        expect(() => key({ key: k })).not.toThrow();
      }
      // Alt+Arrow nudges the crop box (a different branch) — also no-throw.
      expect(() => key({ key: "ArrowLeft", altKey: true })).not.toThrow();
      expect(() => key({ key: "ArrowUp", altKey: true })).not.toThrow();
      await flush();
      // The editor shell is still mounted after the barrage.
      expect(root.querySelector(".fl-app")).not.toBeNull();
    });

    it("Cmd/Ctrl-modified keys are passed through (not hijacked)", () => {
      // The guard returns on metaKey/ctrlKey so OS combos still work. I-with-Cmd
      // must NOT set the In point.
      expect(readoutValue(root, "in")).toBe("—");
      key({ key: "i", metaKey: true });
      key({ key: "i", ctrlKey: true });
      expect(readoutValue(root, "in")).toBe("—");
    });
  });
});
