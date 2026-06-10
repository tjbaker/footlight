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

import { detectSwells, detectOnsets, coverOutName, easedCropWindowAt } from "@core";
import {
  cropBoxToOffset,
  cropBoxToWindow,
  contentCropFromBox,
  scheduleToString,
  serializeManifestJSON,
  specToEditorState,
  type Dims,
  type ClipSpec,
} from "@manifest";
import { planSampleTimes, samplesToCropPath } from "@track";
import type { GhostPreview, CommitOp } from "@assistant-types";
import { platform, platformName } from "./platform/index.js";
import { messages } from "./i18n/index.js";

/** The editor's localized strings (the `editor` namespace of the catalog). */
const m = messages.editor;

import type { HistoryEntry, SessionData } from "./platform/types.js";
import { openSettings, initTheme } from "./settings.js";
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
  errMsg,
  escapeHtml,
  type TextPosV,
  type TextPosH,
} from "./editor-util.js";
import { cropWindowSpec as cropWindowSpecPure } from "./editor-crop.js";
import { currentRegion as currentRegionPure, offsetForBox } from "./editor-offset.js";
import { applyCommitToState } from "./editor-commit.js";
import {
  parseFadeField,
  fadesToSpec,
  fadesFromSpec,
  fadesFit,
  loopSeamTimes,
} from "./editor-fades.js";
import { boxToRegionWindow, pushKeyframes, describePush } from "./editor-push.js";
import { createEditorStore, hasActiveTrack, clipLength, type EditorState } from "./editor-store.js";
import { el, input, textarea, autosize, button, sectionHeader } from "./ui.js";
import {
  ICON_ACTIVITY,
  ICON_BRAND,
  ICON_DOWN,
  ICON_FOLDER,
  ICON_GEAR,
  ICON_HISTORY,
  ICON_MOON,
  ICON_PHONE,
  ICON_PLUS,
  ICON_SPARK,
  ICON_SUN,
  PAUSE_GLYPH,
  PLAY_GLYPH,
} from "./icons.js";
import { openHistoryModal } from "./views/history.js";
import { buildQueueStrip } from "./views/queue.js";
import { buildActivityPanel } from "./views/activity.js";
import { buildAssistantView, type AssistantView } from "./views/assistant.js";
import { buildTimeline } from "./views/timeline.js";
import { buildViewer } from "./views/viewer.js";
import {
  renderOptions,
  loadOutdir,
  saveOutdir,
  loadRecents,
  pushRecent,
  saveTheme,
} from "./editor-prefs.js";

