// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The single-clip cutter editor. All UI is built imperatively (no framework)
 * and talks to the backend only through `platform`. The interesting pieces:
 *
 *  - Frame viewer: each displayed frame is fetched fresh from the backend via
 *    ffmpeg INPUT-seek (-ss before -i) — that per-frame seek is where frame
 *    accuracy comes from. Scrubbing (via the loudness timeline, the app's single
 *    scrubber) is debounced so dragging does not spawn an ffmpeg per value.
 *  - 9:16 crop box: an aspect-locked rectangle drawn on a canvas over the
 *    frame, full-height by default for landscape, draggable horizontally. The
 *    box is read back to a `crop_offset` via the pure `cropBoxToOffset`.
 *  - Content-crop mode: a freely-resizable box marking the real content region
 *    (to strip letter/pillarbox), read back via `contentCropFromBox`.
 *  - Crop keyframes: capture (t, offset) pairs; `scheduleToString` turns them
 *    into the engine's moving-crop schedule string.
 *  - Manifest: assembled `ClipRow`s are serialized with `serializeManifestCSV`
 *    and rendered through `platform.render`.
 */

import {
  TARGET_AR,
  detectSwells,
  detectOnsets,
  coverOutName,
  easedCropWindowAt,
  LOUDNESS_BUCKETS,
} from "@core";
import {
  cropBoxToOffset,
  cropBoxToWindow,
  contentCropFromBox,
  scheduleToString,
  serializeManifestJSON,
  specToEditorState,
  type Box,
  type Dims,
  type ClipSpec,
} from "@manifest";
import { planSampleTimes, samplesToCropPath } from "@track";
import { resolveModels } from "@model";
import type {
  AssistantReply,
  ProposedAction,
  GhostPreview,
  CommitOp,
  Grounding,
  Usage,
} from "@assistant-types";
import { platform, platformName } from "./platform/index.js";
import { openGuide } from "./help.js";
import { messages } from "./i18n/index.js";

/** The editor's localized strings (the `editor` namespace of the catalog). */
const m = messages.editor;

import type { HistoryEntry, SessionData } from "./platform/types.js";
import { createAssistant, type ConversationMessage } from "./assistant/index.js";
import { openSettings, initTheme, loadAssistantOverlay, loadChatStillsBudget } from "./settings.js";
import { BASE_PROMPT } from "./assistant/base-prompt.js";
import { openShortcuts } from "./shortcuts.js";
import {
  loadAutoTrackSettings,
  saveAutoTrackSettings,
  migrateLegacyApiKey,
  GEMINI_API_KEY_SECRET,
  type AutoTrackSettings,
} from "./autotrack.js";
import {
  captionStyleToSpec,
  captionStyleFromSpec,
  parseTextPosition,
  joinTextPosition,
  clamp,
  round3,
  roundEvenLocal,
  shorten,
  fmtClock,
  errMsg,
  safeParse,
  escapeHtml,
  type TextPosV,
  type TextPosH,
} from "./editor-util.js";
import {
  edgeHits,
  insideBox,
  resizeCrop,
  fullHeightCropBox,
  parseContentCropPx,
  cropRegionRect as regionRectPure,
  cropWindowSpec as cropWindowSpecPure,
} from "./editor-crop.js";
import {
  currentRegion as currentRegionPure,
  offsetForBox,
  trackedBoxXAt,
} from "./editor-offset.js";
import { assembleAssistantContext, sampleChatStills } from "./editor-chat-context.js";
import { applyCommitToState } from "./editor-commit.js";
import {
  parseFadeField,
  fadesToSpec,
  fadesFromSpec,
  fadesFit,
  loopSeamTimes,
} from "./editor-fades.js";
import { boxToRegionWindow, pushKeyframes, pushPreviewBox, describePush } from "./editor-push.js";
import { createEditorStore, hasActiveTrack, clipLength, type EditorState } from "./editor-store.js";
import { el, input, textarea, autosize, button, sectionHeader } from "./ui.js";
import {
  ICON_ACTIVITY,
  ICON_BRAND,
  ICON_CHECK,
  ICON_COPY,
  ICON_DOWN,
  ICON_FOLDER,
  ICON_GEAR,
  ICON_HISTORY,
  ICON_MOON,
  ICON_NEXT_CUT,
  ICON_PHONE,
  ICON_PLUS,
  ICON_PREV_CUT,
  ICON_SEND,
  ICON_SPARK,
  ICON_SUN,
  ICON_X,
  PAUSE_GLYPH,
  PLAY_GLYPH,
} from "./icons.js";
import { openHistoryModal } from "./views/history.js";
import {
  assistantSelection,
  renderOptions,
  loadOutdir,
  saveOutdir,
  loadPreviewPref,
  savePreviewPref,
  loadSnapPref,
  saveSnapPref,
  loadRecents,
  pushRecent,
  saveTheme,
} from "./editor-prefs.js";
import { snapToOnset } from "./editor-snap.js";
import { clipDur, fmtUsd, ghostsFrom } from "./editor-format.js";
import { layoutPreviewCaptions, type PreviewCaptionLine } from "./editor-caption-preview.js";

