// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION test for the editor's QUEUE + RENDER flow — the second-biggest
 * untested chunk of editor.ts after the load/mark flow (covered by
 * editor-load.test.ts, which this file's jsdom harness is cloned from). It mounts
 * the whole editor into jsdom, loads a real-ish 1920×1080/30s source via the path
 * input + Enter, marks an In/Out window, then drives the queue:
 *   - "Add clip" → a queue card appears and the Queue label count updates; a
 *     second add grows the queue to two and flips the Render button enabled with
 *     its "Render N" label.
 *   - clicking a card re-opens it via `openSpec` (re-edit path).
 *   - the per-card duplicate (⧉) and remove (✕) controls splice the queue.
 *   - "Export JSON" calls `platform.exportTextFile` with the JSON manifest string.
 *   - "Render" calls `platform.render` once with a manifest JSON carrying the
 *     queued clips; the success log is surfaced into the web Activity panel.
 *   - "Clear" → confirm modal → `clearAll()` (which persists an empty session and
 *     reloads). `location.reload` is stubbed (jsdom doesn't implement navigation);
 *     we assert it fires and the empty session is saved.
 *
 * jsdom stubs (kept here, never in src) mirror editor-load.test.ts:
 *   - `globalThis.localStorage` — Map-backed shim (prefs read at mount).
 *   - `window.matchMedia` — `initTheme()` calls it on boot; jsdom lacks it.
 *   - `HTMLCanvasElement.getContext` → null — stage/overlay canvases call it; the
 *     editor's draw helpers guard `if (!ctx) return`, so null is a safe no-op.
 *   - `URL.createObjectURL` / `revokeObjectURL` — frame plumbing touches them.
 *   - `window.location.reload` — `clearAll()` calls it; jsdom throws "Not
 *     implemented" on navigation, so we replace it with a spy.
 *
 * What this test does NOT exercise under jsdom (and why):
 *   - Drag-to-reorder. The reorder lives in HTML5 `dragstart`/`drop` handlers that
 *     need a real DataTransfer + the card layout jsdom won't lay out; we assert the
 *     simpler splice paths (duplicate / remove) which share the same
 *     `state.clips.splice` + `refreshManifest()` mechanics instead.
 *   - The canvas overlay / crop-box drawing (`getContext` is null) and the
 *     thumbnail `<img>` load (data-URL `img.load` never fires in jsdom). The queue
 *     card still renders its text meta, which is what we assert.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

// --- window.location.reload: clearAll() calls it; jsdom throws on navigation --
const reloadMock = vi.fn();
Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...window.location, reload: reloadMock },
});

// --- platform: mocked wholesale; `probe` returns a real-ish source -----------
const probeMock = vi.fn(async () => ({
  width: 1920,
  height: 1080,
  duration: 30,
  cropdetect: null as string | null,
}));
const renderMock = vi.fn(async () => ({ ok: true, log: "done" }));
const exportTextFileMock = vi.fn(async () => true);
const saveSessionMock = vi.fn(async () => undefined);
vi.mock("../src/platform/index.js", () => {
  const platform = {
    platformName: "web" as const,
    supportsFilePicker: false, // → the editor renders the "Load" button + Enter loads
    extractFrame: vi.fn(async () => "data:image/png;base64,AAAA"),
    probe: probeMock,
    scenes: vi.fn(async () => [] as number[]),
    loudness: vi.fn(async () => ({ display: [] as number[], detect: [] as number[] })),
    track: vi.fn(async () => []),
    listFonts: vi.fn(async () => []),
    listUserFonts: vi.fn(async () => []),
    render: renderMock,
    defaultOutdir: vi.fn(async () => "/tmp/out"),
    checkOutdir: vi.fn(async () => ({ ok: true, resolved: "/tmp/out" })),
    exportTextFile: exportTextFileMock,
    openExternal: vi.fn(async () => undefined),
    pickSourceFile: vi.fn(async () => null),
    pickDirectory: vi.fn(async () => null),
    videoSrc: vi.fn(async () => "blob:x"),
    loadHistory: vi.fn(async () => []),
    saveHistory: vi.fn(async () => undefined),
    loadSession: vi.fn(async () => null),
    saveSession: saveSessionMock,
    getSecret: vi.fn(async () => null),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
  };
  return {
    platform,
    platformName: platform.platformName,
    isTauri: () => false,
  };
});

// Import AFTER the mocks/shims above are installed.
const { mountEditor } = await import("../src/editor.js");

