// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The separate native Activity window (`src/activity.ts`, its own Tauri page)
 * renders every user-facing string from the ACTIVE locale (#272). The page picks
 * its catalog the same way the main window does — from `navigator.language` — so
 * each case stubs the language, re-imports the module fresh, and asserts the
 * chrome, placeholder, "Clips written to" line and copy feedback all come from
 * that locale's `editor.activity` namespace.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { listenMock, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (e: { payload: unknown }) => void>();
  return {
    handlers,
    listenMock: vi.fn(async (name: string, h: (e: { payload: unknown }) => void) => {
      handlers.set(name, h);
      return () => undefined;
    }),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
  emit: vi.fn(async () => undefined),
}));

import { locales } from "../src/i18n/index.js";

function setLanguage(lang: string): void {
  Object.defineProperty(navigator, "language", { value: lang, configurable: true });
}

beforeEach(() => {
  handlers.clear();
  vi.resetModules();
  document.body.innerHTML = '<div id="activity-root"></div>';
});

afterEach(() => {
  // Drop the own-property stub so the prototype getter shows through again.
  delete (navigator as unknown as Record<string, unknown>).language;
  delete (navigator as unknown as Record<string, unknown>).clipboard;
});

describe.each([
  ["en-US", "en"],
  ["es-ES", "es"],
  ["pt-BR", "pt"],
])("Activity window in %s", (lang, code) => {
  const m = locales[code]!.editor.activity;

  it("renders its chrome and placeholder from the active locale", async () => {
    setLanguage(lang);
    await import("../src/activity.js");
    const root = document.getElementById("activity-root")!;
    expect(root.querySelector(".activity-title")!.textContent).toBe(m.title);
    const btn = root.querySelector<HTMLButtonElement>("button.iconbtn")!;
    expect(btn.textContent).toBe(m.copy);
    expect(btn.title).toBe(m.copyTitle);
    expect(root.querySelector("pre.log")!.textContent).toBe(m.placeholder);
  });

  it("labels the output dir and copy feedback in the active locale", async () => {
    setLanguage(lang);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await import("../src/activity.js");
    await vi.waitFor(() => expect(handlers.has("activity-log")).toBe(true));
    handlers.get("activity-log")!({ payload: { text: "done", kind: "ok", outDir: "/out" } });

    const root = document.getElementById("activity-root")!;
    expect(root.querySelector(".hint")!.textContent).toBe(`${m.clipsWrittenTo}/out`);

    const btn = root.querySelector<HTMLButtonElement>("button.iconbtn")!;
    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe(m.copied));
    expect(writeText).toHaveBeenCalledWith("done");
  });
});
