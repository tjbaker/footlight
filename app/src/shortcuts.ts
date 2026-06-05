// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Keyboard-shortcuts modal. A static, read-only reference listing every key
 * binding the editor implements, grouped by purpose. Mirrors the imperative
 * modal pattern used by the Settings modal (backdrop > modal > h3 > … > .close)
 * with dismissal on the close button, on backdrop click, and on Escape.
 */

interface Shortcut {
  /** Individual keys, rendered each as its own <kbd>, chained with "+". */
  keys: string[];
  /** Human-readable description of what the shortcut does. */
  desc: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Playback",
    shortcuts: [
      { keys: ["Space"], desc: "Play / pause" },
      { keys: ["←", "→"], desc: "Step 1 frame back / forward" },
      { keys: ["Shift", "←"], desc: "Nudge time −0.1s" },
      { keys: ["Shift", "→"], desc: "Nudge time +0.1s" },
    ],
  },
  {
    title: "Marking",
    shortcuts: [
      { keys: ["I"], desc: "Set In at the playhead" },
      { keys: ["O"], desc: "Set Out at the playhead" },
      { keys: ["S"], desc: "Add the current clip to the queue" },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["["], desc: "Jump to previous scene cut" },
      { keys: ["]"], desc: "Jump to next scene cut" },
    ],
  },
  {
    title: "Framing",
    shortcuts: [
      { keys: ["Alt", "←"], desc: "Nudge the crop left" },
      { keys: ["Alt", "→"], desc: "Nudge the crop right" },
      { keys: ["Alt", "↑"], desc: "Nudge the crop up (punch-in)" },
      { keys: ["Alt", "↓"], desc: "Nudge the crop down (punch-in)" },
      { keys: ["Double-click"], desc: "Reset framing to full-height 9:16" },
    ],
  },
  {
    title: "Help",
    shortcuts: [
      { keys: ["?"], desc: "Show this shortcuts overlay" },
      { keys: ["Esc"], desc: "Close any dialog" },
    ],
  },
];

/** Show the Keyboard shortcuts modal. */
export function openShortcuts(): void {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal shortcuts";

  const h3 = document.createElement("h3");
  h3.textContent = "Keyboard shortcuts";

  const groups = document.createElement("div");
  groups.className = "shortcuts-groups";

  for (const group of GROUPS) {
    const groupEl = document.createElement("div");
    groupEl.className = "shortcuts-group";

    const h4 = document.createElement("h4");
    h4.textContent = group.title;
    groupEl.append(h4);

    for (const shortcut of group.shortcuts) {
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
  close.textContent = "Close";

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
