// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 *
 * First DOM-level (jsdom) test, exercising the view-wiring that the pure-logic
 * extractions can't reach. `openShortcuts()` builds the keyboard-shortcuts modal
 * from the i18n catalog and wires its dismissal (close button / backdrop click /
 * Escape). This asserts it renders the catalog faithfully and tears down cleanly.
 *
 * Pure tests stay in the default node environment (fast); only files that need a
 * DOM opt in via the `@vitest-environment jsdom` docblock above.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openShortcuts } from "../src/shortcuts.js";
import { messages } from "../src/i18n/index.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

const backdrop = () => document.querySelector<HTMLElement>(".modal-backdrop");

describe("openShortcuts (jsdom)", () => {
  it("renders the modal from the i18n shortcuts catalog", () => {
    openShortcuts();
    const bd = backdrop();
    expect(bd).not.toBeNull();
    expect(bd!.querySelector(".modal.shortcuts")).not.toBeNull();
    expect(bd!.querySelector("h3")?.textContent).toBe(messages.shortcuts.modalTitle);

    // One group block per catalog group, each with its title and rows.
    const groups = bd!.querySelectorAll(".shortcuts-group");
    expect(groups.length).toBe(messages.shortcuts.groups.length);
    const totalRows = bd!.querySelectorAll(".shortcut-row").length;
    const expectedRows = messages.shortcuts.groups.reduce((n, g) => n + g.items.length, 0);
    expect(totalRows).toBe(expectedRows);

    // Multi-key bindings render one <kbd> per key.
    const firstBinding = messages.shortcuts.groups[0]!.items[0]!;
    const firstKeys = bd!.querySelector(".shortcut-keys");
    expect(firstKeys!.querySelectorAll("kbd").length).toBe(firstBinding.keys.length);
  });

  it("dismisses on the close button", () => {
    openShortcuts();
    expect(backdrop()).not.toBeNull();
    backdrop()!.querySelector<HTMLButtonElement>("button.close")!.click();
    expect(backdrop()).toBeNull();
  });

  it("dismisses on a backdrop click but NOT a click inside the modal", () => {
    openShortcuts();
    // Click inside the modal — should stay open.
    backdrop()!.querySelector<HTMLElement>(".modal.shortcuts")!.click();
    expect(backdrop()).not.toBeNull();
    // Click the backdrop itself — should close.
    backdrop()!.click();
    expect(backdrop()).toBeNull();
  });

  it("dismisses on Escape and removes its keydown listener", () => {
    openShortcuts();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop()).toBeNull();
    // A second Escape after dismissal is a no-op (listener was removed; no throw).
    expect(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))).not.toThrow();
  });
});
