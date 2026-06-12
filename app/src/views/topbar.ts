// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The top bar VIEW (#125 Phase 4): brand mark, source crumb, and the action
 * cluster (Render, preview toggle, assistant spark, history, activity toggle,
 * Clear, theme toggle, settings), as `buildTopbar(deps)`. The theme toggle
 * owns its icon/persist logic (the live OS-theme listener is `initTheme`, run
 * by the editor before mounting); everything else fires the editor's actions
 * through `deps` and mirrors state back via the exposed reflect/set methods.
 */

import { messages } from "../i18n/index.js";
import { openSettings } from "../settings.js";
import { saveTheme } from "../editor-prefs.js";
import { el, button } from "../ui.js";
import {
  ICON_ACTIVITY,
  ICON_BRAND,
  ICON_GEAR,
  ICON_HISTORY,
  ICON_MOON,
  ICON_PHONE,
  ICON_SPARK,
  ICON_SUN,
} from "../icons.js";

/** What the top bar needs from the editor (everything else it imports). */
export interface TopbarViewDeps {
  /** Render the queue (the primary action). */
  onRender: () => void;
  /** Open the render-history modal. */
  onHistory: () => void;
  /** Confirm-and-clear the working session. */
  onClear: () => void;
  /** Flip the live 9:16 output preview; returns the new on-state. */
  onTogglePreview: () => boolean;
  /** Toggle the AI assistant dock. */
  onToggleAssistant: () => void;
  /** Toggle the Activity / Output panel (native window or web panel). */
  onToggleActivity: () => void;
  /** The theme changed (keep the separate Activity window's theme in sync). */
  onThemeChanged: () => void;
}

/** The top bar view: its element + the state mirrors the editor drives. */
export interface TopbarView {
  element: HTMLElement;
  /** Show the loaded source's file name on the crumb (and light its dot). */
  setSourceCrumb: (name: string) => void;
  /** Mirror the live preview's on-state onto its toggle button. */
  reflectPreview: (on: boolean) => void;
  /** Mirror the assistant dock's open-state onto the spark button. */
  reflectAssistant: (open: boolean) => void;
  /** Mirror the Activity panel's open / has-output state onto its toggle. */
  setActivityState: (s: { on: boolean; hasOutput: boolean }) => void;
  /** Reflect the queue length on the Render button (label + disabled). */
  setRenderCount: (count: number) => void;
}

export function buildTopbar(deps: TopbarViewDeps): TopbarView {
  const m = messages.editor;

  const topbar = el("div", "fl-topbar");
  const brand = el("div", "fl-brand");
  // Brand mark: the "row of footlights" three-lamp SVG (same motif as the app
  // icon). No tagline.
  brand.innerHTML = `${ICON_BRAND}<div class="fl-word">Footlight</div>`;

  const crumb = el("div", "fl-crumb mono");
  const crumbDot = el("span", "fl-dot");
  const crumbPath = el("span", "path");
  crumbPath.textContent = m.topbar.noSource;
  crumb.append(crumbDot, crumbPath);

  const actions = el("div", "fl-actions");
  const renderBtn = button(m.topbar.render, "fl-btn primary", () => deps.onRender());
  renderBtn.title = m.topbar.renderTitle;
  const historyBtn = button("", "fl-iconbtn", () => deps.onHistory());
  historyBtn.innerHTML = ICON_HISTORY;
  historyBtn.title = m.topbar.historyTitle;
  const clearBtn = button(m.topbar.clear, "fl-btn sm ghost", () => deps.onClear());
  clearBtn.title = m.topbar.clearTitle;
  // The on/off state (persisted) lives in the viewer view; the button mirrors it.
  const previewBtn = button("", "fl-iconbtn", () => reflectPreview(deps.onTogglePreview()));
  previewBtn.innerHTML = ICON_PHONE;
  function reflectPreview(on: boolean): void {
    previewBtn.classList.toggle("on", on);
    previewBtn.title = on ? m.topbar.previewHide : m.topbar.previewShow;
  }
  // Spark toggles the AI assistant dock — a third rail mode that slides over the
  // Frame / Track-subject inspector (SPEC §6.7). Active state mirrors `.on`.
  const assistantBtn = button("", "fl-iconbtn assistant", () => deps.onToggleAssistant());
  assistantBtn.innerHTML = ICON_SPARK;
  assistantBtn.title = m.topbar.assistantTitle;
  const activityToggle = button("", "fl-iconbtn", () => deps.onToggleActivity());
  activityToggle.innerHTML = ICON_ACTIVITY;
  activityToggle.title = m.topbar.activityTitle;
  const themeBtn = button("", "fl-iconbtn", () => toggleTheme());
  const settingsBtn = button("", "fl-iconbtn", () => openSettings());
  settingsBtn.innerHTML = ICON_GEAR;
  settingsBtn.title = m.topbar.settingsTitle;
  actions.append(
    renderBtn,
    previewBtn,
    assistantBtn,
    historyBtn,
    activityToggle,
    clearBtn,
    themeBtn,
    settingsBtn,
  );
  topbar.append(brand, crumb, actions);

  function refreshThemeIcon(): void {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    themeBtn.innerHTML = dark ? ICON_SUN : ICON_MOON;
    themeBtn.title = dark ? m.topbar.themeToLight : m.topbar.themeToDark;
  }
  function toggleTheme(): void {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    saveTheme(next);
    refreshThemeIcon();
    deps.onThemeChanged(); // keep the separate Activity window's theme in sync
  }
  refreshThemeIcon();

  return {
    element: topbar,
    setSourceCrumb: (name: string): void => {
      crumbPath.textContent = name;
      crumbDot.classList.add("live");
    },
    reflectPreview,
    reflectAssistant: (open: boolean): void => {
      assistantBtn.classList.toggle("on", open);
    },
    setActivityState: (s: { on: boolean; hasOutput: boolean }): void => {
      activityToggle.classList.toggle("on", s.on);
      activityToggle.classList.toggle("has-output", s.hasOutput);
    },
    setRenderCount: (count: number): void => {
      renderBtn.textContent = count ? `${m.queue.renderN} ${count}` : m.topbar.render;
      renderBtn.disabled = count === 0;
    },
  };
}
