// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION test for the editor's render-History modal (editor.ts
 * `openHistory` / `openSpec`, HANDOFF §5.5). It mounts the whole editor into
 * jsdom (same harness as editor-load.test.ts), with `platform.loadHistory`
 * mocked to return a handful of `HistoryEntry` objects spanning today/yesterday
 * and all four framing modes, then:
 *   - opens the modal from the top-bar History button and asserts it lists one
 *     row per entry with the right framing-mode pill (track / punch-in /
 *     keyframes / fixed-offset), a keyframe count where applicable, and a
 *     "Today"/"Yesterday" day-divider per group;
 *   - clicks an entry's "Open" and asserts the clip is restored into the editor
 *     (source path field + In/Out readout + dims/duration readout reflect that
 *     entry's spec — `openSpec` calls `load()`, so the mocked `probe` resolves
 *     the dims it needs);
 *   - removes a single entry (the row trash button) and asserts `saveHistory` is
 *     called with the shortened list;
 *   - clears all entries (the modal's "Clear all") and asserts `saveHistory([])`
 *     and the empty-state hint.
 *
 * jsdom stubs (kept here, never in src) mirror editor-load.test.ts:
 *   - `globalThis.localStorage` — Map-backed shim (prefs read at mount).
 *   - `window.matchMedia` — `initTheme()` calls it on boot; jsdom lacks it.
 *   - `HTMLCanvasElement.getContext` → null — stage/overlay draw helpers guard
 *     `if (!ctx) return`, so null is a safe no-op.
 *   - `URL.createObjectURL` / `revokeObjectURL` — frame plumbing touches them.
 *
 * The `platform` module is mocked wholesale (no ffmpeg / dev-server reached);
 * `probe` resolves a real-ish 1920×1080/30s source so `openSpec`→`load()` runs
 * its full success path. The history modal mounts onto a `.fl-modal-backdrop`
 * appended to `document.body` (not into the editor root), so the modal is
 * queried off `document`.
 *
 * What this test does NOT exercise under jsdom (and why):
 *   - Row/queue thumbnails. `setThumb` shells `extractFrame` (mocked) and sets a
 *     CSS `background-image`; with `getContext` null and no real <img> load we
 *     don't assert pixels. The mode pill / readout / day-divider text is the
 *     modal's observable, non-pixel output and is what we assert.
 *   - The crop-box / overlay *drawing* on restore (canvas is a null-ctx no-op);
 *     we assert the restored *state* via the source/In-Out/dims readouts instead.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HistoryEntry } from "../src/platform/types.js";
import type { ClipSpec } from "@manifest";

// --- localStorage: Map-backed shim -------------------------------------------
const store = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string): void => {
    store.set(k, String(v));
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
  clear: (): void => {
    store.clear();
  },
  key: (i: number): string | null => [...store.keys()][i] ?? null,
  get length(): number {
    return store.size;
  },
};
(globalThis as unknown as { localStorage: typeof localStorageMock }).localStorage =
  localStorageMock;

