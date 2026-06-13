// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DIRECT unit tests for views/history.ts (#125 Phase 5) — the modal is opened
 * via `openHistoryModal(deps)` with the mocked platform and recording
 * openSpec/setThumb stubs, NOT through mountEditor (editor-history.test.ts
 * keeps the wired open-→-rehydrate integration path and the framing-pill /
 * kf-readout details). This suite pins the seams that suite leaves dark:
 *
 *  - the FILTER: live narrowing on input by out_name and by source path
 *    (case-insensitive), day headers recomputed per filtered set, the
 *    "No matches." hint only when a query hides a non-empty history, and the
 *    count pill always tracking the FULL set;
 *  - dismissal: the close button, Escape (and its keydown listener removal),
 *    and the backdrop click-away — but never a click inside the dialog;
 *  - resilience: `loadHistory` rejection → the empty-hint state;
 *    `saveHistory` rejection is swallowed (clear-all still completes);
 *  - day grouping (Today / Yesterday) with per-day counts, and the
 *    singular/plural count pill;
 *  - unparseable in/out timestamps → dashes in the row readout;
 *  - Open dismisses then rehydrates via `openSpec(spec, outdir)`.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { messages } from "../src/i18n/index.js";
import type { HistoryEntry } from "../src/platform/types.js";
import type { HistoryViewDeps } from "../src/views/history.js";
import { platformMocks, mockPlatform } from "./helpers/platform-mock.js";
import {
  installDomShims,
  resetHarness,
  clipSpec,
  flush,
  buttonByText,
  setValue,
} from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { openHistoryModal } = await import("../src/views/history.js");

const m = messages.editor;
const DAY_MS = 86_400_000;

function entry(over: Partial<HistoryEntry> & { name: string; ts?: number }): HistoryEntry {
  return {
    id: `id-${over.name}`,
    ts: over.ts ?? Date.now(),
    spec: clipSpec({ out_name: over.name, ...((over.spec as object) ?? {}) }),
    outdir: "/out/clips",
    ...over,
  };
}

async function openModal(entries: HistoryEntry[], overrides: Partial<HistoryViewDeps> = {}) {
  platformMocks.loadHistory.mockResolvedValue(entries);
  const deps: HistoryViewDeps = {
    platform: mockPlatform,
    openSpec: vi.fn(),
    setThumb: vi.fn(),
    ...overrides,
  };
  await openHistoryModal(deps);
  await flush();
  const backdrop = document.querySelector<HTMLElement>(".fl-modal-backdrop")!;
  expect(backdrop).toBeTruthy();
  return { deps, backdrop };
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".fl-hist"));
const rowNames = (): string[] => rows().map((r) => r.querySelector(".nm")!.textContent!);
const dayHeaders = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".fl-hist-day")).map(
    (d) => d.querySelector("span")!.textContent!,
  );
const filterInput = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(`input[placeholder="${m.history.filterPlaceholder}"]`)!;
const countPill = (): HTMLElement => document.querySelector<HTMLElement>(".fl-pill.ghost")!;
const emptyHint = (): HTMLElement =>
  Array.from(document.querySelectorAll<HTMLElement>(".hint")).find(
    (h) => h.textContent === m.history.emptyHint,
  )!;

beforeEach(() => {
  resetHarness();
});

describe("the filter", () => {
  it("narrows by clip name or source path, case-insensitively, and restores on clear", async () => {
    await openModal([
      entry({ name: "Opener" }),
      entry({
        name: "chorus",
        spec: clipSpec({ out_name: "chorus", source_file: "/gigs/solo.mp4" }),
      }),
      entry({ name: "bridge" }),
    ]);
    expect(rowNames()).toEqual(["Opener", "chorus", "bridge"]);

    setValue(filterInput(), "OPEN"); // name match, case-insensitive
    expect(rowNames()).toEqual(["Opener"]);

    setValue(filterInput(), "solo.mp4"); // source-path match
    expect(rowNames()).toEqual(["chorus"]);

    setValue(filterInput(), "");
    expect(rowNames()).toEqual(["Opener", "chorus", "bridge"]);
  });

  it("shows No matches. only for a query that hides a non-empty history", async () => {
    await openModal([entry({ name: "opener" })]);
    const noMatches = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".fl-modal-body .hint")).find(
        (h) => h.textContent === m.history.noMatches,
      );
    expect(noMatches()).toBeUndefined();

    setValue(filterInput(), "zzz");
    expect(rows()).toHaveLength(0);
    expect(noMatches()).toBeTruthy();
    // The pill still counts the FULL set; the empty-history hint stays hidden.
    expect(countPill().textContent).toBe(`1 ${m.history.renderSingular}`);
    expect(emptyHint().style.display).toBe("none");
  });
});