/** Flush microtasks so the editor's async load/bootstrap promises settle. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Dispatch a key on `window` (not an INPUT) so the editor's global keydown
 *  transport sees it — it ignores events whose target is an INPUT/TEXTAREA. */
function pressKey(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

interface Mounted {
  root: HTMLElement;
  queueCards: () => HTMLElement[];
  queueLabel: () => HTMLElement;
  renderBtn: () => HTMLButtonElement;
}

/** Mount the editor, load a 1920×1080 source, and mark a valid In/Out window so
 *  `addClip()` will accept clips. Mirrors editor-load.test.ts's load drive. */
async function mountLoadAndMark(): Promise<Mounted> {
  const root = document.createElement("div");
  document.body.append(root);
  mountEditor(root);
  await flush();

  const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
  expect(srcInput).not.toBeNull();
  srcInput!.value = "/abs/path/to/clip.mp4";
  srcInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();

  // Mark In at t=0, then seek forward and mark Out so the window is valid+ordered.
  pressKey("i");
  await flush();
  pressKey("Escape"); // deselect the In marker so Shift+Arrow seeks the playhead
  for (let i = 0; i < 5; i++) {
    pressKey("ArrowRight", { shiftKey: true });
    await flush(2);
  }
  pressKey("o");
  await flush();

  return {
    root,
    // Queue CARDS carry `.edit`; the always-present "+ add clip" card is
    // `.fl-strip-card` WITHOUT `.edit`, so this filter excludes it.
    queueCards: () =>
      [...root.querySelectorAll<HTMLElement>(".fl-strip-card.edit")],
    queueLabel: () => root.querySelector<HTMLElement>(".fl-filmstrip > .fl-label")!,
    renderBtn: () =>
      root.querySelector<HTMLButtonElement>(".fl-actions .fl-btn.primary")!,
  };
}

/** The Add-clip card inside the filmstrip (the `.fl-strip-card.add`). */
function addCardOf(root: HTMLElement): HTMLElement {
  const card = root.querySelector<HTMLElement>(".fl-strip-card.add");
  expect(card).toBeTruthy();
  return card!;
}

describe("editor queue + render flow (jsdom)", () => {
  beforeEach(() => {
    store.clear();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
    probeMock.mockClear();
    renderMock.mockClear();
    exportTextFileMock.mockClear();
    saveSessionMock.mockClear();
    reloadMock.mockClear();
  });

  it("adds clips to the queue: cards appear and the Queue count + Render button update", async () => {
    const { root, queueCards, queueLabel, renderBtn } = await mountLoadAndMark();

    // Empty queue: no cards, label shows 0, Render disabled.
    expect(queueCards()).toHaveLength(0);
    expect(queueLabel().querySelector(".n")!.textContent).toBe("0");
    expect(renderBtn().disabled).toBe(true);

    // First add via the filmstrip "+ add clip" card.
    addCardOf(root).click();
    await flush();
    expect(queueCards()).toHaveLength(1);
    // Label now carries the count (first `.n` span) + a total-duration `.n`.
    expect(queueLabel().querySelector(".n")!.textContent).toBe("1");
    // Render enabled and relabelled "Render 1".
    expect(renderBtn().disabled).toBe(false);
    expect(renderBtn().textContent).toContain("1");

    // Second add → queue grows to two.
    addCardOf(root).click();
    await flush();
    expect(queueCards()).toHaveLength(2);
    expect(queueLabel().querySelector(".n")!.textContent).toBe("2");
    expect(renderBtn().textContent).toContain("2");
  });

  it("the duplicate (⧉) control inserts a copy after the clip", async () => {
    const { root, queueCards } = await mountLoadAndMark();
    addCardOf(root).click();
    await flush();
    expect(queueCards()).toHaveLength(1);

    // Within a card, the two `.fl-clip-x` buttons are [duplicate, remove] (appended
    // in that order). Click the first → a sibling copy is spliced in after it.
    const dup = queueCards()[0]!.querySelectorAll<HTMLButtonElement>(".fl-clip-x")[0]!;
    dup.click();
    await flush();
    expect(queueCards()).toHaveLength(2);
  });

  it("the remove (✕) control deletes the clip from the queue", async () => {
    const { root, queueCards, renderBtn } = await mountLoadAndMark();
    addCardOf(root).click();
    addCardOf(root).click();
    await flush();
    expect(queueCards()).toHaveLength(2);

    // The remove button is the second `.fl-clip-x` (textContent "✕").
    const del = queueCards()[0]!.querySelectorAll<HTMLButtonElement>(".fl-clip-x")[1]!;
    expect(del.textContent).toBe("✕");
    del.click();
    await flush();
    expect(queueCards()).toHaveLength(1);

    // Remove the last one → empty queue, Render disabled again.
    queueCards()[0]!.querySelectorAll<HTMLButtonElement>(".fl-clip-x")[1]!.click();
    await flush();
    expect(queueCards()).toHaveLength(0);
    expect(renderBtn().disabled).toBe(true);
  });

  it("clicking a queue card re-opens it for editing (openSpec re-load)", async () => {
    const { root, queueCards } = await mountLoadAndMark();
    addCardOf(root).click();
    await flush();
    expect(queueCards()).toHaveLength(1);

    // Re-edit calls openSpec → load() → probe again with the card's source_file.
    probeMock.mockClear();
    queueCards()[0]!.click();
    await flush();
    expect(probeMock).toHaveBeenCalledWith("/abs/path/to/clip.mp4");
    // The source field reflects the re-opened clip's source.
    const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
    expect(srcInput!.value).toBe("/abs/path/to/clip.mp4");
    // Re-edit doesn't change the queue size.
    expect(queueCards()).toHaveLength(1);
  });

  it("Export JSON hands the queued clips to platform.exportTextFile as a JSON manifest", async () => {
    const { root } = await mountLoadAndMark();
    addCardOf(root).click();
    await flush();

    const exportBtn = [...root.querySelectorAll<HTMLButtonElement>(".fl-btn")].find((b) =>
      b.textContent?.includes("Export JSON"),
    );
    expect(exportBtn).toBeTruthy();
    exportBtn!.click();
    await flush();

    expect(exportTextFileMock).toHaveBeenCalledTimes(1);
    const [filename, manifest] = exportTextFileMock.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(filename).toBe("footlight-manifest.json");
    // The manifest is a JSON array of ClipSpec carrying the source/in/out.
    const parsed = JSON.parse(manifest) as Array<{
      source_file: string;
      in_point: string;
      out_point: string;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.source_file).toBe("/abs/path/to/clip.mp4");
    expect(parsed[0]!.in_point).toBe("0.000");
  });

  it("Render calls platform.render once with the queued manifest and surfaces the success log", async () => {
    const { root, renderBtn } = await mountLoadAndMark();
    addCardOf(root).click();
    await flush();

    renderBtn().click();
    await flush();

    expect(renderMock).toHaveBeenCalledTimes(1);
    const [manifestJson, opts] = renderMock.mock.calls[0] as unknown as [
      string,
      { outdir: string },
    ];
    const parsed = JSON.parse(manifestJson) as Array<{ source_file: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.source_file).toBe("/abs/path/to/clip.mp4");
    // Outdir falls back to platform.defaultOutdir() when the field is empty.
    expect(opts.outdir).toBe("/tmp/out");

    // Success: the web Activity panel's <pre.log> carries the render log + ok class.
    const logPre = document.querySelector<HTMLElement>(".activity pre.log");
    expect(logPre).not.toBeNull();
    expect(logPre!.textContent).toBe("done");
    expect(logPre!.className).toContain("ok");
  });

  it("Clear → confirm → clears the queue (empty session saved, reload fired)", async () => {
    const { root } = await mountLoadAndMark();
    addCardOf(root).click();
    await flush();

    // Topbar Clear opens a confirm modal (the safety net nudges Export-first).
    const clearBtn = [...root.querySelectorAll<HTMLButtonElement>(".fl-actions .fl-btn")].find(
      (b) => b.textContent === "Clear",
    );
    expect(clearBtn).toBeTruthy();
    clearBtn!.click();
    await flush();

    // The modal mounts to the body; click its primary/danger confirm button.
    const confirmBtn = [
      ...document.querySelectorAll<HTMLButtonElement>(".fl-modal-foot .fl-btn.primary"),
    ].at(-1);
    expect(confirmBtn).toBeTruthy();
    confirmBtn!.click();
    await flush();

    // clearAll() persists an empty-queue session, then reloads (stubbed).
    expect(saveSessionMock).toHaveBeenCalled();
    const session = saveSessionMock.mock.calls.at(-1)![0] as unknown as {
      clips: unknown[];
      source: string;
    };
    expect(session.clips).toEqual([]);
    expect(session.source).toBe("");
    expect(reloadMock).toHaveBeenCalled();
  });
});
