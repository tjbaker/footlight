// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings → Shortcuts (#270): the read-only key-binding reference.
 */

import { messages } from "./i18n/index.js";
import { el } from "./ui.js";
import { block, panelHeader } from "./settings-controls.js";

// Shortcut bindings are single-sourced in the i18n catalog (messages.shortcuts),
// shared with the Help overlay (shortcuts.ts) — see buildShortcutsPanel.

export function buildShortcutsPanel(): HTMLElement {
  const s = messages.settings.shortcuts;
  const root = el("div");
  root.append(panelHeader(s.title, s.subtitle));
  for (const group of messages.shortcuts.groups) {
    const b = block(group.title);
    const list = el("div", "fl-sc-list");
    for (const r of group.items) {
      const row = el("div", "fl-sc-row");
      const desc = el("span", "fl-sc-desc");
      desc.textContent = r.desc;
      const keys = el("span", "fl-sc-keys");
      r.keys.forEach((k, i) => {
        if (i > 0) {
          const plus = el("span", "plus");
          plus.textContent = "+";
          keys.append(plus);
        }
        const kbd = el("span", "fl-kbd");
        kbd.textContent = k;
        keys.append(kbd);
      });
      row.append(desc, keys);
      list.append(row);
    }
    b.body.append(list);
    root.append(b.root);
  }
  return root;
}
