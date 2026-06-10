// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * jsdom flow test for the Export-cover button (#166): clicking it hands the
 * platform the source, the playhead t, a spec carrying the CURRENT framing
 * (addClip's precedence), and the engine-derived `_cover.png` name. Harness
 * mirrors editor-captions.test.ts (mock platform, Map-backed localStorage).
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
const exportCoverMock = vi.fn(async () => true);
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
    render: vi.fn(async () => ({ ok: true, log: "" })),
    exportCover: exportCoverMock,
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

function coverButton(root: HTMLElement): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    /export cover/i.test(b.textContent ?? ""),
  );
  expect(btn, "Export cover button").toBeTruthy();
  return btn!;
}

describe("Export cover (UI flow)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    store.clear();
    document.documentElement.removeAttribute("data-theme");
    exportCoverMock.mockClear();
  });

  it("does nothing (but reports) without a loaded source", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
    await flush();

    coverButton(root).click();
    await flush();
    expect(exportCoverMock).not.toHaveBeenCalled();
  });

  it("hands the platform the playhead t, the active framing, and the cover name", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
    await flush();

    const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input")!;
    srcInput.value = "/abs/path/to/clip.mp4";
    srcInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    coverButton(root).click();
    await flush();

    expect(exportCoverMock).toHaveBeenCalledTimes(1);
    const [source, t, spec, name] = exportCoverMock.mock.calls[0]! as unknown as [
      string,
      number,
      Record<string, unknown>,
      string,
    ];
    expect(source).toBe("/abs/path/to/clip.mp4");
    expect(t).toBe(0); // playhead at load
    expect(spec.source_file).toBe("/abs/path/to/clip.mp4");
    expect(spec.crop_offset).toBe("center"); // default framing
    expect(name.endsWith("_cover.png")).toBe(true);
    expect(name).toContain("clip");
  });
});
