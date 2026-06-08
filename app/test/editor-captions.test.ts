// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * FORM-CONTROL test for the editor's per-clip caption editor controls (SPEC §6.5)
 * in editor.ts — the hook/title text inputs, the style toggles (bold / italic /
 * underline / shadow / box), the fill / outline / box colour controls, and the
 * 9-zone placement selects (vertical × horizontal). No drag / canvas-layout is
 * needed: these are plain DOM form controls, so they exercise reliably in jsdom.
 *
 * It mounts the whole editor into jsdom (same harness/stubs as editor-load.test.ts),
 * loads a real-ish 1920×1080/30s source via the mocked `platform` so the caption
 * section + crop box are live, then drives each control and asserts the OBSERVABLE
 * output:
 *   - typing into hook/title (`.value` + an `input` event) updates `state.hook`/
 *     `state.title`, observed via the emitted manifest after Add clip;
 *   - the B/I/U + Shadow + Box toggle buttons flip their active (`.primary`) class;
 *   - the Box toggle reveals/hides the box-colour row;
 *   - the fill / outline / box colour swatches (`input[type=color]` + `input` event)
 *     update their `.mono` hex readout;
 *   - the vertical/horizontal placement selects update the stored position;
 *   - and, end-to-end, adding a clip + clicking Render hands `platform.render` a
 *     manifest JSON whose clip carries the non-default `caption` object and
 *     `text_position` (exercising `captionStyleToSpec` / `joinTextPosition`).
 *
 * What this test does NOT exercise under jsdom (and why):
 *   - The live on-canvas caption PREVIEW. `drawPreview`/`drawPreviewCaptions` paint
 *     onto a 2D canvas context, and `getContext` is stubbed to null here (jsdom has
 *     no real canvas), so `drawPreview` returns before drawing. The preview is a
 *     pixel HINT only; we assert the control STATE + the emitted manifest instead,
 *     which is the authoritative, non-pixel output of these controls.
 *   - The font picker's folder/system enumeration (it's an async `platform.list*`
 *     dropdown). We touch the default font only (no `caption.font` is emitted),
 *     keeping the test deterministic and offline.
 *
 * jsdom stubs (kept here, never in src) mirror editor-load.test.ts:
 *   - `globalThis.localStorage` — Map-backed shim (prefs read at mount).
 *   - `window.matchMedia` — `initTheme()` calls it on boot; jsdom lacks it.
 *   - `HTMLCanvasElement.getContext` → null — the stage/overlay/preview canvases
 *     call it; the draw helpers guard `if (!ctx) return`, so null is a safe no-op.
 *   - `URL.createObjectURL` / `revokeObjectURL` — frame plumbing touches them.
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

// --- platform: mocked wholesale; `probe` returns a real-ish source -----------
const probeMock = vi.fn(async () => ({
  width: 1920,
  height: 1080,
  duration: 30,
  cropdetect: null as string | null,
}));
const renderMock = vi.fn(async () => ({ ok: true, log: "" }));
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
    exportTextFile: vi.fn(async () => false),
    openExternal: vi.fn(async () => undefined),
    pickSourceFile: vi.fn(async () => null),
    pickDirectory: vi.fn(async () => null),
    videoSrc: vi.fn(async () => "blob:x"),
    loadHistory: vi.fn(async () => []),
    saveHistory: vi.fn(async () => undefined),
    loadSession: vi.fn(async () => null),
    saveSession: vi.fn(async () => undefined),
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

/** Set an input/select value and fire the event its handler listens for. */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, evt = "input"): void {
  el.value = value;
  el.dispatchEvent(new Event(evt, { bubbles: true }));
}

/** Mount, load a 1920×1080 source, and mark a 0→0.5s In/Out window so `addClip`
 *  passes its guards. Returns the root + the caption section element. */
