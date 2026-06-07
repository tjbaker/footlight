// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Keyboard-shortcuts modal. A static, read-only reference listing every key
 * binding the editor implements, grouped by purpose. Mirrors the imperative
 * modal pattern used by the Settings modal (backdrop > modal > h3 > … > .close)
 * with dismissal on the close button, on backdrop click, and on Escape.
 *
 * The binding list is single-sourced in the i18n catalog (`messages.shortcuts`),
 * shared with the Settings → Shortcuts panel so the two never drift.
 */

import { messages } from "./i18n/index.js";

/** Show the Keyboard shortcuts modal. */
export function openShortcuts(): void {
  const m = messages.shortcuts;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

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
  backdrop.append(modal);
  document.body.append(backdrop);

  const dismiss = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") dismiss();
  }
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) dismiss();
  });
  document.addEventListener("keydown", onKey);
}
