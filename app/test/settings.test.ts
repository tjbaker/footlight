// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
/**
 * DOM tests for `openSettings()` — the left-nav Settings modal. These cover the
 * *shell* behaviour that the per-panel builders all hang off of: that the modal
 * mounts with its five-item left nav (General / Rendering / AI & models /
 * Shortcuts / About), that clicking a nav item swaps the visible panel (and only
 * one nav item is "on" at a time), and that each dismissal path the modal
 * implements — the close ✕, a backdrop click, Escape, and the footer Cancel/Save
 * — tears the modal back down and unbinds its key listener.
 *
 * The platform seam is mocked to benign resolved defaults so the AI panel's
 * `getSecret` hydration and the General panel's `pickDirectory`/`saveSession`
 * wiring don't reach a real backend; localStorage is a Map-backed shim (the
 * panels read theme/outdir/etc. from it). Assertions stay structural (nav-item
 * counts, the active panel's heading, presence of key controls) rather than
 * pinning exact prose, and they read labels back from the i18n catalog so a
 * copy change can't make the test brittle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Map-backed localStorage shim (the panels read footlight.theme/outdir/etc).
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

// --- Platform mock: every method openSettings can reach, resolving benignly.
vi.mock("../src/platform/index.js", () => ({
  platform: {
    getSecret: vi.fn().mockResolvedValue(null),
    setSecret: vi.fn().mockResolvedValue(undefined),
    deleteSecret: vi.fn().mockResolvedValue(undefined),
    listFonts: vi.fn().mockResolvedValue([]),
    listUserFonts: vi.fn().mockResolvedValue([]),
    checkOutdir: vi.fn().mockResolvedValue({ ok: true, resolved: "/x" }),
    openExternal: vi.fn().mockResolvedValue(undefined),
    pickDirectory: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(undefined),
    supportsFilePicker: false,
  },
  platformName: "web",
}));

// Import AFTER the mocks are installed so module-eval-time access is safe.
const { openSettings } = await import("../src/settings.js");
const { messages } = await import("../src/i18n/index.js");

const NAV = messages.settings.nav;
const NAV_LABELS = [NAV.general, NAV.rendering, NAV.ai, NAV.shortcuts, NAV.about];

const backdrop = (): HTMLElement | null =>
  document.querySelector(".fl-modal-backdrop");
const navItems = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".fl-set-navitem"));
const mainPanel = (): HTMLElement | null => document.querySelector(".fl-set-main");
/** The active panel's heading text (panelHeader → `.fl-set-secth`). */
const headingText = (): string =>
  mainPanel()?.querySelector(".fl-set-secth")?.textContent ?? "";

beforeEach(() => {
  store.clear();
  document.body.replaceChildren();
});

afterEach(() => {
  // Defensive: make sure no modal (and its keydown listener) leaks between tests.
  backdrop()?.remove();
});

describe("openSettings — shell + nav", () => {
  it("mounts a dialog modal with the five-item left nav", () => {
    openSettings();

    const bd = backdrop();
    expect(bd).not.toBeNull();
    const modal = bd!.querySelector(".fl-modal.settings");
    expect(modal).not.toBeNull();
    expect(modal!.getAttribute("role")).toBe("dialog");
    expect(modal!.getAttribute("aria-label")).toBe(messages.settings.title);

    const items = navItems();
    expect(items).toHaveLength(NAV_LABELS.length);
    expect(items.map((n) => n.textContent)).toEqual(NAV_LABELS);
  });

  it("lands on General by default, with exactly one nav item active", () => {
    openSettings();

    const active = navItems().filter((n) => n.classList.contains("on"));
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe(NAV.general);
    // The General panel's appearance block exposes the theme segmented control.
    expect(headingText()).toBe(messages.settings.general.title);
    expect(mainPanel()!.querySelector(".fl-seg")).not.toBeNull();
  });

  it("opens directly on a requested panel", () => {
    openSettings("about");

    const active = navItems().filter((n) => n.classList.contains("on"));
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe(NAV.about);
    expect(headingText()).toBe(messages.settings.about.title);
  });

  it("switches the visible panel when a nav item is clicked", () => {
    openSettings();
    expect(headingText()).toBe(messages.settings.general.title);

    // Click "Rendering" — the panel and the active nav item both move.
    const items = navItems();
    const rendering = items.find((n) => n.textContent === NAV.rendering)!;
    rendering.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(headingText()).toBe(messages.settings.rendering.title);
    const active = navItems().filter((n) => n.classList.contains("on"));
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe(NAV.rendering);
    // Rendering panel exposes the CRF range slider.
    expect(mainPanel()!.querySelector("input.fl-range")).not.toBeNull();
  });

  it("renders each panel's heading and key controls when navigated to", () => {
    openSettings();
    const byLabel = (label: string): HTMLElement =>
      navItems().find((n) => n.textContent === label)!;

    byLabel(NAV.ai).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(headingText()).toBe(messages.settings.ai.title);
    // AI panel hydrates the key from the keychain via platform.getSecret.
    expect(mainPanel()!.querySelector('input[type="password"]')).not.toBeNull();

    byLabel(NAV.shortcuts).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(headingText()).toBe(messages.settings.shortcuts.title);
    // One shortcut row per catalog item, at minimum a non-empty list.
    expect(mainPanel()!.querySelectorAll(".fl-sc-row").length).toBeGreaterThan(0);

    byLabel(NAV.about).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(headingText()).toBe(messages.settings.about.title);
    expect(mainPanel()!.querySelector(".fl-link-row")).not.toBeNull();
  });
});

describe("openSettings — dismissal paths", () => {
  it("closes via the header ✕ button", () => {
    openSettings();
    const closeBtn = backdrop()!.querySelector<HTMLButtonElement>(".fl-iconbtn")!;
    closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(backdrop()).toBeNull();
  });

  it("closes on a backdrop click but not on a click inside the modal", () => {
    openSettings();
    const bd = backdrop()!;
    // A click that originates inside the modal must NOT dismiss.
    const modal = bd.querySelector<HTMLElement>(".fl-modal.settings")!;
    modal.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(backdrop()).not.toBeNull();

    // A click on the backdrop itself dismisses.
    bd.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(backdrop()).toBeNull();
  });

  it("closes on Escape and unbinds the key listener", () => {
    openSettings();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop()).toBeNull();

    // A second Escape after dismissal is a no-op (listener was removed) — opening
    // a fresh modal and firing a non-Escape key must leave it standing.
    openSettings();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(backdrop()).not.toBeNull();
  });

  it("closes via the footer Cancel and Save buttons", () => {
    openSettings();
    const foot = () =>
      backdrop()!.querySelector<HTMLElement>(".fl-modal-foot")!;
    const btnByText = (text: string): HTMLButtonElement =>
      Array.from(foot().querySelectorAll("button")).find(
        (b) => b.textContent === text,
      ) as HTMLButtonElement;

    btnByText(messages.settings.cancel).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(backdrop()).toBeNull();

    openSettings();
    btnByText(messages.settings.save).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(backdrop()).toBeNull();
  });
});
