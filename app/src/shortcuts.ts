// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Keyboard-shortcuts modal. A static, read-only reference listing every key
 * binding the editor implements, grouped by purpose. Built on the shared
 * `openModal` (ui.ts): dismissal on the close button, on backdrop click, and on
 * Escape, with focus trapped inside and restored on close.
 *
 * The binding list is single-sourced in the i18n catalog (`messages.shortcuts`),
 * shared with the Settings → Shortcuts panel so the two never drift.
 */

import { messages } from "./i18n/index.js";
import { claimModal, openModal } from "./ui.js";

/** Show the Keyboard shortcuts modal (unless a modal is already open; see `claimModal`). */
export function openShortcuts(): void {
  if (!claimModal("shortcuts")) return;
  const m = messages.shortcuts;

  const modal = document.createElement("div");
  modal.className = "modal shortcuts";

  const h3 = document.createElement("h3");
  h3.textContent = m.modalTitle;

  const groups = document.createElement("div");
  groups.className = "shortcuts-groups";

  for (const group of m.groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "shortcuts-group";

    const h4 = document.createElement("h4");
    h4.textContent = group.title;
    groupEl.append(h4);

    for (const shortcut of group.items) {
      const rowEl = document.createElement("div");
      rowEl.className = "shortcut-row";

      const keysEl = document.createElement("span");
      keysEl.className = "shortcut-keys";
      shortcut.keys.forEach((key, i) => {
        if (i > 0) keysEl.append(document.createTextNode("+"));
        const kbd = document.createElement("kbd");
        kbd.textContent = key;
        keysEl.append(kbd);
      });

      const descEl = document.createElement("span");
      descEl.className = "shortcut-desc";
      descEl.textContent = shortcut.desc;

      rowEl.append(keysEl, descEl);
      groupEl.append(rowEl);
    }

    groups.append(groupEl);
  }

  const close = document.createElement("button");
  close.className = "close";
  close.textContent = m.close;

  modal.append(h3, groups, close);
  const { close: dismiss } = openModal({
    dialog: modal,
    backdropClass: "modal-backdrop",
    labelledBy: h3,
    kind: "shortcuts",
  });
  close.addEventListener("click", dismiss);
}
