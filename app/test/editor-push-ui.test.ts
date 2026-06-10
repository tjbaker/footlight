// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * jsdom flow test for the animated punch-in controls (#163): capturing the
 * drawn box as the push's start and end emits a two-keyframe `cropWindowPath`
 * (the render's highest framing precedence) spanning the clip, with the
 * "center" fallback offset. Harness mirrors editor-captions.test.ts.
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

// --- window.matchMedia / canvas / URL shims (jsdom gaps) ----------------------
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
HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
if (typeof URL.createObjectURL !== "function") {
  (URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL =
    () => "blob:stub";
}
if (typeof URL.revokeObjectURL !== "function") {
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL =
    () => undefined;
}

// --- platform: mocked wholesale ----------------------------------------------
const renderMock = vi.fn(async () => ({ ok: true, log: "" }));
vi.mock("../src/platform/index.js", () => {
  const platform = {
    platformName: "web" as const,
    supportsFilePicker: false,
    extractFrame: vi.fn(async () => "data:image/png;base64,AAAA"),
    probe: vi.fn(async () => ({
      width: 1920,
      height: 1080,
      duration: 30,
      cropdetect: null as string | null,
    })),
    scenes: vi.fn(async () => [] as number[]),
    loudness: vi.fn(async () => ({
      display: [] as number[],
      detect: [] as number[],
      onsets: [] as number[],
    })),
    track: vi.fn(async () => []),
    listFonts: vi.fn(async () => []),
    listUserFonts: vi.fn(async () => []),
    render: renderMock,
    exportCover: vi.fn(async () => true),
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

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

function clickByText(root: HTMLElement, text: string): void {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  expect(btn, `button "${text}"`).toBeTruthy();
  btn!.click();
}

describe("animated punch-in (UI flow)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    store.clear();
    document.documentElement.removeAttribute("data-theme");
    renderMock.mockClear();
  });

  it("capturing start + end emits a two-keyframe cropWindowPath spanning the clip", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
    await flush();

    const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input")!;
    srcInput.value = "/abs/path/to/clip.mp4";
    srcInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    // Mark a 0→0.5s window so addClip passes its guards.
    pressKey("i");
    await flush();
    pressKey("Escape");
    for (let i = 0; i < 5; i++) {
      pressKey("ArrowRight", { shiftKey: true });
      await flush(2);
    }
    pressKey("o");
    await flush();

    // Capture the default drawn box as both endpoints (a valid A→A push).
    clickByText(root, "Set start");
    clickByText(root, "Set end");
    await flush();

    const addBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.title?.startsWith("Add this clip") || /add clip/i.test(b.textContent ?? ""),
    );
    addBtn!.click();
    await flush();
    const renderBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      /render/i.test(b.textContent ?? ""),
    );
    expect(renderBtn, "Render button").toBeTruthy();
    renderBtn!.click();
    await flush();

    expect(renderMock).toHaveBeenCalledTimes(1);
    const clips = JSON.parse(renderMock.mock.calls[0]![0] as string) as Array<{
      cropWindowPath?: Array<{ t: number; x: number; y: number; w: number; h: number }>;
      crop_offset?: string;
    }>;
    const path = clips[0]!.cropWindowPath!;
    expect(path).toHaveLength(2);
    expect(path[0]!.t).toBe(0);
    expect(path[1]!.t).toBeCloseTo(0.5, 1); // spans the In→Out window
    expect(path[0]!.w).toBeGreaterThan(0);
    expect(clips[0]!.crop_offset).toBe("center"); // the stripped-path fallback
  });
});