// --- window.matchMedia: initTheme() needs it on boot (jsdom lacks it) --------
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// --- HTMLCanvasElement.getContext: jsdom returns undefined; force null --------
HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// --- URL object-URL helpers: setT/frame plumbing touches them (jsdom lacks) --
if (typeof URL.createObjectURL !== "function") {
  (URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL =
    () => "blob:stub";
}
if (typeof URL.revokeObjectURL !== "function") {
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL =
    () => undefined;
}

// --- the mocked history: 4 entries, all framing modes, today + yesterday -----
// Stable epoch-ms anchors so the day-divider labels are deterministic:
// `dayLabel` compares start-of-day to *now*, so derive from Date.now().
const NOW = Date.now();
const DAY = 86_400_000;

/** Build a ClipSpec with sane defaults, overridable per entry. */
function spec(over: Partial<ClipSpec>): ClipSpec {
  return {
    source_file: "/abs/footage/show.mp4",
    in_point: "0",
    out_point: "5",
    out_name: "clip",
    ...over,
  };
}

// fixed-offset (ghost pill = the literal offset, here "right"), today.
const ENTRY_FIXED: HistoryEntry = {
  id: "h-fixed",
  ts: NOW - 60_000, // a minute ago → "Today"
  outdir: "/out/today",
  spec: spec({ source_file: "/abs/footage/opener.mp4", out_name: "opener", crop_offset: "right" }),
};
// keyframes (time-keyed schedule → "keyframes" pill, 2 switch points), today.
const ENTRY_KEYFRAMES: HistoryEntry = {
  id: "h-keys",
  ts: NOW - 120_000, // two minutes ago → "Today"
  outdir: "/out/today",
  spec: spec({
    source_file: "/abs/footage/solo.mp4",
    out_name: "solo",
    in_point: "2",
    out_point: "9",
    crop_offset: "0=center; 4.5=440",
  }),
};
// punch-in (explicit cropWindow → "punch-in" pill), yesterday.
const ENTRY_PUNCHIN: HistoryEntry = {
  id: "h-punch",
  ts: NOW - DAY, // ~24h ago → "Yesterday"
  outdir: "/out/yest",
  spec: spec({
    source_file: "/abs/footage/wide.mp4",
    out_name: "wide",
    crop_offset: "center",
    cropWindow: { x: 200, y: 0, w: 608, h: 1080 },
  }),
};
// track (eased cropPath → "track" pill, kf = path length), yesterday.
const ENTRY_TRACK: HistoryEntry = {
  id: "h-track",
  ts: NOW - DAY - 60_000, // also yesterday, slightly earlier
  outdir: "/out/yest",
  spec: spec({
    source_file: "/abs/footage/runner.mp4",
    out_name: "runner",
    in_point: "1",
    out_point: "6",
    cropPath: [
      { t: 0, x: 100 },
      { t: 2, x: 300 },
      { t: 4, x: 520 },
    ],
  }),
};

const HISTORY: HistoryEntry[] = [ENTRY_FIXED, ENTRY_KEYFRAMES, ENTRY_PUNCHIN, ENTRY_TRACK];

const loadHistoryMock = vi.fn(async (): Promise<HistoryEntry[]> => HISTORY.map((e) => ({ ...e })));
const saveHistoryMock = vi.fn(async (_entries: HistoryEntry[]): Promise<void> => undefined);
const probeMock = vi.fn(async () => ({
  width: 1920,
  height: 1080,
  duration: 30,
  cropdetect: null as string | null,
}));

vi.mock("../src/platform/index.js", () => {
  const platform = {
    platformName: "web" as const,
    supportsFilePicker: false,
    extractFrame: vi.fn(async () => "data:image/png;base64,AAAA"),
    probe: probeMock,
    scenes: vi.fn(async () => [] as number[]),
    loudness: vi.fn(async () => ({ display: [] as number[], detect: [] as number[] })),
    track: vi.fn(async () => []),
    listFonts: vi.fn(async () => []),
    listUserFonts: vi.fn(async () => []),
    render: vi.fn(async () => ({ ok: true, log: "" })),
    defaultOutdir: vi.fn(async () => ""),
    checkOutdir: vi.fn(async () => ({ ok: true, resolved: "" })),
    exportTextFile: vi.fn(async () => false),
    openExternal: vi.fn(async () => undefined),
    pickSourceFile: vi.fn(async () => null),
    pickDirectory: vi.fn(async () => null),
    videoSrc: vi.fn(async () => "blob:x"),
    loadHistory: loadHistoryMock,
    saveHistory: saveHistoryMock,
    loadSession: vi.fn(async () => null),
    saveSession: vi.fn(async () => undefined),
    getSecret: vi.fn(async () => null),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
  };
  return { platform, platformName: platform.platformName, isTauri: () => false };
});

// Import AFTER the mocks/shims above are installed.
const { mountEditor } = await import("../src/editor.js");
const { messages } = await import("../src/i18n/index.js");
const m = messages.editor;

/** Flush microtasks so the editor's async load/bootstrap promises settle. */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("editor render-history modal (jsdom)", () => {
  beforeEach(() => {
    store.clear();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
    loadHistoryMock.mockClear();
    saveHistoryMock.mockClear();
    probeMock.mockClear();
  });

  /** Mount the editor and open the History modal from the top-bar button. */
  async function mountAndOpenHistory(): Promise<{ root: HTMLElement; modal: HTMLElement }> {
    const root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
    await flush();

    // The History button is a top-bar icon button carrying historyTitle.
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
    const historyBtn = buttons.find((b) => b.title === m.topbar.historyTitle);
    expect(historyBtn, "History top-bar button").toBeTruthy();
    historyBtn!.click();
    await flush();

    // The modal mounts onto a backdrop appended to <body> (not the editor root).
    const modal = document.querySelector<HTMLElement>(".fl-modal-backdrop .fl-modal");
    expect(modal, "history modal").toBeTruthy();
    return { root, modal: modal! };
  }

  it("loads persisted history and lists one row per entry", async () => {
    const { modal } = await mountAndOpenHistory();
    expect(loadHistoryMock).toHaveBeenCalled();

    const rows = modal.querySelectorAll(".fl-hist");
    expect(rows.length).toBe(HISTORY.length);

    // The count pill reflects the total (plural form for >1).
    const countPill = modal.querySelector(".fl-pill.ghost");
    expect(countPill?.textContent).toBe(`${HISTORY.length} ${m.history.renderPlural}`);

    // Each entry's name (out_name) shows in a row.
    const text = modal.textContent ?? "";
    for (const e of HISTORY) expect(text).toContain(e.spec.out_name!);
  });

  it("shows the right framing-mode pill per entry (track/punch-in/keyframes/fixed)", async () => {
    const { modal } = await mountAndOpenHistory();
    const pillText = [...modal.querySelectorAll(".fl-hist .fl-pill")].map((p) => p.textContent);

    expect(pillText).toContain(m.history.modeTrack);
    expect(pillText).toContain(m.history.modePunchIn);
    expect(pillText).toContain(m.history.modeKeyframes);
    // Fixed offset renders the literal offset string as a ghost pill.
    expect(pillText).toContain("right");
  });

  it("renders a keyframe count for the track + keyframes entries", async () => {
    const { modal } = await mountAndOpenHistory();
    // Locate each row by its name, then read the readout's `kf` value.
    const rowFor = (name: string): HTMLElement => {
      const row = [...modal.querySelectorAll<HTMLElement>(".fl-hist")].find((r) =>
        r.querySelector(".fl-hist-top .nm")?.textContent === name,
      );
      expect(row, `row for ${name}`).toBeTruthy();
      return row!;
    };
    // track entry: cropPath has 3 points → kf 3 in the readout.
    const trackRead = rowFor("runner").querySelector(".fl-readout")?.textContent ?? "";
    expect(trackRead).toContain("kf");
    expect(trackRead).toContain("3");
    // keyframes entry: "0=center; 4.5=440" → 2 switch points → kf 2.
    const keysRead = rowFor("solo").querySelector(".fl-readout")?.textContent ?? "";
    expect(keysRead).toContain("kf");
    expect(keysRead).toContain("2");
    // fixed-offset entry has no schedule → no `kf` token in its readout.
    const fixedRead = rowFor("opener").querySelector(".fl-readout")?.textContent ?? "";
    expect(fixedRead).not.toContain("kf");
  });

  it("groups entries under Today / Yesterday day-dividers", async () => {
    const { modal } = await mountAndOpenHistory();
    const dividers = [...modal.querySelectorAll(".fl-hist-day")].map((d) =>
      d.querySelector("span")?.textContent,
    );
    expect(dividers).toContain(m.history.today);
    expect(dividers).toContain(m.history.yesterday);

    // The Today group's count badge reflects the 2 same-day entries.
    const todayDiv = [...modal.querySelectorAll<HTMLElement>(".fl-hist-day")].find(
      (d) => d.querySelector("span")?.textContent === m.history.today,
    );
    expect(todayDiv?.querySelector(".c")?.textContent).toBe("2");
  });

  it("Open restores that past clip into the editor (source + In/Out + dims)", async () => {
    const { root, modal } = await mountAndOpenHistory();

    // Click "Open" on the keyframes entry (in:2 / out:9 / solo.mp4).
    const solRow = [...modal.querySelectorAll<HTMLElement>(".fl-hist")].find(
      (r) => r.querySelector(".fl-hist-top .nm")?.textContent === "solo",
    );
    expect(solRow).toBeTruthy();
    const openBtn = [...solRow!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === m.history.open,
    );
    expect(openBtn).toBeTruthy();
    openBtn!.click();
    await flush();

    // The modal dismisses on Open.
    expect(document.querySelector(".fl-modal-backdrop")).toBeNull();

    // openSpec → load() probed the entry's source.
    expect(probeMock).toHaveBeenCalledWith("/abs/footage/solo.mp4");

    // The source path field now carries the entry's source.
    const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
    expect(srcInput?.value).toBe("/abs/footage/solo.mp4");

    // The name field reflects the entry's out_name.
    // (nameInput is the only .fl-field input pre-filled with "solo".)
    const filled = [...root.querySelectorAll<HTMLInputElement>("input")].some(
      (i) => i.value === "solo",
    );
    expect(filled).toBe(true);

    // The dims/duration readout reflects the loaded source.
    const readgrid = root.querySelector(".fl-readgrid");
    expect(readgrid?.textContent).toContain("1920×1080");
    expect(readgrid?.textContent).toContain("30.00s");

    // The In/Out readout reflects the entry's window (in 2s → out 9s).
    const valForDot = (cls: string): string | null => {
      for (const dot of root.querySelectorAll<HTMLElement>(`.idot.${cls}`)) {
        const v = dot.parentElement?.querySelector<HTMLElement>(".v");
        if (v) return v.textContent;
      }
      return null;
    };
    expect(valForDot("in")).toBe("2.000s");
    expect(valForDot("out")).toBe("9.000s");
  });

  it("removing a single entry persists the shortened history", async () => {
    const { modal } = await mountAndOpenHistory();
    saveHistoryMock.mockClear();

    const openerRow = [...modal.querySelectorAll<HTMLElement>(".fl-hist")].find(
      (r) => r.querySelector(".fl-hist-top .nm")?.textContent === "opener",
    );
    expect(openerRow).toBeTruthy();
    const rmBtn = openerRow!.querySelector<HTMLButtonElement>("button.fl-iconbtn.sm.rm");
    expect(rmBtn).toBeTruthy();
    rmBtn!.click();
    await flush();

    // saveHistory was called with the list minus the removed entry.
    expect(saveHistoryMock).toHaveBeenCalled();
    const lastArg = saveHistoryMock.mock.calls.at(-1)![0];
    expect(lastArg.map((e) => e.id)).not.toContain("h-fixed");
    expect(lastArg.length).toBe(HISTORY.length - 1);

    // The row is gone from the DOM and the count pill drops by one.
    expect(modal.querySelectorAll(".fl-hist").length).toBe(HISTORY.length - 1);
  });

  it("Clear all empties the list and persists []", async () => {
    const { modal } = await mountAndOpenHistory();
    saveHistoryMock.mockClear();

    const clearBtn = [...modal.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === m.history.clearAll,
    );
    expect(clearBtn).toBeTruthy();
    clearBtn!.click();
    await flush();

    expect(saveHistoryMock).toHaveBeenCalled();
    expect(saveHistoryMock.mock.calls.at(-1)![0]).toEqual([]);

    // No rows remain; the empty-state hint becomes visible.
    expect(modal.querySelectorAll(".fl-hist").length).toBe(0);
    const empty = modal.parentElement?.querySelector<HTMLElement>(".hint");
    // The empty hint lives in the modal (sibling of body); its text is the hint.
    const hintText = [...modal.querySelectorAll<HTMLElement>(".hint")]
      .map((h) => h.textContent)
      .join(" ");
    expect(hintText).toContain(m.history.emptyHint);
    // Avoid an unused-var lint on `empty` when the hint is found via the modal scan.
    void empty;
  });
});
