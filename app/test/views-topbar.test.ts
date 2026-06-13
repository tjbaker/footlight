// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DIRECT unit tests for views/topbar.ts (#125 Phase 5) — the bar is built via
 * `buildTopbar(deps)` with recording dep stubs, NOT through mountEditor
 * (editor-mount.test.ts keeps the wired boot path). `openSettings` is mocked
 * at the module seam: the settings modal is its own suite's subject; here the
 * gear button is just a click-through. Covered:
 *
 *  - the action cluster's click-throughs (Render, History, Clear, preview,
 *    spark, Activity, gear) and the source crumb;
 *  - the state mirrors the editor drives: `reflectPreview` (incl. via the
 *    toggle's own click round-trip through `onTogglePreview`'s return),
 *    `reflectAssistant`, `setActivityState`, and `setRenderCount`
 *    (label + disabled gating);
 *  - the theme toggle it OWNS: flips `data-theme`, persists through
 *    `saveTheme`, swaps the sun/moon icon + tooltip, and notifies
 *    `onThemeChanged` (the separate Activity window re-themes off it).
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

const openSettingsMock = vi.fn();
vi.mock("../src/settings.js", () => ({ openSettings: openSettingsMock }));

import { messages } from "../src/i18n/index.js";
import type { TopbarViewDeps } from "../src/views/topbar.js";
import { installDomShims, resetHarness, buttonByText } from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { buildTopbar } = await import("../src/views/topbar.js");

const m = messages.editor;

function makeView(overrides: Partial<TopbarViewDeps> = {}) {
  const deps: TopbarViewDeps = {
    onRender: vi.fn(),
    onHistory: vi.fn(),
    onClear: vi.fn(),
    onTogglePreview: vi.fn(() => true),
    onToggleAssistant: vi.fn(),
    onToggleActivity: vi.fn(),
    onThemeChanged: vi.fn(),
    ...overrides,
  };
  const view = buildTopbar(deps);
  document.body.append(view.element);
  return { deps, view };
}

const byTitle = (root: HTMLElement, title: string): HTMLButtonElement => {
  const btn = root.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  expect(btn, `button titled "${title}"`).toBeTruthy();
  return btn!;
};

beforeEach(() => {
  resetHarness();
  openSettingsMock.mockClear();
});

describe("crumb + action click-throughs", () => {
  it("starts with the no-source crumb; setSourceCrumb names it and lights the dot", () => {
    const { view } = makeView();
    const path = view.element.querySelector<HTMLElement>(".fl-crumb .path")!;
    const dot = view.element.querySelector<HTMLElement>(".fl-crumb .fl-dot")!;
    expect(path.textContent).toBe(m.topbar.noSource);
    expect(dot.classList.contains("live")).toBe(false);

    view.setSourceCrumb("clip.mp4");
    expect(path.textContent).toBe("clip.mp4");
    expect(dot.classList.contains("live")).toBe(true);
  });

  it("Render / History / Clear / spark / Activity / gear fire their deps", () => {
    const { deps, view } = makeView();
    buttonByText(view.element, m.topbar.render).click();
    expect(deps.onRender).toHaveBeenCalledTimes(1);
    byTitle(view.element, m.topbar.historyTitle).click();
    expect(deps.onHistory).toHaveBeenCalledTimes(1);
    buttonByText(view.element, m.topbar.clear).click();
    expect(deps.onClear).toHaveBeenCalledTimes(1);
    byTitle(view.element, m.topbar.assistantTitle).click();
    expect(deps.onToggleAssistant).toHaveBeenCalledTimes(1);
    byTitle(view.element, m.topbar.activityTitle).click();
    expect(deps.onToggleActivity).toHaveBeenCalledTimes(1);
    byTitle(view.element, m.topbar.settingsTitle).click();
    expect(openSettingsMock).toHaveBeenCalledTimes(1);
  });
});

describe("state mirrors", () => {
  it("the preview toggle round-trips its own click through onTogglePreview's return", () => {
    const { deps, view } = makeView({ onTogglePreview: vi.fn(() => true) });
    // The preview button is untitled until first reflected — it sits right
    // after Render in the action cluster.
    const preview = buttonByText(view.element, m.topbar.render)
      .nextElementSibling as HTMLButtonElement;
    preview.click();
    expect(deps.onTogglePreview).toHaveBeenCalledTimes(1);
    expect(preview.classList.contains("on")).toBe(true);
    expect(preview.title).toBe(m.topbar.previewHide);

    (deps.onTogglePreview as ReturnType<typeof vi.fn>).mockReturnValue(false);
    preview.click();
    expect(preview.classList.contains("on")).toBe(false);
    expect(preview.title).toBe(m.topbar.previewShow);
  });

  it("reflectPreview / reflectAssistant / setActivityState drive the classes", () => {
    const { view } = makeView();
    const preview = buttonByText(view.element, m.topbar.render)
      .nextElementSibling as HTMLButtonElement;
    view.reflectPreview(true);
    expect(preview.classList.contains("on")).toBe(true);
    view.reflectPreview(false);
    expect(preview.classList.contains("on")).toBe(false);

    const spark = byTitle(view.element, m.topbar.assistantTitle);
    view.reflectAssistant(true);
    expect(spark.classList.contains("on")).toBe(true);
    view.reflectAssistant(false);
    expect(spark.classList.contains("on")).toBe(false);

    const activity = byTitle(view.element, m.topbar.activityTitle);
    view.setActivityState({ on: true, hasOutput: true });
    expect(activity.classList.contains("on")).toBe(true);
    expect(activity.classList.contains("has-output")).toBe(true);
    view.setActivityState({ on: false, hasOutput: false });
    expect(activity.classList.contains("on")).toBe(false);
    expect(activity.classList.contains("has-output")).toBe(false);
  });

  it("setRenderCount gates the Render button and counts its label", () => {
    const { view } = makeView();
    const render = buttonByText(view.element, m.topbar.render);
    view.setRenderCount(0);
    expect(render.disabled).toBe(true);
    expect(render.textContent).toBe(m.topbar.render);
    view.setRenderCount(3);
    expect(render.disabled).toBe(false);
    expect(render.textContent).toBe(`${m.queue.renderN} 3`);
  });
});

describe("the theme toggle (owned by the view)", () => {
  it("flips data-theme, persists, swaps the icon/tooltip, and notifies", () => {
    const { deps, view } = makeView();
    // No data-theme attribute → treated as light → the button offers dark.
    const themeBtn = byTitle(view.element, m.topbar.themeToDark);
    const iconLight = themeBtn.innerHTML; // the moon

    themeBtn.click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("footlight.theme")).toBe("dark");
    expect(themeBtn.title).toBe(m.topbar.themeToLight);
    expect(themeBtn.innerHTML).not.toBe(iconLight); // now the sun
    expect(deps.onThemeChanged).toHaveBeenCalledTimes(1);

    themeBtn.click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("footlight.theme")).toBe("light");
    expect(themeBtn.title).toBe(m.topbar.themeToDark);
    expect(themeBtn.innerHTML).toBe(iconLight); // back to the moon
    expect(deps.onThemeChanged).toHaveBeenCalledTimes(2);
  });

  it("reads a pre-set dark theme on build (the editor runs initTheme first)", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const { view } = makeView();
    expect(byTitle(view.element, m.topbar.themeToLight)).toBeTruthy();
  });
});