export function mountEditor(root: HTMLElement): void {
  // The EditorStore (#125 Phase 3): `state` stays directly readable everywhere;
  // migrated clusters WRITE through `store.set`, and renders subscribe to the
  // changes instead of being invoked by hand at every mutation site.
  const store = createEditorStore();
  const state = store.state;

  const isTauri = platformName === "tauri";

  // Activity / Output panel (views/activity.ts) — built EARLY so the top bar's
  // activity toggle, the theme toggle (pushTheme), and every `setOutput` call
  // site can reference its handles. The toggle BUTTON stays here; the view
  // reflects its open / has-output state back via onToggleState.
  const activityToggle = button("", "fl-iconbtn");
  activityToggle.innerHTML = ICON_ACTIVITY;
  activityToggle.title = m.topbar.activityTitle;
  const activity = buildActivityPanel({
    isTauri,
    onToggleState: (s) => {
      activityToggle.classList.toggle("on", s.on);
      activityToggle.classList.toggle("has-output", s.hasOutput);
    },
  });
  activityToggle.addEventListener("click", () => {
    if (isTauri) void activity.toggleNative();
    else activity.setOpen(!activity.isOpen());
  });
  const setOutput = activity.setOutput;
  const setOutDir = activity.setOutDir;

  // The AI assistant dock (views/assistant.ts) is built later (its onOpenChange
  // needs the inspector + spark button, created below), but the top bar, the
  // inspector "Ask" button, and the hotkeys reference it — forward-declare so
  // those handlers can call it (they only fire after the view is assigned).
  // eslint-disable-next-line prefer-const -- assigned once, but referenced above its build site.
  let assistant: AssistantView;

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
  const historyBtn = button("", "fl-iconbtn", () => void openHistory());
  historyBtn.innerHTML = ICON_HISTORY;
  historyBtn.title = m.topbar.historyTitle;
  const clearBtn = button(m.topbar.clear, "fl-btn sm ghost", () => confirmClear());
  clearBtn.title = m.topbar.clearTitle;
  const previewBtn = button("", "fl-iconbtn", () => togglePreview());
  previewBtn.innerHTML = ICON_PHONE;
  // The on/off state (persisted) lives in the viewer view; the button mirrors it.
  function reflectPreviewBtn(on: boolean): void {
    previewBtn.classList.toggle("on", on);
    previewBtn.title = on ? m.topbar.previewHide : m.topbar.previewShow;
  }
  function togglePreview(): void {
    reflectPreviewBtn(viewerView.togglePreview());
  }
  // Spark toggles the AI assistant dock — a third rail mode that slides over the
  // Frame / Track-subject inspector (SPEC §6.7). Active state mirrors `.on`.
  const assistantBtn = button("", "fl-iconbtn assistant", () => assistant.toggle());
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
    void activity.pushTheme(); // keep the separate Activity window's theme in sync
  }
  refreshThemeIcon();

  // ===== main: viewer + inspector =====
  const main = el("div", "fl-main");

  // ----- viewer column (views/viewer.ts) -----
  // The view owns the stage — frame/video/overlay/preview + the first-launch
  // onboarding — the overlay/preview painting, and the crop/content drag
  // interaction. The editor keeps the transport (#187 Slice C) and drives the
  // frame/video display through the view's seams; `currentRegion`/
  // `contentOrigin` are the editor's framing wrappers (`framingToSpec` and the
  // readouts share them).
  const viewerView = buildViewer(store, {
    currentRegion: () => currentRegion(),
    contentOrigin: () => contentOrigin(),
    supportsFilePicker: platform.supportsFilePicker,
    onBrowse: () => void browse(),
    onFocusPath: () => {
      srcInput.focus();
      srcInput.scrollIntoView({ block: "nearest" });
    },
  });
  reflectPreviewBtn(viewerView.isPreviewOn());
  // The transport still owns playback (Slice C): the video element and the
  // overlay repaint it triggers on its tick stay reachable as plain locals.
  const video = viewerView.video;
  const drawOverlay = viewerView.drawOverlay;

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
  const viewer = el("div", "fl-viewer");
  viewer.append(viewerView.element, transport);

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
  const askBtn = button("", "fl-btn", () => assistant.open());
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

  // ----- AI assistant dock (views/assistant.ts; slides over the inspector) -----
  // Commits flow back through the editor's applyCommit; proposal "ghost"
  // previews via setGhosts (the viewer owns the drawing); open/close reflects
  // by hiding the inspector + toggling the spark button.
  assistant = buildAssistantView({
    store,
    currentRegion,
    ensureApiKey,
    getApiKey: () => apiKey,
    applyCommit,
    setGhosts,
    onOpenChange: (open) => {
      inspector.style.display = open ? "none" : "";
      assistantBtn.classList.toggle("on", open);
    },
  });

  main.append(viewer, inspector, assistant.element);

  // ===== loudness timeline (views/timeline.ts) =====
  // The view owns the track DOM and all its repaints (wave / cuts / swells /
  // onsets / ruler / region / keyframes / ghosts / playhead), the In/Out
  // drag-trim, the hover thumb, the onset-snap toggle and the cut-jump
  // buttons; the editor supplies seek, the cached frame extractor, and the
  // scene-detect action. `snapT` is the view's (it owns the snap toggle) —
  // aliased here for the I/O mark sites above.
  const timeline = buildTimeline(store, {
    seek: (t) => seek(t),
    extractFrame: (source, t) => extractCached(source, t),
    onDetectScenes: () => void doScenes(),
  });
  const snapT = (t: number): number => timeline.snapT(t);

  /** Replace the pending assistant ghost set and repaint the stage + timeline
   *  previews (each view keeps its own copy; nothing here mutates editor
   *  state — that's the commit's job). */
  function setGhosts(gs: GhostPreview[]): void {
    timeline.renderGhosts(gs);
    viewerView.renderGhosts(gs);
  }

  /**
   * Fetch the source's audio envelopes and push them to the store: the
   * perceptual `display` envelope draws the bars; the raw-energy `detect`
   * envelope feeds the swell heuristic (it surfaces musical dips that
   * perceptually-gated LUFS smooths away on compressed material); the fine
   * `onsetEnvelope` feeds the onset detector behind the In/Out snap toggle and
   * the timeline's beat ticks. The timeline view repaints via its subscription.
   */
  async function loadLoudness(source: string): Promise<void> {
    timeline.setWaveLoading(true);
    try {
      const { display, detect, onsetEnvelope } = await platform.loudness(source);
      if (state.source !== source) return; // a newer load superseded this one
      store.set({
        loudness: display,
        swells: detectSwells(detect, state.duration),
        onsets: detectOnsets(onsetEnvelope ?? []),
      });
    } catch {
      if (state.source !== source) return;
      store.set({ loudness: null, swells: [], onsets: [] });
    }
    timeline.setWaveLoading(false);
  }

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

  // ---- keyboard-first operation ----
  const CROP_NUDGE_PX = 4;

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
      assistant.toggle();
      return;
    }
    if (assistant.isOpen() && e.key === "Escape") {
      assistant.close();
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
          viewerView.nudgeCrop(dir * CROP_NUDGE_PX, 0);
        } else {
          const step = e.shiftKey ? 0.1 : frame;
          if (!timeline.nudgeMarker(dir * step)) seek(state.t + dir * step);
        }
        break;
      }
      case "ArrowUp":
      case "ArrowDown":
        e.preventDefault();
        if (e.altKey) {
          viewerView.nudgeCrop(0, (e.key === "ArrowDown" ? 1 : -1) * CROP_NUDGE_PX);
        } else {
          // NLE convention: ↑/↓ jump to the previous/next scene cut (alias of [ / ]).
          timeline.jumpCut(e.key === "ArrowUp" ? -1 : 1);
        }
        break;
      case "i":
      case "I":
        // Shift+I jumps the playhead to the In point (verify it); I sets it.
        if (e.shiftKey) {
          if (state.inPoint != null) {
            seek(state.inPoint);
            timeline.setSelectedMarker("in");
          }
        } else {
          store.set({ inPoint: snapT(state.t) }); // identity unless onset snap is ON
          timeline.setSelectedMarker("in");
        }
        break;
      case "o":
      case "O":
        if (e.shiftKey) {
          if (state.outPoint != null) {
            seek(state.outPoint);
            timeline.setSelectedMarker("out");
          }
        } else {
          store.set({ outPoint: snapT(state.t) }); // identity unless onset snap is ON
          timeline.setSelectedMarker("out");
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
          timeline.setSelectedMarker("in");
        }
        break;
      case "w":
      case "W":
        if (state.outPoint != null) {
          seek(state.outPoint);
          timeline.setSelectedMarker("out");
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
        timeline.jumpCut(-1);
        break;
      case "]":
        timeline.jumpCut(1);
        break;
      case "Escape":
        timeline.setSelectedMarker(null);
        break;
    }
  });

  // ===== filmstrip queue (views/queue.ts) =====
  // The view owns the card rendering (reacting to `clips`); the editor supplies
  // the thumbnail painter, the open/outdir hooks, and the add/export handlers.
  // The render button + session autosave also react to `clips` — those stay as
  // the editor's own store subscription below, not driven from the view.
  const queueView = buildQueueStrip(store, {
    setThumb: (elm, source, t) => void setThumb(elm, source, t),
    openSpec: (spec, outdir) => void openSpec(spec, outdir),
    getOutdir: () => outdirInput.value.trim(),
    onAdd: () => addClip(),
    onExportJson: () => {
      if (!state.clips.length) return;
      void platform
        .exportTextFile("footlight-manifest.json", serializeManifestJSON(state.clips))
        .catch((err) => setOutput(errMsg(err), "err"));
    },
    onExportCover: () => void doExportCover(),
  });
  const filmstrip = queueView.element;

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

  appEl.append(topbar, main, timeline.element, filmstrip);
  root.append(appEl);

  // The Activity / Output panel (views/activity.ts, built at the top of
  // mountEditor). On the web build its floating panel mounts to the body; on
  // Tauri the log is a separate OS window (no panel to mount).
  if (!isTauri) document.body.append(activity.element);

  // ---- drag-and-drop to load ----
  // Native Tauri gives us real filesystem paths via its dragDrop event; the web
  // build can't (browsers don't expose a dropped file's path), so it shows a hint.
  const setDropActive = (on: boolean) => viewerView.setDropActive(on);
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
        // New source → reset source-specific timeline data; the timeline view
        // repaints reactively (the duration change also redraws its ruler,
        // ticks and playhead).
        sceneCuts: [],
        loudness: null,
        swells: [],
        onsets: [],
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
      viewerView.setLoaded();
      playBtn.disabled = false;
      pushRecent(source);
      refreshRecents();
      saveSessionSoon();
      void loadLoudness(source);
      void autoDetectScenes(source);
      // New source → start in frame mode; drop any previous player source.
      exitVideoMode();
      video.removeAttribute("src");
      // Default 9:16 crop box: full height, centered.
      viewerView.initCropBox();
      await setT(state.t, true);
    } catch (err) {
      dimsLine.innerHTML = `<span class="err-text">${escapeHtml(errMsg(err))}</span>`;
    }
  }

  let frameToken = 0;
  let debounceTimer: number | undefined;

  /** Set current time, fetch the frame (debounced unless immediate). */
  async function setT(t: number, immediate = false): Promise<void> {
    if (!state.dims) return;
    t = clamp(t, 0, state.duration);
    store.set({ t }); // the timeline's playhead follows via its subscription
    tLabel.textContent = `${t.toFixed(3)}s`;
    viewerView.setStageTime(t);
    if (debounceTimer) window.clearTimeout(debounceTimer);
    const fetchFrame = async () => {
      const token = ++frameToken;
      try {
        const url = await platform.extractFrame(state.source, state.t);
        if (token !== frameToken) {
          URL.revokeObjectURL(url);
          return; // a newer request superseded this one
        }
        viewerView.showFrame(url);
      } catch (err) {
        viewerView.showFrameError(errMsg(err));
      }
    };
    if (immediate) await fetchFrame();
    else debounceTimer = window.setTimeout(() => void fetchFrame(), 140);
  }

  // ---- video preview (play with audio to pick In/Out by ear) ----

  // J/K/L shuttle state: 0 stopped, >0 forward ×, <0 reverse ×. Forward uses the
  // native playbackRate; reverse steps currentTime back on a timer (HTML <video>
  // has no reverse playback).
  const SHUTTLE_MAG = [1, 2, 4] as const;
  let shuttleRate = 0;
  let reverseTimer: number | null = null;

  /** Seek in the active mode (video playback vs frame extraction). */
  function seek(t: number): void {
    const clamped = clamp(t, 0, state.duration);
    if (viewerView.isVideoMode()) video.currentTime = clamped;
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
    video.currentTime = state.t;
    viewerView.setVideoMode(true);
  }

  /** Leave video mode: pause and hide the player (the frame img takes over again). */
  function exitVideoMode(): void {
    shuttleRate = 0;
    stopReverseLoop();
    if (!video.paused) video.pause();
    viewerView.setVideoMode(false);
    syncPlayGlyphs(false);
  }

  /** Reflect play/pause state on the (single) transport play button. */
  function syncPlayGlyphs(playing: boolean): void {
    playBtn.innerHTML = playing ? PAUSE_GLYPH : PLAY_GLYPH;
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
      if (!viewerView.isVideoMode()) await enterVideoMode();
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
      if (!viewerView.isVideoMode()) await enterVideoMode();
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
    if (!viewerView.isVideoMode()) return;
    store.set({ t: video.currentTime }); // the timeline's playhead follows
    tLabel.textContent = `${state.t.toFixed(3)}s`;
    viewerView.setStageTime(state.t);
    drawOverlay();
  });

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
    // Explicit (not view-subscription) repaints: assistant commits write
    // In/Out/keyframes directly, without a store notification.
    timeline.renderRegion();
    timeline.renderKf(); // keyframe positions are clip-relative to In
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
    // The overlay/preview repaints on framing + caption changes are the viewer
    // view's own subscription now (views/viewer.ts).
    if (any(changed, "fadeIn", "fadeOut")) refreshFadeHint();
    if (changed.has("clips")) refreshQueueDependents();
  });

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
    timeline.renderKf();
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

  /**
   * The render button's label/disabled state and the session autosave react to
   * the queue too — but they live in the editor (the queue VIEW owns only the
   * cards). Kept as a function so the clips subscription and the initial mount
   * both call it; the queue cards render themselves via the view's own
   * subscription.
   */
  function refreshQueueDependents(): void {
    renderBtn.textContent = state.clips.length
      ? `${m.queue.renderN} ${state.clips.length}`
      : m.topbar.render;
    renderBtn.disabled = state.clips.length === 0;
    void saveSessionSoon();
  }

  /** Write to the shared Output panel (render / scene-detect / auto-track). */
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

  async function doScenes(): Promise<void> {
    if (!state.source) return flashErr(m.errors.loadSourceFirst);
    setOutput(m.activity.detectingScenes);
    try {
      const cuts = await platform.scenes(state.source);
      store.set({ sceneCuts: cuts }); // the timeline's cut markers follow
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
      store.set({ sceneCuts: cuts }); // the timeline's cut markers follow
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
  refreshQueueDependents();
  refreshRecents();
  // NOTE: the keychain is read lazily (see `ensureApiKey`) on first AI use, not
  // here — launching the app must not trigger an OS keychain prompt.
  void restoreSession();
}

// ---------- small helpers ----------

/** Max number of past renders kept in the history. */
const HISTORY_CAP = 50;
