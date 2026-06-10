// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The shared jsdom harness for editor tests — the localStorage / matchMedia /
 * canvas / object-URL shims plus the flush/keyboard/mount helpers that every
 * editor-*.test.ts previously carried as a private copy. Import-and-call:
 *
 *   vi.mock("../src/platform/index.js", async () =>
 *     (await import("./helpers/platform-mock.js")).platformModule);
 *   installDomShims();
 *   const { mountEditor } = await import("../src/editor.js");
 *
 * and `resetHarness()` in beforeEach (clears the DOM, the localStorage shim,
 * the theme attribute, and restores every platform mock's default).
 */

import { expect } from "vitest";
import { resetPlatformMocks } from "./platform-mock.js";

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

/** Install the jsdom gap-fillers (idempotent; call once before importing the editor). */
export function installDomShims(): void {
  (globalThis as unknown as { localStorage: typeof localStorageMock }).localStorage =
    localStorageMock;
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
}

/** Fresh DOM + storage + platform-mock defaults; call in beforeEach. */
export function resetHarness(): void {
  document.body.innerHTML = "";
  store.clear();
  document.documentElement.removeAttribute("data-theme");
  resetPlatformMocks();
}

/** Flush microtasks so the editor's async load/bootstrap promises settle. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Dispatch a key on `window` (not an INPUT) so the global transport sees it. */
export function pressKey(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

/** Set a form control's value and fire the event its handler listens for. */
export function setValue(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
  evt = "input",
): void {
  el.value = value;
  el.dispatchEvent(new Event(evt, { bubbles: true }));
}

/** Find a button by its visible text (string = exact trim, RegExp = test). */
export function buttonByText(root: HTMLElement, text: string | RegExp): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""),
  );
  expect(btn, `button ${String(text)}`).toBeTruthy();
  return btn!;
}

/** Mount the editor and load a 1920×1080 source (the platform-mock probe). */
export async function mountLoaded(
  mountEditor: (root: HTMLElement) => void,
  source = "/abs/path/to/clip.mp4",
): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  mountEditor(root);
  await flush();
  const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
  expect(srcInput).not.toBeNull();
  srcInput!.value = source;
  srcInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  return root;
}

/** `mountLoaded` plus a 0→0.5s In/Out window so addClip passes its guards. */
export async function mountLoadAndWindow(
  mountEditor: (root: HTMLElement) => void,
  source = "/abs/path/to/clip.mp4",
): Promise<HTMLElement> {
  const root = await mountLoaded(mountEditor, source);
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
