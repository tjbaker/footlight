// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings → About (#270): identity, links, credits and the environment read-out.
 */

import { messages } from "./i18n/index.js";
import { platform } from "./platform/index.js";
import { APP_NAME, APP_VERSION, LICENSE, REPO_URL, ISSUES_NEW_URL } from "./version.js";
import { el, button } from "./ui.js";
import { ICON_BRAND, ICON_LINK, block, panelHeader } from "./settings-controls.js";

export function buildAboutPanel(): HTMLElement {
  const s = messages.settings.about;
  const root = el("div");
  root.append(panelHeader(s.title, s.subtitle));

  const idBlock = block(s.title);
  const id = el("div", "fl-about-id");
  const mark = el("div");
  mark.innerHTML = ICON_BRAND;
  const idMeta = el("div");
  const idName = el("div");
  idName.style.cssText =
    'font-family:"Bricolage Grotesque",sans-serif; font-weight:700; font-size:20px; letter-spacing:-0.02em;';
  idName.textContent = APP_NAME;
  const idTagline = el("div", "fl-rowhint");
  idTagline.style.marginTop = "2px";
  idTagline.textContent = s.tagline;
  const idVer = el("div", "fl-rowhint");
  idVer.style.marginTop = "3px";
  idVer.textContent = `v${APP_VERSION} · ${LICENSE} · © 2026 Trevor Baker`;
  idMeta.append(idName, idTagline, idVer);
  id.append(mark, idMeta);

  const links = el("div", "fl-link-row");
  const repoBtn = button(s.repo, "fl-btn", () => {
    void platform.openExternal(REPO_URL).catch(() => undefined);
  });
  repoBtn.insertAdjacentHTML("afterbegin", ICON_LINK);
  const bugBtn = button(s.reportBug, "fl-btn", () => {
    void platform.openExternal(ISSUES_NEW_URL).catch(() => undefined);
  });
  bugBtn.insertAdjacentHTML("afterbegin", ICON_LINK);
  const licBtn = button(s.licenses, "fl-btn", () => {
    void platform.openExternal(`${REPO_URL}/blob/main/NOTICE`).catch(() => undefined);
  });
  licBtn.insertAdjacentHTML("afterbegin", ICON_LINK);
  links.append(repoBtn, bugBtn, licBtn);
  // Special thanks — a real credit carried over from the former About modal.
  const thanks = el("div", "fl-set-secsub");
  thanks.style.marginTop = "10px";
  const thanksLink = document.createElement("a");
  thanksLink.textContent = "Lincoln Durham";
  thanksLink.href = "#";
  thanksLink.addEventListener("click", (e) => {
    e.preventDefault();
    void platform.openExternal("https://www.lincolndurham.com/").catch(() => undefined);
  });
  thanks.append(document.createTextNode(s.thanks), thanksLink);
  idBlock.body.append(id, links, thanks);
  root.append(idBlock.root);

  // Environment — a static read-out (a live `make doctor` probe needs backend
  // plumbing not present in the platform seam; surfaced read-only here).
  const envBlock = block(s.environment);
  const env = el("div", "fl-env");
  const rows: [string, string][] = [
    ["ffmpeg", "from PATH"],
    ["ffprobe", "from PATH"],
    ["node", "from PATH"],
  ];
  for (const [k, v] of rows) {
    const row = el("div", "fl-env-row");
    const dot = el("span", "fl-dot");
    const key = el("span", "fl-env-k");
    key.textContent = k;
    const val = el("span", "fl-env-v");
    val.textContent = v;
    row.append(dot, key, val);
    env.append(row);
  }
  const envHint = el("div", "fl-set-secsub");
  envHint.textContent = s.environmentHint;
  envBlock.body.append(env, envHint);
  root.append(envBlock.root);

  return root;
}
