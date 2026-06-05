// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * In-app Help menu + About modal. This is plain DOM (no framework) so it works
 * identically in the browser dev build and inside the Tauri webview. The native
 * Tauri menu (main.rs) mirrors these items, but THIS is the one that is
 * guaranteed to function in the verifiable web build. All external links go
 * through `platform.openExternal` so they behave correctly in both backends.
 */

import { platform } from "./platform/index.js";
import { openGuide } from "./help.js";
import { messages } from "./i18n/index.js";
import {
  APP_NAME,
  APP_VERSION,
  LICENSE,
  COPYRIGHT,
  REPO_URL,
  ISSUES_NEW_URL,
} from "./version.js";

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
    openAbout();
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

/** Show the About modal. */
export function openAbout(): void {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";

  const h3 = document.createElement("h3");
  h3.textContent = APP_NAME;

  const tagline = document.createElement("div");
  tagline.className = "about-tagline";
  tagline.textContent = "Your stage, vertical.";

  const ver = document.createElement("div");
  ver.className = "ver";
  ver.textContent = `Version ${APP_VERSION} · License ${LICENSE}`;

  const copy = document.createElement("div");
  copy.textContent = COPYRIGHT;

  const desc = document.createElement("p");
  desc.className = "hint";
  desc.textContent =
    "Footlight turns 16:9 performance video into frame-perfect 9:16 clips — you make every call.";

  const repoLink = document.createElement("a");
  repoLink.textContent = REPO_URL;
  repoLink.addEventListener("click", () => void platform.openExternal(REPO_URL));

  const repoLine = document.createElement("div");
  repoLine.append(document.createTextNode("Repository: "), repoLink);

  const THANKS_URL = "https://www.lincolndurham.com/";
  const thanksLink = document.createElement("a");
  thanksLink.textContent = "Lincoln Durham";
  thanksLink.addEventListener("click", () => void platform.openExternal(THANKS_URL));
  const thanksLine = document.createElement("div");
  thanksLine.className = "thanks";
  thanksLine.append(document.createTextNode("Special thanks to "), thanksLink);

  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "Close";

  modal.append(h3, tagline, ver, copy, desc, repoLine, thanksLine, close);
  backdrop.append(modal);
  document.body.append(backdrop);

  function dismiss() {
    backdrop.remove();
  }
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) dismiss();
  });
}
