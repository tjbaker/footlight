// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * In-app Help menu. This is plain DOM (no framework) so it works identically in
 * the browser dev build and inside the Tauri webview. The native Tauri menu
 * (main.rs) mirrors these items, but THIS is the one that is guaranteed to
 * function in the verifiable web build. All external links go through
 * `platform.openExternal` so they behave correctly in both backends.
 *
 * "About" is NOT a separate surface: it opens Settings → About, the single
 * source of truth for app/version/environment info (both this dropdown and the
 * native macOS app-menu item route there).
 */

import { platform } from "./platform/index.js";
import { openGuide } from "./help.js";
import { openSettings } from "./settings.js";
import { messages } from "./i18n/index.js";
import { REPO_URL, ISSUES_NEW_URL } from "./version.js";

/** Build the Help dropdown + About modal, returning the topbar menu element. */
export function createHelpMenu(): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "menu";

  const trigger = document.createElement("button");
  trigger.textContent = "Help ▾";
  trigger.setAttribute("aria-haspopup", "true");

  const dropdown = document.createElement("div");
  dropdown.className = "menu-dropdown";
  dropdown.hidden = true;

  const guideBtn = mkItem(messages.help.menuLabel, () => {
    closeDropdown();
    openGuide();
  });
  const aboutBtn = mkItem("About Footlight", () => {
    closeDropdown();
    openSettings("about");
  });
  const bugBtn = mkItem("Report a Bug", () => {
    closeDropdown();
    void platform.openExternal(ISSUES_NEW_URL);
  });
  const ghBtn = mkItem("View on GitHub", () => {
    closeDropdown();
    void platform.openExternal(REPO_URL);
  });
  dropdown.append(guideBtn, aboutBtn, bugBtn, ghBtn);

  function openDropdown() {
    dropdown.hidden = false;
  }
  function closeDropdown() {
    dropdown.hidden = true;
  }
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dropdown.hidden) openDropdown();
    else closeDropdown();
  });
  // Click anywhere else closes the dropdown.
  document.addEventListener("click", () => closeDropdown());

  menu.append(trigger, dropdown);
  return menu;
}

function mkItem(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
