// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings → General (#270): theme, timecode, default destination, tracking interval, autosave.
 */

import { messages } from "./i18n/index.js";
import { loadAutoTrackSettings, saveAutoTrackSettings } from "./autotrack.js";
import { platform } from "./platform/index.js";
import type { ThemeMode } from "./settings-util.js";
import { el, button } from "./ui.js";
import { ICON_FOLDER } from "./icons.js";
import { block, labeledRow, panelHeader, segmented, toggleSwitch } from "./settings-controls.js";
import {
  type Timecode,
  AUTOSAVE_KEY,
  OUTDIR_KEY,
  TIMECODE_KEY,
  loadThemeMode,
  persistThemeMode,
  readStr,
  writeStr,
} from "./settings-store.js";

export function buildGeneralPanel(): HTMLElement {
  const s = messages.settings.general;
  const root = el("div");
  root.append(panelHeader(s.title, s.subtitle));

  // Appearance — theme + timecode
  const appearance = block(s.appearance);
  appearance.body.append(
    labeledRow(
      s.theme,
      segmented<ThemeMode>(
        [
          { value: "light", label: s.themeLight },
          { value: "dark", label: s.themeDark },
          { value: "system", label: s.themeSystem },
        ],
        loadThemeMode(),
        (v) => persistThemeMode(v),
      ),
    ),
    labeledRow(
      s.timecode,
      segmented<Timecode>(
        [
          { value: "smpte", label: "MM:SS.mmm" },
          { value: "frames", label: s.timecodeFrames },
        ],
        readStr(TIMECODE_KEY, "smpte") === "frames" ? "frames" : "smpte",
        (v) => writeStr(TIMECODE_KEY, v),
      ),
    ),
  );
  root.append(appearance.root);

  // Defaults — destination + tracking interval
  const defaults = block(s.defaults);

  const destField = el("div", "fl-field path");
  destField.style.flex = "1";
  destField.innerHTML = `<span class="ic">${ICON_FOLDER}</span>`;
  const destInput = document.createElement("input");
  destInput.type = "text";
  destInput.className = "mono";
  destInput.value = readStr(OUTDIR_KEY, "clips");
  destInput.addEventListener("change", () =>
    writeStr(OUTDIR_KEY, destInput.value.trim() || "clips"),
  );
  destField.append(destInput);
  const browse = button(s.destinationBrowse, "fl-btn sm", () => {
    void platform.pickDirectory().then((dir) => {
      if (dir) {
        destInput.value = dir;
        writeStr(OUTDIR_KEY, dir);
      }
    });
  });
  if (!platform.supportsFilePicker) browse.disabled = true;
  const destRow = labeledRow(s.destination, destField, browse);
  const destHint = el("div", "fl-rowhint");
  destHint.style.cssText = "font-family:inherit; width:100%; color:var(--faint); margin-top:2px;";
  destHint.textContent = s.destinationHint;

  const at = loadAutoTrackSettings();
  const intervalRow = labeledRow(
    s.trackingInterval,
    segmented<string>(
      [
        { value: "0.5", label: "0.50s" },
        { value: "0.75", label: "0.75s" },
        { value: "1", label: "1.00s" },
        { value: "1.5", label: "1.50s" },
      ],
      String(at.intervalSec),
      (v) => saveAutoTrackSettings({ ...loadAutoTrackSettings(), intervalSec: Number(v) }),
    ),
  );
  const intervalHint = el("div", "fl-rowhint");
  intervalHint.style.cssText =
    "font-family:inherit; width:100%; color:var(--faint); margin-top:2px;";
  intervalHint.textContent = s.trackingIntervalHint;

  defaults.body.append(destRow, destHint, intervalRow, intervalHint);
  root.append(defaults.root);

  // Session — autosave + clear
  const session = block(s.session);
  const autosaveOn = readStr(AUTOSAVE_KEY, "on") !== "off";
  const autosaveRow = el("div", "fl-adv-toggle");
  autosaveRow.style.cursor = "default";
  const autosaveBody = el("div");
  autosaveBody.style.flex = "1";
  const autosaveTitle = el("div", "fl-adv-title");
  autosaveTitle.textContent = s.autosave;
  const autosaveSub = el("div", "fl-adv-sub");
  autosaveSub.textContent = s.autosaveHint;
  const sw = toggleSwitch(
    autosaveOn,
    (v) => writeStr(AUTOSAVE_KEY, v ? "on" : "off"),
    autosaveTitle,
    autosaveSub,
  );
  autosaveBody.append(autosaveTitle, autosaveSub);
  autosaveRow.append(autosaveBody, sw);

  const clearWrap = el("div");
  clearWrap.style.marginTop = "11px";
  const clearBtn = button(s.clearSession, "fl-btn sm ghost danger", () => {
    void platform
      .saveSession({ source: "", outdir: "", clips: [], savedAt: Date.now() })
      .catch(() => undefined);
    clearBtn.textContent = s.sessionCleared;
    clearBtn.disabled = true;
  });
  clearWrap.append(clearBtn);

  session.body.append(autosaveRow, clearWrap);
  root.append(session.root);

  return root;
}
