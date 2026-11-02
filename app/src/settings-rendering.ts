// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings → Rendering (#270): maps 1:1 to `--crf/--preset/--audio-bitrate/--dry-run`
 * plus the burn-captions opt-in and the custom fonts folder.
 */

import { messages } from "./i18n/index.js";
import { platform } from "./platform/index.js";
import { el, button } from "./ui.js";
import {
  ICON_FOLDER,
  block,
  labeledRow,
  panelHeader,
  segmented,
  toggleSwitch,
} from "./settings-controls.js";
import {
  type AudioMode,
  type RenderPrefs,
  DEFAULT_RENDER,
  FONTS_DIR_KEY,
  PRESETS,
  RENDER_KEY,
  readJson,
  readStr,
  writeJson,
  writeStr,
} from "./settings-store.js";

export function buildRenderingPanel(): HTMLElement {
  const s = messages.settings.rendering;
  const prefs = readJson<RenderPrefs>(RENDER_KEY, DEFAULT_RENDER);
  const save = () => writeJson(RENDER_KEY, prefs);

  const root = el("div");
  root.append(panelHeader(s.title, s.subtitle));

  // Quality (CRF) range
  const qualityBlock = block(s.quality);
  const range = document.createElement("input");
  range.type = "range";
  range.className = "fl-range";
  range.min = "14";
  range.max = "28";
  range.step = "1";
  range.value = String(prefs.crf);
  const ends = el("div", "fl-range-ends");
  const readout = el("span");
  const qualityWord = (crf: number): string =>
    crf <= 17
      ? s.qualityNearLossless
      : crf <= 20
        ? s.qualityHigh
        : crf <= 23
          ? s.qualityGood
          : s.qualitySmaller;
  const paintReadout = () => {
    readout.textContent = `CRF ${prefs.crf} · ${qualityWord(prefs.crf)}`;
  };
  const left = el("span");
  left.textContent = s.crfEndBest;
  const right = el("span");
  right.textContent = s.crfEndSmall;
  ends.append(left, readout, right);
  paintReadout();
  range.addEventListener("input", () => {
    prefs.crf = Number(range.value);
    paintReadout();
    save();
  });
  qualityBlock.body.append(range, ends);
  root.append(qualityBlock.root);

  // Encoder preset chips
  const presetBlock = block(s.preset);
  const presetRow = el("div", "fl-preset-row");
  for (const p of PRESETS) {
    const chip = button(p, p === prefs.preset ? "fl-preset on" : "fl-preset", () => {
      for (const c of Array.from(presetRow.children)) c.classList.remove("on");
      chip.classList.add("on");
      prefs.preset = p;
      save();
    });
    presetRow.append(chip);
  }
  const presetHint = el("div", "fl-set-secsub");
  presetHint.style.marginTop = "10px";
  presetHint.textContent = s.presetHint;
  presetBlock.body.append(presetRow, presetHint);
  root.append(presetBlock.root);

  // Audio
  const audioBlock = block(s.audio);
  const audioHint = el("div", "fl-set-secsub");
  audioHint.style.marginTop = "10px";
  const bitrateWrap = el("div", "fl-row2");
  bitrateWrap.style.marginTop = "12px";
  const bitrateLab = el("span", "fl-rowlab");
  bitrateLab.textContent = s.bitrate;
  const bitrateSeg = segmented<string>(
    [
      { value: "192k", label: "192k" },
      { value: "256k", label: "256k" },
      { value: "320k", label: "320k" },
    ],
    prefs.bitrate,
    (v) => {
      prefs.bitrate = v;
      save();
    },
  );
  bitrateWrap.append(bitrateLab, bitrateSeg);
  const syncAudioUi = () => {
    audioHint.textContent = prefs.audio === "copy" ? s.audioCopyHint : s.audioReencodeHint;
    bitrateWrap.style.display = prefs.audio === "reencode" ? "flex" : "none";
  };
  const audioSeg = segmented<AudioMode>(
    [
      { value: "copy", label: s.audioCopy },
      { value: "reencode", label: s.audioReencode },
    ],
    prefs.audio,
    (v) => {
      prefs.audio = v;
      syncAudioUi();
      save();
    },
  );
  syncAudioUi();
  audioBlock.body.append(audioSeg, audioHint, bitrateWrap);
  root.append(audioBlock.root);

  // Dry-run switch
  const dryBlock = block(s.dryRun);
  const dryToggle = el("div", "fl-adv-toggle");
  dryToggle.style.cursor = "default";
  const dryBody = el("div");
  dryBody.style.flex = "1";
  const dryTitle = el("div", "fl-adv-title");
  dryTitle.textContent = s.dryRun;
  const drySub = el("div", "fl-adv-sub");
  drySub.textContent = s.dryRunHint;
  dryBody.append(dryTitle, drySub);
  dryToggle.append(
    dryBody,
    toggleSwitch(
      prefs.dryRun,
      (v) => {
        prefs.dryRun = v;
        save();
      },
      dryTitle,
      drySub,
    ),
  );
  dryBlock.body.append(dryToggle);
  root.append(dryBlock.root);

  // Captions — global opt-in (off by default) + bring-your-own font
  const capBlock = block(s.captions);

  const capToggle = el("div", "fl-adv-toggle");
  capToggle.style.cursor = "default";
  const capBody = el("div");
  capBody.style.flex = "1";
  const capTitle = el("div", "fl-adv-title");
  capTitle.textContent = s.burnCaptions;
  const capSub = el("div", "fl-adv-sub");
  capSub.textContent = s.burnCaptionsHint;
  capBody.append(capTitle, capSub);
  capToggle.append(
    capBody,
    toggleSwitch(
      prefs.burnCaptions,
      (v) => {
        prefs.burnCaptions = v;
        save();
      },
      capTitle,
      capSub,
    ),
  );

  // --- Fonts folder: a typed path (web) / Browse… (Tauri) bound to its own
  // plain-string key (footlight.fontsDir). Fonts dropped here are offered in the
  // editor's per-clip caption font picker — caption styling itself is per-clip
  // and lives in the editor, not in Settings.
  const fontsDirField = el("div", "fl-field path");
  fontsDirField.style.flex = "1";
  fontsDirField.innerHTML = `<span class="ic">${ICON_FOLDER}</span>`;
  const fontsDirInput = document.createElement("input");
  fontsDirInput.type = "text";
  fontsDirInput.className = "mono";
  fontsDirInput.placeholder = s.fontsDirPlaceholder;
  fontsDirInput.value = readStr(FONTS_DIR_KEY, "");
  fontsDirField.append(fontsDirInput);
  const fontsDirBrowse = button(s.fontsDirBrowse, "fl-btn sm", () => {
    void platform.pickDirectory().then((dir) => {
      if (dir) {
        fontsDirInput.value = dir;
        writeStr(FONTS_DIR_KEY, dir);
      }
    });
  });
  if (!platform.supportsFilePicker) fontsDirBrowse.disabled = true;
  const fontsDirRow = labeledRow(s.fontsDir, fontsDirField, fontsDirBrowse);
  fontsDirInput.addEventListener("change", () => {
    writeStr(FONTS_DIR_KEY, fontsDirInput.value.trim());
  });
  const fontsDirHint = el("div", "fl-rowhint");
  fontsDirHint.style.cssText =
    "font-family:inherit; width:100%; color:var(--faint); margin-top:2px;";
  fontsDirHint.textContent = s.fontsDirHint;

  capBlock.body.append(capToggle, fontsDirRow, fontsDirHint);
  root.append(capBlock.root);

  return root;
}
