// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings modal. Holds global, app-wide configuration — currently the BYOK
 * Gemini API key used by Auto-track. The key is persisted in the shared
 * auto-track settings (localStorage); we load-modify-save so we never clobber
 * the per-run fields (subject hint, interval, mock) the editor owns.
 */

import { messages } from "./i18n/index.js";
import { loadAutoTrackSettings, saveAutoTrackSettings } from "./autotrack.js";

/** Persist just the API key, preserving every other stored auto-track field. */
function saveApiKey(key: string): void {
  const current = loadAutoTrackSettings();
  current.apiKey = key;
  saveAutoTrackSettings(current);
}

/** Show the Settings modal. */
export function openSettings(): void {
  const s = messages.settings;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal settings";

  const h3 = document.createElement("h3");
  h3.textContent = s.title;

  const sectionLabel = document.createElement("h4");
  sectionLabel.textContent = s.apiKeySection;

  const row = document.createElement("div");
  row.className = "row";
  const label = document.createElement("label");
  label.textContent = s.apiKeyLabel;
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.placeholder = s.apiKeyPlaceholder;
  keyInput.classList.add("grow");
  keyInput.value = loadAutoTrackSettings().apiKey;
  keyInput.addEventListener("input", () => saveApiKey(keyInput.value.trim()));
  row.append(label, keyInput);

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = s.apiKeyHint;

  const close = document.createElement("button");
  close.className = "close";
  close.textContent = s.close;

  modal.append(h3, sectionLabel, row, hint, close);
  backdrop.append(modal);
  document.body.append(backdrop);

  const dismiss = () => {
    saveApiKey(keyInput.value.trim());
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
