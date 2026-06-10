// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * jsdom flow tests for the per-clip fade fields and the loop-seam check
 * (#165): typed fade values reach the emitted render manifest (sparse — no
 * fields when no fades), too-long fades refuse to queue with the i18n error,
 * and the loop-seam toggle reveals the two seam frames. Harness mirrors
 * editor-captions.test.ts (mock platform, Map-backed localStorage, keyboard
 * In/Out marking).
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

// --- URL object-URL helpers ---------------------------------------------------
if (typeof URL.createObjectURL !== "function") {
  (URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL =
    () => "blob:stub";
}
if (typeof URL.revokeObjectURL !== "function") {
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL =
    () => undefined;
}

// --- platform: mocked wholesale ----------------------------------------------
const extractFrameMock = vi.fn(async () => "data:image/png;base64,AAAA");
const renderMock = vi.fn(async () => ({ ok: true, log: "" }));
vi.mock("../src/platform/index.js", () => {
  const platform = {
    platformName: "web" as const,
    supportsFilePicker: false,
    extractFrame: extractFrameMock,
    probe: vi.fn(async () => ({
      width: 1920,
      height: 1080,
      duration: 30,
      cropdetect: null as string | null,
    })),
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

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

function setValue(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Mount, load a 1920×1080 source, and mark a 0→0.5s In/Out window. */
async function mountLoadAndWindow(): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  mountEditor(root);
  await flush();

  const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
  expect(srcInput).not.toBeNull();
  srcInput!.value = "/abs/path/to/clip.mp4";
  srcInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();

  pressKey("i");
  await flush();
  pressKey("Escape");
  for (let i = 0; i < 5; i++) {
    pressKey("ArrowRight", { shiftKey: true });
    await flush(2);
  }
  pressKey("o");
  await flush();
  return root;
}

/** The two fade number fields, found by their i18n tooltips. */
function fadeInputs(root: HTMLElement): { fadeIn: HTMLInputElement; fadeOut: HTMLInputElement } {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="number"]'));
  const fadeIn = inputs.find((i) => i.title.startsWith("Fade the clip in"));
  const fadeOut = inputs.find((i) => i.title.startsWith("Fade the clip out"));
  expect(fadeIn).toBeTruthy();
  expect(fadeOut).toBeTruthy();
  return { fadeIn: fadeIn!, fadeOut: fadeOut! };
}

function clickButton(root: HTMLElement, text: string | RegExp): void {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""),
  );
  expect(btn, `button ${text}`).toBeTruthy();
  btn!.click();
}

async function addAndRender(root: HTMLElement): Promise<void> {
  const addBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.title?.startsWith("Add this clip") || /add clip/i.test(b.textContent ?? ""),
  );
  expect(addBtn, "Add clip button").toBeTruthy();
  addBtn!.click();
  await flush();
  clickButton(root, /render/i);
  await flush();
}

describe("per-clip fades (UI flow)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    store.clear();
    document.documentElement.removeAttribute("data-theme");
    renderMock.mockClear();
    extractFrameMock.mockClear();
  });

  it("typed fades reach the emitted manifest; the audio hint appears", async () => {
    const root = await mountLoadAndWindow();
    const { fadeIn, fadeOut } = fadeInputs(root);

    setValue(fadeIn, "0.2");
    setValue(fadeOut, "0.1");
    const hint = Array.from(root.querySelectorAll<HTMLElement>(".hint")).find((h) =>
      h.textContent?.includes("re-encode"),
    );
    expect(hint).toBeTruthy();
    expect(hint!.style.display).not.toBe("none");

    await addAndRender(root);
    expect(renderMock).toHaveBeenCalledTimes(1);
    const clips = JSON.parse(renderMock.mock.calls[0]![0] as string) as Array<
      Record<string, unknown>
    >;
    expect(clips[0]!.fade_in).toBe(0.2);
    expect(clips[0]!.fade_out).toBe(0.1);
  });

  it("a clip without fades carries neither field", async () => {
    const root = await mountLoadAndWindow();
    await addAndRender(root);
    const clips = JSON.parse(renderMock.mock.calls[0]![0] as string) as Array<
      Record<string, unknown>
    >;
    expect("fade_in" in clips[0]!).toBe(false);
    expect("fade_out" in clips[0]!).toBe(false);
  });

  it("fades longer than the clip refuse to queue with the i18n error", async () => {
    const root = await mountLoadAndWindow();
    const { fadeIn, fadeOut } = fadeInputs(root);
    // The window is 0.5s; 0.4 + 0.4 cannot fit.
    setValue(fadeIn, "0.4");
    setValue(fadeOut, "0.4");

    const addBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.title?.startsWith("Add this clip") || /add clip/i.test(b.textContent ?? ""),
    );
    addBtn!.click();
    await flush();
    expect(root.textContent).toContain("Fades are longer than the clip");
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("the loop-seam toggle reveals the In/Out seam frames", async () => {
    const root = await mountLoadAndWindow();
    clickButton(root, "Loop seam");
    await flush();

    const outImg = root.querySelector<HTMLImageElement>('img[alt="Out frame"]');
    const inImg = root.querySelector<HTMLImageElement>('img[alt="In frame"]');
    expect(outImg).not.toBeNull();
    expect(inImg).not.toBeNull();
    expect(outImg!.src).toContain("data:image/png");
    expect(inImg!.src).toContain("data:image/png");
  });
});