async function mountLoadAndWindow(): Promise<{ root: HTMLElement; capSect: HTMLElement }> {
  const root = document.createElement("div");
  document.body.append(root);
  mountEditor(root);
  await flush();

  const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
  expect(srcInput).not.toBeNull();
  srcInput!.value = "/abs/path/to/clip.mp4";
  srcInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();

  // Mark In at t=0, seek forward, mark Out — so addClip's In/Out guards pass.
  pressKey("i");
  await flush();
  pressKey("Escape");
  for (let i = 0; i < 5; i++) {
    pressKey("ArrowRight", { shiftKey: true });
    await flush(2);
  }
  pressKey("o");
  await flush();

  // The caption section is the .fl-sect whose header text is "Captions".
  let capSect: HTMLElement | null = null;
  for (const s of root.querySelectorAll<HTMLElement>(".fl-sect")) {
    if (s.textContent?.includes("Captions")) {
      capSect = s;
      break;
    }
  }
  expect(capSect).not.toBeNull();
  return { root, capSect: capSect! };
}

/** The caption text inputs: hook is the input titled "The big caption line…",
 *  title is the one titled "The secondary caption line…". */
function captionTextInputs(capSect: HTMLElement): {
  hook: HTMLInputElement;
  title: HTMLInputElement;
} {
  const inputs = Array.from(capSect.querySelectorAll<HTMLInputElement>('input[type="text"]'));
  const hook = inputs.find((i) => i.title.startsWith("The big caption line"));
  const title = inputs.find((i) => i.title.startsWith("The secondary caption line"));
  expect(hook).toBeTruthy();
  expect(title).toBeTruthy();
  return { hook: hook!, title: title! };
}

/** The style toggle buttons live in .fl-cap-style and carry single-glyph/word
 *  labels. Find one by its visible text. */
