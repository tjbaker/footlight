// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DIRECT unit tests for views/queue.ts (#125 Phase 5) — the filmstrip is built
 * via `buildQueueStrip(store, deps)` with a REAL EditorStore and recording dep
 * stubs, NOT through mountEditor (editor-queue.test.ts keeps the wired
 * add-clip → card → re-open integration path). Covered:
 *
 *  - the static strip: queue label, add card → `onAdd`, the cover/JSON export
 *    buttons → their deps;
 *  - reactive card rendering off `clips` changes: name (out_name vs shortened
 *    source), duration (clipDur vs the raw `in→out` fallback for unparseable
 *    timestamps), every framing-label branch (track / punch-in / offset /
 *    default), the count + total-duration label, and the per-card `setThumb`;
 *  - card interactions: click-to-edit through `openSpec` (+ the empty-outdir
 *    → undefined mapping), duplicate (a CLONE inserted after its source, and
 *    no click-through), remove (and no click-through);
 *  - HTML5 drag-to-reorder: dragstart/dragend class bookkeeping, dragover
 *    preventDefault (the drop-target enabler), a real reorder on drop, and
 *    the no-op guards (drop with no drag in flight; drop on the dragged card
 *    itself). The handlers never touch `dataTransfer`, so plain Events drive
 *    them under jsdom.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { messages } from "../src/i18n/index.js";
import { createEditorStore } from "../src/editor-store.js";
import type { QueueViewDeps } from "../src/views/queue.js";
import { installDomShims, resetHarness, clipSpec, buttonByText } from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { buildQueueStrip } = await import("../src/views/queue.js");

const m = messages.editor;

function makeView(overrides: Partial<QueueViewDeps> = {}) {
  const store = createEditorStore();
  const deps: QueueViewDeps = {
    setThumb: vi.fn(),
    openSpec: vi.fn(),
    getOutdir: vi.fn(() => "/out/clips"),
    onAdd: vi.fn(),
    onExportJson: vi.fn(),
    onExportCover: vi.fn(),
    ...overrides,
  };
  const view = buildQueueStrip(store, deps);
  document.body.append(view.element);
  return { store, deps, view };
}

const cards = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(".fl-strip-card.edit"));
const cardNames = (root: HTMLElement): string[] =>
  cards(root).map((c) => c.querySelector(".fl-clip-name")!.textContent!);
const label = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>(".fl-label")!;

beforeEach(() => {
  resetHarness();
});

describe("the static strip", () => {
  it("starts empty (Queue 0) and wires add / export cover / export JSON", () => {
    const { deps, view } = makeView();
    expect(label(view.element).textContent).toBe(`${m.queue.queueLabel} 0`);
    expect(cards(view.element)).toHaveLength(0);

    view.element.querySelector<HTMLElement>(".fl-strip-card.add")!.click();
    expect(deps.onAdd).toHaveBeenCalledTimes(1);
    buttonByText(view.element, new RegExp(m.queue.exportCover)).click();
    expect(deps.onExportCover).toHaveBeenCalledTimes(1);
    buttonByText(view.element, new RegExp(m.queue.exportJson)).click();
    expect(deps.onExportJson).toHaveBeenCalledTimes(1);
  });
});

describe("reactive card rendering", () => {
  it("renders one card per clip with name, duration, framing label, and thumb", () => {
    const { store, deps, view } = makeView();
    store.set({
      clips: [
        clipSpec({ out_name: "opener", crop_offset: "right" }),
        clipSpec({ source_file: "/abs/footage/long-source-name.mp4" }), // no out_name, no offset
        clipSpec({ out_name: "tracked", cropPath: [{ t: 0, x: 0 }] }),
        clipSpec({ out_name: "punched", cropWindow: { x: 0, y: 0, w: 304, h: 540 } }),
      ],
    });

    expect(cardNames(view.element)).toEqual([
      "opener",
      "long-source-name.mp4", // shortened source stands in for a missing name
      "tracked",
      "punched",
    ]);
    const subs = cards(view.element).map((c) => c.querySelector(".fl-clip-sub")!.textContent!);
    expect(subs[0]).toBe(`8.0s · right`);
    expect(subs[1]).toBe(`8.0s · ${m.framing.defaultOffset}`); // missing offset → center
    expect(subs[2]).toBe(`8.0s · ${m.framing.modeTrack}`); // cropPath wins
    expect(subs[3]).toBe(`8.0s · ${m.framing.modePunchIn}`); // then cropWindow

    // Count + total duration (4 × 8 s = 32 s → 0:32).
    expect(label(view.element).textContent).toBe(`${m.queue.queueLabel} 4 · 0:32`);
    // Every card painted its thumbnail at the parsed In point.
    expect(deps.setThumb).toHaveBeenCalledTimes(4);
    expect(deps.setThumb).toHaveBeenCalledWith(expect.any(HTMLElement), "/abs/clip.mp4", 2);
  });

  it("falls back to the raw in→out text when the timestamps don't parse", () => {
    const { store, view } = makeView();
    store.set({ clips: [clipSpec({ in_point: "bogus", out_point: "nope" })] });
    expect(cards(view.element)[0]!.querySelector(".fl-clip-sub")!.textContent).toContain(
      "bogus→nope",
    );
  });
});