export function mountEditor(root: HTMLElement): void {
  // The EditorStore (#125 Phase 3): `state` stays directly readable everywhere;
  // migrated clusters WRITE through `store.set`, and renders subscribe to the
  // changes instead of being invoked by hand at every mutation site.
  const store = createEditorStore();
  const state = store.state;

  const autoTrack: AutoTrackSettings = loadAutoTrackSettings();
  // The BYOK Gemini key lives in the OS keychain (via `secretStore`), not in the
  // auto-track blob. Read LAZILY on first AI use (see `ensureApiKey`) — never at
  // launch — so the native app doesn't prompt for keychain access unless you
  // actually use the assistant / Auto-track.
  let apiKey = "";

  root.innerHTML = "";
  // Resolve light/dark/System and install the live OS listener (handles a
  // persisted "system" theme correctly on boot — the top-bar toggle below is a
  // quick light<->dark override).
  initTheme();

  // Whether the live 9:16 output preview is shown (persisted, default on).
  let previewOn = loadPreviewPref();

  const appEl = el("div", "fl-app");

  // ===== top bar =====
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
  const renderBtn = button(m.topbar.render, "fl-btn primary", doRender);
  renderBtn.title = m.topbar.renderTitle;
  const activityToggle = button("", "fl-iconbtn", () => {
    if (isTauri) void toggleNativeActivity();
    else setActivityOpen(activityPanel.hidden);
  });
  activityToggle.innerHTML = ICON_ACTIVITY;
  activityToggle.title = m.topbar.activityTitle;
  const historyBtn = button("", "fl-iconbtn", () => void openHistory());
  historyBtn.innerHTML = ICON_HISTORY;
  historyBtn.title = m.topbar.historyTitle;
  const clearBtn = button(m.topbar.clear, "fl-btn sm ghost", () => confirmClear());
  clearBtn.title = m.topbar.clearTitle;
  const previewBtn = button("", "fl-iconbtn", () => togglePreview());
  previewBtn.innerHTML = ICON_PHONE;
  function togglePreview(): void {
    previewOn = !previewOn;
    savePreviewPref(previewOn);
    previewBtn.classList.toggle("on", previewOn);
    previewBtn.title = previewOn ? m.topbar.previewHide : m.topbar.previewShow;
    drawPreview();
  }
  previewBtn.classList.toggle("on", previewOn);
  previewBtn.title = previewOn ? m.topbar.previewHide : m.topbar.previewShow;
  // Spark toggles the AI assistant dock — a third rail mode that slides over the
  // Frame / Track-subject inspector (SPEC §6.7). Active state mirrors `.on`.
  const assistantBtn = button("", "fl-iconbtn assistant", () => toggleAssistant());
  assistantBtn.innerHTML = ICON_SPARK;
  assistantBtn.title = m.topbar.assistantTitle;
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
    void pushTheme(); // keep the separate Activity window's theme in sync
  }
  refreshThemeIcon();

  // ===== main: viewer + inspector =====
  const main = el("div", "fl-main");

  // ----- viewer column -----
  const viewer = el("div", "fl-viewer");
  const stage = el("div", "fl-stage empty");
  const stageMeta = el("div", "fl-stage-meta");
  const stageTag = el("span", "fl-stage-tag rec");
  stageTag.textContent = m.stage.sourceTag;
  const stageTimeTag = el("span", "fl-stage-tag");
  stageTimeTag.textContent = "t = 0.000s";
  stageMeta.append(stageTag, stageTimeTag);
  // First-launch onboarding (issue #46): breathing lamp + headline/sub, a 9:16
  // dashed drop target (which literally previews the output shape), the workflow
  // ghost row, and a guide link. Static markup is built as innerHTML (the SVGs make
  // pure-DOM tedious); the interactive bits are queried back out and wired below.
  const emptyMsg = el("div", "fl-stage-center");
  // On the web build there's no native picker or drag-and-drop — the path field is
  // the primary affordance there, so soften the "drag" line and lead with paste.
  const canDrop = platform.supportsFilePicker;
  emptyMsg.innerHTML =
    `<div class="fl-onboard">` +
    `<div class="fl-lamp-wrap" aria-hidden="true">` +
    `<div class="fl-lamp-halo"></div>` +
    ICON_BRAND +
    `</div>` +
    `<div class="fl-hero-h">${escapeHtml(m.stage.heroH)}</div>` +
    `<div class="fl-hero-sub">${escapeHtml(m.stage.heroSub)}</div>` +
    `<div class="fl-drop">` +
    `<span class="fl-drop-ratio mono">${escapeHtml(m.stage.dropRatio)}</span>` +
    `<span class="fl-drop-glyph" aria-hidden="true">${ICON_DOWN}</span>` +
    (canDrop
      ? `<div class="fl-drop-cta fl-drop-cta-rest">${escapeHtml(m.stage.dropTitle)}</div>` +
        `<div class="fl-drop-cta fl-drop-cta-drag">${escapeHtml(m.stage.dropTitleActive)}</div>`
      : "") +
    `<button type="button" class="fl-drop-browse">${escapeHtml(m.source.browse)}</button>` +
    `<button type="button" class="fl-drop-paste mono">${escapeHtml(m.stage.pasteHint)}</button>` +
    `</div>` +
    `<div class="fl-flow">` +
    `<div class="fl-flow-step"><span class="fl-flow-n mono">01</span><span class="fl-flow-lbl">${escapeHtml(m.stage.flowMark)}</span></div>` +
    `<div class="fl-flow-step"><span class="fl-flow-n mono">02</span><span class="fl-flow-lbl">${escapeHtml(m.stage.flowFrame)}</span></div>` +
    `<div class="fl-flow-step"><span class="fl-flow-n mono">03</span><span class="fl-flow-lbl">${escapeHtml(m.stage.flowQueue)}</span></div>` +
    `<div class="fl-flow-step"><span class="fl-flow-n mono">04</span><span class="fl-flow-lbl">${escapeHtml(m.stage.flowRender)}</span></div>` +
    `</div>` +
    `<div class="fl-guide"><a href="#" class="fl-guide-link">${escapeHtml(m.stage.guide)}</a></div>` +
    `</div>`;
  // Wire the interactive bits to the existing handlers (reuse, don't rebuild).
  emptyMsg.querySelector(".fl-drop-browse")?.addEventListener("click", () => void browse());
  emptyMsg.querySelector(".fl-drop-paste")?.addEventListener("click", () => {
    srcInput.focus();
    srcInput.scrollIntoView({ block: "nearest" });
  });
  emptyMsg.querySelector(".fl-guide-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    openGuide();
  });
  const img = document.createElement("img");
  img.id = "frame";
  img.alt = m.stage.frameAlt;
  img.style.display = "none";
  const video = document.createElement("video");
  video.id = "preview-video";
  video.style.display = "none";
  video.preload = "metadata";
  video.playsInline = true;
  const overlay = document.createElement("canvas");
  overlay.id = "overlay";
  overlay.style.display = "none";
  overlay.title = m.stage.overlayTitle;
  // Live 9:16 output preview — the actual vertical result (cropped + scaled, with
  // the moving-crop/track applied), pinned bottom-right of the stage.
  const preview = el("div", "fl-preview empty");
  const previewCanvas = document.createElement("canvas");
  previewCanvas.className = "fl-preview-canvas";
  previewCanvas.width = 144;
  previewCanvas.height = 256; // 9:16 internal buffer; redrawn from the source frame
  // A header strip is the ONLY interactive part — it's the drag handle and holds
  // the zoom tag + guides toggle. The panel body (the canvas) is pointer-transparent
  // so crop-box drags/resizes underneath it still work (the preview floats above
  // the overlay). Tag shows live zoom (1.0× full-frame, >1× punched in); the output
  // is always 9:16, so labelling that is noise.
  const previewHead = el("div", "fl-preview-head");
  previewHead.title = m.stage.previewHeadTitle;
  const previewTag = el("span", "fl-preview-tag mono");
  previewTag.textContent = "1.0×";
  let safeAreas = false;
  const safeToggle = button(m.stage.guides, "fl-preview-safe", () => {
    safeAreas = !safeAreas;
    safeToggle.classList.toggle("on", safeAreas);
    drawPreview();
  });
  safeToggle.title = m.stage.guidesTitle;
  previewHead.append(previewTag, safeToggle);
  preview.append(previewCanvas, previewHead);
  stage.append(stageMeta, emptyMsg, img, video, overlay, preview);

  // Drag the preview by its header to any corner so it never occludes what you're
  // framing (clamped inside the stage bounds).
  {
    let dragging = false;
    let offX = 0;
    let offY = 0;
    previewHead.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".fl-preview-safe")) return; // let the toggle work
      const pr = preview.getBoundingClientRect();
      offX = e.clientX - pr.left;
      offY = e.clientY - pr.top;
      dragging = true;
      previewHead.setPointerCapture(e.pointerId);
      preview.classList.add("dragging");
    });
    previewHead.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const sr = stage.getBoundingClientRect();
      const pr = preview.getBoundingClientRect();
      preview.style.left = `${clamp(e.clientX - sr.left - offX, 6, Math.max(6, sr.width - pr.width - 6))}px`;
      preview.style.top = `${clamp(e.clientY - sr.top - offY, 6, Math.max(6, sr.height - pr.height - 6))}px`;
      preview.style.right = "auto";
      preview.style.bottom = "auto";
    });
    const endPreviewDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      previewHead.releasePointerCapture(e.pointerId);
      preview.classList.remove("dragging");
    };
    previewHead.addEventListener("pointerup", endPreviewDrag);
    previewHead.addEventListener("pointercancel", endPreviewDrag);
  }

  // Transport: a single centered jog cluster (the ONLY play button in the app),
  // in→out chip far-left, timecode far-right. No scrub bar — the loudness timeline
  // below is the single scrubber.
  const transport = el("div", "fl-transport");
  const playBtn = button("", "fl-play", () => void togglePlay());
  playBtn.innerHTML = PLAY_GLYPH;
  playBtn.title = m.transport.playTitle;
  playBtn.disabled = true;
  const mkStep = (label: string, delta: () => number) =>
    button(label, "fl-step", () => seek(state.t + delta()));
  const stepsLeft = el("div", "fl-steps");
  stepsLeft.append(
    mkStep("⟨ −1s", () => -1),
    mkStep("−0.1", () => -0.1),
    mkStep("−1f", () => -1 / state.fps),
  );
  const stepsRight = el("div", "fl-steps");
  stepsRight.append(
    mkStep("+1f", () => 1 / state.fps),
    mkStep("+0.1", () => 0.1),
    mkStep("+1s ⟩", () => 1),
  );
  const jog = el("div", "fl-jog");
  jog.append(stepsLeft, playBtn, stepsRight);

  const ioChip = el("div", "fl-rdchip");
  ioChip.innerHTML = `<span class="lab">${escapeHtml(m.transport.inOut)}</span><span class="val">${escapeHtml(m.common.dash)}</span>`;
  const tpLeft = el("div", "fl-tp-side");
  tpLeft.append(ioChip);
  const tLabel = el("div", "fl-time tnum");
  tLabel.textContent = "0.000s";
  const tpRight = el("div", "fl-tp-side end");
  tpRight.append(tLabel);
  transport.append(tpLeft, jog, tpRight);
  viewer.append(stage, transport);

  // ----- inspector column -----
  const inspector = el("div", "fl-inspector");
  const seg = el("div", "fl-seg");
  seg.style.margin = "16px 16px 4px";
  const frameTab = button(m.tabs.frame, undefined, () => selectTab("frame"));
  const trackTab = button("", undefined, () => selectTab("track"));
  trackTab.textContent = m.tabs.track;
  seg.append(frameTab, trackTab);

  // -- Frame tab --
  const framePane = el("div");

  const srcSect = el("div", "fl-sect");
  srcSect.append(sectionHeader(m.source.header));
  const srcStack = el("div", "fl-stack");
  const srcInput = input("text", m.source.sourcePlaceholder);
  srcInput.classList.add("mono");
  srcInput.title = m.source.sourceTitle;
  // Recent sources as a native autocomplete on the path field.
  const recentsList = document.createElement("datalist");
  recentsList.id = "fl-recents";
  srcInput.setAttribute("list", "fl-recents");
  function refreshRecents(): void {
    recentsList.innerHTML = "";
    for (const p of loadRecents()) {
      const opt = document.createElement("option");
      opt.value = p;
      recentsList.append(opt);
    }
  }
  const loadBtn = button(m.source.load, "fl-btn sm", () => void load());
  const srcField = el("div", "fl-field path");
  srcField.innerHTML = `<span class="ic">${ICON_FOLDER}</span>`;
  srcField.append(srcInput, recentsList);
  const srcRow = el("div", "fl-rowg");
  srcRow.append(srcField);
  if (platform.supportsFilePicker) {
    const browseBtn = button(m.source.browse, "fl-btn sm", () => void browse());
    browseBtn.style.flex = "none";
    srcRow.append(browseBtn);
  } else {
    loadBtn.style.flex = "none";
    srcRow.append(loadBtn);
  }
  const dimsLine = el("div", "hint");
  dimsLine.textContent = m.source.notLoaded;
  const cropdetectLine = el("div", "hint");
  const outdirInput = input("text", m.source.destPlaceholder);
  outdirInput.classList.add("mono");
  outdirInput.value = loadOutdir();
  outdirInput.title = m.source.destTitle;
  outdirInput.addEventListener("change", () => {
    saveOutdir(outdirInput.value);
    saveSessionSoon();
  });
  // Seed the platform default on a fresh install (no persisted/typed choice yet):
  // the native app fills a folder in ~/Movies; web shows `clips`. Never clobbers a
  // value the user already has, and the placeholder reflects it either way so an
  // empty field still shows where clips will land (issue #58).
  void platform
    .defaultOutdir()
    .then((d) => {
      if (d) outdirInput.placeholder = d;
      if (!outdirInput.value.trim() && d) outdirInput.value = d;
    })
    .catch(() => {
      /* default lookup failed — the field keeps the `clips` fallback. */
    });
  const destField = el("div", "fl-field path");
  destField.innerHTML = `<span class="ic">${ICON_DOWN}</span>`;
  destField.append(outdirInput);
  const destRow = el("div", "fl-rowg");
  destRow.append(destField);
  if (platform.supportsFilePicker) {
    const browseDest = button(m.source.browse, "fl-btn sm", () => void browseOutdir());
    browseDest.style.flex = "none";
    destRow.append(browseDest);
  }
  srcStack.append(srcRow, dimsLine, cropdetectLine, destRow);
  srcSect.append(srcStack);

  const clipSect = el("div", "fl-sect");
  clipSect.append(sectionHeader(m.clip.header));
  const ioRow = el("div", "fl-rowg");
  ioRow.style.marginBottom = "12px";
  // Marking In/Out (button or I/O key) goes through `snapT`: with the timeline's
  // onset-snap toggle ON the point magnetizes to the nearest detected onset
  // (±150 ms); OFF (the default) it is the identity — the point stays exactly
  // where the user put it.
  const setInBtn = button("", "fl-btn", () => {
    store.set({ inPoint: snapT(state.t) });
  });
  setInBtn.innerHTML = `<span class="idot in"></span>${escapeHtml(m.clip.setIn)}`;
  setInBtn.title = m.clip.setInTitle;
  const setOutBtn = button("", "fl-btn", () => {
    store.set({ outPoint: snapT(state.t) });
  });
  setOutBtn.innerHTML = `<span class="idot out"></span>${escapeHtml(m.clip.setOut)}`;
  setOutBtn.title = m.clip.setOutTitle;
  ioRow.append(setInBtn, setOutBtn);
  // 2×2 readout grid so the second column aligns:  in | out  /  dur | offset
  const kSpan = (t: string): HTMLElement => {
    const s = el("span", "k");
    s.textContent = t;
    return s;
  };
  const dotSpan = (c: string): HTMLElement => el("span", `idot ${c}`);
  const readCell = (...kids: HTMLElement[]): HTMLElement => {
    const d = el("div");
    d.append(...kids);
    return d;
  };
  const inVal = el("span", "v");
  inVal.textContent = "—";
  const outVal = el("span", "v");
  outVal.textContent = "—";
  const durVal = el("span", "v accent");
  durVal.textContent = "—";
  const offsetVal = el("span", "v");
  offsetVal.textContent = "—";
  const ioGrid = el("div", "fl-readgrid");
  ioGrid.append(
    readCell(dotSpan("in"), kSpan(m.clip.inKey), inVal),
    readCell(dotSpan("out"), kSpan(m.clip.outKey), outVal),
    readCell(dotSpan("dur"), kSpan(m.clip.durKey), durVal),
    readCell(kSpan(m.clip.offsetKey), offsetVal),
  );
  clipSect.append(ioRow, ioGrid);

  // Per-clip fades (#165): two small numeric fields. A fade forces that clip's
  // audio to re-encode (an afade can't ride `-c:a copy`), so the hint shows
  // whenever any fade is set.
  const fadeRow = el("div", "fl-rowg");
  fadeRow.style.marginTop = "8px";
  const mkFadeInput = (
    label: string,
    title: string,
    set: (v: number) => void,
  ): HTMLInputElement => {
    const lab = el("span", "fl-rowlab");
    lab.textContent = label;
    const inp = input("number", "0");
    inp.title = title;
    inp.min = "0";
    inp.step = "0.1";
    inp.classList.add("mono");
    inp.style.maxWidth = "70px";
    inp.addEventListener("input", () => {
      set(parseFadeField(inp.value)); // the fade hint renders via subscription
    });
    fadeRow.append(lab, inp);
    return inp;
  };
  const fadeInInput = mkFadeInput(
    m.clip.fadeInLabel,
    m.clip.fadeInTitle,
    (v) => store.set({ fadeIn: v }),
  );
  const fadeOutInput = mkFadeInput(
    m.clip.fadeOutLabel,
    m.clip.fadeOutTitle,
    (v) => store.set({ fadeOut: v }),
  );
  const fadeHint = el("div", "hint");
  fadeHint.textContent = m.clip.fadeAudioHint;
  fadeHint.style.display = "none";
  function refreshFadeHint(): void {
    fadeHint.style.display = state.fadeIn > 0 || state.fadeOut > 0 ? "" : "none";
  }

  // Loop-seam check (#165): the clip's LAST frame next to its In frame — the
  // exact join the viewer sees when the clip loops (last → first).
  const seamPanel = el("div", "fl-loopseam");
  seamPanel.style.cssText = "display:none; gap:6px; margin-top:8px;";
  const mkSeamCell = (label: string): { wrap: HTMLElement; img: HTMLImageElement } => {
    const wrap = el("div");
    wrap.style.cssText = "flex:1; min-width:0;";
    const img = document.createElement("img");
    img.alt = label;
    img.style.cssText = "width:100%; display:block; border-radius:4px;";
    const cap = el("div", "hint");
    cap.textContent = label;
    wrap.append(img, cap);
    return { wrap, img };
  };
  const seamOut = mkSeamCell(m.clip.loopSeamOutLabel);
  const seamIn = mkSeamCell(m.clip.loopSeamInLabel);
  seamPanel.append(seamOut.wrap, seamIn.wrap); // out first — the loop reads out → in
  let seamOpen = false;
  const seamBtn = button(m.clip.loopSeam, "fl-btn sm ghost", () => {
    seamOpen = !seamOpen;
    seamBtn.classList.toggle("primary", seamOpen);
    seamPanel.style.display = seamOpen ? "flex" : "none";
    void refreshLoopSeam();
  });
  seamBtn.title = m.clip.loopSeamTitle;
  async function refreshLoopSeam(): Promise<void> {
    if (!seamOpen || !state.source || state.inPoint == null || state.outPoint == null) return;
    const { inT, outT } = loopSeamTimes(state.inPoint, state.outPoint, state.fps);
    try {
      const [outUrl, inUrl] = await Promise.all([
        extractCached(state.source, outT),
        extractCached(state.source, inT),
      ]);
      seamOut.img.src = outUrl;
      seamIn.img.src = inUrl;
    } catch {
      /* best-effort: a failed frame leaves the previous image in place */
    }
  }
  clipSect.append(fadeRow, fadeHint, seamBtn, seamPanel);

  const framingSect = el("div", "fl-sect");
  framingSect.append(sectionHeader(m.framing.header));
  const cropReadout = el("div", "fl-readout");
  cropReadout.textContent = m.framing.loadASource;
  framingSect.append(cropReadout);

  // Animated punch-in ("push", #163): capture the drawn box twice — as the
  // start and end windows — and the render eases between them over the clip.
  const pushRow = el("div", "fl-rowg");
  pushRow.style.marginTop = "8px";
  const pushLab = el("span", "fl-rowlab");
  pushLab.textContent = m.framing.pushLabel;
  const pushReadout = el("span", "hint");
  const capturePushWindow = () =>
    state.cropBox && state.dims
      ? boxToRegionWindow(state.cropBox, contentOrigin(), currentRegion())
      : null;
  function refreshPushReadout(): void {
    pushReadout.textContent = describePush(state.push);
    pushClearBtn.style.display = state.push.start || state.push.end ? "" : "none";
  }
  const pushStartBtn = button(m.framing.pushSetStart, "fl-btn sm ghost", () => {
    const w = capturePushWindow();
    if (!w) return;
    store.set({ push: { ...state.push, start: w } });
  });
  pushStartBtn.title = m.framing.pushSetStartTitle;
  const pushEndBtn = button(m.framing.pushSetEnd, "fl-btn sm ghost", () => {
    const w = capturePushWindow();
    if (!w) return;
    store.set({ push: { ...state.push, end: w } });
  });
  pushEndBtn.title = m.framing.pushSetEndTitle;
  const pushClearBtn = button("✕", "fl-btn sm ghost", () => {
    store.set({ push: { start: null, end: null } });
  });
  pushClearBtn.title = m.framing.pushClearTitle;
  pushRow.append(pushLab, pushStartBtn, pushEndBtn, pushClearBtn, pushReadout);
  framingSect.append(pushRow);
  refreshPushReadout();
  // content-crop omitted from the UI (engine still supports it via the manifest);
  // contentReadout stays so the inert content-crop code paths keep compiling.
  const contentReadout = el("div", "hint");
  contentReadout.textContent = m.framing.contentOff;

  // Captions (SPEC §6.5): shot-list text carried in the manifest (hook/title/
  // text_position). It is stored regardless of whether burn-in is enabled in
  // Settings → Rendering; the engine's drawtext is the authoritative render.
  const capSect = el("div", "fl-sect");
  capSect.append(sectionHeader(m.captions.header));
  const hookField = el("div", "fl-field");
  hookField.style.marginBottom = "8px";
  const hookInput = textarea(m.captions.hookPlaceholder);
  hookInput.title = m.captions.hookTitle;
  hookInput.addEventListener("input", () => {
    store.set({ hook: hookInput.value }); // the preview renders via subscription
    autosize(hookInput);
  });
  hookField.append(hookInput);
  const titleCapField = el("div", "fl-field");
  titleCapField.style.marginBottom = "8px";
  const titleCapInput = textarea(m.captions.titlePlaceholder);
  titleCapInput.title = m.captions.titleTitle;
  titleCapInput.addEventListener("input", () => {
    store.set({ title: titleCapInput.value });
    autosize(titleCapInput);
  });
  titleCapField.append(titleCapInput);
  // Caption placement on a 9-zone grid: two small selects (vertical × horizontal)
  // combined into one stored `text_position` (`"<v>"` when horizontal is center for
  // back-compat, else `"<v>-<h>"`). The engine maps this to ASS alignment 1–9.
  const posField = el("div", "fl-rowg");
  const posVSelect = document.createElement("select");
  posVSelect.title = m.captions.posVTitle;
  for (const [value, label] of [
    ["top", m.captions.posTop],
    ["center", m.captions.posCenter],
    ["bottom", m.captions.posBottom],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    posVSelect.append(opt);
  }
  const posHSelect = document.createElement("select");
  posHSelect.title = m.captions.posHTitle;
  for (const [value, label] of [
    ["left", m.captions.posLeft],
    ["center", m.captions.posCenter],
    ["right", m.captions.posRight],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    posHSelect.append(opt);
  }
  const syncPosFromSelects = (): void => {
    store.set({
      textPosition: joinTextPosition(posVSelect.value as TextPosV, posHSelect.value as TextPosH),
    });
  };
  const syncSelectsFromPos = (): void => {
    const { v, h } = parseTextPosition(state.textPosition);
    posVSelect.value = v;
    posHSelect.value = h;
  };
  syncSelectsFromPos();
  posVSelect.addEventListener("change", syncPosFromSelects);
  posHSelect.addEventListener("change", syncPosFromSelects);
  posField.append(posVSelect, posHSelect);

  // --- Per-clip caption style (SPEC §6.5) ---------------------------------
  // Font + colour + emphasis + effects + rotation, edited in situ so each clip
  // can look different. The controls bind to `state.caption` (a populated working
  // copy); `addClip` narrows it to a sparse `spec.caption`. The fonts FOLDER stays
  // in Settings — its dir feeds the "Your fonts" group of the picker here.
  const FONTS_DIR_KEY = "footlight.fontsDir";
  const styleWrap = el("div", "fl-cap-style");
  styleWrap.style.cssText = "display:flex; flex-direction:column; gap:8px; margin-top:8px;";

  // Font picker: a CUSTOM dropdown (trigger button + absolutely-positioned popup
  // list) grouped into System default / Your fonts / System fonts / Custom path…
  // A native <select> can't preview faces — browsers and the macOS WKWebView
  // popup render <option>s in the OS UI font and ignore per-option font-family.
  // Here each row sets `li.style.fontFamily` to its own family so it renders in
  // its own typeface. Folder fonts store their FILE PATH (engine resolves family
  // + fontsdir); system fonts store the family NAME; custom reveals a text field.
  //
  // Sentinels for the two non-family rows. A leading space keeps them out of any
  // real family / path namespace (a stored font value is never " default").
  const FONT_DEFAULT = " default";
  const FONT_CUSTOM = " custom";

  // The free-text custom-path field (revealed only by the "Custom path…" row).
  const fontField = el("div", "fl-field");
  fontField.style.marginTop = "2px";
  const fontPathInput = input("text", m.captions.fontPathPlaceholder);
  fontPathInput.classList.add("mono");
  fontField.append(fontPathInput);
  fontField.style.display = "none";
  fontPathInput.addEventListener("input", () => {
    if (selected === FONT_CUSTOM) {
      setCaption("font", fontPathInput.value.trim());
    }
  });

  // The trigger (a .fl-field-styled button) + its popup list.
  const fontRow = el("div", "fl-field");
  fontRow.style.cssText = "position:relative; cursor:pointer; gap:0;";
  const fontTrigger = button("", undefined);
  fontTrigger.type = "button";
  fontTrigger.title = m.captions.fontTitle;
  fontTrigger.setAttribute("aria-haspopup", "listbox");
  fontTrigger.setAttribute("aria-expanded", "false");
  fontTrigger.style.cssText =
    "flex:1; min-width:0; display:flex; align-items:center; justify-content:space-between; gap:9px; background:none; border:none; outline:none; color:var(--text); font:inherit; font-size:13px; padding:0; text-align:left; cursor:pointer;";
  const fontTriggerLabel = el("span");
  fontTriggerLabel.style.cssText =
    "min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
  const fontCaret = el("span");
  fontCaret.textContent = "▾";
  fontCaret.style.cssText = "flex:none; color:var(--faint); font-size:11px;";
  fontTrigger.append(fontTriggerLabel, fontCaret);
  fontRow.append(fontTrigger);

  const fontPopup = el("ul");
  fontPopup.setAttribute("role", "listbox");
  fontPopup.setAttribute("aria-label", m.captions.fontTitle);
  fontPopup.style.cssText =
    "position:absolute; top:calc(100% + 6px); left:0; right:0; z-index:40; margin:0; padding:5px; list-style:none; max-height:260px; overflow-y:auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:var(--shadow); display:none;";
  fontRow.append(fontPopup);

  const closeFontPopup = (): void => {
    fontPopup.style.display = "none";
    fontTrigger.setAttribute("aria-expanded", "false");
  };
  const openFontPopup = (): void => {
    fontPopup.style.display = "block";
    fontTrigger.setAttribute("aria-expanded", "true");
    fontPopup
      .querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  };
  fontTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (fontPopup.style.display === "block") closeFontPopup();
    else openFontPopup();
  });
  // Click-away closes the popup. Esc is handled locally on the picker (a
  // capture-free listener on the trigger/popup) so the global keydown transport
  // handler stays untouched.
  document.addEventListener("click", (e) => {
    if (!fontRow.contains(e.target as Node)) closeFontPopup();
  });
  const onFontEsc = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeFontPopup();
      fontTrigger.focus();
    }
  };
  fontTrigger.addEventListener("keydown", onFontEsc);
  fontPopup.addEventListener("keydown", onFontEsc);

  // An option in the picker. A folder font carries `path` (selection sets
  // caption.font = path so the engine resolves family + fontsdir); a system font
  // has no path (selection sets caption.font = family). `face` is the CSS family
  // for the per-row live preview (best-effort — see the FontFace loading below).
  type FontOpt = { value: string; label: string; face?: string; path?: string };

  let selected = FONT_DEFAULT; // updated by (re)build / restore; the live selection

  // Reflect a selection onto the trigger label (in its own face) + custom-field
  // visibility. Single quotes are stripped so the inline family value can't break
  // out of its quoting. `display` overrides the shown text/face for a value that
  // is a file path (folder fonts) — show the family, never the raw path.
  const syncFontTrigger = (value: string, display?: { label: string; face: string }): void => {
    const custom = value === FONT_CUSTOM;
    fontField.style.display = custom ? "" : "none";
    if (custom) {
      fontTriggerLabel.textContent = m.captions.fontCustomPath;
      fontTriggerLabel.style.fontFamily = "";
    } else if (value === FONT_DEFAULT || value === "") {
      fontTriggerLabel.textContent = m.captions.fontSystemDefault;
      fontTriggerLabel.style.fontFamily = "";
    } else if (display) {
      fontTriggerLabel.textContent = display.label;
      fontTriggerLabel.style.fontFamily = display.face ? `'${display.face.replace(/'/g, "")}'` : "";
    } else {
      fontTriggerLabel.textContent = value;
      fontTriggerLabel.style.fontFamily = `'${value.replace(/'/g, "")}'`;
    }
  };

  const markFontSelected = (value: string): void => {
    for (const li of Array.from(fontPopup.children) as HTMLElement[]) {
      if (li.dataset.value === undefined) continue; // group headers aren't options
      const on = li.dataset.value === value;
      li.setAttribute("aria-selected", String(on));
      li.style.background = on ? "var(--panel-3)" : "";
    }
  };

  const fontGroupHeader = (text: string): HTMLElement => {
    const li = el("li");
    li.setAttribute("role", "presentation");
    li.textContent = text;
    li.style.cssText =
      "padding:8px 10px 4px; font-size:10.5px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; color:var(--faint); cursor:default;";
    return li;
  };

  // Folder fonts aren't installed system-wide, so the OS can't resolve their
  // family by name. Load each from its file (Tauri asset URL) via the FontFace
  // API so its row + the trigger preview in the REAL face; fall back silently to
  // the default face if loading fails (the web dev backend has no local-file URL
  // for arbitrary paths, or the file is malformed). The burn always uses the file
  // path, so a missed preview is purely cosmetic — the row still shows the family.
  const loadedFolderFaces = new Set<string>();
  const loadFolderFontFace = (family: string, path: string): void => {
    if (platformName !== "tauri") return; // no cross-backend local-file URL on web
    const key = `${family}\u0000${path}`;
    if (loadedFolderFaces.has(key)) return;
    loadedFolderFaces.add(key);
    void (async () => {
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const url = convertFileSrc(path);
        const face = new FontFace(family, `url("${url.replace(/"/g, "%22")}")`);
        await face.load();
        (document as Document & { fonts: FontFaceSet }).fonts.add(face);
        // Repaint the trigger if this is the live selection (the row already
        // carries the family, so it picks up the face once it's registered).
        if (selected === path) syncFontTrigger(path, { label: family, face: family });
      } catch {
        loadedFolderFaces.delete(key); // allow a later retry
      }
    })();
  };

  // All real (non-sentinel) options, so a restored clip whose font is a path or a
  // family resolves to the right row instead of falling to "Custom path…".
  let fontOpts: FontOpt[] = [];

  const fontOptionRow = (opt: FontOpt): HTMLElement => {
    const li = el("li");
    li.dataset.value = opt.value;
    li.setAttribute("role", "option");
    li.tabIndex = 0;
    li.textContent = opt.label;
    li.style.cssText =
      "padding:7px 10px; border-radius:7px; cursor:pointer; font-size:13px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
    // Each family row renders in its own face: system fonts resolve by name;
    // folder fonts are loaded via FontFace above (and previewed once ready).
    if (opt.face) li.style.fontFamily = `'${opt.face.replace(/'/g, "")}'`;
    li.addEventListener("mouseenter", () => {
      if (li.getAttribute("aria-selected") !== "true") li.style.background = "var(--panel-2)";
    });
    li.addEventListener("mouseleave", () => {
      if (li.getAttribute("aria-selected") !== "true") li.style.background = "";
    });
    const choose = (): void => {
      selected = opt.value;
      markFontSelected(selected);
      if (opt.value === FONT_DEFAULT) {
        setCaption("font", "");
        fontPathInput.value = "";
      } else if (opt.value === FONT_CUSTOM) {
        // Reveal the free-text field; keep whatever path is already there.
        setCaption("font", fontPathInput.value.trim());
      } else {
        // A folder font sets caption.font = its file path (engine resolves the
        // family + fontsdir); a system font sets caption.font = the family.
        setCaption("font", opt.path ?? opt.value);
      }
      const realFont = opt.value !== FONT_DEFAULT && opt.value !== FONT_CUSTOM;
      syncFontTrigger(
        opt.value === FONT_CUSTOM ? FONT_CUSTOM : state.caption.font || FONT_DEFAULT,
        realFont && opt.path ? { label: opt.label, face: opt.face ?? opt.label } : undefined,
      );
      closeFontPopup();
      if (opt.value === FONT_CUSTOM) fontPathInput.focus();
      else fontTrigger.focus();
    };
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      choose();
    });
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose();
      }
    });
    return li;
  };

  /**
   * Reflect `state.caption.font` onto the trigger + custom field, after a (re)build
   * or on clip restore. "" → default; a value matching a listed option → that
   * option; anything else → Custom path… (the free-text field shows it). Folder
   * fonts store a path, so show their family (and ensure its face is loaded).
   */
  const syncFontSelect = (): void => {
    const f = state.caption.font.trim();
    const hit = f ? fontOpts.find((o) => o.value === f) : undefined;
    if (!f) {
      selected = FONT_DEFAULT;
    } else if (hit) {
      selected = hit.value;
    } else {
      selected = FONT_CUSTOM;
      fontPathInput.value = f;
    }
    markFontSelected(selected);
    if (hit?.path) loadFolderFontFace(hit.label, hit.path);
    syncFontTrigger(
      selected === FONT_CUSTOM ? FONT_CUSTOM : state.caption.font || FONT_DEFAULT,
      hit?.path ? { label: hit.label, face: hit.face ?? hit.label } : undefined,
    );
  };

  // (Re)build the dropdown: scan the fonts folder (if set) into a "Your fonts"
  // group at the top, then list system fonts. Called once on mount and again
  // whenever the fonts-folder changes. Each rebuild supersedes the last (a stale
  // async result is dropped via the token).
  let fontBuildToken = 0;
  async function rebuildFontPicker(): Promise<void> {
    const token = ++fontBuildToken;
    let userFonts: { family: string; path?: string }[] = [];
    let sysFonts: { family: string; path?: string }[] = [];
    try {
      const dir = localStorage.getItem(FONTS_DIR_KEY)?.trim() ?? "";
      if (dir) userFonts = await platform.listUserFonts(dir);
    } catch {
      /* unreadable folder → no "Your fonts" group */
    }
    try {
      sysFonts = await platform.listFonts();
    } catch {
      /* enumeration unavailable → system-default + custom path only */
    }
    if (token !== fontBuildToken) return; // a newer rebuild started — drop this one

    // Folder fonts: keep those with a real family + path; de-dupe by family.
    const userByFamily = new Map<string, { family: string; path: string }>();
    for (const f of userFonts) {
      const fam = f.family.trim();
      if (!fam || !f.path) continue;
      const key = fam.toLowerCase();
      if (!userByFamily.has(key)) userByFamily.set(key, { family: fam, path: f.path });
    }
    const userList = Array.from(userByFamily.values());
    userList.sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: "base" }));
    const userKeys = new Set(userList.map((f) => f.family.toLowerCase()));

    // System families: de-dupe + sort; a folder font that also exists system-wide
    // is dropped here so the file-backed entry wins.
    const sysFamilies = Array.from(
      new Set(sysFonts.map((f) => f.family).filter((f) => f.trim())),
    ).filter((f) => !userKeys.has(f.toLowerCase()));
    sysFamilies.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    const userOpts: FontOpt[] = userList.map((f) => ({
      value: f.path,
      label: f.family,
      face: f.family,
      path: f.path,
    }));
    const sysOpts: FontOpt[] = sysFamilies.map((f) => ({ value: f, label: f, face: f }));
    fontOpts = [...userOpts, ...sysOpts];

    fontPopup.replaceChildren();
    fontPopup.append(fontOptionRow({ value: FONT_DEFAULT, label: m.captions.fontSystemDefault }));
    if (userOpts.length) {
      fontPopup.append(fontGroupHeader(m.captions.fontYourFonts));
      for (const o of userOpts) {
        fontPopup.append(fontOptionRow(o));
        if (o.path) loadFolderFontFace(o.label, o.path); // warm the preview face
      }
    }
    if (sysOpts.length) {
      fontPopup.append(fontGroupHeader(m.captions.fontSystemFonts));
      for (const o of sysOpts) fontPopup.append(fontOptionRow(o));
    }
    fontPopup.append(fontOptionRow({ value: FONT_CUSTOM, label: m.captions.fontCustomPath }));

    syncFontSelect();
  }

  /** A `#RRGGBB` colour control: swatch + live hex label, bound to `bind`. */
  /** Patch ONE field of the per-clip caption style through the store (a fresh
   *  object, so the preview renders via subscription). */
  function setCaption<K extends keyof EditorState["caption"]>(
    key: K,
    value: EditorState["caption"][K],
  ): void {
    store.set({ caption: { ...state.caption, [key]: value } });
  }

  function colorControl(label: string, get: () => string, set: (v: string) => void): HTMLElement {
    const row = el("div", "fl-rowg");
    row.style.cssText = "align-items:center; gap:8px;";
    const lab = el("span", "fl-label");
    lab.style.cssText = "flex:1; font-size:12px;";
    lab.textContent = label;
    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.value = get();
    const hex = el("span", "mono");
    hex.style.cssText = "font-size:12px; color:var(--faint); min-width:62px; text-align:right;";
    hex.textContent = get().toUpperCase();
    swatch.addEventListener("input", () => {
      set(swatch.value);
      hex.textContent = swatch.value.toUpperCase();
    });
    (swatch as HTMLInputElement & { _sync?: () => void })._sync = () => {
      swatch.value = get();
      hex.textContent = get().toUpperCase();
    };
    row.append(lab, swatch, hex);
    return row;
  }
  const fillRow = colorControl(
    m.captions.fill,
    () => state.caption.color,
    (v) => setCaption("color", v),
  );
  const outlineRow = colorControl(
    m.captions.outline,
    () => state.caption.outlineColor,
    (v) => setCaption("outlineColor", v),
  );

  /** A B/I/U-style toggle button bound to a boolean on `state.caption`. */
  function toggleBtn(
    glyph: string,
    css: string,
    title: string,
    get: () => boolean,
    set: (v: boolean) => void,
  ): HTMLButtonElement {
    const b = button(glyph, "fl-btn sm");
    if (css) b.style.cssText = css;
    b.title = title;
    const refresh = () => b.classList.toggle("primary", get());
    b.addEventListener("click", () => {
      set(!get());
      refresh();
    });
    (b as HTMLButtonElement & { _sync?: () => void })._sync = refresh;
    refresh();
    return b;
  }
  const boldBtn = toggleBtn(
    "B",
    "font-weight:700;",
    m.captions.bold,
    () => state.caption.bold,
    (v) => setCaption("bold", v),
  );
  const italicBtn = toggleBtn(
    "I",
    "font-style:italic;",
    m.captions.italic,
    () => state.caption.italic,
    (v) => setCaption("italic", v),
  );
  const underlineBtn = toggleBtn(
    "U",
    "text-decoration:underline;",
    m.captions.underline,
    () => state.caption.underline,
    (v) => setCaption("underline", v),
  );
  const emphasisRow = el("div", "fl-rowg");
  emphasisRow.style.gap = "6px";
  emphasisRow.append(boldBtn, italicBtn, underlineBtn);

  const boxColorRow = colorControl(
    m.captions.boxColor,
    () => state.caption.boxColor,
    (v) => setCaption("boxColor", v),
  );
  const shadowBtn = toggleBtn(
    m.captions.shadow,
    "",
    m.captions.shadowTitle,
    () => state.caption.shadow,
    (v) => setCaption("shadow", v),
  );
  const boxBtn = toggleBtn(
    m.captions.box,
    "",
    m.captions.boxTitle,
    () => state.caption.box,
    (v) => {
      setCaption("box", v);
      boxColorRow.style.display = v ? "" : "none";
    },
  );
  boxColorRow.style.display = state.caption.box ? "" : "none";
  const fxRow = el("div", "fl-rowg");
  fxRow.style.gap = "6px";
  fxRow.append(shadowBtn, boxBtn);

  const angleRow = el("div", "fl-rowg");
  angleRow.style.cssText = "align-items:center; gap:8px;";
  const angleLab = el("span", "fl-label");
  angleLab.style.cssText = "flex:none; font-size:12px;";
  angleLab.textContent = m.captions.rotate;
  const angleInput = document.createElement("input");
  angleInput.type = "range";
  angleInput.min = "-30";
  angleInput.max = "30";
  angleInput.step = "1";
  angleInput.style.flex = "1";
  angleInput.value = String(state.caption.angle);
  const angleVal = el("span", "mono");
  angleVal.style.cssText = "font-size:12px; color:var(--faint); min-width:34px; text-align:right;";
  angleVal.textContent = `${state.caption.angle}°`;
  angleInput.addEventListener("input", () => {
    setCaption("angle", Number(angleInput.value));
    angleVal.textContent = `${state.caption.angle}°`;
  });
  angleRow.append(angleLab, angleInput, angleVal);

  styleWrap.append(
    fontRow,
    fontField,
    fillRow,
    outlineRow,
    emphasisRow,
    fxRow,
    boxColorRow,
    angleRow,
  );

  /** Refresh every caption-style control from `state.caption` (used on clip restore). */
  function syncCaptionControls(): void {
    syncFontSelect();
    for (const c of [fillRow, outlineRow, boxColorRow]) {
      const sw = c.querySelector('input[type="color"]') as
        | (HTMLInputElement & { _sync?: () => void })
        | null;
      sw?._sync?.();
    }
    for (const b of [boldBtn, italicBtn, underlineBtn, shadowBtn, boxBtn] as Array<
      HTMLButtonElement & { _sync?: () => void }
    >) {
      b._sync?.();
    }
    boxColorRow.style.display = state.caption.box ? "" : "none";
    angleInput.value = String(state.caption.angle);
    angleVal.textContent = `${state.caption.angle}°`;
  }
  void rebuildFontPicker();

  capSect.append(hookField, titleCapField, posField, styleWrap);

  const kfSect = el("div", "fl-sect");
  kfSect.append(sectionHeader(m.keyframes.header));
  const kfRow = el("div", "fl-rowg");
  kfRow.style.marginBottom = "10px";
  const addKfBtn = button(m.keyframes.add, "fl-btn sm", addKeyframe);
  addKfBtn.title = m.keyframes.addTitle;
  const clearKfBtn = button(m.keyframes.clear, "fl-btn sm ghost", () => {
    store.set({ keyframes: [] });
  });
  kfRow.append(addKfBtn, clearKfBtn);
  const kfList = el("ul", "fl-kf-list") as HTMLUListElement;
  const scheduleReadout = el("div", "fl-readout");
  scheduleReadout.style.marginTop = "8px";
  scheduleReadout.textContent = m.keyframes.scheduleNone;
  kfSect.append(kfRow, kfList, scheduleReadout);

  const addSect = el("div", "fl-sect");
  addSect.append(sectionHeader(m.add.header));
  const nameField = el("div", "fl-field");
  nameField.style.marginBottom = "12px";
  const nameInput = input("text", m.add.namePlaceholder);
  nameInput.classList.add("mono");
  nameField.append(nameInput);
  const addClipBtn = button("", "fl-btn lg primary", addClip);
  addClipBtn.innerHTML = `${ICON_PLUS}${escapeHtml(m.add.addClip)}`;
  addClipBtn.title = m.add.addClipTitle;
  const clipErr = el("div", "err-text");
  addSect.append(nameField, addClipBtn, clipErr);

  framePane.append(srcSect, clipSect, framingSect, capSect, kfSect, addSect);

  // -- Track tab (auto-track) --
  const trackPane = el("div");
  const trackSect = el("div", "fl-sect");
  trackSect.append(sectionHeader(m.track.header));
  const trackHelp = el("div", "fl-help");
  trackHelp.textContent = m.track.help;
  const hintField = el("div", "fl-field");
  hintField.style.marginBottom = "10px";
  const hintInput = input("text", m.track.subjectPlaceholder);
  hintInput.classList.add("mono");
  hintInput.value = autoTrack.subjectHint;
  hintField.append(hintInput);
  const intervalField = el("div", "fl-field");
  intervalField.style.cssText = "justify-content:space-between; margin-bottom:12px;";
  const intervalInput = input("number", m.track.intervalPlaceholder);
  intervalInput.value = String(autoTrack.intervalSec);
  intervalInput.step = "0.05";
  intervalInput.min = "0.05";
  intervalInput.classList.add("mono");
  intervalInput.style.maxWidth = "90px";
  const intervalLab = el("span", "hint");
  intervalLab.textContent = m.track.intervalLabel;
  intervalField.append(intervalLab, intervalInput);
  const trackBtnRow = el("div", "fl-rowg");
  const trackBtn = button(m.track.autoTrack, "fl-btn primary", () => void doAutoTrack());
  trackBtn.title = m.track.autoTrackTitle;
  const clearTrackBtn = button(m.track.clearTrack, "fl-btn ghost", clearTrack);
  clearTrackBtn.title = m.track.clearTrackTitle;
  trackBtnRow.append(trackBtn, clearTrackBtn);
  const trackStatus = el("div", "fl-readout");
  trackStatus.style.marginTop = "10px";
  trackStatus.textContent = m.track.statusNone;
  trackSect.append(trackHelp, hintField, intervalField, trackBtnRow, trackStatus);
  trackPane.append(trackSect);

  const persistAutoTrack = () => {
    autoTrack.subjectHint = hintInput.value;
    autoTrack.mock = false;
    const iv = Number(intervalInput.value);
    autoTrack.intervalSec = Number.isFinite(iv) && iv > 0 ? iv : 0.75;
    saveAutoTrackSettings(autoTrack);
  };
  hintInput.addEventListener("change", persistAutoTrack);
  intervalInput.addEventListener("change", persistAutoTrack);

  // Second entry point into the assistant: a button pinned at the inspector base
  // (the spark in the top bar is the first). Opening the dock hides the inspector.
  const askSect = el("div", "fl-sect");
  const askBtn = button("", "fl-btn", () => openAssistant());
  askBtn.innerHTML = `${ICON_SPARK}${escapeHtml(m.ask.button)}`;
  askBtn.title = m.ask.title;
  askSect.append(askBtn);

  inspector.append(seg, framePane, trackPane, askSect);

  function selectTab(which: "frame" | "track"): void {
    const frameOn = which === "frame";
    frameTab.classList.toggle("on", frameOn);
    trackTab.classList.toggle("on", !frameOn);
    framePane.style.display = frameOn ? "" : "none";
    trackPane.style.display = frameOn ? "none" : "";
  }
  selectTab("frame");

  // ----- AI assistant dock (third rail mode; slides over the inspector) -----
  const dock = buildAssistantDock();

  main.append(viewer, inspector, dock.el);

  // ===== loudness timeline =====
  // A full-width track under the viewer: a normalized RMS waveform (bars warm
  // toward orange as they get louder), scene cuts, the In/Out region, keyframe
  // diamonds and a live playhead. Above it, "suggested" swell chips (quiet→loud
  // moments) that seek to just before the rise. Click the track to seek, drag to
  // scrub, drag the region edges to set In/Out.
  const timeline = el("div", "fl-timeline");

  // Left cluster: prev-cut / next-cut jump buttons (no play button — the only
  // play button in the app lives in the transport jog). They step the playhead
  // between detected scene cuts.
  const tlCluster = el("div", "fl-tl-cluster");
  const tlPrevCut = button("", "fl-iconbtn", () => jumpCut(-1));
  tlPrevCut.innerHTML = ICON_PREV_CUT;
  tlPrevCut.title = m.timeline.prevCutTitle;
  const tlNextCut = button("", "fl-iconbtn", () => jumpCut(1));
  tlNextCut.innerHTML = ICON_NEXT_CUT;
  tlNextCut.title = m.timeline.nextCutTitle;
  tlCluster.append(tlPrevCut, tlNextCut);

  const tlCol = el("div", "fl-tl-col");
  const suggestLane = el("div", "fl-tl-suggest");
  const suggestTag = el("span", "fl-suggest-tag");
  suggestTag.innerHTML = `<span class="sparkdot"></span>${escapeHtml(m.timeline.suggested)}`;
  suggestLane.append(suggestTag);

  const tlTrack = el("div", "fl-tl-track");
  const tlRuler = el("div", "fl-tl-ruler");
  const tlWave = el("div", "fl-tl-wave");
  const layer = (): HTMLElement => {
    const d = el("div");
    d.style.cssText = "position:absolute; inset:0; pointer-events:none;";
    return d;
  };
  const tlCutsLayer = layer();
  const tlOnsetsLayer = layer();
  const tlMarksLayer = layer();
  const tlRegion = el("div", "fl-tl-region");
  tlRegion.style.display = "none";
  const tlKfLayer = layer();
  // Assistant ghost-proposal previews (dashed): a proposed In/Out region and
  // proposed keyframe / track diamonds, shown while proposals are pending and
  // cleared on Accept / Step / Discard (SPEC §6.7 propose -> ghost -> commit).
  const tlGhostRegion = el("div", "fl-tl-region ghost");
  tlGhostRegion.style.display = "none";
  const tlGhostKfLayer = layer();
  const tlPlayhead = el("div", "fl-tl-playhead");
  tlPlayhead.style.display = "none";
  const tlBubble = el("span", "fl-tl-bubble");
  tlBubble.textContent = "0:00.000";
  tlPlayhead.append(tlBubble);
  tlTrack.append(
    tlRuler,
    tlWave,
    tlOnsetsLayer,
    tlCutsLayer,
    tlMarksLayer,
    tlRegion,
    tlGhostRegion,
    tlKfLayer,
    tlGhostKfLayer,
    tlPlayhead,
  );
  tlCol.append(suggestLane, tlTrack);

  const tlInfo = el("div", "fl-tl-cluster");
  const cutsChip = el("span", "fl-rdchip");
  cutsChip.innerHTML = `<span class="lab">${escapeHtml(m.timeline.cutsLabel)}</span><span class="val">0</span>`;
  const swellsChip = el("span", "fl-rdchip swell");
  swellsChip.innerHTML = `<span class="lab">${escapeHtml(m.timeline.swellsLabel)}</span><span class="val">0</span>`;
  // Onset snap (issue #164): opt-in, persisted. When ON, releasing an In/Out
  // drag or keying I/O magnetizes the point to the nearest detected onset
  // (±ONSET_SNAP_WINDOW_SEC). Never applied during the drag itself.
  let snapOn = loadSnapPref();
  const snapBtn = button(m.timeline.snapLabel, "fl-btn sm fl-snap", () => {
    snapOn = !snapOn;
    saveSnapPref(snapOn);
    snapBtn.classList.toggle("on", snapOn);
  });
  snapBtn.title = m.timeline.snapTitle;
  snapBtn.classList.toggle("on", snapOn);
  const scenesBtn = button(m.timeline.detectScenes, "fl-btn sm", doScenes);
  scenesBtn.title = m.timeline.detectScenesTitle;
  tlInfo.append(cutsChip, swellsChip, snapBtn, scenesBtn);

  /** `t` snapped to the nearest onset when the toggle is on (else unchanged). */
  const snapT = (t: number): number => (snapOn ? snapToOnset(t, state.onsets) : t);

  timeline.append(tlCluster, tlCol, tlInfo);

  // ----- timeline rendering -----
  const pct = (t: number): string => `${clamp((t / (state.duration || 1)) * 100, 0, 100)}%`;

  /**
   * Pending assistant ghost previews (dashed, preview-only) drawn on the stage
   * and timeline while proposals await Accept / Step / Discard. Set via
   * `setGhosts`; nothing here mutates editor state — that's the commit's job.
   */
  let ghostPreviews: GhostPreview[] = [];

  function renderRuler(): void {
    tlRuler.innerHTML = "";
    if (!(state.duration > 0)) return;
    const N = 5;
    for (let i = 0; i < N; i++) {
      const frac = i / N;
      const tick = el("div", "fl-tl-tick");
      tick.style.left = `${frac * 100}%`;
      const lab = el("span", "fl-tl-label");
      lab.textContent = fmtClock(frac * state.duration, false);
      tick.append(lab);
      tlRuler.append(tick);
    }
  }

  function renderWave(loading = false): void {
    tlWave.innerHTML = "";
    tlWave.classList.toggle("loading", loading);
    const data = state.loudness;
    if (!data || data.length === 0) {
      // Flat placeholder bars (also shown while loudness is loading).
      for (let i = 0; i < LOUDNESS_BUCKETS; i++) {
        const bar = document.createElement("span");
        bar.style.height = "8%";
        bar.style.background = "var(--line)";
        tlWave.append(bar);
      }
      return;
    }
    for (const L0 of data) {
      // Bar height 10%..92%; color lerps muted→orange via a smoothstep on level.
      const L = clamp(L0, 0.06, 1);
      const tt = L * L * (3 - 2 * L);
      const r = Math.round(158 + (255 - 158) * tt);
      const g = Math.round(140 + (122 - 140) * tt);
      const b = Math.round(112 + (69 - 112) * tt);
      const bar = document.createElement("span");
      bar.style.height = `${(10 + L * 82).toFixed(1)}%`;
      bar.style.background = `rgb(${r},${g},${b})`;
      tlWave.append(bar);
    }
  }

  function renderSwells(): void {
    suggestLane.querySelectorAll(".fl-suggest").forEach((n) => n.remove());
    tlMarksLayer.innerHTML = "";
    state.swells.forEach((sw) => {
      // Chip seeks to ~0.4s before the rise so you land in the quiet run-up.
      const chip = button("", "fl-suggest", () => seek(Math.max(0, sw.t - 0.4)));
      chip.style.left = pct(sw.t);
      chip.innerHTML =
        '<span class="spark"><i style="height:28%"></i><i style="height:52%"></i>' +
        `<i style="height:78%"></i><i style="height:100%"></i></span>${sw.label}`;
      chip.title = `${m.timeline.seekSwellPrefix}${fmtClock(sw.t, true)}${m.timeline.seekSwellSuffix}`;
      suggestLane.append(chip);
      const mark = el("div", "fl-tl-suggest-mark");
      mark.style.left = pct(sw.t);
      tlMarksLayer.append(mark);
    });
    const v = swellsChip.querySelector(".val");
    if (v) v.textContent = String(state.swells.length);
  }

  /** Subtle onset ticks along the bottom of the track (below the scene-cut
   *  markers' full-height lines) — the beat grid the snap toggle targets. */
  function renderOnsets(): void {
    tlOnsetsLayer.innerHTML = "";
    if (!(state.duration > 0)) return;
    state.onsets.forEach((t) => {
      const tick = el("div", "fl-tl-onset");
      tick.style.left = pct(t);
      tlOnsetsLayer.append(tick);
    });
  }

  function renderCuts(): void {
    tlCutsLayer.innerHTML = "";
    if (state.duration > 0) {
      state.sceneCuts.forEach((c) => {
        const cut = el("div", "fl-tl-cut");
        cut.style.left = pct(c);
        tlCutsLayer.append(cut);
      });
    }
    const v = cutsChip.querySelector(".val");
    if (v) v.textContent = String(state.sceneCuts.length);
  }

  function renderKf(): void {
    tlKfLayer.innerHTML = "";
    if (state.inPoint == null || !(state.duration > 0)) return;
    state.keyframes.forEach((kf) => {
      const d = el("div", "fl-tl-kf");
      d.style.left = pct(state.inPoint! + kf.t);
      tlKfLayer.append(d);
    });
  }

  function renderRegion(): void {
    if (
      state.inPoint != null &&
      state.outPoint != null &&
      state.outPoint > state.inPoint &&
      state.duration > 0
    ) {
      tlRegion.style.display = "block";
      tlRegion.style.left = pct(state.inPoint);
      tlRegion.style.width = `${clamp(((state.outPoint - state.inPoint) / state.duration) * 100, 0, 100)}%`;
    } else {
      tlRegion.style.display = "none";
    }
  }

  /**
   * Draw the timeline ghosts for every pending proposal: a dashed proposed
   * In/Out region (`ghost.region`, absolute source seconds — mirrors
   * `renderRegion`) and dashed diamonds for proposed crop keyframes / track
   * paths (`ghost.keyframe` / `ghost.path`, clip-relative to In — mirrors
   * `renderKf`). The stage crop-box ghost is drawn by `drawOverlay`.
   */
  function renderGhosts(): void {
    tlGhostKfLayer.innerHTML = "";
    let regionShown = false;
    for (const g of ghostPreviews) {
      if (g.region && state.duration > 0 && g.region.outSec > g.region.inSec) {
        tlGhostRegion.style.display = "block";
        tlGhostRegion.style.left = pct(g.region.inSec);
        tlGhostRegion.style.width = `${clamp(
          ((g.region.outSec - g.region.inSec) / state.duration) * 100,
          0,
          100,
        )}%`;
        regionShown = true;
      }
      // Keyframe / path diamonds are clip-relative; only place them once an In
      // point exists (their absolute position is In + t, like committed kfs).
      if (state.inPoint != null && state.duration > 0) {
        const ks = g.path ?? (g.keyframe ? [g.keyframe] : []);
        for (const k of ks) {
          const d = el("div", "fl-tl-kf ghost");
          d.style.left = pct(state.inPoint + k.t);
          tlGhostKfLayer.append(d);
        }
      }
    }
    if (!regionShown) tlGhostRegion.style.display = "none";
  }

  /** Replace the pending ghost set and repaint the stage + timeline previews. */
  function setGhosts(gs: GhostPreview[]): void {
    ghostPreviews = gs;
    renderGhosts();
    drawOverlay();
  }

  function movePlayhead(): void {
    if (!(state.duration > 0)) {
      tlPlayhead.style.display = "none";
      return;
    }
    tlPlayhead.style.display = "block";
    tlPlayhead.style.left = pct(state.t);
    tlBubble.textContent = fmtClock(state.t, true);
  }

  /**
   * Fetch the source's audio envelopes and update the timeline: the perceptual
   * `display` envelope draws the bars; the raw-energy `detect` envelope feeds
   * the swell heuristic (it surfaces musical dips that perceptually-gated LUFS
   * smooths away on compressed material); the fine `onsetEnvelope` feeds the
   * onset detector behind the In/Out snap toggle and the timeline's beat ticks.
   */
  async function loadLoudness(source: string): Promise<void> {
    renderWave(true);
    try {
      const { display, detect, onsetEnvelope } = await platform.loudness(source);
      if (state.source !== source) return; // a newer load superseded this one
      state.loudness = display;
      state.swells = detectSwells(detect, state.duration);
      state.onsets = detectOnsets(onsetEnvelope ?? []);
    } catch {
      if (state.source !== source) return;
      state.loudness = null;
      state.swells = [];
      state.onsets = [];
    }
    renderWave(false);
    renderSwells();
    renderOnsets();
  }

  /** Source time at a client-X over the timeline track. */
  function tlTimeAt(clientX: number): number {
    const rect = tlTrack.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1) * state.duration;
  }

  // Track interaction (the timeline is the app's scrubber AND trimmer):
  //  • click empty   → seek there (and deselect any marker)
  //  • drag empty    → define a fresh In→Out region (the playhead previews the frame)
  //  • click an edge → select that In/Out marker (then nudge it with ←/→)
  //  • drag an edge  → move that marker
  let tlDrag: null | "region" | "in" | "out" = null;
  let regionAnchor = 0;
  let tlDownX = 0;
  let tlMoved = false;
  const TL_EDGE_PX = 7;

  /** A selected In/Out marker that ←/→ will nudge; highlighted on the region. */
  let selectedMarker: "in" | "out" | null = null;
  function setSelectedMarker(m: "in" | "out" | null): void {
    selectedMarker = m;
    tlRegion.classList.toggle("sel-in", m === "in");
    tlRegion.classList.toggle("sel-out", m === "out");
  }

  /** Pixel distance from the In / Out edges at a client-x, or null if no region. */
  function edgeDist(clientX: number): { inPx: number; outPx: number } | null {
    if (
      state.inPoint == null ||
      state.outPoint == null ||
      state.outPoint <= state.inPoint ||
      !(state.duration > 0)
    ) {
      return null;
    }
    const rect = tlTrack.getBoundingClientRect();
    const x = clientX - rect.left;
    return {
      inPx: Math.abs(x - (state.inPoint / state.duration) * rect.width),
      outPx: Math.abs(x - (state.outPoint / state.duration) * rect.width),
    };
  }

  /** Nudge the selected In/Out marker by `delta` seconds (keyboard). */
  function nudgeMarker(delta: number): boolean {
    if (selectedMarker === "in" && state.inPoint != null) {
      store.set({
        inPoint: round3(clamp(state.inPoint + delta, 0, state.outPoint ?? state.duration)),
      });
      seek(state.inPoint);
      return true;
    }
    if (selectedMarker === "out" && state.outPoint != null) {
      store.set({
        outPoint: round3(clamp(state.outPoint + delta, state.inPoint ?? 0, state.duration)),
      });
      seek(state.outPoint);
      return true;
    }
    return false;
  }

  tlTrack.addEventListener("pointerdown", (e) => {
    if (!state.dims || !(state.duration > 0)) return;
    tlTrack.setPointerCapture(e.pointerId);
    const d = edgeDist(e.clientX);
    if (d && d.inPx <= TL_EDGE_PX && d.inPx <= d.outPx) {
      tlDrag = "in";
      setSelectedMarker("in");
      return;
    }
    if (d && d.outPx <= TL_EDGE_PX) {
      tlDrag = "out";
      setSelectedMarker("out");
      return;
    }
    tlDrag = "region";
    regionAnchor = tlTimeAt(e.clientX);
    tlDownX = e.clientX;
    tlMoved = false;
  });
  tlTrack.addEventListener("pointermove", (e) => {
    if (!tlDrag) {
      const d = edgeDist(e.clientX);
      tlTrack.style.cursor =
        d && (d.inPx <= TL_EDGE_PX || d.outPx <= TL_EDGE_PX) ? "ew-resize" : "pointer";
      showHoverThumb(e.clientX);
      return;
    }
    hideHoverThumb(); // dragging: the playhead/region is the feedback, not the thumb
    const t = tlTimeAt(e.clientX);
    if (tlDrag === "region") {
      if (!tlMoved && Math.abs(e.clientX - tlDownX) < 3) return; // not yet a drag
      tlMoved = true;
      store.set({
        inPoint: round3(Math.min(regionAnchor, t)),
        outPoint: round3(Math.max(regionAnchor, t)),
      });
      seek(t);
    } else if (tlDrag === "in") {
      store.set({ inPoint: round3(clamp(t, 0, state.outPoint ?? state.duration)) });
      seek(t);
    } else if (tlDrag === "out") {
      store.set({ outPoint: round3(clamp(t, state.inPoint ?? 0, state.duration)) });
      seek(t);
    }
  });
  const endTlDrag = (e: PointerEvent) => {
    if (tlDrag == null) return;
    tlTrack.releasePointerCapture(e.pointerId);
    if (tlDrag === "region" && !tlMoved) {
      // A plain click: seek there and drop any marker selection.
      setSelectedMarker(null);
      seek(regionAnchor);
    } else if (snapOn) {
      // Onset snap happens at RELEASE only (never mid-drag), so the magnet
      // assists the gesture without fighting the hand. With the toggle off,
      // the release leaves the user's point exactly where they put it.
      const snapped: { inPoint?: number; outPoint?: number } = {};
      if ((tlDrag === "in" || tlDrag === "region") && state.inPoint != null) {
        snapped.inPoint = round3(clamp(snapT(state.inPoint), 0, state.outPoint ?? state.duration));
      }
      if ((tlDrag === "out" || tlDrag === "region") && state.outPoint != null) {
        snapped.outPoint = round3(
          clamp(snapT(state.outPoint), snapped.inPoint ?? state.inPoint ?? 0, state.duration),
        );
      }
      store.set(snapped);
    }
    tlDrag = null;
  };
  tlTrack.addEventListener("pointerup", endTlDrag);
  tlTrack.addEventListener("pointercancel", endTlDrag);

  // ---- frame thumbnails (hover-scrub + queue/history cards) ----
  // Cache extracted frames by source@time so re-renders and repeated hovers don't
  // re-spawn ffmpeg. Blob URLs (web) are revoked on eviction.
  const frameCache = new Map<string, string>();
  async function extractCached(source: string, t: number): Promise<string> {
    const key = `${source}@${t.toFixed(3)}`;
    const hit = frameCache.get(key);
    if (hit) return hit;
    const url = await platform.extractFrame(source, t);
    frameCache.set(key, url);
    if (frameCache.size > 96) {
      const k = frameCache.keys().next().value;
      if (k) {
        const u = frameCache.get(k);
        frameCache.delete(k);
        if (u && u.startsWith("blob:")) URL.revokeObjectURL(u);
      }
    }
    return url;
  }

  /** Fill a `.fl-thumb` with the source frame at `t` (object-fit cover). */
  async function setThumb(elm: HTMLElement, source: string, t: number): Promise<void> {
    if (!source || !Number.isFinite(t)) return;
    try {
      const url = await extractCached(source, t);
      elm.style.backgroundImage = `url("${url}")`;
      elm.classList.add("has-img");
    } catch {
      /* leave the glow placeholder on failure */
    }
  }

  // Hover-scrub: a floating frame preview above the timeline at the cursor time.
  // Mounted on <body> with fixed positioning so the track's overflow doesn't clip it.
  const tlHover = el("div", "fl-tl-hover");
  tlHover.style.display = "none";
  const tlHoverImg = document.createElement("img");
  tlHoverImg.className = "fl-tl-hover-img";
  const tlHoverT = el("div", "fl-tl-hover-t");
  tlHover.append(tlHoverImg, tlHoverT);
  document.body.append(tlHover);
  let hoverTimer: number | undefined;
  let hoverToken = 0;

  function hideHoverThumb(): void {
    tlHover.style.display = "none";
    if (hoverTimer) window.clearTimeout(hoverTimer);
  }
  function showHoverThumb(clientX: number): void {
    if (!state.dims || !(state.duration > 0)) return;
    const rect = tlTrack.getBoundingClientRect();
    const t = clamp((clientX - rect.left) / rect.width, 0, 1) * state.duration;
    tlHover.style.display = "block";
    const W = 124;
    tlHover.style.left = `${clamp(clientX - W / 2, 6, window.innerWidth - W - 6)}px`;
    tlHover.style.top = `${rect.top - 8}px`;
    tlHoverT.textContent = fmtClock(t, true);
    if (hoverTimer) window.clearTimeout(hoverTimer);
    const token = ++hoverToken;
    hoverTimer = window.setTimeout(() => {
      // Quantize to 0.5s so nearby hovers share a cached frame (smooth + cheap).
      void extractCached(state.source, Math.round(t * 2) / 2).then(
        (url) => {
          if (token === hoverToken) tlHoverImg.src = url;
        },
        () => undefined,
      );
    }, 90);
  }
  tlTrack.addEventListener("pointerleave", hideHoverThumb);

  // ---- keyboard-first operation ----
  const CROP_NUDGE_PX = 4;
  /** Nudge the crop box within the working region (Alt+arrows). */
  function nudgeCrop(dx: number, dy: number): void {
    if (!state.cropBox || !cropInteractive()) return;
    const r = cropRegionRect();
    if (dx) {
      state.cropBox.x = clamp(state.cropBox.x + dx, r.x0, Math.max(r.x0, r.x1 - state.cropBox.w));
    }
    if (dy && state.cropBox.h < r.y1 - r.y0 - 2) {
      state.cropBox.y = clamp(state.cropBox.y + dy, r.y0, Math.max(r.y0, r.y1 - state.cropBox.h));
    }
    refreshCropReadout();
    drawOverlay();
  }

  window.addEventListener("keydown", (e) => {
    // Never hijack typing in a field; let browser/OS combos through.
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable))
      return;
    if (e.metaKey || e.ctrlKey) return;
    if (e.key === "?") {
      openShortcuts();
      return;
    }
    // Spark hotkey: toggle the assistant rail (works even before a source loads
    // so the "load a source first" guidance is reachable). Esc closes it.
    if (e.key === "a" || e.key === "A") {
      e.preventDefault();
      toggleAssistant();
      return;
    }
    if (assistantOpen && e.key === "Escape") {
      closeAssistant();
      return;
    }
    if (!state.dims) return;
    const frame = 1 / state.fps;
    switch (e.key) {
      case " ":
        e.preventDefault();
        void togglePlay();
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (e.altKey) {
          nudgeCrop(dir * CROP_NUDGE_PX, 0);
        } else {
          const step = e.shiftKey ? 0.1 : frame;
          if (!(selectedMarker && nudgeMarker(dir * step))) seek(state.t + dir * step);
        }
        break;
      }
      case "ArrowUp":
      case "ArrowDown":
        e.preventDefault();
        if (e.altKey) {
          nudgeCrop(0, (e.key === "ArrowDown" ? 1 : -1) * CROP_NUDGE_PX);
        } else {
          // NLE convention: ↑/↓ jump to the previous/next scene cut (alias of [ / ]).
          jumpCut(e.key === "ArrowUp" ? -1 : 1);
        }
        break;
      case "i":
      case "I":
        // Shift+I jumps the playhead to the In point (verify it); I sets it.
        if (e.shiftKey) {
          if (state.inPoint != null) {
            seek(state.inPoint);
            setSelectedMarker("in");
          }
        } else {
          store.set({ inPoint: snapT(state.t) }); // identity unless onset snap is ON
          setSelectedMarker("in");
        }
        break;
      case "o":
      case "O":
        if (e.shiftKey) {
          if (state.outPoint != null) {
            seek(state.outPoint);
            setSelectedMarker("out");
          }
        } else {
          store.set({ outPoint: snapT(state.t) }); // identity unless onset snap is ON
          setSelectedMarker("out");
        }
        break;
      // J/K/L shuttle (NLE convention): J reverse, K pause, L forward; tap again
      // to speed up. Enters video mode on first press.
      case "j":
      case "J":
        e.preventDefault();
        void shuttle(-1);
        break;
      case "k":
      case "K":
        e.preventDefault();
        setShuttle(0);
        break;
      case "l":
      case "L":
        e.preventDefault();
        void shuttle(1);
        break;
      // Avid-style go-to aliases (mirror Shift+I / Shift+O).
      case "q":
      case "Q":
        if (state.inPoint != null) {
          seek(state.inPoint);
          setSelectedMarker("in");
        }
        break;
      case "w":
      case "W":
        if (state.outPoint != null) {
          seek(state.outPoint);
          setSelectedMarker("out");
        }
        break;
      // Jump to the source start / end (NLE Home/End convention).
      case "Home":
        e.preventDefault();
        seek(0);
        break;
      case "End":
        e.preventDefault();
        seek(state.duration);
        break;
      case "s":
      case "S":
        addClip();
        break;
      case "[":
        jumpCut(-1);
        break;
      case "]":
        jumpCut(1);
        break;
      case "Escape":
        setSelectedMarker(null);
        break;
    }
  });

  renderWave();

  // ===== filmstrip queue =====
  const filmstrip = el("div", "fl-filmstrip");
  const queueLabel = el("span", "fl-label");
  queueLabel.style.alignSelf = "center";
  queueLabel.innerHTML = `${escapeHtml(m.queue.queueLabel)} <span class="n">0</span>`;
  const clipList = el("div");
  clipList.style.display = "contents";
  const addCard = el("div", "fl-strip-card add");
  addCard.textContent = m.queue.addClip;
  addCard.addEventListener("click", () => addClip());
  const fsSpacer = el("span", "fl-spacer");
  // Export the queue as a JSON manifest (re-imports via `footlight render`) — the
  // single queue-out action (replaces the old copy-to-clipboard) and the safety
  // net for Clear.
  const exportBtn = button("", "fl-btn sm ghost", () => {
    if (!state.clips.length) return;
    void platform
      .exportTextFile("footlight-manifest.json", serializeManifestJSON(state.clips))
      .catch((err) => setOutput(errMsg(err), "err"));
  });
  exportBtn.innerHTML = `${ICON_DOWN}${escapeHtml(m.queue.exportJson)}`;
  exportBtn.style.alignSelf = "center";
  exportBtn.title = m.queue.exportJsonTitle;
  // Export the playhead frame, through the ACTIVE framing, as the clip's
  // 1080×1920 PNG cover image (#166) — same framing precedence as addClip.
  const coverBtn = button("", "fl-btn sm ghost", () => {
    void doExportCover();
  });
  coverBtn.innerHTML = `${ICON_DOWN}${escapeHtml(m.queue.exportCover)}`;
  coverBtn.style.alignSelf = "center";
  coverBtn.title = m.queue.exportCoverTitle;
  filmstrip.append(queueLabel, clipList, addCard, fsSpacer, coverBtn, exportBtn);

  /**
   * Cover-frame export (#166): build a spec from the CURRENT editor framing
   * (cropPath > cropWindow > offset/schedule, plus any content crop — the same
   * precedence addClip emits) and hand it to the platform with the playhead t.
   * The backend evaluates the crop at that instant and writes/downloads the PNG.
   */
  async function doExportCover(): Promise<void> {
    if (!state.source || !state.dims) {
      setOutput(m.errors.loadSourceFirst, "err");
      return;
    }
    const spec: ClipSpec = {
      source_file: state.source,
      in_point: (state.inPoint ?? 0).toFixed(3),
      out_point: (state.outPoint ?? state.duration).toFixed(3),
    };
    Object.assign(spec, framingToSpec(state.t));
    const name = nameInput.value.trim();
    if (name) spec.out_name = name;
    try {
      const saved = await platform.exportCover(
        state.source,
        state.t,
        spec,
        coverOutName({
          source_file: spec.source_file,
          in_point: spec.in_point,
          out_point: spec.out_point,
          ...(spec.out_name ? { out_name: spec.out_name } : {}),
        }),
      );
      if (saved) setOutput(m.activity.coverExported);
    } catch (err) {
      setOutput(errMsg(err), "err");
    }
  }

  appEl.append(topbar, main, timeline, filmstrip);
  root.append(appEl);

  // Activity / Output — a toggleable floating window so render,
  // scene-detect and auto-track output is available on demand without taking
  // permanent space in the main UI. Hidden by default; auto-opens on errors.
  const activityPanel = el("div", "activity");
  activityPanel.hidden = true;
  const activityHead = el("div", "activity-head");
  const activityTitle = el("div", "activity-title");
  activityTitle.textContent = m.activity.title;
  const outDirLine = el("div", "hint");
  const copyLogBtn = button(m.activity.copy, "iconbtn", () => void copyLog());
  copyLogBtn.title = m.activity.copyTitle;
  const closeActivityBtn = button("✕", "iconbtn", () => setActivityOpen(false));
  closeActivityBtn.title = m.activity.closeTitle;
  activityHead.append(activityTitle, outDirLine, copyLogBtn, closeActivityBtn);
  const logPre = document.createElement("pre");
  logPre.className = "log";
  logPre.textContent = m.activity.placeholder;
  activityPanel.append(activityHead, logPre);

  // Always-visible toggle (bottom-right) that shows/hides the activity window.
  // On the native app the Activity log is a SEPARATE OS window (created in Rust);
  // on the web build it's the in-app floating panel above. lastOutput is the
  // shared data model, replayed to the native window when it opens.
  const isTauri = platformName === "tauri";
  let lastOutput: { text: string; kind: "" | "ok" | "err"; outDir: string } = {
    text: m.activity.placeholder,
    kind: "",
    outDir: "",
  };

  // The Activity toggle lives in the top bar (created above). On the web build the
  // floating panel mounts to the body; on Tauri it's a separate OS window (no panel).
  if (!isTauri) document.body.append(activityPanel);

  // ---- drag-and-drop to load ----
  // Native Tauri gives us real filesystem paths via its dragDrop event; the web
  // build can't (browsers don't expose a dropped file's path), so it shows a hint.
  const setDropActive = (on: boolean) => stage.classList.toggle("dropping", on);
  if (isTauri) {
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        await getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setDropActive(true);
          else if (p.type === "leave") setDropActive(false);
          else if (p.type === "drop") {
            setDropActive(false);
            const path = p.paths?.[0];
            if (path) {
              srcInput.value = path;
              void load();
            }
          }
        });
      } catch {
        /* native drag-drop unavailable — the Browse… button still works. */
      }
    })();
  } else {
    // Web: HTML5 DnD for the visual affordance; a dropped file has no real path,
    // so point the user at the path field instead of failing silently.
    appEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      setDropActive(true);
    });
    appEl.addEventListener("dragleave", (e) => {
      if (e.target === appEl) setDropActive(false);
    });
    appEl.addEventListener("drop", (e) => {
      e.preventDefault();
      setDropActive(false);
      if (e.dataTransfer?.files?.length) {
        dimsLine.innerHTML = `<span class="err-text">${escapeHtml(m.source.dropHint)}</span>`;
        srcInput.focus();
      }
    });
  }

  function setActivityOpen(open: boolean): void {
    activityPanel.hidden = !open;
    activityToggle.classList.toggle("on", open);
    if (open) activityToggle.classList.remove("has-output");
  }

  /** Toggle the native Activity window open/closed; sync the button to its state. */
  async function toggleNativeActivity(): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const visible = await invoke<boolean>("toggle_activity_window");
      activityToggle.classList.toggle("on", visible);
      activityToggle.classList.remove("has-output");
      if (visible) await pushActivity();
    } catch {
      /* ignore */
    }
  }

  /** Reveal the native Activity window (used to surface failures). */
  async function showNativeActivity(): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("show_activity_window");
      activityToggle.classList.add("on");
      activityToggle.classList.remove("has-output");
      await pushActivity();
    } catch {
      /* ignore */
    }
  }

  /** Emit the current output to the native Activity window (Tauri only). */
  async function pushActivity(): Promise<void> {
    if (!isTauri) return;
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("activity-log", lastOutput);
    } catch {
      /* ignore */
    }
  }

  /** Push the current theme to the native Activity window so it matches. */
  async function pushTheme(): Promise<void> {
    if (!isTauri) return;
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("theme", document.documentElement.getAttribute("data-theme") || "light");
    } catch {
      /* ignore */
    }
  }

  // Native window events: when the Activity window signals ready, replay the
  // latest output AND the current theme; clear the toggle's "on" state when the
  // user closes the window from its own control.
  if (isTauri) {
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        await listen("activity-ready", () => {
          void pushActivity();
          void pushTheme();
        });
        await listen("activity-hidden", () => activityToggle.classList.remove("on"));
      } catch {
        /* ignore */
      }
    })();
  }

  // Drag the activity window by its header (resize is native via CSS `resize`).
  {
    let dragging = false;
    let offX = 0;
    let offY = 0;
    activityHead.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return; // let header buttons work
      const rect = activityPanel.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      // Switch from bottom/right anchoring to absolute left/top so it follows.
      activityPanel.style.left = `${rect.left}px`;
      activityPanel.style.top = `${rect.top}px`;
      activityPanel.style.right = "auto";
      activityPanel.style.bottom = "auto";
      dragging = true;
      activityHead.setPointerCapture(e.pointerId);
    });
    activityHead.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      activityPanel.style.left = `${clamp(e.clientX - offX, 0, window.innerWidth - 80)}px`;
      activityPanel.style.top = `${clamp(e.clientY - offY, 0, window.innerHeight - 40)}px`;
    });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      activityHead.releasePointerCapture(e.pointerId);
    };
    activityHead.addEventListener("pointerup", endDrag);
    activityHead.addEventListener("pointercancel", endDrag);
  }

  // ---------- behavior ----------

  loadBtn.addEventListener("click", () => void load());
  srcInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void load();
  });

  /** Open the native file picker; on a pick, fill the field and load it. */
  async function browse(): Promise<void> {
    try {
      const picked = await platform.pickSourceFile();
      if (!picked) return; // cancelled
      srcInput.value = picked;
      await load();
    } catch (err) {
      dimsLine.innerHTML = `<span class="err-text">${escapeHtml(errMsg(err))}</span>`;
    }
  }

  async function load(): Promise<void> {
    const source = srcInput.value.trim();
    if (!source) {
      dimsLine.innerHTML = `<span class="err-text">${escapeHtml(m.source.enterPath)}</span>`;
      srcInput.focus();
      return;
    }
    dimsLine.textContent = m.source.probing;
    cropdetectLine.textContent = "";
    try {
      const p = await platform.probe(source);
      state.source = source;
      store.set({
        dims: { width: p.width, height: p.height },
        duration: p.duration,
        cropdetect: p.cropdetect,
        t: Math.min(state.t, p.duration),
      });
      dimsLine.innerHTML =
        '<div class="fl-readgrid">' +
        `<div><span class="k">${escapeHtml(m.source.dimKey)}</span><span class="v">${p.width}×${p.height}</span></div>` +
        `<div><span class="k">${escapeHtml(m.source.durKey)}</span><span class="v">${p.duration.toFixed(2)}s</span></div>` +
        `<div><span class="k">${escapeHtml(m.source.arKey)}</span><span class="v">${(p.width / p.height).toFixed(3)}</span></div>` +
        "</div>";
      cropdetectLine.textContent = p.cropdetect
        ? `${m.source.cropdetectPrefix}${p.cropdetect}`
        : m.source.cropdetectNone;
      crumbPath.textContent = source.split(/[\\/]/).pop() || source;
      crumbDot.classList.add("live");
      stage.classList.remove("empty");
      playBtn.disabled = false;
      pushRecent(source);
      refreshRecents();
      saveSessionSoon();
      // New source → reset source-specific timeline data and redraw the track.
      state.sceneCuts = [];
      state.loudness = null;
      state.swells = [];
      state.onsets = [];
      renderRuler();
      renderCuts();
      renderSwells();
      renderOnsets();
      renderKf();
      renderRegion();
      movePlayhead();
      void loadLoudness(source);
      void autoDetectScenes(source);
      // New source → start in frame mode; drop any previous player source.
      exitVideoMode();
      video.removeAttribute("src");
      // Default 9:16 crop box: full height, centered.
      initCropBox();
      await setT(state.t, true);
    } catch (err) {
      dimsLine.innerHTML = `<span class="err-text">${escapeHtml(errMsg(err))}</span>`;
    }
  }

  function initCropBox(): void {
    if (!state.dims) return;
    const { width, height } = state.dims;
    // Mirror engine landscape math: full height, crop width = round(h*9/16).
    if (width / height >= TARGET_AR) {
      const cw = roundEvenLocal(height * TARGET_AR);
      const maxX = width - cw;
      store.set({ cropBox: { x: Math.floor(maxX / 2), y: 0, w: cw, h: height } });
    } else {
      // Taller than 9:16: full width, crop height.
      const ch = roundEvenLocal(width / TARGET_AR);
      store.set({ cropBox: { x: 0, y: Math.floor((height - ch) / 2), w: width, h: ch } });
    }
    // Default content box covers the full frame.
    store.set({ contentBox: { x: 0, y: 0, w: width, h: height } });
  }

  let frameToken = 0;
  let debounceTimer: number | undefined;

  /** Set current time, fetch the frame (debounced unless immediate). */
  async function setT(t: number, immediate = false): Promise<void> {
    if (!state.dims) return;
    t = clamp(t, 0, state.duration);
    store.set({ t });
    tLabel.textContent = `${t.toFixed(3)}s`;
    stageTimeTag.textContent = `t = ${t.toFixed(3)}s`;
    movePlayhead();
    if (debounceTimer) window.clearTimeout(debounceTimer);
    const fetchFrame = async () => {
      const token = ++frameToken;
      try {
        const url = await platform.extractFrame(state.source, state.t);
        if (token !== frameToken) {
          URL.revokeObjectURL(url);
          return; // a newer request superseded this one
        }
        const prev = img.src;
        img.src = url;
        img.style.display = "block";
        emptyMsg.style.display = "none";
        if (prev.startsWith("blob:")) URL.revokeObjectURL(prev);
      } catch (err) {
        emptyMsg.textContent = errMsg(err);
        emptyMsg.style.display = "block";
      }
    };
    if (immediate) await fetchFrame();
    else debounceTimer = window.setTimeout(() => void fetchFrame(), 140);
  }

  // Resize the overlay canvas to the displayed image and (re)draw the box.
  img.addEventListener("load", () => {
    syncOverlay();
    drawOverlay();
  });
  window.addEventListener("resize", () => {
    syncOverlay();
    drawOverlay();
  });

  // ---- video preview (play with audio to pick In/Out by ear) ----
  let videoMode = false;

  // J/K/L shuttle state: 0 stopped, >0 forward ×, <0 reverse ×. Forward uses the
  // native playbackRate; reverse steps currentTime back on a timer (HTML <video>
  // has no reverse playback).
  const SHUTTLE_MAG = [1, 2, 4] as const;
  let shuttleRate = 0;
  let reverseTimer: number | null = null;

  /** Whichever media element is shown — the <video> in playback mode, else the frame img. */
  function currentMedia(): HTMLElement {
    return videoMode ? video : img;
  }

  /** Seek in the active mode (video playback vs frame extraction). */
  function seek(t: number): void {
    const clamped = clamp(t, 0, state.duration);
    if (videoMode) video.currentTime = clamped;
    else void setT(clamped);
  }

  async function enterVideoMode(): Promise<void> {
    const url = await platform.videoSrc(state.source);
    if (video.src !== url) {
      video.src = url;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener("loadedmetadata", onMeta);
          video.removeEventListener("error", onErr);
        };
        const onMeta = () => {
          cleanup();
          resolve();
        };
        const onErr = () => {
          cleanup();
          reject(new Error(m.errors.previewPlayerFailed));
        };
        video.addEventListener("loadedmetadata", onMeta);
        video.addEventListener("error", onErr);
      });
    }
    videoMode = true;
    img.style.display = "none";
    emptyMsg.style.display = "none";
    video.style.display = "block";
    video.currentTime = state.t;
    syncOverlay();
    drawOverlay();
  }

  /** Leave video mode: pause and hide the player (the frame img takes over again). */
  function exitVideoMode(): void {
    shuttleRate = 0;
    stopReverseLoop();
    if (!video.paused) video.pause();
    videoMode = false;
    video.style.display = "none";
    syncPlayGlyphs(false);
  }

  /** Reflect play/pause state on the (single) transport play button. */
  function syncPlayGlyphs(playing: boolean): void {
    playBtn.innerHTML = playing ? PAUSE_GLYPH : PLAY_GLYPH;
  }

  /** Seek to the nearest scene cut before (dir<0) or after (dir>0) the playhead. */
  function jumpCut(dir: number): void {
    if (!state.sceneCuts.length) return;
    const eps = 1e-3;
    const target =
      dir < 0
        ? state.sceneCuts
            .filter((c) => c < state.t - eps)
            .sort((a, b) => a - b)
            .pop()
        : state.sceneCuts.filter((c) => c > state.t + eps).sort((a, b) => a - b)[0];
    if (target != null) seek(target);
  }

  /** Play glyph reflects "moving" — forward OR reverse shuttle — not the raw paused flag. */
  function reflectShuttleGlyph(): void {
    syncPlayGlyphs(shuttleRate !== 0);
  }

  function stopReverseLoop(): void {
    if (reverseTimer !== null) {
      window.clearInterval(reverseTimer);
      reverseTimer = null;
    }
  }

  /** Apply a shuttle rate: forward via playbackRate, reverse via a step loop, 0 = pause. */
  function setShuttle(rate: number): void {
    shuttleRate = rate;
    if (rate > 0) {
      stopReverseLoop();
      video.playbackRate = rate;
      if (video.paused) void video.play().catch(() => undefined);
    } else if (rate < 0) {
      if (!video.paused) video.pause(); // no native reverse — step currentTime back
      video.playbackRate = 1;
      if (reverseTimer === null) {
        reverseTimer = window.setInterval(() => {
          const next = video.currentTime + shuttleRate / 30; // shuttleRate < 0
          if (next <= 0) {
            video.currentTime = 0;
            setShuttle(0);
            return;
          }
          video.currentTime = next;
        }, 1000 / 30);
      }
    } else {
      stopReverseLoop();
      video.playbackRate = 1;
      if (!video.paused) video.pause();
    }
    reflectShuttleGlyph();
  }

  /**
   * Shuttle in `dir` (+1 forward / −1 reverse). Same direction steps up to the
   * next speed (1→2→4); a new or opposite direction (re)starts at 1×. Enters
   * video mode first, like `togglePlay`.
   */
  async function shuttle(dir: 1 | -1): Promise<void> {
    if (!state.source || !state.dims) return;
    try {
      if (!videoMode) await enterVideoMode();
    } catch (err) {
      setOutput(errMsg(err), "err");
      return;
    }
    let mag = 1;
    if (Math.sign(shuttleRate) === dir) {
      const i = SHUTTLE_MAG.indexOf(Math.abs(shuttleRate) as 1 | 2 | 4);
      mag = SHUTTLE_MAG[Math.min(i + 1, SHUTTLE_MAG.length - 1)]!;
    }
    setShuttle(dir * mag);
  }

  async function togglePlay(): Promise<void> {
    if (!state.source || !state.dims) return;
    try {
      if (!videoMode) await enterVideoMode();
    } catch (err) {
      setOutput(errMsg(err), "err");
      return;
    }
    // Moving (forward, reverse, or natively playing) → stop; else play forward.
    if (shuttleRate !== 0 || !video.paused) setShuttle(0);
    else setShuttle(1);
  }

  video.addEventListener("play", () => reflectShuttleGlyph());
  video.addEventListener("pause", () => reflectShuttleGlyph());
  video.addEventListener("ended", () => setShuttle(0));
  video.addEventListener("timeupdate", () => {
    if (!videoMode) return;
    store.set({ t: video.currentTime });
    tLabel.textContent = `${state.t.toFixed(3)}s`;
    stageTimeTag.textContent = `t = ${state.t.toFixed(3)}s`;
    movePlayhead();
    drawOverlay();
  });
  video.addEventListener("loadedmetadata", () => {
    syncOverlay();
    drawOverlay();
  });

  function syncOverlay(): void {
    if (!state.dims) return;
    const m = currentMedia();
    const rect = m.getBoundingClientRect();
    overlay.width = rect.width;
    overlay.height = rect.height;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.display = "block";
    // Position the overlay exactly over the active media element.
    overlay.style.left = `${m.offsetLeft}px`;
    overlay.style.top = `${m.offsetTop}px`;
    store.set({ displayScale: rect.width / state.dims.width });
  }

  function drawOverlay(): void {
    const ctx = overlay.getContext("2d");
    if (!ctx || !state.dims) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const s = state.displayScale;

    // Content-crop box (dashed) when in content mode.
    if (state.contentMode && state.contentBox) {
      const b = state.contentBox;
      ctx.strokeStyle = "#4ec977";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(b.x * s, b.y * s, b.w * s, b.h * s);
      ctx.setLineDash([]);
    }

    // 9:16 crop box. When an AI track path is set, override the box x with the
    // eased x at the current clip-relative time so the preview follows the
    // subject (the path is in working-region coords; offset by the content box
    // origin when one is active, matching how the engine evaluates it).
    if (state.cropBox) {
      const b: Box =
        hasActiveTrack(state) && state.inPoint != null
          ? { ...state.cropBox, x: trackedBoxX() }
          : state.cropBox;
      const bx = b.x * s;
      const by = b.y * s;
      const bw = b.w * s;
      const bh = b.h * s;
      // Matte everything outside the crop box (all four sides — a punch-in box is
      // smaller than the frame vertically too, not just horizontally).
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, overlay.width, by); // top
      ctx.fillRect(0, by + bh, overlay.width, overlay.height - (by + bh)); // bottom
      ctx.fillRect(0, by, bx, bh); // left
      ctx.fillRect(bx + bw, by, overlay.width - (bx + bw), bh); // right
      ctx.strokeStyle = "#ff7847";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(bx, by, bw, bh);
      // center guideline
      ctx.strokeStyle = "rgba(255,178,122,0.5)";
      ctx.beginPath();
      ctx.moveTo(bx + bw / 2, by);
      ctx.lineTo(bx + bw / 2, by + bh);
      ctx.stroke();
      // Animated-push ghost (#163): the eased window at the playhead, dashed,
      // so the push's motion is visible while scrubbing (the solid box stays
      // the editable capture target).
      const pushKfs = pushKeyframes(state.push, clipLength(state));
      if (pushKfs) {
        const rel = Math.max(0, state.t - (state.inPoint ?? 0));
        const g = pushPreviewBox(pushKfs, rel, contentOrigin());
        ctx.strokeStyle = "#7ab8ff";
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(g.x * s, g.y * s, g.w * s, g.h * s);
        ctx.setLineDash([]);
      }
      // Corner handles signal the box is resizable into a punch-in (hidden while
      // an AI track owns the framing).
      if (cropInteractive()) {
        const hs = 7;
        ctx.fillStyle = "#ff7847";
        for (const [cx, cy] of [
          [bx, by],
          [bx + bw, by],
          [bx, by + bh],
          [bx + bw, by + bh],
        ]) {
          ctx.fillRect(cx! - hs / 2, cy! - hs / 2, hs, hs);
        }
      }
    }

    // Assistant ghost-proposal crop boxes (dashed, preview-only). A proposed 9:16
    // crop (`ghost.crop`) and/or a proposed content crop (`ghost.contentCrop`,
    // "W:H:X:Y") render as dashed accent-2 outlines WITHOUT mutating state —
    // committing happens on Accept. Boxes are in working-region px (offset by the
    // active content box's origin so they land in source-frame coords, matching
    // how the engine and `trackedBoxX` evaluate them).
    if (ghostPreviews.length) {
      const dx = state.contentMode && state.contentBox ? state.contentBox.x : 0;
      const dy = state.contentMode && state.contentBox ? state.contentBox.y : 0;
      const accent2 =
        getComputedStyle(document.documentElement).getPropertyValue("--accent-2").trim() ||
        "#ffb27a";
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = accent2;
      for (const g of ghostPreviews) {
        if (g.crop) {
          ctx.strokeRect((g.crop.x + dx) * s, (g.crop.y + dy) * s, g.crop.w * s, g.crop.h * s);
        }
        if (g.contentCrop) {
          const cc = parseContentCropPx(g.contentCrop);
          if (cc) ctx.strokeRect(cc.x * s, cc.y * s, cc.w * s, cc.h * s);
        }
      }
      ctx.restore();
    }
    drawPreview();
  }

  /** Parse a `W:H:X:Y` content-crop string into a source-px box (null if malformed). */
  /**
   * Render the live 9:16 output preview: draw the current frame cropped to the
   * exact box that would render (the crop box, with the tracked x at the current
   * time when a track path owns the framing) into the phone-shaped canvas, plus
   * optional safe-area guides for the caption/button dead zones.
   */
  function drawPreview(): void {
    if (!previewOn) {
      preview.classList.add("empty");
      return;
    }
    const ctx = previewCanvas.getContext("2d");
    if (!ctx) return;
    const cw = previewCanvas.width;
    const ch = previewCanvas.height;
    ctx.clearRect(0, 0, cw, ch);
    if (!state.dims || !state.cropBox) {
      preview.classList.add("empty");
      return;
    }
    const b: Box =
      hasActiveTrack(state) && state.inPoint != null
        ? { ...state.cropBox, x: trackedBoxX() }
        : state.cropBox;
    try {
      ctx.drawImage(currentMedia() as CanvasImageSource, b.x, b.y, b.w, b.h, 0, 0, cw, ch);
      preview.classList.remove("empty");
    } catch {
      return; // media not yet drawable (no frame loaded) — leave it blank
    }
    // Live zoom: how much the 9:16 crop is punched in vs the full working region.
    const zoom = b.h > 0 ? currentRegion().height / b.h : 1;
    previewTag.textContent = `${zoom.toFixed(1)}×`;
    if (safeAreas) {
      ctx.fillStyle = "rgba(0,0,0,0.34)";
      ctx.fillRect(0, ch * 0.78, cw, ch * 0.22); // bottom caption zone
      ctx.fillRect(cw * 0.86, 0, cw * 0.14, ch); // right button rail
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(0.5, ch * 0.78, cw - 1, ch * 0.22);
      ctx.strokeRect(cw * 0.86, 0.5, cw * 0.14 - 0.5, ch - 1);
      ctx.setLineDash([]);
    }
    drawPreviewCaptions(ctx, cw, ch);
  }

  /**
   * Rough on-canvas approximation of the burned caption: hook above title,
   * placed on the 9-zone grid per text_position (vertical top/center/bottom ×
   * horizontal left/center/right) and styled per the clip's `caption` (fill /
   * outline colour, bold/italic/underline, drop shadow, opaque box, rotation,
   * and the font family when it's a name the browser can render). This is a
   * runtime-visual HINT only — the AUTHORITATIVE render is the engine's libass
   * (`--burn-captions`); spacing/fonts/metrics will differ. The WHAT/WHERE
   * (line list, block geometry, grid anchor, per-line font strings) is the pure
   * `layoutPreviewCaptions` (editor-caption-preview.ts); only the ctx painting
   * lives here.
   */
  function drawPreviewCaptions(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    const cap = state.caption;
    const layout = layoutPreviewCaptions(state.hook, state.title, state.textPosition, cap, cw, ch);
    if (!layout) return;
    const { lines, gap, blockH, top, x, h, hookSize } = layout;

    ctx.save();
    ctx.textAlign = h === "left" ? "left" : h === "right" ? "right" : "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";

    // Rotate the whole block around its anchor (ASS positive angle = CCW).
    if (cap.angle) {
      ctx.translate(x, top + blockH / 2);
      ctx.rotate((-cap.angle * Math.PI) / 180);
      ctx.translate(-x, -(top + blockH / 2));
    }

    // Opaque box behind the block, sized to the widest line.
    if (cap.box) {
      let widest = 0;
      for (const line of lines) {
        ctx.font = line.font;
        widest = Math.max(widest, ctx.measureText(line.text).width);
      }
      const bpad = Math.round(hookSize * 0.18);
      const bx =
        h === "left" ? x - bpad : h === "right" ? x - widest - bpad : x - widest / 2 - bpad;
      ctx.fillStyle = cap.boxColor;
      ctx.fillRect(bx, top - bpad, widest + bpad * 2, blockH + bpad * 2);
    }

    let y = top;
    const drawLine = (line: PreviewCaptionLine): void => {
      const { text, size } = line;
      ctx.font = line.font;
      if (cap.shadow) {
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillText(text, x + Math.round(size * 0.05), y + Math.round(size * 0.05));
        ctx.restore();
      }
      if (!cap.box) {
        ctx.lineWidth = Math.max(2, Math.round(size * 0.14));
        ctx.strokeStyle = cap.outlineColor;
        ctx.strokeText(text, x, y);
      }
      ctx.fillStyle = cap.color;
      ctx.fillText(text, x, y);
      if (cap.underline) {
        const w = ctx.measureText(text).width;
        const ux = h === "left" ? x : h === "right" ? x - w : x - w / 2;
        ctx.fillRect(ux, y + size, w, Math.max(2, Math.round(size * 0.07)));
      }
      y += size + gap;
    };
    for (const line of lines) drawLine(line);
    ctx.restore();
  }

  // ---- dragging ----
  // Hit-test margin (display px) for grabbing a content-box edge/corner.
  const EDGE_MARGIN_PX = 8;

  /**
   * The crop box is directly editable (move/resize) only when no AI track path
   * owns the framing — when a `cropPath` is active the preview box follows it.
   */
  function cropInteractive(): boolean {
    return !hasActiveTrack(state);
  }

  /**
   * The working region the crop box lives in (source px): content box when
   * content-crop mode is active (and drawn), else the full frame. Thin wrapper
   * over the pure `editor-crop` math, reading the editor's live state.
   */
  function cropRegionRect(): { x0: number; y0: number; x1: number; y1: number } {
    return regionRectPure(state.contentMode, state.contentBox, state.dims!);
  }

  /** Reset the crop box to the default FULL-HEIGHT, centered 9:16 of the region. */
  function resetCropBoxFullHeight(): void {
    if (!state.dims) return;
    store.set({ cropBox: fullHeightCropBox(cropRegionRect()) });
  }

  /**
   * The explicit punch-in/zoom window for the current crop box, in WORKING-REGION
   * pixels (relative to the content box origin when one is active) — or null when
   * the box is still full height, in which case the engine should get a plain
   * `crop_offset` (which preserves schedules and auto-track) instead.
   */
  function cropWindowSpec(): ReturnType<typeof cropBoxToWindow> | null {
    if (!state.cropBox || !state.dims) return null;
    const o = contentOrigin();
    const box = o
      ? { ...state.cropBox, x: state.cropBox.x - o.x, y: state.cropBox.y - o.y }
      : state.cropBox;
    return cropWindowSpecPure(box, currentRegion());
  }

  /** Content-box origin when content mode is active (source ↔ region shift). */
  function contentOrigin(): { x: number; y: number } | null {
    return state.contentMode && state.contentBox
      ? { x: state.contentBox.x, y: state.contentBox.y }
      : null;
  }

  /**
   * The CURRENT framing as manifest fields — the ONE place the framing
   * precedence is encoded for emission (addClip and the cover export share it):
   * push (`cropWindowPath`, #163) > AI track (`cropPath`, SPEC §6.9) > punch-in
   * window > keyframe schedule / fixed offset, plus any content crop. Each
   * animated form keeps a sensible static `crop_offset` fallback so the row
   * stays valid if its path is ever stripped.
   *
   * `coverAtT` (a SOURCE time) flattens an armed push to its eased window at
   * that instant — the cover backends take a static window, and a cover is one
   * frame, so this is the render-exact framing for it.
   */
  function framingToSpec(
    coverAtT?: number,
  ): Pick<ClipSpec, "cropWindowPath" | "cropPath" | "cropWindow" | "crop_offset" | "content_crop"> {
    const spec: ReturnType<typeof framingToSpec> = {};
    const win = cropWindowSpec();
    const dur =
      state.inPoint != null && state.outPoint != null
        ? state.outPoint - state.inPoint
        : clipLength(state);
    const pushKfs = pushKeyframes(state.push, dur);
    if (pushKfs && coverAtT != null) {
      const w = easedCropWindowAt(pushKfs, Math.max(0, coverAtT - (state.inPoint ?? 0)));
      spec.cropWindow = { x: w.x, y: w.y, w: w.w, h: w.h };
      spec.crop_offset = "center";
    } else if (pushKfs) {
      spec.cropWindowPath = pushKfs;
      spec.crop_offset = "center";
    } else if (hasActiveTrack(state)) {
      spec.cropPath = state.cropPath!.map((k) => ({ t: k.t, x: k.x }));
      spec.crop_offset = "center";
    } else if (win) {
      // Schedules don't apply to a fixed window, so keyframes are intentionally
      // ignored here; the offset fallback keeps the row framing sensibly.
      spec.cropWindow = win;
      spec.crop_offset = currentOffset();
    } else {
      spec.crop_offset = state.keyframes.length
        ? scheduleToString(state.keyframes)
        : currentOffset();
    }
    if (state.contentMode && state.contentBox && state.contentBox.w > 0) {
      spec.content_crop = contentCropFromBox(state.contentBox);
    }
    return spec;
  }

  /** Cursor hinting the move/resize/draw affordance under the pointer. */
  function hoverCursor(px: number, py: number): string {
    const m = EDGE_MARGIN_PX / state.displayScale;
    if (state.contentMode) {
      const b = state.contentBox;
      if (b && b.w > 2 && b.h > 2) {
        const ed = edgeHits(px, py, b, m);
        if ((ed.l && ed.t) || (ed.r && ed.b)) return "nwse-resize";
        if ((ed.r && ed.t) || (ed.l && ed.b)) return "nesw-resize";
        if (ed.l || ed.r) return "ew-resize";
        if (ed.t || ed.b) return "ns-resize";
        if (insideBox(px, py, b)) return "move";
      }
      return "crosshair"; // empty area → draw a fresh box
    }
    if (state.cropBox && cropInteractive()) {
      const b = state.cropBox;
      const ed = edgeHits(px, py, b, m);
      // Corners (an l/r AND a t/b edge) resize the aspect-locked box → punch-in.
      if ((ed.l || ed.r) && (ed.t || ed.b)) {
        return (ed.l && ed.t) || (ed.r && ed.b) ? "nwse-resize" : "nesw-resize";
      }
      if (insideBox(px, py, b)) return "move";
    }
    return "default";
  }

  let drag: null | {
    startX: number;
    startY: number;
    box: Box;
    mode: "move-crop" | "resize-crop" | "move-content" | "resize-content" | "draw-content";
    edges?: { l: boolean; r: boolean; t: boolean; b: boolean };
  } = null;

  overlay.addEventListener("pointerdown", (e) => {
    if (!state.dims) return;
    const s = state.displayScale;
    const px = e.offsetX / s;
    const py = e.offsetY / s;
    overlay.setPointerCapture(e.pointerId);
    overlay.classList.add("dragging");

    if (state.contentMode) {
      const m = EDGE_MARGIN_PX / s;
      const b = state.contentBox;
      // Grab an existing box (edges → resize, interior → move); only DRAW a fresh
      // box when the press lands outside it (or there is no usable box yet).
      if (b && b.w > 2 && b.h > 2 && insideBox(px, py, b, m)) {
        const edges = edgeHits(px, py, b, m);
        drag =
          edges.l || edges.r || edges.t || edges.b
            ? { startX: px, startY: py, box: { ...b }, mode: "resize-content", edges }
            : { startX: px, startY: py, box: { ...b }, mode: "move-content" };
      } else {
        drag = { startX: px, startY: py, box: { x: px, y: py, w: 0, h: 0 }, mode: "draw-content" };
        state.contentBox = { x: px, y: py, w: 0, h: 0 };
        drawOverlay();
      }
    } else if (state.cropBox && cropInteractive()) {
      const m = EDGE_MARGIN_PX / s;
      const ed = edgeHits(px, py, state.cropBox, m);
      // A corner grab resizes (aspect-locked) → punch-in; anywhere else moves.
      if ((ed.l || ed.r) && (ed.t || ed.b)) {
        drag = {
          startX: px,
          startY: py,
          box: { ...state.cropBox },
          mode: "resize-crop",
          edges: ed,
        };
      } else {
        drag = { startX: px, startY: py, box: { ...state.cropBox }, mode: "move-crop" };
      }
    }
  });

  overlay.addEventListener("pointermove", (e) => {
    if (!state.dims) return;
    const s = state.displayScale;
    const px = e.offsetX / s;
    const py = e.offsetY / s;

    if (!drag) {
      overlay.style.cursor = hoverCursor(px, py);
      return;
    }

    if (drag.mode === "move-crop" && state.cropBox) {
      // Orange 9:16 box: pan within the working region. Horizontal always; also
      // vertical once the box is a punch-in (shorter than full region height).
      // A FRESH box (not in-place x/y writes) so the store sees the change and
      // the readout + overlay render via subscription.
      const r = cropRegionRect();
      const box = { ...state.cropBox };
      box.x = clamp(drag.box.x + (px - drag.startX), r.x0, Math.max(r.x0, r.x1 - box.w));
      if (box.h < r.y1 - r.y0 - 2) {
        box.y = clamp(drag.box.y + (py - drag.startY), r.y0, Math.max(r.y0, r.y1 - box.h));
      }
      store.set({ cropBox: box });
    } else if (drag.mode === "resize-crop" && state.cropBox && drag.edges) {
      store.set({ cropBox: resizeCrop(px, py, drag.box, drag.edges, cropRegionRect()) });
    } else if (drag.mode === "move-content" && state.contentBox) {
      const { w, h } = drag.box;
      const nx = clamp(drag.box.x + (px - drag.startX), 0, state.dims.width - w);
      const ny = clamp(drag.box.y + (py - drag.startY), 0, state.dims.height - h);
      store.set({ contentBox: { x: nx, y: ny, w, h } });
    } else if (drag.mode === "resize-content" && state.contentBox && drag.edges) {
      let left = drag.box.x;
      let top = drag.box.y;
      let right = drag.box.x + drag.box.w;
      let bottom = drag.box.y + drag.box.h;
      if (drag.edges.l) left = clamp(px, 0, right - 4);
      if (drag.edges.r) right = clamp(px, left + 4, state.dims.width);
      if (drag.edges.t) top = clamp(py, 0, bottom - 4);
      if (drag.edges.b) bottom = clamp(py, top + 4, state.dims.height);
      store.set({ contentBox: { x: left, y: top, w: right - left, h: bottom - top } });
    } else if (drag.mode === "draw-content" && state.contentBox) {
      const x0 = Math.min(drag.startX, px);
      const y0 = Math.min(drag.startY, py);
      store.set({
        contentBox: {
          x: clamp(x0, 0, state.dims.width),
          y: clamp(y0, 0, state.dims.height),
          w: clamp(Math.abs(px - drag.startX), 0, state.dims.width),
          h: clamp(Math.abs(py - drag.startY), 0, state.dims.height),
        },
      });
    }
    // Rendering is subscription-driven: each branch's store.set repaints the
    // overlay + readouts exactly once per change (the old trailing drawOverlay
    // and per-branch refresh calls are gone).
  });

  overlay.addEventListener("pointerup", (e) => {
    overlay.releasePointerCapture(e.pointerId);
    overlay.classList.remove("dragging");
    drag = null;
  });

  // Double-click the framing box (normal mode) to undo a punch-in: reset to the
  // default full-height, centered 9:16 window.
  overlay.addEventListener("dblclick", () => {
    if (state.contentMode || !state.cropBox || !cropInteractive()) return;
    resetCropBoxFullHeight();
  });

  /**
   * The working region a `crop_offset` is computed against. Thin wrapper over the
   * pure `editor-offset` math, reading the editor's live state.
   */
  function currentRegion(): Dims {
    return currentRegionPure(state.contentMode, state.contentBox, state.dims!);
  }

  function refreshCropReadout(): void {
    if (!state.cropBox || !state.dims) return;
    const win = cropWindowSpec();
    if (win) {
      const region = currentRegion();
      const zoom = (region.height / win.h).toFixed(2);
      cropReadout.textContent = `${m.framing.punchInPrefix}${win.w}×${win.h} @ (${win.x},${win.y})${m.framing.zoomMid}${zoom}${m.framing.resetSuffix}`;
    } else {
      // Full-height box → plain horizontal crop_offset, relative to the content
      // box when one is active.
      let box = state.cropBox;
      const region = currentRegion();
      if (state.contentMode && state.contentBox) {
        box = { ...state.cropBox, x: state.cropBox.x - state.contentBox.x };
      }
      cropReadout.textContent = `${m.framing.cropOffsetPrefix}${cropBoxToOffset(box, region)}`;
    }
    refreshIO(); // keep the Clip "offset" readout in sync with framing changes
  }

  function refreshContentReadout(): void {
    if (!state.contentMode || !state.contentBox || state.contentBox.w === 0) {
      contentReadout.textContent = m.framing.contentOff;
      return;
    }
    contentReadout.textContent = `${m.framing.contentCropPrefix}${contentCropFromBox(state.contentBox)}`;
  }

  function refreshIO(): void {
    const fmt = (n: number | null) => (n == null ? "—" : `${n.toFixed(3)}s`);
    const dur =
      state.inPoint != null && state.outPoint != null
        ? `${(state.outPoint - state.inPoint).toFixed(3)}s`
        : "—";
    inVal.textContent = fmt(state.inPoint);
    outVal.textContent = fmt(state.outPoint);
    durVal.textContent = dur;
    // The framing mode this clip would render with (mirrors addClip's precedence).
    offsetVal.textContent =
      state.push.start && state.push.end
        ? m.framing.modePush
        : hasActiveTrack(state)
          ? m.framing.modeTrack
          : cropWindowSpec()
            ? m.framing.modePunchIn
            : state.keyframes.length
              ? m.framing.modeSchedule
              : currentOffset();
    const valEl = ioChip.querySelector(".val");
    if (valEl) valEl.textContent = dur;
    renderRegion();
    renderKf(); // keyframe positions are clip-relative to In
    void refreshLoopSeam(); // the seam frames track In/Out while the panel is open
  }

  // Phase 3 (#125): rendering is REACTIVE — `store.set` drives the renders, so
  // mutation sites no longer call the refresh/draw functions by hand. (Direct
  // legacy writes don't notify; they keep their manual calls until their
  // cluster migrates.) The In/Out readout also shows the framing MODE, so it
  // re-renders on framing changes too.
  const any = (changed: ReadonlySet<string>, ...keys: string[]): boolean =>
    keys.some((k) => changed.has(k));
  store.onChange((changed) => {
    if (
      any(changed, "inPoint", "outPoint", "duration", "keyframes", "cropPath", "push", "cropBox")
    ) {
      refreshIO();
    }
    if (any(changed, "cropBox", "contentBox", "contentMode")) refreshCropReadout();
    if (any(changed, "contentBox", "contentMode")) refreshContentReadout();
    if (changed.has("keyframes")) refreshKeyframes();
    if (changed.has("push")) refreshPushReadout();
    if (any(changed, "cropBox", "contentBox", "contentMode", "keyframes", "cropPath", "push")) {
      drawOverlay();
    }
    if (any(changed, "hook", "title", "textPosition", "caption")) drawPreview();
    if (any(changed, "fadeIn", "fadeOut")) refreshFadeHint();
    if (changed.has("clips")) refreshManifest();
  });

  /**
   * Drawn-box x for the AI track preview at the current time. The cropPath x is
   * in working-region pixels; when a content box is active it is relative to
   * that box's origin, so we add it back to land in source-frame coordinates.
   * Clamped into the frame to match `boxCenterToCropX`/`computeCrop`.
   */
  function trackedBoxX(): number {
    if (!state.cropPath || !state.cropBox || !state.dims || state.inPoint == null) {
      return state.cropBox?.x ?? 0;
    }
    return trackedBoxXAt(
      state.cropPath,
      state.cropBox,
      state.dims,
      state.t,
      state.inPoint,
      state.contentMode,
      state.contentBox,
    );
  }

  function currentOffset(): string {
    if (!state.cropBox || !state.dims) return "center";
    return offsetForBox(state.cropBox, state.contentMode, state.contentBox, currentRegion());
  }

  function addKeyframe(): void {
    if (state.inPoint == null) {
      flashErr(m.keyframes.needIn);
      return;
    }
    const rel = Math.max(0, state.t - state.inPoint);
    store.set({ keyframes: [...state.keyframes, { t: round3(rel), offset: currentOffset() }] });
  }

  function refreshKeyframes(): void {
    kfList.innerHTML = "";
    state.keyframes
      .slice()
      .sort((a, b) => a.t - b.t)
      .forEach((kf) => {
        const li = document.createElement("li");
        const span = document.createElement("span");
        span.textContent = `t=${kf.t}s → ${kf.offset}`;
        const del = button("✕", undefined, () => {
          store.set({ keyframes: state.keyframes.filter((k) => k !== kf) });
        });
        li.append(span, del);
        kfList.append(li);
      });
    scheduleReadout.textContent = state.keyframes.length
      ? `${m.keyframes.schedulePrefix}${scheduleToString(state.keyframes)}`
      : m.keyframes.scheduleNoKeyframes;
    renderKf();
  }

  /**
   * Run the AI subject-tracking pipeline for the current shot (In→Out):
   * plan sample times (cut-anchored within range) → ask the backend tracker →
   * smooth into an eased crop path → store it on the draft. Times handed to the
   * tracker and produced on the path are CLIP-RELATIVE (offset from In), and the
   * region is the working region (content box if set, else full frame).
   */
  async function doAutoTrack(): Promise<void> {
    persistAutoTrack();
    if (!state.source || !state.dims) {
      trackStatus.textContent = m.track.statusLoadSource;
      return;
    }
    if (state.inPoint == null || state.outPoint == null) {
      trackStatus.textContent = m.track.statusNeedInOut;
      return;
    }
    if (state.outPoint <= state.inPoint) {
      trackStatus.textContent = m.track.statusOutAfterIn;
      return;
    }
    // First keychain touch happens here (lazily), not at launch — so a user who
    // never uses Auto-track never sees an OS keychain prompt. Reads fresh so a
    // key entered in Settings this session is honored. Absent ⇒ "no key".
    await ensureApiKey();
    if (!apiKey.trim()) {
      trackStatus.textContent = m.track.statusNeedKey;
      return;
    }

    const inPt = state.inPoint;
    const shotEnd = state.outPoint - inPt; // clip-relative shot length
    const region = currentRegion();
    // Scene cuts inside the In/Out range, expressed clip-relative.
    const sceneCuts = state.sceneCuts
      .filter((c) => c > inPt && c < state.outPoint!)
      .map((c) => c - inPt);

    trackBtn.disabled = true;
    // Live elapsed counter + spinner so a long run reads as "working", not frozen.
    let elapsed = 0;
    const renderTrackStatus = () => {
      trackStatus.textContent = `${m.track.statusWorkingPrefix}${elapsed}${m.track.statusWorkingSuffix}`;
    };
    trackStatus.classList.add("working");
    renderTrackStatus();
    const trackTimer = window.setInterval(() => {
      elapsed += 1;
      renderTrackStatus();
    }, 1000);
    try {
      const sampleTimes = planSampleTimes({
        shotStart: 0,
        shotEnd,
        intervalSec: autoTrack.intervalSec,
        sceneCuts,
      });
      const samples = await platform.track({
        sourcePath: state.source,
        region: { width: region.width, height: region.height },
        sampleTimes,
        subjectHint: autoTrack.subjectHint.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        // The shot's In point in source seconds: frames are sampled from here,
        // and the content crop (if any) keeps frames in the working region.
        startSec: inPt,
        contentCrop:
          state.contentMode && state.contentBox && state.contentBox.w > 0
            ? contentCropFromBox(state.contentBox)
            : undefined,
      });
      const path = samplesToCropPath(samples, region);
      if (path.length === 0) {
        store.set({ cropPath: null });
        trackStatus.textContent = m.track.statusNoBoxes;
        setOutput(m.track.noBoxesOutput);
      } else {
        store.set({ cropPath: path });
        trackStatus.textContent = `${m.track.statusOnPrefix}${path.length}${m.track.statusOnSuffix}`;
        setOutput(
          `${m.track.resultPrefix}${path.length}${m.track.resultMid}${samples.length}${m.track.resultSuffix}`,
          "ok",
        );
      }
    } catch (err) {
      store.set({ cropPath: null });
      trackStatus.textContent = m.track.statusFailed;
      setOutput(`${m.track.failedOutputPrefix}${errMsg(err)}`, "err");
    } finally {
      window.clearInterval(trackTimer);
      trackStatus.classList.remove("working");
      trackBtn.disabled = false;
    }
  }

  /** Drop the tracked crop path; revert to the manual crop_offset / schedule. */
  function clearTrack(): void {
    store.set({ cropPath: null });
    trackStatus.textContent = m.track.statusNone;
  }

  // ============================================================
  // AI assistant dock (SPEC §6.7) — the conversational "framing brain".
  // A third rail mode that slides over the inspector: a message log + a composer.
  // The assistant PROPOSES; nothing mutates editor state until the human Accepts.
  // Render only ever STAGES — it never auto-fires (the manual Render button owns
  // the encode). The canvas "ghost" preview is a later PR; this dock handles the
  // conversation, the proposal cards, and committing accepted proposals through
  // the editor's existing state mutations.
  // ============================================================

  /** Whether the assistant rail is showing (inspector hidden when true). */
  let assistantOpen = false;
  /** Multi-turn history threaded into each turn. */
  const assistantHistory: ConversationMessage[] = [];
  /** Pending proposals from the most recent reply (cleared on Discard / new turn). */
  let pendingActions: ProposedAction[] = [];
  /** Step cursor: index of the next single proposal to apply via "Step". */
  let stepIndex = 0;

  /**
   * Build the assistant rail DOM: header (spark + title + close), a scrolling
   * message log, and a footer composer (suggestion chips + textarea + send). The
   * returned object exposes the root plus the imperative pieces the open/turn
   * handlers drive.
   */
  function buildAssistantDock(): {
    el: HTMLElement;
    log: HTMLElement;
    textarea: HTMLTextAreaElement;
    send: HTMLButtonElement;
  } {
    const root = el("div", "fl-assist");
    root.style.display = "none";

    const head = el("div", "fl-assist-h");
    const spark = el("span", "fl-assist-spark");
    spark.innerHTML = ICON_SPARK;
    const headText = el("div");
    const title = el("div", "fl-assist-title");
    title.textContent = m.assistant.title;
    const sub = el("div", "fl-assist-sub");
    sub.textContent = m.assistant.sub;
    headText.append(title, sub);
    const closeBtn = button("", "fl-iconbtn sm", () => closeAssistant());
    closeBtn.innerHTML = ICON_X;
    closeBtn.title = m.assistant.closeTitle;
    closeBtn.style.marginLeft = "auto";
    head.append(spark, headText, closeBtn);

    const log = el("div", "fl-assist-body");

    const foot = el("div", "fl-assist-foot");
    const chips = el("div", "fl-chips");
    const SUGGESTIONS = m.assistant.suggestions;
    for (const s of SUGGESTIONS) {
      const chip = button(s, "fl-chip", () => {
        textarea.value = s;
        textarea.focus();
        syncSend();
      });
      chips.append(chip);
    }
    const composer = el("div", "fl-composer");
    const textarea = document.createElement("textarea");
    textarea.rows = 1;
    textarea.placeholder = m.assistant.composerPlaceholder;
    const send = button("", "fl-send", () => void sendTurn()) as HTMLButtonElement;
    send.innerHTML = ICON_SEND;
    send.disabled = true;
    send.title = m.assistant.sendTitle;
    composer.append(textarea, send);

    const syncSend = () => {
      send.disabled = textarea.value.trim().length === 0;
    };
    textarea.addEventListener("input", syncSend);
    textarea.addEventListener("keydown", (e) => {
      // Enter sends; Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!send.disabled) void sendTurn();
      }
    });

    foot.append(chips, composer);
    root.append(head, log, foot);
    return { el: root, log, textarea, send };
  }

  /** Show the assistant rail (hides the inspector so the viewer stays full-width). */
  function openAssistant(): void {
    assistantOpen = true;
    inspector.style.display = "none";
    dock.el.style.display = "";
    assistantBtn.classList.add("on");
    if (dock.log.childElementCount === 0) greetAssistant();
    dock.textarea.focus();
  }

  /** Hide the assistant rail; restore the inspector. */
  function closeAssistant(): void {
    assistantOpen = false;
    dock.el.style.display = "none";
    inspector.style.display = "";
    assistantBtn.classList.remove("on");
    setGhosts([]); // don't leave dashed previews floating with the rail hidden
  }

  function toggleAssistant(): void {
    if (assistantOpen) closeAssistant();
    else openAssistant();
  }

  /** Seed the log with a one-time greeting (the first time the dock opens). */
  function greetAssistant(): void {
    appendBubble("ai", m.assistant.greeting);
  }

  /** Append a chat bubble (`.fl-msg` + `.fl-bubble`) to the log and scroll to it. */
  function appendBubble(who: "user" | "ai", text: string, warn?: string): HTMLElement {
    const msg = el("div", `fl-msg ${who}`);
    const label = el("div", "who");
    label.textContent = who === "user" ? m.assistant.youLabel : m.assistant.assistantLabel;
    const bubble = el("div", "fl-bubble");
    bubble.textContent = text;
    if (warn) {
      const w = el("span", "warn");
      w.textContent = warn;
      bubble.append(w);
    }
    msg.append(label, bubble);
    dock.log.append(msg);
    dock.log.scrollTop = dock.log.scrollHeight;
    return msg;
  }

  /** A transient "thinking…" bubble; returns a disposer that removes it. */
  function appendThinking(): () => void {
    const msg = el("div", "fl-msg ai");
    const bubble = el("div", "fl-bubble");
    const think = el("div", "fl-think");
    think.innerHTML = "<i></i><i></i><i></i>";
    bubble.append(think);
    msg.append(bubble);
    dock.log.append(msg);
    dock.log.scrollTop = dock.log.scrollHeight;
    return () => msg.remove();
  }

  /**
   * Assemble the per-turn `AssistantContext` from live editor state: the working
   * region (post content-crop), In/Out + duration, detected scene cuts, suggested
   * swells, the resolved models, and the BYOK key (read fresh from the keychain).
   * `source` lets the vision runner extract frames. Returns null with a friendly
   * message when there is no source or no key.
   */
  async function buildAssistantContext(): Promise<
    | { ok: true; ctx: Parameters<ReturnType<typeof createAssistant>["turn"]>[0]["context"] }
    | { ok: false; reason: string }
  > {
    if (!state.source || !state.dims) {
      return { ok: false, reason: m.assistant.needSource };
    }
    // First keychain touch happens here (lazily), not at launch — so a user who
    // never opens the assistant never sees an OS keychain prompt. Reads fresh so
    // a key entered in Settings this session is honored.
    await ensureApiKey();
    if (!apiKey.trim()) {
      return {
        ok: false,
        reason: m.assistant.needKey,
      };
    }
    const region = currentRegion();
    const models = resolveModels(assistantSelection());
    const overlay = loadAssistantOverlay(); // editor's append-only framing preferences
    // Sparse still strip (#40): sample a few frames so the model SEES the footage.
    // System-chosen, bounded by the user's budget; failures degrade to fewer/no stills.
    const stills = await sampleChatStills({
      source: state.source,
      budget: loadChatStillsBudget(),
      inPoint: state.inPoint,
      outPoint: state.outPoint,
      duration: state.duration,
      sceneCuts: state.sceneCuts,
      extractFrame: (source, t) => platform.extractFrame(source, t),
    });
    const ctx = assembleAssistantContext({
      region: { width: region.width, height: region.height },
      source: state.source,
      models,
      apiKey: apiKey.trim(),
      basePrompt: BASE_PROMPT, // the read-only framing brain (prompts/base.md)
      overlay,
      inPoint: state.inPoint,
      outPoint: state.outPoint,
      duration: state.duration,
      sceneCuts: state.sceneCuts,
      swells: state.swells,
      stills,
    });
    return { ok: true, ctx };
  }

  /** Run one assistant turn end-to-end: assemble context → call the model → render. */
  async function sendTurn(): Promise<void> {
    const message = dock.textarea.value.trim();
    if (!message) return;
    dock.textarea.value = "";
    dock.send.disabled = true;
    setGhosts([]); // a new turn supersedes any still-previewing proposals
    appendBubble("user", message);
    assistantHistory.push({ role: "user", text: message });

    const built = await buildAssistantContext();
    if (!built.ok) {
      appendBubble("ai", built.reason);
      assistantHistory.push({ role: "assistant", text: built.reason });
      return;
    }

    const dispose = appendThinking();
    try {
      const assistant = createAssistant({
        selection: assistantSelection(),
        platform,
      });
      const reply: AssistantReply = await assistant.turn({
        message,
        context: built.ctx,
        history: assistantHistory.slice(0, -1), // exclude the just-pushed user line
      });
      dispose();
      renderReply(reply);
      assistantHistory.push({ role: "assistant", text: reply.text });
    } catch (err) {
      dispose();
      const failMsg = `${m.assistant.turnFailedPrefix}${errMsg(err)}`;
      appendBubble("ai", failMsg);
      assistantHistory.push({ role: "assistant", text: failMsg });
    }
  }

  /** Render one reply: prose bubble + grounding chips + proposal cards + action bar. */
  function renderReply(reply: AssistantReply): void {
    const msg = appendBubble("ai", reply.text, reply.warn);
    const bubble = msg.querySelector(".fl-bubble");
    if (bubble && reply.grounding.length) bubble.append(groundingRow(reply.grounding));

    if (bubble && reply.usage) bubble.append(usageRow(reply.usage, reply.costUsd));

    pendingActions = reply.actions.slice();
    stepIndex = 0;
    setGhosts(ghostsFrom(pendingActions, 0));
    if (pendingActions.length) dock.log.append(proposalCard(pendingActions));
    dock.log.scrollTop = dock.log.scrollHeight;
  }

  /**
   * The per-turn usage/cost footer under an AI bubble: exact total tokens plus an
   * estimated USD cost (tokens × a maintained rate table — `assistant/cost.ts`).
   * The dollar figure is omitted when the model's price is unknown; the tooltip
   * breaks down in/out tokens and flags that the cost is an estimate.
   */
  function usageRow(usage: Usage, costUsd?: number): HTMLElement {
    const row = el("div", "fl-usage");
    const tok = el("span", "tok");
    tok.textContent = `${usage.totalTokens.toLocaleString()} ${m.assistant.usageTokens}`;
    row.append(tok);
    if (costUsd != null) {
      const cost = el("span", "cost");
      cost.textContent = `~${fmtUsd(costUsd)}`;
      row.append(cost);
    }
    row.title =
      `${usage.promptTokens.toLocaleString()} ${m.assistant.usageInLabel} + ` +
      `${usage.outputTokens.toLocaleString()} ${m.assistant.usageOutLabel} · ` +
      m.assistant.usageEstNote;
    return row;
  }

  /** "grounded in …" chip row citing the real signals (never audio). */
  function groundingRow(grounding: Grounding[]): HTMLElement {
    const row = el("div", "fl-ground");
    const lab = el("span", "gl");
    lab.textContent = m.assistant.grounded;
    row.append(lab);
    for (const g of grounding) {
      const chip = el("span", "gchip");
      chip.textContent = g.detail ?? `${g.kind} @ ${fmtClock(g.t, true)}`;
      row.append(chip);
    }
    return row;
  }

  /**
   * The proposed-action card: a mono list of `→ fn detail` rows plus an
   * Accept all · Step · Discard bar. Accept applies every commit through the
   * editor's existing mutations; Step applies one at a time; Discard clears the
   * proposals (state untouched). Rows mark `.active` / `.done` / `.skip`.
   */
  function proposalCard(actions: ProposedAction[]): HTMLElement {
    const card = el("div", "fl-prop");
    const h = el("div", "fl-prop-h");
    h.append(document.createTextNode(m.assistant.proposed));
    const n = el("span", "n");
    n.textContent = `${actions.length} ${actions.length === 1 ? m.assistant.actionSingular : m.assistant.actionPlural}`;
    h.append(n);

    const list = el("div", "fl-prop-list");
    const rows: HTMLElement[] = actions.map((a) => {
      const row = el("div", "fl-act");
      const arrow = el("span", "arrow");
      arrow.textContent = m.assistant.arrow;
      const fn = el("span", "fn");
      fn.textContent = a.display.fn;
      const detail = el("span", "detail");
      detail.textContent = a.display.detail;
      const tick = el("span", "tick");
      tick.innerHTML = ICON_CHECK;
      row.append(arrow, fn, detail, tick);
      list.append(row);
      return row;
    });

    const bar = el("div", "fl-prop-bar");
    const acceptBtn = button(m.assistant.acceptAll, "fl-btn primary sm");
    const stepLab = el("span", "step");
    const stepBtn = button(m.assistant.step, "fl-btn sm");
    const discardBtn = button(m.assistant.discard, "fl-btn sm ghost");

    const markActiveStep = () => {
      rows.forEach((r, i) =>
        r.classList.toggle("active", i === stepIndex && stepIndex < actions.length),
      );
      stepLab.textContent = `${Math.min(stepIndex, actions.length)}/${actions.length}`;
    };

    const finish = (note: string, kind: "" | "ok" = "ok") => {
      bar.remove();
      const done = el("div", "fl-applied-note");
      if (kind === "ok") done.innerHTML = ICON_CHECK;
      const span = el("span");
      span.textContent = note;
      done.append(span);
      card.append(done);
    };

    acceptBtn.addEventListener("click", () => {
      let staged = false;
      let applied = 0;
      for (let i = stepIndex; i < actions.length; i++) {
        const a = actions[i]!;
        const res = applyCommit(a.commit);
        rows[i]!.classList.remove("active");
        rows[i]!.classList.add(res.applied ? "done" : "skip");
        if (res.applied) applied++;
        if (res.staged) staged = true;
      }
      stepIndex = actions.length;
      pendingActions = [];
      setGhosts([]); // committed — drop the previews
      finish(
        staged
          ? `${m.assistant.appliedStagedPrefix}${applied}${m.assistant.appliedStagedSuffix}`
          : `${m.assistant.appliedPrefix}${applied}${applied === 1 ? m.assistant.appliedSuffixSingular : m.assistant.appliedSuffixPlural}`,
      );
    });

    stepBtn.addEventListener("click", () => {
      if (stepIndex >= actions.length) return;
      const a = actions[stepIndex]!;
      const res = applyCommit(a.commit);
      rows[stepIndex]!.classList.remove("active");
      rows[stepIndex]!.classList.add(res.applied ? "done" : "skip");
      stepIndex++;
      markActiveStep();
      // Drop the ghost for the just-committed action; keep the rest previewing.
      setGhosts(ghostsFrom(actions, stepIndex));
      if (stepIndex >= actions.length) {
        pendingActions = [];
        finish(m.assistant.steppedThrough);
      }
    });

    discardBtn.addEventListener("click", () => {
      rows.forEach((r) => r.classList.add("skip"));
      pendingActions = [];
      stepIndex = actions.length;
      setGhosts([]); // nothing committed, but the previews go away
      finish(m.assistant.discarded, "");
    });

    bar.append(acceptBtn, stepLab, stepBtn, discardBtn);
    markActiveStep();
    card.append(h, list, bar);
    return card;
  }

  /**
   * Apply ONE accepted commit: the state transition is the pure
   * `applyCommitToState` (editor-commit.ts); this wrapper runs the UI effects
   * it returns, in order, against the closure-bound refresh/draw functions.
   */
  function applyCommit(commit: CommitOp): { applied: boolean; staged: boolean } {
    const res = applyCommitToState(state, commit);
    for (const fx of res.effects) {
      switch (fx.kind) {
        case "refreshIO":
          refreshIO();
          break;
        case "seekToIn":
          void setT(state.inPoint!, true);
          break;
        case "refreshContentReadout":
          refreshContentReadout();
          break;
        case "refreshCropReadout":
          refreshCropReadout();
          break;
        case "drawOverlay":
          drawOverlay();
          break;
        case "detectScenes":
          void doScenes();
          break;
        case "refreshKeyframes":
          refreshKeyframes();
          break;
        case "trackStatus":
          trackStatus.textContent = `${m.assistant.trackFromAssistantPrefix}${fx.count}${m.assistant.trackFromAssistantSuffix}`;
          break;
        case "stagedRender":
          setOutput(m.activity.stagedForRender);
          break;
      }
    }
    return { applied: res.applied, staged: res.staged };
  }

  function addClip(): void {
    clipErr.textContent = "";
    if (!state.source || !state.dims) return flashErr(m.errors.loadSourceFirst);
    if (state.inPoint == null || state.outPoint == null) return flashErr(m.errors.setInOut);
    if (state.outPoint <= state.inPoint) return flashErr(m.errors.outAfterIn);
    // Mirror the engine's early fade validation so the queue never holds a clip
    // the render would reject.
    if (!fadesFit({ fadeIn: state.fadeIn, fadeOut: state.fadeOut }, state.outPoint - state.inPoint))
      return flashErr(m.errors.fadesTooLong);

    const spec: ClipSpec = {
      source_file: state.source,
      in_point: state.inPoint.toFixed(3),
      out_point: state.outPoint.toFixed(3),
    };
    Object.assign(spec, framingToSpec());
    const name = nameInput.value.trim();
    if (name) spec.out_name = name;

    // Caption shot-list data (SPEC §6.5) — carried in the manifest regardless
    // of whether burn-in is enabled at render. Trim; omit empty fields.
    const hook = state.hook.trim();
    const title = state.title.trim();
    if (hook) spec.hook = hook;
    if (title) spec.title = title;
    // Per-clip fades (#165) — sparse: a clip without fades carries neither field.
    Object.assign(spec, fadesToSpec({ fadeIn: state.fadeIn, fadeOut: state.fadeOut }));
    // Omit the default (bottom-center, stored as "bottom") to keep manifests clean.
    if ((hook || title) && state.textPosition !== "bottom") spec.text_position = state.textPosition;
    // Per-clip caption style (omitting engine defaults). Only meaningful with text.
    if (hook || title) {
      const cap = captionStyleToSpec(state.caption);
      if (cap) spec.caption = cap;
    }

    store.set({ clips: [...state.clips, spec] });
    nameInput.value = "";
  }

  let dragFrom: number | null = null;

  function refreshManifest(): void {
    clipList.innerHTML = "";
    state.clips.forEach((spec, i) => {
      // Card is click-to-edit (re-opens the clip), drag-to-reorder, with
      // duplicate + remove actions. The ✕/⧉ buttons stop propagation so they
      // don't trigger the card's edit click.
      const card = el("div", "fl-strip-card edit") as HTMLDivElement;
      card.draggable = true;
      card.title = m.queue.cardEditTitle;
      const thumb = el("div", "fl-thumb");
      void setThumb(thumb, spec.source_file, safeParse(spec.in_point));
      const meta = el("div", "fl-clip-meta");
      const name = el("div", "fl-clip-name");
      name.textContent = spec.out_name || shorten(spec.source_file);
      const sub = el("div", "fl-clip-sub");
      const d = clipDur(spec);
      const dur = d > 0 ? `${d.toFixed(1)}s` : `${spec.in_point}→${spec.out_point}`;
      const framing = spec.cropPath?.length
        ? m.framing.modeTrack
        : spec.cropWindow
          ? m.framing.modePunchIn
          : (spec.crop_offset ?? m.framing.defaultOffset);
      sub.innerHTML = `${dur} · <span style="color:var(--accent-2)">${escapeHtml(framing)}</span>`;
      meta.append(name, sub);

      const dup = el("button", "fl-clip-x") as HTMLButtonElement;
      dup.innerHTML = ICON_COPY;
      dup.title = m.queue.duplicateTitle;
      dup.addEventListener("click", (ev) => {
        ev.stopPropagation();
        store.set({
          clips: [
            ...state.clips.slice(0, i + 1),
            structuredClone(spec),
            ...state.clips.slice(i + 1),
          ],
        });
      });
      const del = el("button", "fl-clip-x") as HTMLButtonElement;
      del.textContent = "✕";
      del.title = m.queue.removeTitle;
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        store.set({ clips: state.clips.filter((_, idx) => idx !== i) });
      });

      card.addEventListener(
        "click",
        () => void openSpec(spec, outdirInput.value.trim() || undefined),
      );
      // HTML5 drag-to-reorder.
      card.addEventListener("dragstart", () => {
        dragFrom = i;
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => {
        dragFrom = null;
        card.classList.remove("dragging");
      });
      card.addEventListener("dragover", (ev) => ev.preventDefault());
      card.addEventListener("drop", (ev) => {
        ev.preventDefault();
        if (dragFrom == null || dragFrom === i) return;
        const moved = state.clips[dragFrom];
        if (moved) {
          const without = state.clips.filter((_, idx) => idx !== dragFrom);
          store.set({ clips: [...without.slice(0, i), moved, ...without.slice(i)] });
        }
      });

      card.append(thumb, meta, dup, del);
      clipList.append(card);
    });
    const total = state.clips.reduce((s, c) => s + clipDur(c), 0);
    queueLabel.innerHTML = state.clips.length
      ? `${escapeHtml(m.queue.queueLabel)} <span class="n">${state.clips.length}</span> · <span class="n">${fmtClock(total, false)}</span>`
      : `${escapeHtml(m.queue.queueLabel)} <span class="n">0</span>`;
    renderBtn.textContent = state.clips.length
      ? `${m.queue.renderN} ${state.clips.length}`
      : m.topbar.render;
    renderBtn.disabled = state.clips.length === 0;
    void saveSessionSoon();
  }

  /** Write to the shared Output panel (render / scene-detect / auto-track). */
  function setOutput(text: string, kind: "" | "ok" | "err" = ""): void {
    lastOutput = { text, kind, outDir: "" };
    if (isTauri) {
      void pushActivity();
      if (kind === "err") void showNativeActivity(); // surface failures
      return;
    }
    // Web build: the in-app floating panel.
    outDirLine.textContent = "";
    logPre.className = kind ? `log ${kind}` : "log";
    logPre.textContent = text;
    if (kind === "err") setActivityOpen(true);
    else if (activityPanel.hidden) activityToggle.classList.add("has-output");
  }

  /** Attach the resolved output directory ("Clips written to …") to the log. */
  function setOutDir(dir: string): void {
    lastOutput = { ...lastOutput, outDir: dir };
    if (isTauri) {
      void pushActivity();
      return;
    }
    outDirLine.textContent = "";
    if (dir) {
      outDirLine.append(document.createTextNode(m.activity.clipsWrittenTo));
      const s = el("span", "stat");
      s.textContent = dir;
      outDirLine.append(s);
    }
  }

  async function doRender(): Promise<void> {
    if (!state.clips.length) return flashErr(m.errors.addAtLeastOne);
    const outdir = outdirInput.value.trim() || (await platform.defaultOutdir());
    saveOutdir(outdir);
    // Pre-flight the output folder so a stale/unwritable path gives a clear
    // message HERE (and keeps the field focused) instead of a raw EACCES from the
    // engine mid-render (issue #58).
    try {
      const check = await platform.checkOutdir(outdir);
      if (!check.ok) {
        setOutput(
          `${m.activity.cantWritePrefix}${check.resolved || outdir} — ${check.error || m.activity.cantWriteFallbackReason}.`,
          "err",
        );
        outdirInput.focus();
        try {
          outdirInput.select();
        } catch {
          /* not selectable — focus is enough */
        }
        return;
      }
    } catch {
      /* checkOutdir itself failed (backend down) — let the render attempt report it. */
    }
    const manifestJson = serializeManifestJSON(state.clips);
    setOutput(m.activity.rendering);
    try {
      const result = await platform.render(manifestJson, renderOptions(outdir));
      setOutput(
        result.log || (result.ok ? m.activity.okNoOutput : m.activity.renderFailed),
        result.ok ? "ok" : "err",
      );
      // Surface the resolved output directory so the clips are findable. The
      // backend echoes the (absolute) outdir it used in the log header.
      const outdirMatch = /--outdir ([^\n]*)/.exec(result.log || "");
      const resolvedOutdir =
        result.ok && outdirMatch && outdirMatch[1]?.trim() ? outdirMatch[1].trim() : outdir;
      if (result.ok && outdirMatch && outdirMatch[1]?.trim()) setOutDir(resolvedOutdir);
      // On success, record each rendered clip to history so it can be re-opened
      // and tweaked later (a render is the meaningful checkpoint).
      if (result.ok) void recordHistory(state.clips, resolvedOutdir);
    } catch (err) {
      setOutput(errMsg(err), "err");
    }
  }

  /** Open the native folder picker and adopt the chosen output directory. */
  async function browseOutdir(): Promise<void> {
    try {
      const picked = await platform.pickDirectory();
      if (!picked) return; // cancelled
      outdirInput.value = picked;
      saveOutdir(picked);
    } catch (err) {
      setOutput(errMsg(err), "err");
    }
  }

  /** Copy `text` to the clipboard, flashing brief confirmation on `btn`. */
  async function copyToClipboard(text: string, btn: HTMLButtonElement): Promise<void> {
    if (!text.trim()) return;
    const idle = btn.textContent || m.activity.copyIdle;
    const done = (ok: boolean) => {
      btn.textContent = ok ? m.activity.copied : m.activity.copyFailed;
      window.setTimeout(() => {
        btn.textContent = idle;
      }, 1200);
    };
    try {
      await navigator.clipboard.writeText(text);
      done(true);
    } catch {
      // Fallback for webviews without async-clipboard access.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        done(ok);
      } catch {
        done(false);
      }
    }
  }

  /** Copy the Output panel log. */
  function copyLog(): void {
    const text = logPre.textContent ?? "";
    if (text === m.activity.placeholder) return;
    void copyToClipboard(text, copyLogBtn);
  }

  async function doScenes(): Promise<void> {
    if (!state.source) return flashErr(m.errors.loadSourceFirst);
    setOutput(m.activity.detectingScenes);
    try {
      const cuts = await platform.scenes(state.source);
      state.sceneCuts = cuts;
      renderCuts();
      setOutput(
        cuts.length
          ? `${m.activity.sceneCutsPrefix}${cuts.join(", ")}${m.activity.sceneCutsSuffix}`
          : m.activity.noScenes,
      );
    } catch (err) {
      setOutput(errMsg(err), "err");
    }
  }

  /**
   * Background scene detection, fired on load: the downscaled scan is cheap, so
   * cuts populate the timeline (ticks, prev/next-cut, auto-track sampling) with no
   * click. Silent — no Activity output, guarded against a superseding load.
   */
  async function autoDetectScenes(source: string): Promise<void> {
    try {
      const cuts = await platform.scenes(source);
      if (state.source !== source) return;
      state.sceneCuts = cuts;
      renderCuts();
    } catch {
      /* non-fatal — the manual Detect scenes button remains. */
    }
  }

  // ---------- render history ----------

  /** Append the just-rendered clips to the persisted history (newest first, capped). */
  async function recordHistory(clips: ClipSpec[], outdir: string): Promise<void> {
    try {
      const existing = await platform.loadHistory();
      const now = Date.now();
      const fresh: HistoryEntry[] = clips.map((spec, i) => ({
        id: `${now}-${i}`,
        ts: now,
        spec: structuredClone(spec),
        outdir,
      }));
      await platform.saveHistory([...fresh, ...existing].slice(0, HISTORY_CAP));
    } catch {
      /* non-fatal — history is a convenience. */
    }
  }

  /**
   * Open a stored clip spec fully into the editor: load its source, then restore
   * In/Out, framing (crop box / punch-in / content box / keyframes / track path)
   * and name via the pure `specToEditorState`. Used by both the history modal and
   * click-to-edit on a queue card — the user can re-frame / re-cut and render.
   */
  async function openSpec(spec: ClipSpec, outdir?: string): Promise<void> {
    srcInput.value = spec.source_file;
    if (outdir) {
      outdirInput.value = outdir;
      saveOutdir(outdir);
    }
    await load();
    if (!state.dims) return; // load failed — the error is already surfaced
    const r = specToEditorState(spec, state.dims);
    // Animated push (#163): rehydrate the captured endpoints from the path's
    // first/last keyframes (v1 authors exactly two; extra mid-keyframes from a
    // hand-written manifest still restore as their endpoints).
    let push: EditorState["push"] = { start: null, end: null };
    if (r.cropWindowPath?.length) {
      const sorted = [...r.cropWindowPath].sort((a, b) => a.t - b.t);
      const strip = (k: (typeof sorted)[number]) => ({ x: k.x, y: k.y, w: k.w, h: k.h });
      push = { start: strip(sorted[0]!), end: strip(sorted[sorted.length - 1]!) };
    }
    // One atomic patch: the clip window + the whole framing cluster render via
    // their subscriptions, once.
    // Caption fields aren't part of specToEditorState (they live untouched in
    // the manifest module); read them straight off the spec for round-trip.
    // The text_position re-normalizes through the parse/join round-trip so any
    // 9-zone value (or a legacy bare keyword) restores cleanly.
    const restored = parseTextPosition(spec.text_position);
    const fades = fadesFromSpec(spec);
    // ONE atomic patch — window, framing, captions, fades; every subscriber
    // renders once.
    store.set({
      inPoint: r.inPoint,
      outPoint: r.outPoint,
      contentMode: r.contentMode,
      contentBox: r.contentBox,
      cropBox: r.cropBox,
      keyframes: r.keyframes,
      cropPath: r.cropPath,
      push,
      hook: spec.hook ?? "",
      title: spec.title ?? "",
      textPosition: joinTextPosition(restored.v, restored.h),
      caption: captionStyleFromSpec(spec.caption),
      fadeIn: fades.fadeIn,
      fadeOut: fades.fadeOut,
    });
    nameInput.value = r.name;
    hookInput.value = state.hook;
    titleCapInput.value = state.title;
    autosize(hookInput);
    autosize(titleCapInput);
    fadeInInput.value = fades.fadeIn > 0 ? String(fades.fadeIn) : "";
    fadeOutInput.value = fades.fadeOut > 0 ? String(fades.fadeOut) : "";
    syncSelectsFromPos();
    syncCaptionControls();
    await setT(r.inPoint, true);
    drawOverlay(); // setT redraws the frame; ensure the overlay lands after it
  }

  /**
   * Render-history modal — extracted to `views/history.ts` (#125 Phase 4).
   * The view owns its DOM/behavior; the editor supplies only the platform and
   * the `openSpec`/`setThumb` callbacks it can't build itself.
   */
  function openHistory(): Promise<void> {
    return openHistoryModal({
      platform,
      openSpec: (spec, outdir) => void openSpec(spec, outdir),
      setThumb: (elm, source, t) => void setThumb(elm, source, t),
    });
  }

  // ---------- session (project) persistence ----------
  let sessionTimer: number | undefined;
  /** Debounced autosave of the working session (source + queue + outdir). */
  function saveSessionSoon(): void {
    if (sessionTimer) window.clearTimeout(sessionTimer);
    sessionTimer = window.setTimeout(() => {
      const data: SessionData = {
        source: state.source,
        outdir: outdirInput.value.trim(),
        clips: state.clips,
        savedAt: Date.now(),
      };
      void platform.saveSession(data).catch(() => undefined);
    }, 600);
  }

  /** On launch, restore the last session: outdir, queue, and re-load the source. */
  async function restoreSession(): Promise<void> {
    let data: SessionData | null;
    try {
      data = await platform.loadSession();
    } catch {
      data = null;
    }
    if (!data) return;
    if (data.outdir) outdirInput.value = data.outdir;
    if (Array.isArray(data.clips) && data.clips.length) {
      store.set({ clips: data.clips });
    }
    if (data.source) {
      srcInput.value = data.source;
      await load(); // re-probe; any error is surfaced but the queue stays intact
    }
  }

  /**
   * Clear everything → first-run: persist an empty session (keeping the chosen
   * destination, a preference not "content"), then reload the editor. A reload is
   * a guaranteed full reset of every in-memory field + the UI, far safer than
   * resetting two dozen state vars and their readouts by hand.
   */
  async function clearAll(): Promise<void> {
    try {
      await platform.saveSession({
        source: "",
        outdir: outdirInput.value.trim(),
        clips: [],
        savedAt: Date.now(),
      });
    } catch {
      /* non-fatal — the reload drops in-memory state regardless */
    }
    location.reload();
  }

  /** Confirm before Clear when there's work to lose; nudges toward Export first. */
  function confirmClear(): void {
    if (!state.source && state.clips.length === 0) return; // nothing to clear
    const backdrop = el("div", "fl-modal-backdrop");
    const modal = el("div", "fl-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", m.clear.title);
    const h = el("div", "fl-modal-h");
    const title = el("span", "fl-label");
    title.style.fontSize = "14px";
    title.textContent = m.clear.title;
    h.append(title);
    const bodyEl = el("div");
    bodyEl.style.cssText = "padding:4px 2px 2px; line-height:1.55; color:var(--muted);";
    bodyEl.textContent = m.clear.body;
    const foot = el("div", "fl-modal-foot");
    const dismiss = (): void => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
    };
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") dismiss();
    }
    const cancelBtn = button(m.clear.cancel, "fl-btn ghost", dismiss);
    const confirmBtn = button(m.clear.confirm, "fl-btn primary danger", () => {
      dismiss();
      void clearAll();
    });
    foot.append(el("span", "fl-spacer"), cancelBtn, confirmBtn);
    modal.append(h, bodyEl, foot);
    backdrop.append(modal);
    document.body.append(backdrop);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) dismiss();
    });
    document.addEventListener("keydown", onKey);
  }

  function flashErr(msg: string): void {
    clipErr.textContent = msg;
  }

  /** Whether the one-time legacy-key migration has been attempted this session. */
  let apiKeyMigrated = false;

  /**
   * LAZILY load the BYOK key: on first need, migrate any legacy inline key into
   * the keychain (one-time, gated — a no-op when there's no legacy key), then
   * read `apiKey` fresh from `secretStore`. Called only when the assistant /
   * Auto-track actually needs the key — NOT at launch — so the native app never
   * shows an OS keychain prompt to users who don't use the AI features. A
   * locked/denied keychain leaves `apiKey` empty (track reports "no key"); the
   * migration keeps the legacy copy for a later attempt.
   */
  async function ensureApiKey(): Promise<void> {
    if (!apiKeyMigrated) {
      apiKeyMigrated = true;
      try {
        await migrateLegacyApiKey(platform);
      } catch {
        /* migration failed (keychain locked, etc.) — key preserved for next run. */
      }
    }
    try {
      apiKey = (await platform.getSecret(GEMINI_API_KEY_SECRET)) ?? "";
    } catch {
      apiKey = "";
    }
  }

  // Initial readouts.
  refreshIO();
  refreshKeyframes();
  refreshManifest();
  refreshRecents();
  // NOTE: the keychain is read lazily (see `ensureApiKey`) on first AI use, not
  // here — launching the app must not trigger an OS keychain prompt.
  void restoreSession();
}

// ---------- small helpers ----------

/** Max number of past renders kept in the history. */
const HISTORY_CAP = 50;
