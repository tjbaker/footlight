// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings modal. Holds global, app-wide configuration — currently the BYOK
 * Gemini API key used by Auto-track. The key is persisted in the OS keychain via
 * the platform `secretStore` (a DEV-ONLY localStorage shim on the web build),
 * NOT in the `footlight.autotrack` localStorage blob — so it never lands in a
 * config/session file. We hydrate the field asynchronously and write on edit.
 */

import { messages } from "./i18n/index.js";
import { GEMINI_API_KEY_SECRET } from "./autotrack.js";
import { platform } from "./platform/index.js";

/**
 * Persist (or clear) the API key in the keychain. An empty value deletes the
 * secret rather than storing a blank, so "no key" reads back as absent.
 */
async function saveApiKey(key: string): Promise<void> {
  try {
    if (key) await platform.setSecret(GEMINI_API_KEY_SECRET, key);
    else await platform.deleteSecret(GEMINI_API_KEY_SECRET);
  } catch {
    /* keychain unavailable (locked, denied, etc.) — non-fatal for the modal. */
  }
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
  // Hydrate the current key from the keychain (async); leave blank if absent.
  void platform
    .getSecret(GEMINI_API_KEY_SECRET)
    .then((v) => {
      keyInput.value = v ?? "";
    })
    .catch(() => undefined);
  keyInput.addEventListener("input", () => void saveApiKey(keyInput.value.trim()));
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
    void saveApiKey(keyInput.value.trim());
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
