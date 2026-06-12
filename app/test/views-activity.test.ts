// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DIRECT unit tests for views/activity.ts (#125 Phase 5) — the view is built
 * via `buildActivityPanel(deps)` with an `onToggleState` spy, NOT through
 * mountEditor, so each behavior is asserted at the view's own seam:
 *
 *  - WEB build (`isTauri: false`): the floating panel's open/close/isOpen state
 *    and its onToggleState mirroring, `setOutput` (text + ok/err accents, the
 *    err auto-open, the closed-panel "has output" hint), `setOutDir` rendering,
 *    the copy-to-clipboard button (success, placeholder no-op, failure label),
 *    and the header drag (bounds-clamped left/top, header buttons exempt).
 *  - NATIVE build (`isTauri: true`): the separate-OS-window protocol —
 *    `toggleNative` invoking `toggle_activity_window` + replaying `lastOutput`
 *    via emit, err output force-showing the window, `setOutDir` merging into
 *    the emitted model, `pushTheme`, and the `activity-ready` /
 *    `activity-hidden` listen handshake. The `@tauri-apps/api/*` modules the
 *    view dynamically imports are vi.mocked, so this runs without a webview.
 *
 * Not covered: the activity-ready handler's CONCURRENT theme replay — vitest's
 * module runner resolves only one of two simultaneous dynamic imports of a
 * mocked module to the mock — so that test asserts the output replay and the
 * dedicated pushTheme test pins the theme push (see the inline note).
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock, emitMock, listenMock, nativeHandlers } = vi.hoisted(() => {
  const nativeHandlers = new Map<string, () => void>();
  return {
    invokeMock: vi.fn(),
    emitMock: vi.fn(async () => undefined),
    listenMock: vi.fn(async (name: string, handler: () => void) => {
      nativeHandlers.set(name, handler);
      return () => undefined;
    }),
    nativeHandlers,
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ emit: emitMock, listen: listenMock }));

import { messages } from "../src/i18n/index.js";
import { installDomShims, resetHarness, flush, buttonByText } from "./helpers/editor-harness.js";
import { firePointer } from "./helpers/pointer.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { buildActivityPanel } = await import("../src/views/activity.js");

const m = messages.editor.activity;

/** Build the view with an onToggleState spy; web panels append to the body. */
function makePanel(isTauri: boolean) {
  const onToggleState = vi.fn();
  const view = buildActivityPanel({ isTauri, onToggleState });
  if (!isTauri) document.body.append(view.element);
  return { view, onToggleState };
}

/** The log <pre> inside the panel. */
function logPre(root: HTMLElement): HTMLPreElement {
  const pre = root.querySelector<HTMLPreElement>("pre.log");
  expect(pre).not.toBeNull();
  return pre!;
}

beforeEach(() => {
  resetHarness();
  invokeMock.mockReset();
  emitMock.mockClear();
  listenMock.mockClear();
  nativeHandlers.clear();
});

describe("web floating panel: open/close state", () => {
  it("starts hidden with the placeholder log", () => {
    const { view } = makePanel(false);
    expect(view.element.hidden).toBe(true);
    expect(view.isOpen()).toBe(false);
    expect(logPre(view.element).textContent).toBe(m.placeholder);
  });

  it("setOpen flips visibility and mirrors state onto the toggle", () => {
    const { view, onToggleState } = makePanel(false);
    view.setOpen(true);
    expect(view.element.hidden).toBe(false);
    expect(view.isOpen()).toBe(true);
    expect(onToggleState).toHaveBeenLastCalledWith({ on: true, hasOutput: false });
    view.setOpen(false);
    expect(view.isOpen()).toBe(false);
    expect(onToggleState).toHaveBeenLastCalledWith({ on: false, hasOutput: false });
  });

  it("the header ✕ button closes the panel", () => {
    const { view, onToggleState } = makePanel(false);
    view.setOpen(true);
    buttonByText(view.element, "✕").click();
    expect(view.isOpen()).toBe(false);
    expect(onToggleState).toHaveBeenLastCalledWith({ on: false, hasOutput: false });
  });
});

