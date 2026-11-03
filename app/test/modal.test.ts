// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The shared modal helper (`openModal` in ui.ts, #266) and the five dialogs
 * built on it. The helper is pinned directly — role/aria wiring, focus moving
 * in, the Tab/Shift-Tab trap, Escape, focus restore, and the topmost-only rule
 * for stacked modals — then each real dialog is opened once to prove it is
 * wired through the helper (labelled, focus in, focus restored on close).
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { messages } from "../src/i18n/index.js";
import { mockPlatform } from "./helpers/platform-mock.js";
import {
  installDomShims,
  resetHarness,
  flush,
  buttonByText,
  mountLoaded,
} from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { openModal, isModalOpen } = await import("../src/ui.js");
const { openShortcuts } = await import("../src/shortcuts.js");
const { openGuide } = await import("../src/help.js");
const { openSettings } = await import("../src/settings.js");
const { openHistoryModal } = await import("../src/views/history.js");
const { mountEditor } = await import("../src/editor.js");

const tab = (shiftKey = false): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  (document.activeElement ?? document).dispatchEvent(e);
  return e;
};
const escape = (): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
};

/** An opener button on the page, focused — what focus must return to. */
function focusedOpener(): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = "open";
  document.body.append(b);
  b.focus();
  return b;
}

/** A small dialog: title + three buttons (one hidden, one disabled) + a field. */
function sampleDialog(): {
  dialog: HTMLElement;
  title: HTMLElement;
  a: HTMLElement;
  z: HTMLElement;
} {
  const dialog = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = "Sample";
  const a = document.createElement("button");
  a.textContent = "first";
  const hidden = document.createElement("button");
  hidden.style.display = "none";
  const disabled = document.createElement("button");
  disabled.disabled = true;
  const z = document.createElement("input");
  dialog.append(title, a, hidden, disabled, z);
  return { dialog, title, a, z };
}

beforeEach(() => {
  resetHarness();
});

