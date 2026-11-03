// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings — a left-nav modal with five panels (General / Rendering / AI &
 * models / Shortcuts / About). It is a *surface* over capability that already
 * lives elsewhere in the app: theme + timecode + default destination +
 * autosave (General), the render flags (Rendering), the BYOK key in the OS
 * keychain + tracking interval (AI), the keyboard bindings (Shortcuts), and the
 * build metadata from `version.ts` (About).
 *
 * This module is the modal shell: the nav, the panel switch and dismissal.
 * Each panel is its own `settings-<panel>.ts`; their shared builders and icons
 * are in settings-controls.ts (#270).
 *
 * Persistence is split by sensitivity, never inline in a config/session file:
 * - the BYOK API key lives in the OS keychain via the platform `secretStore`
 *   under `GEMINI_API_KEY_SECRET` (a DEV-ONLY localStorage shim on the web build;
 *   see settings-ai-key.ts);
 * - every other preference is a small `localStorage` blob (the `*_KEY`s in
 *   settings-store.ts), reusing the keys the editor already reads
 *   (`footlight.theme`, `footlight.outdir`) so the two stay in sync.
 *
 * The Rendering panel maps 1:1 to `--crf/--preset/--audio-bitrate/--dry-run`:
 * the editor's `renderOptions()` (editor-prefs.ts) reads the persisted blob and
 * threads it through `platform.render` on both backends.
 */

import { messages } from "./i18n/index.js";
import { el, button, openModal } from "./ui.js";
import {
  ICON_FILM,
  ICON_GEAR,
  ICON_INFO,
  ICON_KEYBOARD,
  ICON_SPARK,
  ICON_X,
} from "./settings-controls.js";
import { buildGeneralPanel } from "./settings-general.js";
import { buildRenderingPanel } from "./settings-rendering.js";
import { buildAiPanel } from "./settings-ai.js";
import { buildShortcutsPanel } from "./settings-shortcuts.js";
import { buildAboutPanel } from "./settings-about.js";

// The persisted-prefs readers other modules import from here.
export { initTheme, loadAssistantOverlay, loadChatStillsBudget } from "./settings-store.js";

// =====================================================================
// Shell
// =====================================================================

type PanelId = "general" | "rendering" | "ai" | "shortcuts" | "about";

const NAV: { id: PanelId; icon: string; label: () => string; build: () => HTMLElement }[] = [
  {
    id: "general",
    icon: ICON_GEAR,
    label: () => messages.settings.nav.general,
    build: buildGeneralPanel,
  },
  {
    id: "rendering",
    icon: ICON_FILM,
    label: () => messages.settings.nav.rendering,
    build: buildRenderingPanel,
  },
  { id: "ai", icon: ICON_SPARK, label: () => messages.settings.nav.ai, build: buildAiPanel },
  {
    id: "shortcuts",
    icon: ICON_KEYBOARD,
    label: () => messages.settings.nav.shortcuts,
    build: buildShortcutsPanel,
  },
  {
    id: "about",
    icon: ICON_INFO,
    label: () => messages.settings.nav.about,
    build: buildAboutPanel,
  },
];

/** Input types whose value commits on `change` (blur/Enter) rather than per click. */
const TEXT_INPUT_TYPES = new Set(["text", "password", "search", "url", "number"]);

/** Show the Settings modal, landing on `panel` (default General). */
export function openSettings(panel: PanelId = "general"): void {
  const s = messages.settings;

  const modal = el("div", "fl-modal settings");
  modal.setAttribute("aria-label", s.title);

  // header: spark mark + "Settings" + close ✕
  const head = el("div", "fl-modal-h");
  const titleWrap = el("div");
  titleWrap.style.cssText = "display:flex; align-items:center; gap:11px;";
  const spark = el("span", "fl-assist-spark");
  spark.innerHTML = ICON_SPARK;
  const title = el("span", "fl-label");
  title.style.fontSize = "14px";
  title.textContent = s.title;
  titleWrap.append(spark, title);
  const closeBtn = button("", "fl-iconbtn");
  closeBtn.innerHTML = ICON_X;
  closeBtn.title = s.close;
  head.append(titleWrap, el("span", "fl-spacer"), closeBtn);

  // body: nav + main
  const setRoot = el("div", "fl-set fl-grow");
  const nav = el("div", "fl-set-nav");
  const main = el("div", "fl-set-main");

  const navItems = new Map<PanelId, HTMLElement>();
  let current: PanelId = panel;

  // Text fields persist on `change`, which a browser fires on blur but NOT when
  // a focused field is simply removed. So before closing the modal or swapping
  // panels, fire the focused field's `change` ourselves: explicit rather than
  // relying on blur → change, which differs across engines (jsdom never fires
  // it). The field is removed right after, so no native change follows; at
  // worst a handler re-writes an unchanged value, which is idempotent.
  const commitFocusedField = (): void => {
    const active = document.activeElement;
    const isTextField =
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(active.type));
    if (isTextField && modal.contains(active)) {
      active.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const renderPanel = (id: PanelId): void => {
    commitFocusedField();
    current = id;
    for (const [pid, item] of navItems) item.classList.toggle("on", pid === id);
    main.replaceChildren(NAV.find((n) => n.id === id)!.build());
    main.scrollTop = 0;
  };

  for (const item of NAV) {
    const navItem = el("div", "fl-set-navitem");
    navItem.innerHTML = item.icon;
    const lab = document.createElement("span");
    lab.textContent = item.label();
    navItem.append(lab);
    navItem.addEventListener("click", () => renderPanel(item.id));
    navItems.set(item.id, navItem);
    nav.append(navItem);
  }
  setRoot.append(nav, main);

  // footer: Cancel / Save (settings persist live, so both just close)
  const foot = el("div", "fl-modal-foot");
  const cancelBtn = button(s.cancel, "fl-btn ghost", () => dismiss());
  const saveBtn = button(s.save, "fl-btn primary", () => dismiss());
  foot.append(el("span", "fl-spacer"), cancelBtn, saveBtn);

  modal.append(head, setRoot, foot);
  renderPanel(current);

  // Every dismiss path commits the focused text field while it is still mounted.
  const { close: dismiss } = openModal({
    dialog: modal,
    backdropClass: "fl-modal-backdrop",
    labelledBy: title,
    beforeClose: commitFocusedField,
  });
  closeBtn.addEventListener("click", dismiss);
}