function toggleByText(capSect: HTMLElement, text: string): HTMLButtonElement {
  const style = capSect.querySelector<HTMLElement>(".fl-cap-style");
  expect(style).not.toBeNull();
  const btn = Array.from(style!.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  expect(btn, `toggle button "${text}"`).toBeTruthy();
  return btn!;
}

/** A colour control row (`.fl-rowg` w/ an `input[type=color]`) found by its label. */
function colorRowByLabel(
  capSect: HTMLElement,
  label: string,
): { swatch: HTMLInputElement; hex: HTMLElement; row: HTMLElement } {
  const style = capSect.querySelector<HTMLElement>(".fl-cap-style")!;
  const rows = Array.from(style.querySelectorAll<HTMLElement>(".fl-rowg"));
  const row = rows.find((r) => r.querySelector(".fl-label")?.textContent === label);
  expect(row, `colour row "${label}"`).toBeTruthy();
  const swatch = row!.querySelector<HTMLInputElement>('input[type="color"]')!;
  const hex = row!.querySelector<HTMLElement>(".mono")!;
  return { swatch, hex, row: row! };
}

describe("editor caption controls (jsdom)", () => {
  beforeEach(() => {
    store.clear();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
    probeMock.mockClear();
    renderMock.mockClear();
  });

  it("typing hook + title text reflects into the emitted manifest", async () => {
    const { root, capSect } = await mountLoadAndWindow();
    const { hook, title } = captionTextInputs(capSect);

    setValue(hook, "MY HOOK");
    setValue(title, "my title");

    // Add the clip, then render so we can read the serialized manifest the editor
    // hands to platform.render — its clip should carry the typed hook/title.
    const addBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.title?.startsWith("Add this clip") || /add clip/i.test(b.textContent ?? ""),
    );
    expect(addBtn, "Add clip button").toBeTruthy();
    addBtn!.click();
    await flush();

    const renderBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      /render/i.test(b.textContent ?? ""),
    );
    expect(renderBtn, "Render button").toBeTruthy();
    renderBtn!.click();
    await flush();

    expect(renderMock).toHaveBeenCalledTimes(1);
    const manifestJson = renderMock.mock.calls[0]![0] as string;
    const clips = JSON.parse(manifestJson) as Array<Record<string, unknown>>;
    expect(clips).toHaveLength(1);
    expect(clips[0]!.hook).toBe("MY HOOK");
    expect(clips[0]!.title).toBe("my title");
  });

  it("bold / italic / underline / shadow / box toggles flip their active class", async () => {
    const { capSect } = await mountLoadAndWindow();

    for (const text of ["B", "I", "U", "Shadow", "Box"]) {
      const btn = toggleByText(capSect, text);
      expect(btn.classList.contains("primary")).toBe(false);
      btn.click();
      expect(btn.classList.contains("primary"), `${text} active after click`).toBe(true);
      btn.click();
      expect(btn.classList.contains("primary"), `${text} inactive after 2nd click`).toBe(false);
    }
  });

  it("the Box toggle reveals/hides the box-colour row", async () => {
    const { capSect } = await mountLoadAndWindow();

    const { row: boxColorRow } = colorRowByLabel(capSect, "Box color");
    // Hidden by default (box off).
    expect(boxColorRow.style.display).toBe("none");

    toggleByText(capSect, "Box").click();
    expect(boxColorRow.style.display).toBe("");

    toggleByText(capSect, "Box").click();
    expect(boxColorRow.style.display).toBe("none");
  });

  it("fill + outline colour swatches update their hex readout", async () => {
    const { capSect } = await mountLoadAndWindow();

    const fill = colorRowByLabel(capSect, "Fill");
    expect(fill.hex.textContent).toBe("#FFFFFF"); // default
    setValue(fill.swatch, "#ff0000");
    expect(fill.hex.textContent).toBe("#FF0000");

    const outline = colorRowByLabel(capSect, "Outline");
    expect(outline.hex.textContent).toBe("#000000"); // default
    setValue(outline.swatch, "#00ff00");
    expect(outline.hex.textContent).toBe("#00FF00");
  });

  it("placement selects + non-default style flow into the emitted caption object", async () => {
    const { root, capSect } = await mountLoadAndWindow();

    // Caption text is required for the engine to emit hook/text_position/caption.
    const { hook } = captionTextInputs(capSect);
    setValue(hook, "Hook");

    // Placement: the two selects are titled by their axis. Pick top-left.
    const selects = Array.from(capSect.querySelectorAll<HTMLSelectElement>("select"));
    const posV = selects.find((s) => s.title.startsWith("Vertical placement"));
    const posH = selects.find((s) => s.title.startsWith("Horizontal placement"));
    expect(posV, "vertical placement select").toBeTruthy();
    expect(posH, "horizontal placement select").toBeTruthy();
    setValue(posV!, "top", "change");
    setValue(posH!, "left", "change");

    // A couple of non-default style choices to populate the caption object.
    toggleByText(capSect, "B").click(); // bold
    const fill = colorRowByLabel(capSect, "Fill");
    setValue(fill.swatch, "#112233");

    // Add + render → inspect the serialized manifest handed to platform.render.
    const addBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.title?.startsWith("Add this clip") || /add clip/i.test(b.textContent ?? ""),
    );
    addBtn!.click();
    await flush();
    const renderBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      /render/i.test(b.textContent ?? ""),
    );
    renderBtn!.click();
    await flush();

    expect(renderMock).toHaveBeenCalledTimes(1);
    const clips = JSON.parse(renderMock.mock.calls[0]![0] as string) as Array<
      Record<string, unknown>
    >;
    expect(clips).toHaveLength(1);
    // joinTextPosition("top","left") → "top-left".
    expect(clips[0]!.text_position).toBe("top-left");
    // captionStyleToSpec keeps only the non-default fields we set.
    const cap = clips[0]!.caption as Record<string, unknown>;
    expect(cap).toBeTruthy();
    expect(cap.bold).toBe(true);
    expect(String(cap.color).toUpperCase()).toBe("#112233");
  });
});