describe("openModal", () => {
  it("wires role=dialog, aria-modal and aria-labelledby the title", () => {
    const { dialog, title } = sampleDialog();
    const { backdrop } = openModal({
      dialog,
      backdropClass: "fl-modal-backdrop",
      labelledBy: title,
    });
    expect(backdrop.parentElement).toBe(document.body);
    expect(backdrop.className).toBe("fl-modal-backdrop");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(title.id).not.toBe("");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
    expect(isModalOpen()).toBe(true);
  });

  it("moves focus to the first Tab stop, or to initialFocus when given", () => {
    const one = sampleDialog();
    openModal({ dialog: one.dialog, backdropClass: "modal-backdrop", labelledBy: one.title });
    expect(document.activeElement).toBe(one.a);

    resetHarness();
    const two = sampleDialog();
    openModal({
      dialog: two.dialog,
      backdropClass: "modal-backdrop",
      labelledBy: two.title,
      initialFocus: two.z,
    });
    expect(document.activeElement).toBe(two.z);
  });

  it("focuses the dialog itself when it has no Tab stops", () => {
    const dialog = document.createElement("div");
    const title = document.createElement("h3");
    dialog.append(title);
    openModal({ dialog, backdropClass: "modal-backdrop", labelledBy: title });
    expect(document.activeElement).toBe(dialog);
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });

  it("traps Tab forward from the last stop and Shift-Tab back from the first", () => {
    const { dialog, title, a, z } = sampleDialog();
    openModal({ dialog, backdropClass: "modal-backdrop", labelledBy: title });
    expect(document.activeElement).toBe(a);

    // Shift-Tab on the first stop wraps to the last (the hidden and disabled
    // buttons are skipped).
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(z);

    // Tab on the last stop wraps to the first.
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);

    // Between stops the browser moves focus natively: not intercepted.
    expect(tab().defaultPrevented).toBe(false);
  });

  it("pulls focus back in when it has escaped the dialog", () => {
    const outside = focusedOpener();
    const { dialog, title, a, z } = sampleDialog();
    openModal({ dialog, backdropClass: "modal-backdrop", labelledBy: title });
    outside.focus();
    tab();
    expect(document.activeElement).toBe(a);
    outside.focus();
    tab(true);
    expect(document.activeElement).toBe(z);
  });

  it("from the dialog itself (a click on its padding), Tab and Shift-Tab land on a stop", () => {
    const { dialog, title, a, z } = sampleDialog();
    openModal({ dialog, backdropClass: "modal-backdrop", labelledBy: title });
    dialog.focus();
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(z);
    dialog.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);
  });

  it("consumes its Escape: the editor's window-level handler never sees it", () => {
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    try {
      const { dialog, title, a } = sampleDialog();
      const { backdrop } = openModal({
        dialog,
        backdropClass: "modal-backdrop",
        labelledBy: title,
      });
      // From a focused button inside the dialog, as a real key press would be.
      a.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(backdrop.isConnected).toBe(false);
      expect(onWindow).not.toHaveBeenCalled();
      // With no modal open, Escape reaches the window as before.
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(onWindow).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
  });

  it("an Escape that ends an IME composition leaves the modal open", () => {
    const { dialog, title, z } = sampleDialog();
    const { backdrop } = openModal({ dialog, backdropClass: "modal-backdrop", labelledBy: title });
    z.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }),
    );
    expect(backdrop.isConnected).toBe(true);
  });

  it("Escape closes, restores focus to the opener, and unhooks", () => {
    const opener = focusedOpener();
    const before = vi.fn();
    const { dialog, title } = sampleDialog();
    const { backdrop } = openModal({
      dialog,
      backdropClass: "fl-modal-backdrop",
      labelledBy: title,
      beforeClose: () => before(backdrop.isConnected),
    });
    expect(document.activeElement).not.toBe(opener);
    escape();
    expect(backdrop.isConnected).toBe(false);
    expect(isModalOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
    // beforeClose ran exactly once, while the dialog was still mounted.
    expect(before).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledWith(true);
    escape();
    expect(before).toHaveBeenCalledTimes(1);
  });

  it("close() and a backdrop click close too; a click inside does not", () => {
    const opener = focusedOpener();
    const one = sampleDialog();
    const h1 = openModal({
      dialog: one.dialog,
      backdropClass: "modal-backdrop",
      labelledBy: one.title,
    });
    one.dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(h1.backdrop.isConnected).toBe(true);
    h1.backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(h1.backdrop.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);

    const two = sampleDialog();
    const h2 = openModal({
      dialog: two.dialog,
      backdropClass: "modal-backdrop",
      labelledBy: two.title,
    });
    h2.close();
    h2.close(); // idempotent
    expect(h2.backdrop.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("only the topmost of stacked modals answers Escape", () => {
    const lower = sampleDialog();
    const h1 = openModal({
      dialog: lower.dialog,
      backdropClass: "modal-backdrop",
      labelledBy: lower.title,
    });
    const upper = sampleDialog();
    const h2 = openModal({
      dialog: upper.dialog,
      backdropClass: "modal-backdrop",
      labelledBy: upper.title,
    });
    escape();
    expect(h2.backdrop.isConnected).toBe(false);
    expect(h1.backdrop.isConnected).toBe(true);
    // Focus went back to where it was when the upper one opened: inside the lower.
    expect(document.activeElement).toBe(lower.a);
    escape();
    expect(h1.backdrop.isConnected).toBe(false);
  });

  it("a backdrop removed from outside never blocks the next modal", () => {
    const stale = sampleDialog();
    openModal({ dialog: stale.dialog, backdropClass: "modal-backdrop", labelledBy: stale.title });
    document.body.innerHTML = ""; // torn down without close()
    expect(isModalOpen()).toBe(false);
    const fresh = sampleDialog();
    const h = openModal({
      dialog: fresh.dialog,
      backdropClass: "modal-backdrop",
      labelledBy: fresh.title,
    });
    escape();
    expect(h.backdrop.isConnected).toBe(false);
  });
});

/** Open a real dialog from a focused opener; assert it is labelled, focus moved in, and Escape restores focus. */
async function expectAccessibleModal(open: () => void | Promise<void>, titleText: string) {
  const opener = focusedOpener();
  await open();
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  expect(dialog).not.toBeNull();
  const title = document.getElementById(dialog!.getAttribute("aria-labelledby")!);
  expect(title?.textContent).toBe(titleText);
  expect(dialog!.contains(document.activeElement)).toBe(true);
  escape();
  expect(isModalOpen()).toBe(false);
  expect(document.activeElement).toBe(opener);
}

describe("every dialog is built on openModal", () => {
  it("keyboard shortcuts", async () => {
    await expectAccessibleModal(openShortcuts, messages.shortcuts.modalTitle);
  });

  it("user guide", async () => {
    await expectAccessibleModal(openGuide, messages.help.title);
  });

  it("settings", async () => {
    await expectAccessibleModal(() => openSettings(), messages.settings.title);
  });

  it("render history (focus lands on the filter, not Clear all)", async () => {
    await expectAccessibleModal(
      () => openHistoryModal({ platform: mockPlatform, openSpec: vi.fn(), setThumb: vi.fn() }),
      messages.editor.history.title,
    );
    await openHistoryModal({ platform: mockPlatform, openSpec: vi.fn(), setThumb: vi.fn() });
    expect(document.activeElement).toBe(
      document.querySelector(`input[placeholder="${messages.editor.history.filterPlaceholder}"]`),
    );
  });

  it("clear-confirm (focus lands on Cancel, never on the destructive confirm)", async () => {
    const root = await mountLoaded(mountEditor);
    const clear = buttonByText(root, messages.editor.topbar.clear);
    clear.focus();
    clear.click();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
    expect(dialog).not.toBeNull();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(
      messages.editor.clear.title,
    );
    expect(document.activeElement).toBe(buttonByText(dialog, messages.editor.clear.cancel));
    escape();
    expect(isModalOpen()).toBe(false);
    expect(document.activeElement).toBe(clear);
  });
});