describe("card interactions", () => {
  it("click-to-edit re-opens the spec with the current outdir (empty → undefined)", () => {
    const { store, deps, view } = makeView();
    const spec = clipSpec({ out_name: "opener" });
    store.set({ clips: [spec] });
    cards(view.element)[0]!.click();
    expect(deps.openSpec).toHaveBeenCalledWith(spec, "/out/clips");

    (deps.getOutdir as ReturnType<typeof vi.fn>).mockReturnValue("");
    cards(view.element)[0]!.click();
    expect(deps.openSpec).toHaveBeenLastCalledWith(spec, undefined);
  });

  it("duplicate inserts a CLONE right after its source and never click-throughs", () => {
    const { store, deps, view } = makeView();
    const a = clipSpec({ out_name: "a" });
    const b = clipSpec({ out_name: "b" });
    store.set({ clips: [a, b] });

    cards(view.element)[0]!
      .querySelector<HTMLButtonElement>(`[title="${m.queue.duplicateTitle}"]`)!
      .click();
    expect(store.state.clips.map((c) => c.out_name)).toEqual(["a", "a", "b"]);
    expect(store.state.clips[1]).not.toBe(a); // structuredClone, not a shared ref
    expect(store.state.clips[1]).toEqual(a);
    expect(deps.openSpec).not.toHaveBeenCalled(); // stopPropagation held
  });

  it("remove drops exactly its card and never click-throughs", () => {
    const { store, deps, view } = makeView();
    store.set({ clips: [clipSpec({ out_name: "a" }), clipSpec({ out_name: "b" })] });
    cards(view.element)[0]!
      .querySelector<HTMLButtonElement>(`[title="${m.queue.removeTitle}"]`)!
      .click();
    expect(store.state.clips.map((c) => c.out_name)).toEqual(["b"]);
    expect(deps.openSpec).not.toHaveBeenCalled();
  });
});

describe("drag-to-reorder", () => {
  function seed3() {
    const made = makeView();
    made.store.set({
      clips: [
        clipSpec({ out_name: "a" }),
        clipSpec({ out_name: "b" }),
        clipSpec({ out_name: "c" }),
      ],
    });
    return made;
  }

  it("dragstart marks the card; dragging a→after-c reorders; dragend unmarks", () => {
    const { store, view } = seed3();
    const [a, , c] = cards(view.element);

    a!.dispatchEvent(new Event("dragstart"));
    expect(a!.classList.contains("dragging")).toBe(true);

    const over = new Event("dragover", { cancelable: true });
    c!.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true); // the drop-target enabler

    c!.dispatchEvent(new Event("drop", { cancelable: true }));
    expect(store.state.clips.map((s) => s.out_name)).toEqual(["b", "c", "a"]);

    // The card list re-rendered; the original card still clears its own flag.
    a!.dispatchEvent(new Event("dragend"));
    expect(a!.classList.contains("dragging")).toBe(false);
  });

  it("dragging c onto a moves it to the front", () => {
    const { store, view } = seed3();
    const [a, , c] = cards(view.element);
    c!.dispatchEvent(new Event("dragstart"));
    a!.dispatchEvent(new Event("drop", { cancelable: true }));
    expect(store.state.clips.map((s) => s.out_name)).toEqual(["c", "a", "b"]);
  });

  it("a drop with no drag in flight — or onto the dragged card itself — is a no-op", () => {
    const { store, view } = seed3();
    const [a, b] = cards(view.element);

    b!.dispatchEvent(new Event("drop", { cancelable: true })); // nothing started
    expect(store.state.clips.map((s) => s.out_name)).toEqual(["a", "b", "c"]);

    a!.dispatchEvent(new Event("dragstart"));
    a!.dispatchEvent(new Event("drop", { cancelable: true })); // self-drop
    expect(store.state.clips.map((s) => s.out_name)).toEqual(["a", "b", "c"]);

    // dragend resets the source index: a later drop is inert again.
    a!.dispatchEvent(new Event("dragend"));
    b!.dispatchEvent(new Event("drop", { cancelable: true }));
    expect(store.state.clips.map((s) => s.out_name)).toEqual(["a", "b", "c"]);
  });
});