describe("web floating panel: setOutput / setOutDir", () => {
  it("writes the text with the kind accent class", () => {
    const { view } = makePanel(false);
    view.setOutput("rendered 3 clips", "ok");
    const pre = logPre(view.element);
    expect(pre.textContent).toBe("rendered 3 clips");
    expect(pre.className).toBe("log ok");
    view.setOutput("plain note");
    expect(pre.className).toBe("log");
  });

  it("non-error output while CLOSED stays closed but raises the has-output hint", () => {
    const { view, onToggleState } = makePanel(false);
    view.setOutput("done", "ok");
    expect(view.isOpen()).toBe(false);
    expect(onToggleState).toHaveBeenLastCalledWith({ on: false, hasOutput: true });
  });

  it("non-error output while OPEN raises no extra toggle-state call", () => {
    const { view, onToggleState } = makePanel(false);
    view.setOpen(true);
    onToggleState.mockClear();
    view.setOutput("progress…");
    expect(onToggleState).not.toHaveBeenCalled();
  });

  it("error output auto-opens the panel", () => {
    const { view, onToggleState } = makePanel(false);
    view.setOutput("ffmpeg exploded", "err");
    expect(view.isOpen()).toBe(true);
    expect(logPre(view.element).className).toBe("log err");
    expect(onToggleState).toHaveBeenLastCalledWith({ on: true, hasOutput: false });
  });

  it("setOutDir renders the 'Clips written to' line; setOutput clears it", () => {
    const { view } = makePanel(false);
    view.setOutDir("/tmp/out");
    const hint = view.element.querySelector<HTMLElement>(".hint")!;
    expect(hint.textContent).toBe(`${m.clipsWrittenTo}/tmp/out`);
    expect(hint.querySelector(".stat")?.textContent).toBe("/tmp/out");
    view.setOutDir("");
    expect(hint.textContent).toBe("");
    view.setOutDir("/tmp/out");
    view.setOutput("next run…");
    expect(hint.textContent).toBe("");
  });

  it("never touches the Tauri APIs on the web build", async () => {
    const { view } = makePanel(false);
    view.setOutput("hello", "err");
    view.setOutDir("/tmp/out");
    await view.pushTheme(); // isTauri false → early return
    await flush();
    expect(emitMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });
});

describe("web floating panel: copy log", () => {
  const writeText = vi.fn(async () => undefined);
  beforeEach(() => {
    writeText.mockClear().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("copies the log text and flashes ✓ Copied, reverting after 1200ms", async () => {
    vi.useFakeTimers();
    const { view } = makePanel(false);
    view.setOutput("the log body");
    const copyBtn = buttonByText(view.element, m.copy);
    copyBtn.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("the log body");
    expect(copyBtn.textContent).toBe(m.copied);
    vi.advanceTimersByTime(1300);
    expect(copyBtn.textContent).toBe(m.copy);
  });

  it("does nothing while the log still shows the placeholder", async () => {
    const { view } = makePanel(false);
    buttonByText(view.element, m.copy).click();
    await flush();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("shows the failure label when the clipboard is unavailable", async () => {
    const { view } = makePanel(false);
    writeText.mockRejectedValue(new Error("denied"));
    view.setOutput("body");
    const copyBtn = buttonByText(view.element, m.copy);
    copyBtn.click();
    await flush();
    // The execCommand textarea fallback also fails under jsdom → "Copy failed".
    expect(copyBtn.textContent).toBe(m.copyFailed);
  });
});

describe("web floating panel: header drag", () => {
  it("drags by the header, clamped into the window, and stops on pointerup", () => {
    const { view } = makePanel(false);
    const head = view.element.querySelector<HTMLElement>(".activity-head")!;
    // Press at (50,20): panel rect is 0×0 under jsdom → offsets are the press point.
    firePointer(head, "pointerdown", { clientX: 50, clientY: 20 });
    expect(view.element.style.right).toBe("auto");
    expect(view.element.style.bottom).toBe("auto");
    firePointer(head, "pointermove", { clientX: 250, clientY: 120 });
    expect(view.element.style.left).toBe("200px");
    expect(view.element.style.top).toBe("100px");
    // Clamped: left ≤ innerWidth−80, top ≤ innerHeight−40, and never negative.
    firePointer(head, "pointermove", { clientX: 99999, clientY: 99999 });
    expect(view.element.style.left).toBe(`${window.innerWidth - 80}px`);
    expect(view.element.style.top).toBe(`${window.innerHeight - 40}px`);
    firePointer(head, "pointermove", { clientX: -500, clientY: -500 });
    expect(view.element.style.left).toBe("0px");
    expect(view.element.style.top).toBe("0px");
    firePointer(head, "pointerup", { clientX: -500, clientY: -500 });
    firePointer(head, "pointermove", { clientX: 300, clientY: 300 });
    expect(view.element.style.left).toBe("0px"); // drag ended — no further moves
  });

  it("a press on a header button does NOT start a drag", () => {
    const { view } = makePanel(false);
    const head = view.element.querySelector<HTMLElement>(".activity-head")!;
    firePointer(buttonByText(view.element, m.copy), "pointerdown", { clientX: 10, clientY: 10 });
    firePointer(head, "pointermove", { clientX: 300, clientY: 300 });
    expect(view.element.style.left).toBe(""); // never re-anchored / moved
  });
});

describe("native (Tauri) window", () => {
  /**
   * Build the native panel and SETTLE its listen handshake before driving it.
   * The view's `await import("@tauri-apps/api/*")` calls resolve through
   * vitest's async module runner — a macrotask, not a microtask, so `flush()`
   * can't cover it, and the build-time IIFE's first import can race a
   * concurrent one. Waiting for both listeners registers the protocol and
   * leaves the mocked event module fully evaluated for the rest of the test.
   */
  async function makeNativePanel() {
    const made = makePanel(true);
    await vi.waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith("activity-ready", expect.any(Function));
      expect(listenMock).toHaveBeenCalledWith("activity-hidden", expect.any(Function));
    });
    return made;
  }

  it("registers the activity-ready / activity-hidden listeners on build", async () => {
    const { view } = await makeNativePanel(); // the waitFor IS the registration assert
    expect(view.element.hidden).toBe(true); // the in-page panel never opens on Tauri
  });

  it("toggleNative → visible: syncs the button ON and replays lastOutput", async () => {
    const { view, onToggleState } = await makeNativePanel();
    invokeMock.mockResolvedValue(true);
    await view.toggleNative();
    expect(invokeMock).toHaveBeenCalledWith("toggle_activity_window");
    expect(onToggleState).toHaveBeenLastCalledWith({ on: true, hasOutput: false });
    expect(emitMock).toHaveBeenCalledWith("activity-log", {
      text: m.placeholder,
      kind: "",
      outDir: "",
    });
  });

  it("toggleNative → hidden: syncs the button OFF without replaying", async () => {
    const { view, onToggleState } = await makeNativePanel();
    emitMock.mockClear();
    invokeMock.mockResolvedValue(false);
    await view.toggleNative();
    expect(onToggleState).toHaveBeenLastCalledWith({ on: false, hasOutput: false });
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("toggleNative swallows an invoke failure (no throw, no state change)", async () => {
    const { view, onToggleState } = await makeNativePanel();
    invokeMock.mockRejectedValue(new Error("no window"));
    await expect(view.toggleNative()).resolves.toBeUndefined();
    expect(onToggleState).not.toHaveBeenCalled();
  });

  it("setOutput emits to the native window and leaves the web panel DOM alone", async () => {
    const { view } = await makeNativePanel();
    view.setOutput("native progress", "ok");
    await vi.waitFor(() =>
      expect(emitMock).toHaveBeenCalledWith("activity-log", {
        text: "native progress",
        kind: "ok",
        outDir: "",
      }),
    );
    // The in-page panel is unused on Tauri: untouched and never shown.
    expect(logPre(view.element).textContent).toBe(m.placeholder);
    expect(view.element.hidden).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("show_activity_window");
  });

  it("an err output force-shows the native window and reports it ON", async () => {
    const { view, onToggleState } = await makeNativePanel();
    invokeMock.mockResolvedValue(undefined);
    view.setOutput("render failed", "err");
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("show_activity_window");
      expect(emitMock).toHaveBeenCalledWith("activity-log", {
        text: "render failed",
        kind: "err",
        outDir: "",
      });
      expect(onToggleState).toHaveBeenLastCalledWith({ on: true, hasOutput: false });
    });
  });

  it("setOutDir merges the dir into the emitted model", async () => {
    const { view } = await makeNativePanel();
    view.setOutput("done", "ok");
    await vi.waitFor(() =>
      expect(emitMock).toHaveBeenCalledWith("activity-log", {
        text: "done",
        kind: "ok",
        outDir: "",
      }),
    );
    emitMock.mockClear();
    view.setOutDir("/render/out");
    await vi.waitFor(() =>
      expect(emitMock).toHaveBeenCalledWith("activity-log", {
        text: "done",
        kind: "ok",
        outDir: "/render/out",
      }),
    );
    // The web outdir line is never rendered on the native branch.
    expect(view.element.querySelector(".hint")?.textContent).toBe("");
  });

  it("pushTheme emits the current data-theme (default light)", async () => {
    const { view } = await makeNativePanel();
    await view.pushTheme();
    expect(emitMock).toHaveBeenCalledWith("theme", "light");
    document.documentElement.setAttribute("data-theme", "dark");
    await view.pushTheme();
    expect(emitMock).toHaveBeenLastCalledWith("theme", "dark");
  });

  it("activity-ready replays the latest output to the new window", async () => {
    const { view } = await makeNativePanel();
    view.setOutput("replay me", "ok");
    view.setOutDir("/replay/dir");
    await vi.waitFor(() =>
      expect(emitMock).toHaveBeenCalledWith("activity-log", {
        text: "replay me",
        kind: "ok",
        outDir: "/replay/dir",
      }),
    );
    emitMock.mockClear();
    nativeHandlers.get("activity-ready")!();
    await vi.waitFor(() =>
      expect(emitMock).toHaveBeenCalledWith("activity-log", {
        text: "replay me",
        kind: "ok",
        outDir: "/replay/dir",
      }),
    );
    // NOT asserted here: the handler's concurrent theme replay. It fires
    // pushActivity + pushTheme simultaneously, and vitest's module runner
    // resolves only ONE of two simultaneous dynamic imports of a mocked module
    // to the mock (the other gets the real module, whose emit the view's
    // try/catch swallows under jsdom — verified empirically). The theme push
    // itself is pinned by the dedicated pushTheme test above.
  });

  it("activity-hidden clears the toggle's ON state", async () => {
    const { onToggleState } = await makeNativePanel();
    nativeHandlers.get("activity-hidden")!();
    expect(onToggleState).toHaveBeenLastCalledWith({ on: false, hasOutput: false });
  });
});