describe("day grouping + the count pill", () => {
  it("groups Today/Yesterday with per-day counts; pluralizes the pill", async () => {
    const now = Date.now();
    await openModal([
      entry({ name: "today-a", ts: now }),
      entry({ name: "today-b", ts: now - 1 }),
      entry({ name: "yesterday-a", ts: now - DAY_MS }),
    ]);
    expect(dayHeaders()).toEqual([m.history.today, m.history.yesterday]);
    const counts = Array.from(document.querySelectorAll<HTMLElement>(".fl-hist-day .c")).map(
      (c) => c.textContent,
    );
    expect(counts).toEqual(["2", "1"]);
    expect(countPill().textContent).toBe(`3 ${m.history.renderPlural}`);
  });

  it("renders dashes for unparseable timestamps", async () => {
    await openModal([
      entry({ name: "broken", spec: clipSpec({ out_name: "broken", in_point: "bogus" }) }),
    ]);
    const readout = rows()[0]!.querySelector(".fl-readout")!.textContent!;
    expect(readout).toContain("—");
  });
});

describe("dismissal", () => {
  it("the close button removes the modal", async () => {
    const { backdrop } = await openModal([entry({ name: "x" })]);
    backdrop.querySelector<HTMLButtonElement>(`button[title="${m.common.close}"]`)!.click();
    expect(document.querySelector(".fl-modal-backdrop")).toBeNull();
  });

  it("Escape dismisses and unhooks its document listener", async () => {
    await openModal([entry({ name: "x" })]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".fl-modal-backdrop")).toBeNull();
    // A second Escape after dismissal must be inert (listener removed).
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  it("a backdrop click-away dismisses; a click inside the dialog does not", async () => {
    const { backdrop } = await openModal([entry({ name: "x" })]);
    backdrop
      .querySelector<HTMLElement>(".fl-modal")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".fl-modal-backdrop")).not.toBeNull();
    backdrop.dispatchEvent(new MouseEvent("click"));
    expect(document.querySelector(".fl-modal-backdrop")).toBeNull();
  });

  it("Open dismisses first, then rehydrates through openSpec", async () => {
    const e = entry({ name: "opener" });
    const { deps } = await openModal([e]);
    buttonByText(document.body, m.history.open).click();
    expect(document.querySelector(".fl-modal-backdrop")).toBeNull();
    expect(deps.openSpec).toHaveBeenCalledWith(e.spec, "/out/clips");
  });
});

describe("resilience", () => {
  it("a failed loadHistory opens the empty state instead of throwing", async () => {
    platformMocks.loadHistory.mockRejectedValue(new Error("corrupt store"));
    const deps: HistoryViewDeps = { platform: mockPlatform, openSpec: vi.fn(), setThumb: vi.fn() };
    await openHistoryModal(deps);
    expect(rows()).toHaveLength(0);
    expect(emptyHint().style.display).toBe("block");
    expect(countPill().textContent).toBe(`0 ${m.history.renderPlural}`);
  });

  it("clear-all empties the list even when saveHistory rejects (swallowed)", async () => {
    platformMocks.saveHistory.mockRejectedValue(new Error("disk full"));
    await openModal([entry({ name: "a" }), entry({ name: "b" })]);
    buttonByText(document.body, m.history.clearAll).click();
    await flush();
    expect(rows()).toHaveLength(0);
    expect(emptyHint().style.display).toBe("block");
    expect(platformMocks.saveHistory).toHaveBeenCalledWith([]);
    // The Clear-all button hides itself once there is nothing to clear.
    expect(buttonByText(document.body, m.history.clearAll).style.display).toBe("none");
  });

  it("removing a row persists the survivors", async () => {
    await openModal([entry({ name: "a" }), entry({ name: "b" })]);
    rows()[0]!
      .querySelector<HTMLButtonElement>(`button[title="${m.history.removeTitle}"]`)!
      .click();
    await flush();
    expect(rowNames()).toEqual(["b"]);
    const saved = platformMocks.saveHistory.mock.calls.at(-1)![0] as HistoryEntry[];
    expect(saved.map((e) => e.spec.out_name)).toEqual(["b"]);
  });
});
