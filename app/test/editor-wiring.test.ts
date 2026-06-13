// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * WIRING tests for `editor.ts` — the composition root (#125 Phase 5, final slice).
 *
 * The `views-*.test.ts` suites build each view in isolation with STUBBED deps
 * closures; the feature suites (`editor-queue`, `editor-assistant`, …) drive one
 * feature through a real mount. Neither asserts the composition root's OWN glue:
 * the cross-view deps closures that only `mountEditor` knows about, where a real
 * view instance drives ANOTHER real view (or an action) — the `onToggle*` /
 * `onOpenChange` / `reflect*` round-trips wired in editor.ts.
 *
 * Each test here clicks a REAL top-bar control (or fires a real DOM event) and
 * asserts the effect lands on the OTHER real view, with no stubs in between.
 *
 * Deliberately NOT re-tested here (already covered, per the dedup audit):
 *   - clips-change → Render button enable/disable + queue cards → `editor-queue`.
 *   - the assistant-open route via the spark + the propose/accept/discard flow →
 *     `editor-assistant` (this suite asserts only the `onOpenChange` MIRROR it
 *     leaves untested: inspector hidden / spark lit / toggle restores).
 *
 * Out of scope in jsdom: the Tauri-only branches — native drag-drop
 * (`getCurrentWebview().onDragDropEvent`) and `activity.toggleNative()`. The
 * platform mock reports `platformName: "web"`, so the web branches run.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { installDomShims, resetHarness, flush } from "./helpers/editor-harness.js";
import { messages } from "../src/i18n/index.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { mountEditor } = await import("../src/editor.js");

const m = messages.editor;

/** Mount a fresh editor (no source loaded — these are pre-load UI affordances). */
async function mount(): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  mountEditor(root);
  await flush();
  return root;
}

const iconButtons = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>(".fl-topbar .fl-iconbtn"));

/** The preview toggle is the icon button titled show/hide-preview (either side
 *  of its current state). */
const previewButton = (root: HTMLElement): HTMLButtonElement => {
  const btn = iconButtons(root).find(
    (b) => b.title === m.topbar.previewShow || b.title === m.topbar.previewHide,
  );
  expect(btn, "preview toggle button").toBeTruthy();
  return btn!;
};

const activityButton = (root: HTMLElement): HTMLButtonElement => {
  const btn = iconButtons(root).find((b) => b.title === m.topbar.activityTitle);
  expect(btn, "activity toggle button").toBeTruthy();
  return btn!;
};

const sparkButton = (root: HTMLElement): HTMLButtonElement => {
  const btn = root.querySelector<HTMLButtonElement>(".fl-topbar .fl-iconbtn.assistant");
  expect(btn, "assistant spark button").toBeTruthy();
  return btn!;
};

describe("editor composition root: cross-view wiring (jsdom)", () => {
  beforeEach(() => {
    resetHarness();
  });

  it("mounts with the inspector shown, the assistant dock + activity panel closed", async () => {
    const root = await mount();

    // Inspector visible, assistant dock present-but-hidden (display:none set by
    // the onOpenChange closure's closed state).
    const inspector = root.querySelector<HTMLElement>(".fl-inspector");
    expect(inspector).not.toBeNull();
    expect(inspector!.style.display).not.toBe("none");

    // Spark not lit; render-history crumb shows the no-source placeholder.
    expect(sparkButton(root).classList.contains("on")).toBe(false);
    expect(root.querySelector(".fl-crumb .path")?.textContent).toBe(m.topbar.noSource);

    // The activity panel mounts to the body (web build) and starts hidden.
    const panel = document.body.querySelector<HTMLElement>(".activity");
    expect(panel, "activity panel appended to body on web").not.toBeNull();
    expect(panel!.hidden).toBe(true);
    expect(activityButton(root).classList.contains("on")).toBe(false);
  });

  it("the top-bar preview button drives the viewer's preview and mirrors back its state", async () => {
    const root = await mount();
    const btn = previewButton(root);

    const before = btn.classList.contains("on");
    btn.click(); // onTogglePreview → viewerView.togglePreview() → reflectPreview(new state)
    expect(btn.classList.contains("on")).toBe(!before);
    // The title flips to match the new state — the reflect round-trip, not a stub.
    expect(btn.title).toBe(before ? m.topbar.previewShow : m.topbar.previewHide);

    btn.click();
    expect(btn.classList.contains("on")).toBe(before);
    expect(btn.title).toBe(before ? m.topbar.previewHide : m.topbar.previewShow);
  });

  it("the spark's onOpenChange hides the inspector and lights the spark, and restores both on close", async () => {
    const root = await mount();
    const inspector = root.querySelector<HTMLElement>(".fl-inspector")!;
    const spark = sparkButton(root);

    // Open: onOpenChange(true) → inspector hidden + spark .on.
    spark.click();
    await flush();
    expect(inspector.style.display).toBe("none");
    expect(spark.classList.contains("on")).toBe(true);

    // Close: onOpenChange(false) → inspector restored + spark cleared.
    spark.click();
    await flush();
    expect(inspector.style.display).not.toBe("none");
    expect(spark.classList.contains("on")).toBe(false);
  });

  it("the top-bar activity button toggles the body panel and mirrors its open-state (web build)", async () => {
    const root = await mount();
    const btn = activityButton(root);
    const panel = document.body.querySelector<HTMLElement>(".activity")!;

    // Open: onToggleActivity → activity.setOpen(true) → panel shown +
    // onToggleState → topbar.setActivityState lights the toggle.
    btn.click();
    expect(panel.hidden).toBe(false);
    expect(btn.classList.contains("on")).toBe(true);

    // Close again.
    btn.click();
    expect(panel.hidden).toBe(true);
    expect(btn.classList.contains("on")).toBe(false);
  });

  it("web drag-and-drop sets the stage drop-active affordance and points dropped files at the path field", async () => {
    const root = await mount();
    const appEl = root.querySelector<HTMLElement>(".fl-app")!;
    const stage = root.querySelector<HTMLElement>(".fl-stage")!;

    // dragover on the app → setDropActive(true) → stage gets `.dropping`.
    appEl.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    expect(stage.classList.contains("dropping")).toBe(true);

    // dragleave (target is the app itself) → cleared.
    appEl.dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(stage.classList.contains("dropping")).toBe(false);

    // drop with a file: the web build has no real path, so it clears the
    // affordance, shows the inspector drop hint, and focuses the path field
    // (rather than loading). jsdom's drop Event carries no dataTransfer, so we
    // attach one the handler can read.
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [new File(["x"], "clip.mp4", { type: "video/mp4" })] },
    });
    appEl.dispatchEvent(drop);

    expect(stage.classList.contains("dropping")).toBe(false);
    const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
    expect(srcInput).not.toBeNull();
    expect(document.activeElement).toBe(srcInput); // focusSource()
    // setDropHint() replaced the dims readout with the drop-hint message.
    expect(root.textContent).toContain(m.source.dropHint);
  });
});
