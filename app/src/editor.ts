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

import { TARGET_AR, parseTimestamp, detectSwells, LOUDNESS_BUCKETS, type CropPathKeyframe } from "@core";
import {
  cropBoxToOffset,
  cropBoxToWindow,
  isFullHeightWindow,
  contentCropFromBox,
  scheduleToString,
  serializeManifestJSON,
  specToEditorState,
  type Box,
  type Dims,
  type ClipSpec,
  type CropKeyframe,
} from "@manifest";
import { planSampleTimes, samplesToCropPath } from "@track";
import { resolveModels } from "@model";
import type {
  AssistantReply,
  ProposedAction,
  GhostPreview,
  CommitOp,
  Grounding,
} from "@assistant-types";
import { platform, platformName } from "./platform/index.js";

/**
 * The assistant model the user picked in Settings → AI & models (persisted under
 * `footlight.ai` as `{ provider, model }`), defaulting to Gemini 3.5 Flash. Read
 * fresh per turn so a change in Settings takes effect without a reload.
 */
function assistantSelection(): { assistantModel: { provider: string; model: string } } {
  let assistantModel = { provider: "gemini", model: "gemini-3.5-flash" };
  try {
    const raw = localStorage.getItem("footlight.ai");
    if (raw) {
      const p = JSON.parse(raw) as { provider?: unknown; model?: unknown };
      if (typeof p.provider === "string" && typeof p.model === "string") {
        assistantModel = { provider: p.provider, model: p.model };
      }
    }
  } catch {
    /* fall back to the default */
  }
  return { assistantModel };
}

/** Render flags from Settings → Rendering (persisted under `footlight.render`). */
function renderOptions(outdir: string): RenderOptions {
  const opts: RenderOptions = { outdir };
  try {
    const raw = localStorage.getItem("footlight.render");
    if (raw) {
      const p = JSON.parse(raw) as {
        crf?: unknown;
        preset?: unknown;
        audio?: unknown;
        bitrate?: unknown;
        dryRun?: unknown;
      };
      if (typeof p.crf === "number") opts.crf = p.crf;
      if (typeof p.preset === "string") opts.preset = p.preset;
      if (p.audio === "reencode" && typeof p.bitrate === "string") opts.audioBitrate = p.bitrate;
      if (p.dryRun === true) opts.dryRun = true;
    }
  } catch {
    /* fall back to the engine's own defaults */
  }
  return opts;
}
import type { HistoryEntry, SessionData, RenderOptions } from "./platform/types.js";
import { createAssistant, type ConversationMessage } from "./assistant/index.js";
import { openSettings, initTheme, loadAssistantOverlay } from "./settings.js";
import { BASE_PROMPT } from "./assistant/base-prompt.js";
import { openShortcuts } from "./shortcuts.js";
import {
  loadAutoTrackSettings,
  saveAutoTrackSettings,
  migrateLegacyApiKey,
  easedCropXAt,
  GEMINI_API_KEY_SECRET,
  type AutoTrackSettings,
} from "./autotrack.js";

interface EditorState {
  source: string;
  dims: Dims | null;
  duration: number;
  fps: number;
  cropdetect: string | null;
  t: number;
  inPoint: number | null;
  outPoint: number | null;
  /** 9:16 crop box, in source-pixel coordinates. */
  cropBox: Box | null;
  /** Optional content-crop box (source pixels) when content mode is on. */
  contentBox: Box | null;
  contentMode: boolean;
  keyframes: CropKeyframe[];
  clips: ClipSpec[];
  /** Frame image natural display scale: displayedPx / sourcePx. */
  displayScale: number;
  /**
   * Optional AI subject-tracking crop path (SPEC §6.9). When set, it takes
   * precedence over the manual `crop_offset`/keyframe schedule: the preview box
   * follows it, and `addClip` emits a `cropPath` instead of a `crop_offset`.
   * x values are in working-region pixels (relative to the content box if one
   * is set), t is clip-relative seconds.
   */
  cropPath: CropPathKeyframe[] | null;
  /** Detected scene cuts (seconds) for the current source, if run. */
  sceneCuts: number[];
  /** Normalized loudness envelope (0..1) for the current source, or null. */
  loudness: number[] | null;
  /** Suggested quiet→loud "swell" moments (seconds), derived from loudness. */
  swells: { t: number; label: string }[];
}

const DEFAULT_FPS = 30;

export function mountEditor(root: HTMLElement): void {
  const state: EditorState = {
    source: "",
    dims: null,
    duration: 0,
    fps: DEFAULT_FPS,
    cropdetect: null,
    t: 0,
    inPoint: null,
    outPoint: null,
    cropBox: null,
    contentBox: null,
    contentMode: false,
    keyframes: [],
    clips: [],
    displayScale: 1,
    cropPath: null,
    sceneCuts: [],
    loudness: null,
    swells: [],
  };

  const autoTrack: AutoTrackSettings = loadAutoTrackSettings();
  // The BYOK Gemini key lives in the OS keychain (via `secretStore`), not in the
  // auto-track blob. Hydrated asynchronously at init (see `hydrateApiKey`) and
  // re-read at track time so a key entered in Settings mid-session is picked up.
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
  crumbPath.textContent = "no source loaded";
  crumb.append(crumbDot, crumbPath);

  const actions = el("div", "fl-actions");
  const renderBtn = button("Render", "fl-btn primary", doRender);
  renderBtn.title = "Encode every clip in the queue to 1080×1920 H.264.";
  const activityToggle = button("", "fl-iconbtn", () => {
    if (isTauri) void toggleNativeActivity();
    else setActivityOpen(activityPanel.hidden);
  });
  activityToggle.innerHTML = ICON_ACTIVITY;
  activityToggle.title = "Show render, scene-detect and auto-track output";
  const historyBtn = button("", "fl-iconbtn", () => void openHistory());
  historyBtn.innerHTML = ICON_HISTORY;
  historyBtn.title = "History — re-open a past render to tweak and re-encode";
  const previewBtn = button("", "fl-iconbtn", () => togglePreview());
  previewBtn.innerHTML = ICON_PHONE;
  function togglePreview(): void {
    previewOn = !previewOn;
    savePreviewPref(previewOn);
    previewBtn.classList.toggle("on", previewOn);
    previewBtn.title = previewOn ? "Hide the 9:16 output preview" : "Show the 9:16 output preview";
    drawPreview();
  }
  previewBtn.classList.toggle("on", previewOn);
  previewBtn.title = previewOn ? "Hide the 9:16 output preview" : "Show the 9:16 output preview";
  // Spark toggles the AI assistant dock — a third rail mode that slides over the
  // Frame / Track-subject inspector (SPEC §6.7). Active state mirrors `.on`.
  const assistantBtn = button("", "fl-iconbtn assistant", () => toggleAssistant());
  assistantBtn.innerHTML = ICON_SPARK;
  assistantBtn.title = "AI assistant (A) — propose framing in plain language";
  const themeBtn = button("", "fl-iconbtn", () => toggleTheme());
  const settingsBtn = button("", "fl-iconbtn", () => openSettings());
  settingsBtn.innerHTML = ICON_GEAR;
  settingsBtn.title = "Settings";
  actions.append(renderBtn, previewBtn, assistantBtn, historyBtn, activityToggle, themeBtn, settingsBtn);
  topbar.append(brand, crumb, actions);

  function refreshThemeIcon(): void {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    themeBtn.innerHTML = dark ? ICON_SUN : ICON_MOON;
    themeBtn.title = dark ? "Switch to light theme" : "Switch to dark theme";
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
  stageTag.textContent = "SOURCE";
  const stageTimeTag = el("span", "fl-stage-tag");
  stageTimeTag.textContent = "t = 0.000s";
  stageMeta.append(stageTag, stageTimeTag);
  const emptyMsg = el("div", "fl-stage-center");
  emptyMsg.innerHTML =
    '<div class="fl-hero-h">Your stage, vertical.</div>' +
    '<div class="fl-hero-sub">Footlight turns 16:9 performance video into frame-perfect 9:16 clips — you make every call.</div>' +
    '<div class="fl-hero-cta">Browse… or paste a path to load — then mark, frame, queue, render.</div>';
  const img = document.createElement("img");
  img.id = "frame";
  img.alt = "current frame";
  img.style.display = "none";
  const video = document.createElement("video");
  video.id = "preview-video";
  video.style.display = "none";
  video.preload = "metadata";
  video.playsInline = true;
  const overlay = document.createElement("canvas");
  overlay.id = "overlay";
  overlay.style.display = "none";
  overlay.title = "Drag to reframe · drag a corner to punch-in / zoom · double-click to reset";
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
  previewHead.title = "Drag to move · toggle the preview off in the top bar";
  const previewTag = el("span", "fl-preview-tag mono");
  previewTag.textContent = "1.0×";
  let safeAreas = false;
  const safeToggle = button("guides", "fl-preview-safe", () => {
    safeAreas = !safeAreas;
    safeToggle.classList.toggle("on", safeAreas);
    drawPreview();
  });
  safeToggle.title = "Show TikTok/Reels safe-area guides — the bottom caption + right button zones a platform overlays, so you don't frame the subject where it gets covered";
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
  playBtn.title = "Play with audio to find your In/Out by ear — Set In/Out works while playing";
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
  ioChip.innerHTML = '<span class="lab">in→out</span><span class="val">—</span>';
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
  const frameTab = button("Frame", undefined, () => selectTab("frame"));
  const trackTab = button("", undefined, () => selectTab("track"));
  trackTab.textContent = "Track subject";
  seg.append(frameTab, trackTab);

  // -- Frame tab --
  const framePane = el("div");

  const srcSect = el("div", "fl-sect");
  srcSect.append(sectionHeader("Source"));
  const srcStack = el("div", "fl-stack");
  const srcInput = input("text", "/absolute/path/to/source.mp4");
  srcInput.classList.add("mono");
  srcInput.title = "Type or paste an absolute path and press Enter, or use Browse…";
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
  const loadBtn = button("Load", "fl-btn sm", () => void load());
  const srcField = el("div", "fl-field path");
  srcField.innerHTML = `<span class="ic">${ICON_FOLDER}</span>`;
  srcField.append(srcInput, recentsList);
  const srcRow = el("div", "fl-rowg");
  srcRow.append(srcField);
  if (platform.supportsFilePicker) {
    const browseBtn = button("Browse…", "fl-btn sm", () => void browse());
    browseBtn.style.flex = "none";
    srcRow.append(browseBtn);
  } else {
    loadBtn.style.flex = "none";
    srcRow.append(loadBtn);
  }
  const dimsLine = el("div", "hint");
  dimsLine.textContent = "Not loaded.";
  const cropdetectLine = el("div", "hint");
  const outdirInput = input("text", "clips");
  outdirInput.classList.add("mono");
  outdirInput.value = loadOutdir();
  outdirInput.title = "Folder where rendered clips are written.";
  outdirInput.addEventListener("change", () => {
    saveOutdir(outdirInput.value);
    saveSessionSoon();
  });
  const destField = el("div", "fl-field path");
  destField.innerHTML = `<span class="ic">${ICON_DOWN}</span>`;
  destField.append(outdirInput);
  const destRow = el("div", "fl-rowg");
  destRow.append(destField);
  if (platform.supportsFilePicker) {
    const browseDest = button("Browse…", "fl-btn sm", () => void browseOutdir());
    browseDest.style.flex = "none";
    destRow.append(browseDest);
  }
  srcStack.append(srcRow, dimsLine, cropdetectLine, destRow);
  srcSect.append(srcStack);

  const clipSect = el("div", "fl-sect");
  clipSect.append(sectionHeader("Clip"));
  const ioRow = el("div", "fl-rowg");
  ioRow.style.marginBottom = "12px";
  const setInBtn = button("", "fl-btn", () => {
    state.inPoint = state.t;
    refreshIO();
  });
  setInBtn.innerHTML = '<span class="idot in"></span>Set In';
  setInBtn.title = "Mark the clip start at the current frame.";
  const setOutBtn = button("", "fl-btn", () => {
    state.outPoint = state.t;
    refreshIO();
  });
  setOutBtn.innerHTML = '<span class="idot out"></span>Set Out';
  setOutBtn.title = "Mark the clip end at the current frame.";
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
    readCell(dotSpan("in"), kSpan("in"), inVal),
    readCell(dotSpan("out"), kSpan("out"), outVal),
    readCell(dotSpan("dur"), kSpan("dur"), durVal),
    readCell(kSpan("offset"), offsetVal),
  );
  clipSect.append(ioRow, ioGrid);

  const framingSect = el("div", "fl-sect");
  framingSect.append(sectionHeader("Framing"));
  const cropReadout = el("div", "fl-readout");
  cropReadout.textContent = "crop_offset: (load a source)";
  framingSect.append(cropReadout);
  // content-crop omitted from the UI (engine still supports it via the manifest);
  // contentReadout stays so the inert content-crop code paths keep compiling.
  const contentReadout = el("div", "hint");
  contentReadout.textContent = "content_crop: (off)";

  const kfSect = el("div", "fl-sect");
  kfSect.append(sectionHeader("Moving crop — keyframes"));
  const kfRow = el("div", "fl-rowg");
  kfRow.style.marginBottom = "10px";
  const addKfBtn = button("Add keyframe", "fl-btn sm", addKeyframe);
  addKfBtn.title = "Record the current time + box position as a crop switch point.";
  const clearKfBtn = button("Clear", "fl-btn sm ghost", () => {
    state.keyframes = [];
    refreshKeyframes();
  });
  kfRow.append(addKfBtn, clearKfBtn);
  const kfList = el("ul", "fl-kf-list") as HTMLUListElement;
  const scheduleReadout = el("div", "fl-readout");
  scheduleReadout.style.marginTop = "8px";
  scheduleReadout.textContent = "schedule: (none)";
  kfSect.append(kfRow, kfList, scheduleReadout);

  const addSect = el("div", "fl-sect");
  addSect.append(sectionHeader("Add to queue"));
  const nameField = el("div", "fl-field");
  nameField.style.marginBottom = "12px";
  const nameInput = input("text", "out_name (optional, e.g. chorus_closeup)");
  nameInput.classList.add("mono");
  nameField.append(nameInput);
  const addClipBtn = button("", "fl-btn lg primary", addClip);
  addClipBtn.innerHTML = `${ICON_PLUS}Add clip → queue`;
  addClipBtn.title = "Add the current In/Out + framing to the queue.";
  const clipErr = el("div", "err-text");
  addSect.append(nameField, addClipBtn, clipErr);

  framePane.append(srcSect, clipSect, framingSect, kfSect, addSect);

  // -- Track tab (auto-track) --
  const trackPane = el("div");
  const trackSect = el("div", "fl-sect");
  trackSect.append(sectionHeader("Track subject"));
  const trackHelp = el("div", "fl-help");
  trackHelp.textContent =
    "Opt-in. Pans to follow a subject across one shot. Set your Gemini key in Settings.";
  const hintField = el("div", "fl-field");
  hintField.style.marginBottom = "10px";
  const hintInput = input("text", 'subject, e.g. "the person playing guitar"');
  hintInput.classList.add("mono");
  hintInput.value = autoTrack.subjectHint;
  hintField.append(hintInput);
  const intervalField = el("div", "fl-field");
  intervalField.style.cssText = "justify-content:space-between; margin-bottom:12px;";
  const intervalInput = input("number", "0.75");
  intervalInput.value = String(autoTrack.intervalSec);
  intervalInput.step = "0.05";
  intervalInput.min = "0.05";
  intervalInput.classList.add("mono");
  intervalInput.style.maxWidth = "90px";
  const intervalLab = el("span", "hint");
  intervalLab.textContent = "interval (s)";
  intervalField.append(intervalLab, intervalInput);
  const trackBtnRow = el("div", "fl-rowg");
  const trackBtn = button("Auto-track", "fl-btn primary", () => void doAutoTrack());
  trackBtn.title = "Track the subject across the In/Out shot and build an eased crop path.";
  const clearTrackBtn = button("Clear track", "fl-btn ghost", clearTrack);
  clearTrackBtn.title = "Discard the tracked path; revert to manual framing.";
  trackBtnRow.append(trackBtn, clearTrackBtn);
  const trackStatus = el("div", "fl-readout");
  trackStatus.style.marginTop = "10px";
  trackStatus.textContent = "track: (none — manual crop_offset in use)";
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
  askBtn.innerHTML = `${ICON_SPARK}Ask the assistant…`;
  askBtn.title = "Open the AI assistant to propose framing in plain language";
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
  tlPrevCut.title = "Jump to previous cut";
  const tlNextCut = button("", "fl-iconbtn", () => jumpCut(1));
  tlNextCut.innerHTML = ICON_NEXT_CUT;
  tlNextCut.title = "Jump to next cut";
  tlCluster.append(tlPrevCut, tlNextCut);

  const tlCol = el("div", "fl-tl-col");
  const suggestLane = el("div", "fl-tl-suggest");
  const suggestTag = el("span", "fl-suggest-tag");
  suggestTag.innerHTML = '<span class="sparkdot"></span>suggested';
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
  cutsChip.innerHTML = '<span class="lab">cuts</span><span class="val">0</span>';
  const swellsChip = el("span", "fl-rdchip swell");
  swellsChip.innerHTML = '<span class="lab">swells</span><span class="val">0</span>';
  const scenesBtn = button("Detect scenes", "fl-btn sm", doScenes);
  scenesBtn.title = "Detect scene cuts — align keyframe switch times to these.";
  tlInfo.append(cutsChip, swellsChip, scenesBtn);

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
      chip.title = `Seek to just before this swell (${fmtClock(sw.t, true)})`;
      suggestLane.append(chip);
      const mark = el("div", "fl-tl-suggest-mark");
      mark.style.left = pct(sw.t);
      tlMarksLayer.append(mark);
    });
    const v = swellsChip.querySelector(".val");
    if (v) v.textContent = String(state.swells.length);
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
   * Fetch the source's two loudness envelopes and update the timeline: the
   * perceptual `display` envelope draws the bars; the raw-energy `detect`
   * envelope feeds the swell heuristic (it surfaces musical dips that
   * perceptually-gated LUFS smooths away on compressed material).
   */
  async function loadLoudness(source: string): Promise<void> {
    renderWave(true);
    try {
      const { display, detect } = await platform.loudness(source);
      if (state.source !== source) return; // a newer load superseded this one
      state.loudness = display;
      state.swells = detectSwells(detect, state.duration);
    } catch {
      if (state.source !== source) return;
      state.loudness = null;
      state.swells = [];
    }
    renderWave(false);
    renderSwells();
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
      state.inPoint = round3(clamp(state.inPoint + delta, 0, state.outPoint ?? state.duration));
      refreshIO();
      seek(state.inPoint);
      return true;
    }
    if (selectedMarker === "out" && state.outPoint != null) {
      state.outPoint = round3(clamp(state.outPoint + delta, state.inPoint ?? 0, state.duration));
      refreshIO();
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
      tlTrack.style.cursor = d && (d.inPx <= TL_EDGE_PX || d.outPx <= TL_EDGE_PX) ? "ew-resize" : "pointer";
      showHoverThumb(e.clientX);
      return;
    }
    hideHoverThumb(); // dragging: the playhead/region is the feedback, not the thumb
    const t = tlTimeAt(e.clientX);
    if (tlDrag === "region") {
      if (!tlMoved && Math.abs(e.clientX - tlDownX) < 3) return; // not yet a drag
      tlMoved = true;
      state.inPoint = round3(Math.min(regionAnchor, t));
      state.outPoint = round3(Math.max(regionAnchor, t));
      refreshIO();
      seek(t);
    } else if (tlDrag === "in") {
      state.inPoint = round3(clamp(t, 0, state.outPoint ?? state.duration));
      refreshIO();
      seek(t);
    } else if (tlDrag === "out") {
      state.outPoint = round3(clamp(t, state.inPoint ?? 0, state.duration));
      refreshIO();
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
      void extractCached(state.source, Math.round(t * 2) / 2).then((url) => {
        if (token === hoverToken) tlHoverImg.src = url;
      }, () => undefined);
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
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
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
        if (e.altKey) {
          e.preventDefault();
          nudgeCrop(0, (e.key === "ArrowDown" ? 1 : -1) * CROP_NUDGE_PX);
        }
        break;
      case "i":
      case "I":
        state.inPoint = state.t;
        refreshIO();
        setSelectedMarker("in");
        break;
      case "o":
      case "O":
        state.outPoint = state.t;
        refreshIO();
        setSelectedMarker("out");
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
  queueLabel.innerHTML = 'Queue <span class="n">0</span>';
  const clipList = el("div");
  clipList.style.display = "contents";
  const addCard = el("div", "fl-strip-card add");
  addCard.textContent = "+ add clip";
  addCard.addEventListener("click", () => addClip());
  const fsSpacer = el("span", "fl-spacer");
  const copyManifestBtn = button("", "fl-btn sm ghost", () => {
    if (state.clips.length) void copyToClipboard(serializeManifestJSON(state.clips), copyManifestBtn);
  });
  copyManifestBtn.innerHTML = `${ICON_COPY}Copy JSON`;
  copyManifestBtn.style.alignSelf = "center";
  copyManifestBtn.title = "Copy the queue JSON to the clipboard";
  filmstrip.append(queueLabel, clipList, addCard, fsSpacer, copyManifestBtn);

  appEl.append(topbar, main, timeline, filmstrip);
  root.append(appEl);

  // Activity / Output — a toggleable floating window so render,
  // scene-detect and auto-track output is available on demand without taking
  // permanent space in the main UI. Hidden by default; auto-opens on errors.
  const activityPanel = el("div", "activity");
  activityPanel.hidden = true;
  const activityHead = el("div", "activity-head");
  const activityTitle = el("div", "activity-title");
  activityTitle.textContent = "Activity";
  const outDirLine = el("div", "hint");
  const copyLogBtn = button("⧉ Copy", "iconbtn", () => void copyLog());
  copyLogBtn.title = "Copy the output to the clipboard";
  const closeActivityBtn = button("✕", "iconbtn", () => setActivityOpen(false));
  closeActivityBtn.title = "Hide the activity window";
  activityHead.append(activityTitle, outDirLine, copyLogBtn, closeActivityBtn);
  const logPre = document.createElement("pre");
  logPre.className = "log";
  logPre.textContent = "(output appears here)";
  activityPanel.append(activityHead, logPre);

  // Always-visible toggle (bottom-right) that shows/hides the activity window.
  // On the native app the Activity log is a SEPARATE OS window (created in Rust);
  // on the web build it's the in-app floating panel above. lastOutput is the
  // shared data model, replayed to the native window when it opens.
  const isTauri = platformName === "tauri";
  let lastOutput: { text: string; kind: "" | "ok" | "err"; outDir: string } = {
    text: "(output appears here)",
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
        dimsLine.innerHTML =
          '<span class="err-text">Drag-drop loads files in the desktop app — paste the absolute path above.</span>';
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
      dimsLine.innerHTML =
        '<span class="err-text">Enter an absolute path to a source file, then click Load.</span>';
      srcInput.focus();
      return;
    }
    dimsLine.textContent = "Probing…";
    cropdetectLine.textContent = "";
    try {
      const p = await platform.probe(source);
      state.source = source;
      state.dims = { width: p.width, height: p.height };
      state.duration = p.duration;
      state.cropdetect = p.cropdetect;
      state.t = Math.min(state.t, p.duration);
      dimsLine.innerHTML =
        '<div class="fl-readgrid">' +
        `<div><span class="k">dim</span><span class="v">${p.width}×${p.height}</span></div>` +
        `<div><span class="k">dur</span><span class="v">${p.duration.toFixed(2)}s</span></div>` +
        `<div><span class="k">ar</span><span class="v">${(p.width / p.height).toFixed(3)}</span></div>` +
        "</div>";
      cropdetectLine.textContent = p.cropdetect
        ? `cropdetect (black bars only): crop=${p.cropdetect}`
        : "cropdetect: no black bars detected (colored/blurred pillarbox is invisible to it — eyeball the frame).";
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
      renderRuler();
      renderCuts();
      renderSwells();
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
      state.cropBox = { x: Math.floor(maxX / 2), y: 0, w: cw, h: height };
    } else {
      // Taller than 9:16: full width, crop height.
      const ch = roundEvenLocal(width / TARGET_AR);
      state.cropBox = { x: 0, y: Math.floor((height - ch) / 2), w: width, h: ch };
    }
    // Default content box covers the full frame.
    state.contentBox = { x: 0, y: 0, w: width, h: height };
    refreshCropReadout();
  }

  let frameToken = 0;
  let debounceTimer: number | undefined;

  /** Set current time, fetch the frame (debounced unless immediate). */
  async function setT(t: number, immediate = false): Promise<void> {
    if (!state.dims) return;
    t = clamp(t, 0, state.duration);
    state.t = t;
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
          reject(new Error("the preview player could not load this source"));
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
        ? state.sceneCuts.filter((c) => c < state.t - eps).sort((a, b) => a - b).pop()
        : state.sceneCuts.filter((c) => c > state.t + eps).sort((a, b) => a - b)[0];
    if (target != null) seek(target);
  }

  async function togglePlay(): Promise<void> {
    if (!state.source || !state.dims) return;
    try {
      if (!videoMode) await enterVideoMode();
    } catch (err) {
      setOutput(errMsg(err), "err");
      return;
    }
    if (video.paused) await video.play().catch(() => undefined);
    else video.pause();
  }

  video.addEventListener("play", () => syncPlayGlyphs(true));
  video.addEventListener("pause", () => syncPlayGlyphs(false));
  video.addEventListener("timeupdate", () => {
    if (!videoMode) return;
    state.t = video.currentTime;
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
    state.displayScale = rect.width / state.dims.width;
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
        state.cropPath && state.cropPath.length > 0 && state.inPoint != null
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
  function parseContentCropPx(str: string): Box | null {
    const parts = str.split(":").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [w, h, x, y] = parts as [number, number, number, number];
    return { x, y, w, h };
  }

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
      state.cropPath && state.cropPath.length > 0 && state.inPoint != null
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
  }

  // ---- dragging ----
  // Hit-test margin (display px) for grabbing a content-box edge/corner.
  const EDGE_MARGIN_PX = 8;

  /** Which edges of `b` the point (px,py) is within `m` source-px of. */
  function edgeHits(px: number, py: number, b: Box, m: number) {
    const withinX = px >= b.x - m && px <= b.x + b.w + m;
    const withinY = py >= b.y - m && py <= b.y + b.h + m;
    return {
      l: withinY && Math.abs(px - b.x) <= m,
      r: withinY && Math.abs(px - (b.x + b.w)) <= m,
      t: withinX && Math.abs(py - b.y) <= m,
      b: withinX && Math.abs(py - (b.y + b.h)) <= m,
    };
  }

  /** True when (px,py) is inside `b`, expanded by margin `m`. */
  function insideBox(px: number, py: number, b: Box, m = 0): boolean {
    return px >= b.x - m && px <= b.x + b.w + m && py >= b.y - m && py <= b.y + b.h + m;
  }

  // Smallest crop-box height (source px) a punch-in resize allows — keeps the
  // derived 9:16 width sane and the upscale from going absurd.
  const MIN_CROP_H = 80;

  /**
   * The crop box is directly editable (move/resize) only when no AI track path
   * owns the framing — when a `cropPath` is active the preview box follows it.
   */
  function cropInteractive(): boolean {
    return !(state.cropPath && state.cropPath.length > 0);
  }

  /**
   * The working region the crop box lives in, in SOURCE-pixel coordinates:
   * the content box when content-crop mode is active (and drawn), else the full
   * frame. Used to clamp moves/resizes and to know what "full height" means.
   */
  function cropRegionRect(): { x0: number; y0: number; x1: number; y1: number } {
    if (
      state.contentMode &&
      state.contentBox &&
      state.contentBox.w > 2 &&
      state.contentBox.h > 2
    ) {
      const b = state.contentBox;
      return { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
    }
    return { x0: 0, y0: 0, x1: state.dims!.width, y1: state.dims!.height };
  }

  /**
   * Aspect-locked (9:16) corner resize of the crop box. `start.edges` says which
   * corner is grabbed; the diagonally opposite corner is the fixed anchor. Height
   * drives the lock (`w = even(h * 9/16)`); the box is clamped to MIN_CROP_H and
   * to the room available inside the working region so it can never leave frame.
   */
  function resizeCrop(px: number, py: number, start: NonNullable<typeof drag>): Box {
    const box = start.box;
    const ed = start.edges!;
    const r = cropRegionRect();
    const anchorX = ed.l ? box.x + box.w : box.x;
    const anchorY = ed.t ? box.y + box.h : box.y;
    const dirX = ed.l ? -1 : 1;
    const dirY = ed.t ? -1 : 1;
    // Candidate height: satisfy the pointer on whichever axis pulls harder.
    let h = Math.max(Math.abs(py - anchorY), Math.abs(px - anchorX) / TARGET_AR);
    const roomY = dirY > 0 ? r.y1 - anchorY : anchorY - r.y0;
    const roomX = dirX > 0 ? r.x1 - anchorX : anchorX - r.x0;
    h = Math.min(h, roomY, roomX / TARGET_AR);
    h = Math.max(h, MIN_CROP_H);
    h = roundEvenLocal(h);
    const w = roundEvenLocal(h * TARGET_AR);
    const x = dirX > 0 ? anchorX : anchorX - w;
    const y = dirY > 0 ? anchorY : anchorY - h;
    return { x, y, w, h };
  }

  /** Reset the crop box to the default FULL-HEIGHT, centered 9:16 of the region. */
  function resetCropBoxFullHeight(): void {
    if (!state.dims) return;
    const r = cropRegionRect();
    const rw = r.x1 - r.x0;
    const rh = r.y1 - r.y0;
    if (rw / rh >= TARGET_AR) {
      const cw = roundEvenLocal(rh * TARGET_AR);
      const maxX = rw - cw;
      state.cropBox = { x: r.x0 + Math.floor(maxX / 2), y: r.y0, w: cw, h: roundEvenLocal(rh) };
    } else {
      const ch = roundEvenLocal(rw / TARGET_AR);
      state.cropBox = { x: r.x0, y: r.y0 + Math.floor((rh - ch) / 2), w: roundEvenLocal(rw), h: ch };
    }
    refreshCropReadout();
    drawOverlay();
  }

  /**
   * The explicit punch-in/zoom window for the current crop box, in WORKING-REGION
   * pixels (relative to the content box origin when one is active) — or null when
   * the box is still full height, in which case the engine should get a plain
   * `crop_offset` (which preserves schedules and auto-track) instead.
   */
  function cropWindowSpec(): ReturnType<typeof cropBoxToWindow> | null {
    if (!state.cropBox || !state.dims) return null;
    const region = currentRegion();
    let box = state.cropBox;
    if (state.contentMode && state.contentBox) {
      box = {
        ...state.cropBox,
        x: state.cropBox.x - state.contentBox.x,
        y: state.cropBox.y - state.contentBox.y,
      };
    }
    if (isFullHeightWindow(box, region)) return null;
    return cropBoxToWindow(box, region);
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

  let drag:
    | null
    | {
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
        drag = { startX: px, startY: py, box: { ...state.cropBox }, mode: "resize-crop", edges: ed };
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
      const r = cropRegionRect();
      const nx = drag.box.x + (px - drag.startX);
      state.cropBox.x = clamp(nx, r.x0, Math.max(r.x0, r.x1 - state.cropBox.w));
      if (state.cropBox.h < r.y1 - r.y0 - 2) {
        const ny = drag.box.y + (py - drag.startY);
        state.cropBox.y = clamp(ny, r.y0, Math.max(r.y0, r.y1 - state.cropBox.h));
      }
      refreshCropReadout();
    } else if (drag.mode === "resize-crop" && state.cropBox && drag.edges) {
      state.cropBox = resizeCrop(px, py, drag);
      refreshCropReadout();
    } else if (drag.mode === "move-content" && state.contentBox) {
      const { w, h } = drag.box;
      const nx = clamp(drag.box.x + (px - drag.startX), 0, state.dims.width - w);
      const ny = clamp(drag.box.y + (py - drag.startY), 0, state.dims.height - h);
      state.contentBox = { x: nx, y: ny, w, h };
      refreshContentReadout();
    } else if (drag.mode === "resize-content" && state.contentBox && drag.edges) {
      let left = drag.box.x;
      let top = drag.box.y;
      let right = drag.box.x + drag.box.w;
      let bottom = drag.box.y + drag.box.h;
      if (drag.edges.l) left = clamp(px, 0, right - 4);
      if (drag.edges.r) right = clamp(px, left + 4, state.dims.width);
      if (drag.edges.t) top = clamp(py, 0, bottom - 4);
      if (drag.edges.b) bottom = clamp(py, top + 4, state.dims.height);
      state.contentBox = { x: left, y: top, w: right - left, h: bottom - top };
      refreshContentReadout();
    } else if (drag.mode === "draw-content" && state.contentBox) {
      const x0 = Math.min(drag.startX, px);
      const y0 = Math.min(drag.startY, py);
      state.contentBox = {
        x: clamp(x0, 0, state.dims.width),
        y: clamp(y0, 0, state.dims.height),
        w: clamp(Math.abs(px - drag.startX), 0, state.dims.width),
        h: clamp(Math.abs(py - drag.startY), 0, state.dims.height),
      };
      refreshContentReadout();
    }
    drawOverlay();
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


  function currentRegion(): Dims {
    // crop_offset is computed relative to the content region if one is set.
    if (state.contentMode && state.contentBox && state.contentBox.w > 0) {
      return { width: state.contentBox.w, height: state.contentBox.h };
    }
    return state.dims!;
  }

  function refreshCropReadout(): void {
    if (!state.cropBox || !state.dims) return;
    const win = cropWindowSpec();
    if (win) {
      const region = currentRegion();
      const zoom = (region.height / win.h).toFixed(2);
      cropReadout.textContent = `punch-in: ${win.w}×${win.h} @ (${win.x},${win.y}) · zoom ${zoom}× · double-click to reset`;
    } else {
      // Full-height box → plain horizontal crop_offset, relative to the content
      // box when one is active.
      let box = state.cropBox;
      const region = currentRegion();
      if (state.contentMode && state.contentBox) {
        box = { ...state.cropBox, x: state.cropBox.x - state.contentBox.x };
      }
      cropReadout.textContent = `crop_offset: ${cropBoxToOffset(box, region)}`;
    }
    refreshIO(); // keep the Clip "offset" readout in sync with framing changes
  }

  function refreshContentReadout(): void {
    if (!state.contentMode || !state.contentBox || state.contentBox.w === 0) {
      contentReadout.textContent = "content_crop: (off)";
      return;
    }
    contentReadout.textContent = `content_crop: ${contentCropFromBox(state.contentBox)}`;
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
      state.cropPath && state.cropPath.length > 0
        ? "track"
        : cropWindowSpec()
          ? "punch-in"
          : state.keyframes.length
            ? "schedule"
            : currentOffset();
    const valEl = ioChip.querySelector(".val");
    if (valEl) valEl.textContent = dur;
    renderRegion();
    renderKf(); // keyframe positions are clip-relative to In
  }

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
    const rel = clamp(state.t - state.inPoint, 0, Number.POSITIVE_INFINITY);
    let x = easedCropXAt(state.cropPath, rel);
    if (state.contentMode && state.contentBox) {
      x += state.contentBox.x;
    }
    const maxX = state.dims.width - state.cropBox.w;
    return clamp(x, 0, Math.max(0, maxX));
  }

  function currentOffset(): string {
    if (!state.cropBox || !state.dims) return "center";
    let box = state.cropBox;
    if (state.contentMode && state.contentBox) {
      box = { ...state.cropBox, x: state.cropBox.x - state.contentBox.x };
    }
    return cropBoxToOffset(box, currentRegion());
  }

  function addKeyframe(): void {
    if (state.inPoint == null) {
      flashErr("Set the In point before adding keyframes (keyframe times are clip-relative).");
      return;
    }
    const rel = Math.max(0, state.t - state.inPoint);
    state.keyframes.push({ t: round3(rel), offset: currentOffset() });
    refreshKeyframes();
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
          state.keyframes = state.keyframes.filter((k) => k !== kf);
          refreshKeyframes();
        });
        li.append(span, del);
        kfList.append(li);
      });
    scheduleReadout.textContent = state.keyframes.length
      ? `schedule: ${scheduleToString(state.keyframes)}`
      : "schedule: (no keyframes — uses current box offset)";
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
      trackStatus.textContent = "track: load a source first.";
      return;
    }
    if (state.inPoint == null || state.outPoint == null) {
      trackStatus.textContent = "track: set both In and Out points first.";
      return;
    }
    if (state.outPoint <= state.inPoint) {
      trackStatus.textContent = "track: Out must be after In.";
      return;
    }
    // Re-read from the keychain so a key entered in Settings during this session
    // is honored; fall back to whatever init hydrated. Absent ⇒ "no key", as before.
    try {
      apiKey = (await platform.getSecret(GEMINI_API_KEY_SECRET)) ?? apiKey;
    } catch {
      /* keychain unavailable — fall back to the init-hydrated value. */
    }
    if (!apiKey.trim()) {
      trackStatus.textContent = "track: set a Gemini API key in Settings first.";
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
      trackStatus.textContent = `track: extracting frames + querying Gemini… ${elapsed}s — this can take a while`;
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
        state.cropPath = null;
        trackStatus.textContent = "track: no usable boxes — using manual crop_offset.";
        setOutput(
          `Auto-track: the tracker returned no usable boxes for the In→Out window. Falling back to the manual crop_offset.`,
        );
      } else {
        state.cropPath = path;
        trackStatus.textContent = `track: ON · ${path.length} keyframe(s). Clear track to revert.`;
        setOutput(
          `Auto-track: ${path.length} keyframe(s) from ${samples.length} sample(s). ` +
            `The preview box now follows the subject across the shot — Add clip → queue to render with the eased crop path.`,
          "ok",
        );
      }
      drawOverlay();
      refreshIO();
    } catch (err) {
      state.cropPath = null;
      trackStatus.textContent = "track: failed — see Output.";
      setOutput(`Auto-track failed: ${errMsg(err)}`, "err");
      drawOverlay();
    } finally {
      window.clearInterval(trackTimer);
      trackStatus.classList.remove("working");
      trackBtn.disabled = false;
    }
  }

  /** Drop the tracked crop path; revert to the manual crop_offset / schedule. */
  function clearTrack(): void {
    state.cropPath = null;
    trackStatus.textContent = "track: (none — manual crop_offset in use)";
    drawOverlay();
    refreshIO();
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
    title.textContent = "Assistant";
    const sub = el("div", "fl-assist-sub");
    sub.textContent = "Proposes cuts & framing — you accept. Never hears the audio.";
    headText.append(title, sub);
    const closeBtn = button("", "fl-iconbtn sm", () => closeAssistant());
    closeBtn.innerHTML = ICON_X;
    closeBtn.title = "Close the assistant (Esc / A)";
    closeBtn.style.marginLeft = "auto";
    head.append(spark, headText, closeBtn);

    const log = el("div", "fl-assist-body");

    const foot = el("div", "fl-assist-foot");
    const chips = el("div", "fl-chips");
    const SUGGESTIONS = [
      "Find a tight chorus around the loud part",
      "Track the guitarist across this shot",
      "Frame the singer at the current moment",
      "Set In/Out to the cleanest 15 seconds",
    ];
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
    textarea.placeholder = "Ask the assistant to find a moment or frame a subject…";
    const send = button("", "fl-send", () => void sendTurn()) as HTMLButtonElement;
    send.innerHTML = ICON_SEND;
    send.disabled = true;
    send.title = "Send (Enter)";
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
    appendBubble(
      "ai",
      "Tell me the moment or subject you want and I'll propose the cut and framing. " +
        "I work from your project state — scene cuts and loudness swells — and look at " +
        "specific frames when I frame or track a subject. I never hear the audio, and " +
        "every proposal previews before it changes anything.",
    );
  }

  /** Append a chat bubble (`.fl-msg` + `.fl-bubble`) to the log and scroll to it. */
  function appendBubble(who: "user" | "ai", text: string, warn?: string): HTMLElement {
    const msg = el("div", `fl-msg ${who}`);
    const label = el("div", "who");
    label.textContent = who === "user" ? "you" : "assistant";
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
      return { ok: false, reason: "Load a source first, then I can read its frames and propose framing." };
    }
    // Read the key fresh so a key entered in Settings this session is honored.
    try {
      apiKey = (await platform.getSecret(GEMINI_API_KEY_SECRET)) ?? apiKey;
    } catch {
      /* keychain unavailable — fall back to the init-hydrated value. */
    }
    if (!apiKey.trim()) {
      return {
        ok: false,
        reason:
          "I need a Gemini API key to read frames. Add one in Settings → AI & models (it's stored in your OS keychain, never in project files), then ask me again.",
      };
    }
    const region = currentRegion();
    const models = resolveModels(assistantSelection());
    const overlay = loadAssistantOverlay(); // editor's append-only framing preferences
    const ctx = {
      region: { width: region.width, height: region.height },
      source: state.source,
      models,
      apiKey: apiKey.trim(),
      basePrompt: BASE_PROMPT, // the read-only framing brain (prompts/base.md)
      ...(overlay ? { userOverlay: overlay } : {}),
      ...(state.inPoint != null ? { inSec: state.inPoint } : {}),
      ...(state.outPoint != null ? { outSec: state.outPoint } : {}),
      ...(state.duration > 0 ? { duration: state.duration } : {}),
      ...(state.sceneCuts.length ? { sceneCuts: state.sceneCuts.slice() } : {}),
      ...(state.swells.length
        ? { swells: state.swells.map((s) => ({ t: s.t, label: s.label })) }
        : {}),
    };
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
      const m = `Sorry — that turn failed: ${errMsg(err)}`;
      appendBubble("ai", m);
      assistantHistory.push({ role: "assistant", text: m });
    }
  }

  /** Render one reply: prose bubble + grounding chips + proposal cards + action bar. */
  function renderReply(reply: AssistantReply): void {
    const msg = appendBubble("ai", reply.text, reply.warn);
    const bubble = msg.querySelector(".fl-bubble");
    if (bubble && reply.grounding.length) bubble.append(groundingRow(reply.grounding));

    pendingActions = reply.actions.slice();
    stepIndex = 0;
    setGhosts(ghostsFrom(pendingActions, 0));
    if (pendingActions.length) dock.log.append(proposalCard(pendingActions));
    dock.log.scrollTop = dock.log.scrollHeight;
  }

  /** The ghost previews for the not-yet-committed actions (index `from` onward). */
  function ghostsFrom(actions: ProposedAction[], from: number): GhostPreview[] {
    return actions
      .slice(from)
      .map((a) => a.ghost)
      .filter((g): g is GhostPreview => g != null);
  }

  /** "grounded in …" chip row citing the real signals (never audio). */
  function groundingRow(grounding: Grounding[]): HTMLElement {
    const row = el("div", "fl-ground");
    const lab = el("span", "gl");
    lab.textContent = "grounded in";
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
    h.append(document.createTextNode("Proposed"));
    const n = el("span", "n");
    n.textContent = `${actions.length} action${actions.length === 1 ? "" : "s"}`;
    h.append(n);

    const list = el("div", "fl-prop-list");
    const rows: HTMLElement[] = actions.map((a) => {
      const row = el("div", "fl-act");
      const arrow = el("span", "arrow");
      arrow.textContent = "→";
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
    const acceptBtn = button("Accept all", "fl-btn primary sm");
    const stepLab = el("span", "step");
    const stepBtn = button("Step", "fl-btn sm");
    const discardBtn = button("Discard", "fl-btn sm ghost");

    const markActiveStep = () => {
      rows.forEach((r, i) => r.classList.toggle("active", i === stepIndex && stepIndex < actions.length));
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
          ? `Applied ${applied} — render staged. Use the Render button when you're ready.`
          : `Applied ${applied} proposal${applied === 1 ? "" : "s"}.`,
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
        finish("Stepped through every proposal.");
      }
    });

    discardBtn.addEventListener("click", () => {
      rows.forEach((r) => r.classList.add("skip"));
      pendingActions = [];
      stepIndex = actions.length;
      setGhosts([]); // nothing committed, but the previews go away
      finish("Discarded — your state is untouched.", "");
    });

    bar.append(acceptBtn, stepLab, stepBtn, discardBtn);
    markActiveStep();
    card.append(h, list, bar);
    return card;
  }

  /**
   * Apply ONE accepted commit through the editor's existing state mutations.
   * Returns whether it actually changed state (`applied`) and whether it merely
   * STAGED a render (`staged` — never auto-renders). Anything that can't be
   * cleanly applied is reported back so the row reads as skipped.
   */
  function applyCommit(commit: CommitOp): { applied: boolean; staged: boolean } {
    switch (commit.kind) {
      case "setInOut": {
        state.inPoint = round3(clamp(commit.inSec, 0, state.duration || commit.inSec));
        state.outPoint = round3(clamp(commit.outSec, state.inPoint, state.duration || commit.outSec));
        refreshIO();
        void setT(state.inPoint, true);
        return { applied: true, staged: false };
      }
      case "trim": {
        if (state.inPoint == null) return { applied: false, staged: false };
        state.outPoint = round3(clamp(commit.outSec, state.inPoint, state.duration || commit.outSec));
        refreshIO();
        return { applied: true, staged: false };
      }
      case "setContentCrop": {
        // content-crop UI is currently inert in the editor; round-trip the spec
        // string through the manifest restorer so the box + mode are consistent.
        const r = specToEditorState(
          { source_file: state.source, in_point: "0", out_point: "0", content_crop: commit.contentCrop },
          state.dims!,
        );
        state.contentBox = r.contentBox;
        state.contentMode = r.contentMode;
        refreshContentReadout();
        refreshCropReadout();
        drawOverlay();
        return { applied: true, staged: false };
      }
      case "detectScenes": {
        void doScenes();
        return { applied: true, staged: false };
      }
      case "addCropKeyframe": {
        if (state.inPoint == null) return { applied: false, staged: false };
        // The commit's x is in working-region px; an integer x-pixel offset is a
        // valid `crop_offset` form (clamped into frame by the engine), so store it
        // straight as the keyframe offset.
        state.keyframes.push({ t: round3(commit.t), offset: String(Math.round(commit.x)) });
        refreshKeyframes();
        return { applied: true, staged: false };
      }
      case "suggestCropForFrame": {
        // A single-frame framing suggestion → set the crop box from the proposed
        // offset (overwrites the manual box). The cropPath, if any, still wins at
        // render, so clear it so this fixed offset is what the user sees.
        state.cropPath = null;
        const r = specToEditorState(
          { source_file: state.source, in_point: "0", out_point: "0", crop_offset: commit.cropOffset },
          state.dims!,
        );
        state.cropBox = r.cropBox;
        refreshCropReadout();
        drawOverlay();
        refreshIO();
        return { applied: true, staged: false };
      }
      case "trackSubject": {
        // Same engine as the Track-subject tab: adopt the eased crop path.
        state.cropPath = commit.cropPath.map((k) => ({ t: k.t, x: k.x }));
        trackStatus.textContent = `track: ON · ${state.cropPath.length} keyframe(s) (from the assistant). Clear track to revert.`;
        drawOverlay();
        refreshIO();
        return { applied: true, staged: false };
      }
      case "render": {
        // STAGE only — never auto-fire. Surface a hint; the manual Render button
        // owns the encode.
        setOutput(
          "Assistant staged the queue for render. Press Render when you're ready — I never encode automatically.",
        );
        return { applied: true, staged: true };
      }
      default: {
        // Exhaustiveness guard — a new CommitOp kind lands here until wired.
        const _never: never = commit;
        void _never;
        return { applied: false, staged: false };
      }
    }
  }

  function addClip(): void {
    clipErr.textContent = "";
    if (!state.source || !state.dims) return flashErr("Load a source first.");
    if (state.inPoint == null || state.outPoint == null)
      return flashErr("Set both In and Out points.");
    if (state.outPoint <= state.inPoint) return flashErr("Out must be after In.");

    const spec: ClipSpec = {
      source_file: state.source,
      in_point: state.inPoint.toFixed(3),
      out_point: state.outPoint.toFixed(3),
    };
    const win = cropWindowSpec();
    if (state.cropPath && state.cropPath.length > 0) {
      // AI tracking takes precedence over crop_offset (SPEC §6.9). Keep a
      // "center" fallback so the row is still valid if the path is stripped.
      spec.cropPath = state.cropPath.map((k) => ({ t: k.t, x: k.x }));
      spec.crop_offset = "center";
    } else if (win) {
      // Punch-in / zoom: a fixed 9:16 window takes precedence over crop_offset
      // at render. Keep a horizontal-offset fallback so the row still frames
      // sensibly if the window is ever stripped. (Schedules don't apply to a
      // fixed window, so any keyframes are intentionally ignored here.)
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
    const name = nameInput.value.trim();
    if (name) spec.out_name = name;

    state.clips.push(spec);
    refreshManifest();
    nameInput.value = "";
  }

  /** Clip duration in seconds (0 if unparseable). */
  function clipDur(spec: ClipSpec): number {
    try {
      return Math.max(0, parseTimestamp(spec.out_point) - parseTimestamp(spec.in_point));
    } catch {
      return 0;
    }
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
      card.title = "Click to re-open this clip for editing · drag to reorder";
      const thumb = el("div", "fl-thumb");
      void setThumb(thumb, spec.source_file, safeParse(spec.in_point));
      const meta = el("div", "fl-clip-meta");
      const name = el("div", "fl-clip-name");
      name.textContent = spec.out_name || shorten(spec.source_file);
      const sub = el("div", "fl-clip-sub");
      const d = clipDur(spec);
      const dur = d > 0 ? `${d.toFixed(1)}s` : `${spec.in_point}→${spec.out_point}`;
      const framing = spec.cropPath?.length
        ? "track"
        : spec.cropWindow
          ? "punch-in"
          : (spec.crop_offset ?? "center");
      sub.innerHTML = `${dur} · <span style="color:var(--accent-2)">${escapeHtml(framing)}</span>`;
      meta.append(name, sub);

      const dup = el("button", "fl-clip-x") as HTMLButtonElement;
      dup.innerHTML = ICON_COPY;
      dup.title = "Duplicate (e.g. a second framing of this moment)";
      dup.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.clips.splice(i + 1, 0, structuredClone(spec));
        refreshManifest();
      });
      const del = el("button", "fl-clip-x") as HTMLButtonElement;
      del.textContent = "✕";
      del.title = "Remove from queue";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.clips.splice(i, 1);
        refreshManifest();
      });

      card.addEventListener("click", () => void openSpec(spec, outdirInput.value.trim() || undefined));
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
        const [moved] = state.clips.splice(dragFrom, 1);
        if (moved) state.clips.splice(i, 0, moved);
        refreshManifest();
      });

      card.append(thumb, meta, dup, del);
      clipList.append(card);
    });
    const total = state.clips.reduce((s, c) => s + clipDur(c), 0);
    queueLabel.innerHTML = state.clips.length
      ? `Queue <span class="n">${state.clips.length}</span> · <span class="n">${fmtClock(total, false)}</span>`
      : 'Queue <span class="n">0</span>';
    renderBtn.textContent = state.clips.length ? `Render ${state.clips.length}` : "Render";
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
      outDirLine.append(document.createTextNode("Clips written to "));
      const s = el("span", "stat");
      s.textContent = dir;
      outDirLine.append(s);
    }
  }

  async function doRender(): Promise<void> {
    if (!state.clips.length) return flashErr("Add at least one clip to the queue.");
    const manifestJson = serializeManifestJSON(state.clips);
    setOutput("Rendering… (this runs ffmpeg per clip; may take a while)");
    try {
      const outdir = outdirInput.value.trim() || "clips";
      saveOutdir(outdir);
      const result = await platform.render(manifestJson, renderOptions(outdir));
      setOutput(
        result.log || (result.ok ? "OK (no output)" : "Render failed."),
        result.ok ? "ok" : "err",
      );
      // Surface the resolved output directory so the clips are findable. The
      // backend echoes the (absolute) outdir it used in the log header.
      const m = /--outdir ([^\n]*)/.exec(result.log || "");
      const resolvedOutdir = result.ok && m && m[1]?.trim() ? m[1].trim() : outdir;
      if (result.ok && m && m[1]?.trim()) setOutDir(resolvedOutdir);
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
    const idle = btn.textContent || "⧉ Copy";
    const done = (ok: boolean) => {
      btn.textContent = ok ? "✓ Copied" : "Copy failed";
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
    if (text === "(output appears here)") return;
    void copyToClipboard(text, copyLogBtn);
  }

  async function doScenes(): Promise<void> {
    if (!state.source) return flashErr("Load a source first.");
    setOutput("Detecting scenes…");
    try {
      const cuts = await platform.scenes(state.source);
      state.sceneCuts = cuts;
      renderCuts();
      setOutput(
        cuts.length
          ? `Scene cuts (s): ${cuts.join(", ")}  (auto-track will force a fresh sample just after each cut inside the In/Out range)`
          : "No scene cuts detected (threshold 0.4).",
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
    state.inPoint = r.inPoint;
    state.outPoint = r.outPoint;
    state.contentMode = r.contentMode;
    state.contentBox = r.contentBox;
    state.cropBox = r.cropBox;
    state.keyframes = r.keyframes;
    state.cropPath = r.cropPath;
    nameInput.value = r.name;
    refreshContentReadout();
    refreshCropReadout();
    refreshKeyframes();
    await setT(r.inPoint, true);
    drawOverlay();
  }

  /**
   * Render-history modal (HANDOFF §5.5): past renders grouped by day, each row
   * showing the clip name + offset-mode pill, source, an In→Out / dur / kf /
   * output readout, and render time. Open rehydrates the editor via `openSpec`
   * WITHOUT touching the session queue (`state.clips`); remove + clear all.
   */
  async function openHistory(): Promise<void> {
    const backdrop = el("div", "fl-modal-backdrop");
    const modal = el("div", "fl-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "Render history");

    // header: title + N renders · spacer · Clear all · close
    const head = el("div", "fl-modal-h");
    const titleWrap = el("div");
    titleWrap.style.cssText = "display:flex; align-items:center; gap:11px;";
    const title = el("span", "fl-label");
    title.style.fontSize = "13px";
    title.textContent = "Render history";
    const countPill = el("span", "fl-pill ghost");
    titleWrap.append(title, countPill);
    const clearBtn = button("Clear all", "fl-btn sm ghost danger", () => {
      entries = [];
      void save();
      draw();
    });
    const closeBtn = button("", "fl-iconbtn");
    closeBtn.innerHTML = ICON_X;
    closeBtn.title = "Close";
    head.append(titleWrap, el("span", "fl-spacer"), clearBtn, closeBtn);

    // tools: filter field + "stored · local" chip
    const tools = el("div", "fl-modal-tools");
    const filterField = el("div", "fl-field");
    filterField.style.flex = "1";
    filterField.innerHTML = `<span class="ic">${ICON_SEARCH}</span>`;
    const filterInput = input("text", "Filter by source or clip name…");
    filterField.append(filterInput);
    const storedChip = el("span", "fl-rdchip");
    storedChip.innerHTML = '<span class="lab">stored</span><span class="val">local</span>';
    tools.append(filterField, storedChip);
    filterInput.addEventListener("input", () => draw());

    const body = el("div", "fl-modal-body");
    const empty = el("div", "hint");
    empty.style.padding = "24px 8px";
    empty.textContent = "No renders yet — render a clip and it lands here.";

    const foot = el("div", "fl-modal-foot");
    foot.innerHTML =
      '<span class="idot in" style="background:var(--accent)"></span>' +
      "<span><b>Open</b> loads the source and re-frames the editor to that render. " +
      "Your current queue isn’t touched.</span>";

    modal.append(head, tools, body, empty, foot);
    backdrop.append(modal);
    document.body.append(backdrop);

    let entries: HistoryEntry[] = [];
    const save = () => platform.saveHistory(entries).catch(() => undefined);

    function histRow(entry: HistoryEntry): HTMLElement {
      const row = el("div", "fl-hist");
      const meta = el("div", "fl-hist-meta");
      const top = el("div", "fl-hist-top");
      const nm = el("span", "nm");
      nm.textContent = entry.spec.out_name || shorten(entry.spec.source_file);
      const mode = offsetMode(entry.spec);
      const pill = el("span", mode.ghost ? "fl-pill ghost" : "fl-pill");
      pill.textContent = mode.label;
      top.append(nm, pill);
      const src = el("div", "fl-hist-src");
      src.textContent = baseName(entry.spec.source_file);
      const read = el("div", "fl-readout");
      const kf = kfCount(entry.spec);
      let inT = "—";
      let outT = "—";
      let dur = "—";
      try {
        const a = parseTimestamp(entry.spec.in_point);
        const b = parseTimestamp(entry.spec.out_point);
        inT = fmtTC(a);
        outT = fmtTC(b);
        dur = `${(b - a).toFixed(2)}s`;
      } catch {
        /* leave dashes on an unparseable spec */
      }
      read.innerHTML =
        `<span class="idot in"></span><span class="v">${inT}</span><span class="arrow">→</span>` +
        `<span class="idot out"></span><span class="v">${outT}</span>` +
        `<span class="sep">·</span><span class="k">dur</span><span class="v accent">${dur}</span>` +
        (kf > 0 ? `<span class="sep">·</span><span class="k">kf</span><span class="v">${kf}</span>` : "") +
        `<span class="sep">·</span><span class="path">${escapeHtml(entry.outdir)}</span>`;
      meta.append(top, src, read);

      const side = el("div", "fl-hist-side");
      const time = el("span", "fl-hist-time");
      time.textContent = fmtClockTime(entry.ts);
      const actions = el("div", "fl-hist-actions");
      const openBtn = button("Open", "fl-btn sm primary", () => {
        dismiss();
        void openSpec(entry.spec, entry.outdir);
      });
      const rm = button("", "fl-iconbtn sm rm");
      rm.innerHTML = ICON_TRASH;
      rm.title = "Remove from history";
      rm.addEventListener("click", () => {
        entries = entries.filter((e) => e.id !== entry.id);
        void save();
        draw();
      });
      actions.append(openBtn, rm);
      side.append(time, actions);

      const thumb = el("div", "fl-thumb");
      void setThumb(thumb, entry.spec.source_file, safeParse(entry.spec.in_point));
      row.append(thumb, meta, side);
      return row;
    }

    function draw(): void {
      const q = filterInput.value.trim().toLowerCase();
      const shown = q
        ? entries.filter(
            (e) =>
              (e.spec.out_name || "").toLowerCase().includes(q) ||
              e.spec.source_file.toLowerCase().includes(q),
          )
        : entries;
      body.innerHTML = "";
      countPill.textContent = `${entries.length} render${entries.length === 1 ? "" : "s"}`;
      clearBtn.style.display = entries.length ? "" : "none";
      empty.style.display = entries.length ? "none" : "block";
      let lastDay = "";
      for (const entry of shown) {
        const day = dayLabel(entry.ts);
        if (day !== lastDay) {
          lastDay = day;
          const count = shown.filter((e) => dayLabel(e.ts) === day).length;
          const div = el("div", "fl-hist-day");
          div.innerHTML = `<span>${day}</span><span class="line"></span><span class="c">${count}</span>`;
          body.append(div);
        }
        body.append(histRow(entry));
      }
      if (q && shown.length === 0 && entries.length) {
        const none = el("div", "hint");
        none.style.padding = "16px 8px";
        none.textContent = "No matches.";
        body.append(none);
      }
    }

    try {
      entries = await platform.loadHistory();
    } catch {
      entries = [];
    }
    draw();

    const dismiss = () => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
    };
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    closeBtn.addEventListener("click", dismiss);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) dismiss();
    });
    document.addEventListener("keydown", onKey);
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
    let data: SessionData | null = null;
    try {
      data = await platform.loadSession();
    } catch {
      data = null;
    }
    if (!data) return;
    if (data.outdir) outdirInput.value = data.outdir;
    if (Array.isArray(data.clips) && data.clips.length) {
      state.clips = data.clips;
      refreshManifest();
    }
    if (data.source) {
      srcInput.value = data.source;
      await load(); // re-probe; any error is surfaced but the queue stays intact
    }
  }

  function flashErr(msg: string): void {
    clipErr.textContent = msg;
  }

  /**
   * On launch, move any legacy inline key into the keychain (one-time), then
   * hydrate `apiKey` from `secretStore` so the Auto-track action sees a stored
   * key. If none is present, `apiKey` stays "" and the track path reports "no
   * key" honestly. Best-effort: a locked/denied keychain leaves `apiKey` empty
   * (and `migrateLegacyApiKey` keeps the legacy copy for a later attempt).
   */
  async function hydrateApiKey(): Promise<void> {
    try {
      await migrateLegacyApiKey(platform);
    } catch {
      /* migration failed (keychain locked, etc.) — key preserved for next run. */
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
  void hydrateApiKey();
  void restoreSession();
}

// ---------- small helpers ----------

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function input(type: string, placeholder: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = type;
  i.placeholder = placeholder;
  return i;
}

function button(label: string, cls?: string, onClick?: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function roundEvenLocal(n: number): number {
  const i = Math.round(n);
  return i - (i % 2);
}

function shorten(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.length > 28 ? base.slice(0, 25) + "…" : base;
}

/** Format seconds as `m:ss` (ruler ticks) or `m:ss.mmm` (playhead bubble). */
function fmtClock(sec: number, withMs: boolean): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  if (!withMs) return base;
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${base}.${String(ms).padStart(3, "0")}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Max number of past renders kept in the history. */
const HISTORY_CAP = 50;

// ---- history-modal formatting helpers ----

/** Basename of a path (no truncation; the modal's CSS handles overflow). */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Parse a timestamp string to seconds, or NaN if unparseable. */
function safeParse(ts: string): number {
  try {
    return parseTimestamp(ts);
  } catch {
    return NaN;
  }
}

/** Escape a string for safe interpolation into innerHTML. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Timecode `mm:ss.s` (e.g. 62.04 → "01:02.0"). */
function fmtTC(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Wall-clock render time for an entry (e.g. "2:18 PM"). */
function fmtClockTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Day-divider label for an entry: "Today" / "Yesterday" / "Mon D". */
function dayLabel(ts: number): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day = new Date(ts);
  const diff = Math.round((startOfDay(new Date()) - startOfDay(day)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The clip's framing mode as a pill: track / punch-in / keyframes / fixed offset. */
function offsetMode(spec: ClipSpec): { label: string; ghost: boolean } {
  if (spec.cropPath?.length) return { label: "track", ghost: false };
  if (spec.cropWindow) return { label: "punch-in", ghost: false };
  const off = spec.crop_offset ?? "center";
  if (off.includes(";") || off.includes("=")) return { label: "keyframes", ghost: false };
  return { label: off, ghost: true };
}

/** Keyframe count for a clip (track path points or schedule switch points). */
function kfCount(spec: ClipSpec): number {
  if (spec.cropPath?.length) return spec.cropPath.length;
  const off = spec.crop_offset ?? "";
  if (off.includes("=")) return off.split(";").filter((p) => p.includes("=")).length;
  return 0;
}

// Persist the chosen output folder so it survives reloads (best effort).
const OUTDIR_KEY = "footlight.outdir";

function loadOutdir(): string {
  try {
    return localStorage.getItem(OUTDIR_KEY) || "clips";
  } catch {
    return "clips";
  }
}

function saveOutdir(value: string): void {
  try {
    localStorage.setItem(OUTDIR_KEY, value.trim() || "clips");
  } catch {
    /* localStorage unavailable (private mode etc.) — non-fatal. */
  }
}

// Live 9:16 output-preview visibility (persisted; default on).
const PREVIEW_KEY = "footlight.preview";

function loadPreviewPref(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== "off";
  } catch {
    return true;
  }
}

function savePreviewPref(on: boolean): void {
  try {
    localStorage.setItem(PREVIEW_KEY, on ? "on" : "off");
  } catch {
    /* non-fatal */
  }
}

// Recent source paths (most-recent-first), shown as a datalist on the path field.
const RECENTS_KEY = "footlight.recents";
const RECENTS_CAP = 10;

function loadRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(path: string): void {
  const p = path.trim();
  if (!p) return;
  try {
    const next = [p, ...loadRecents().filter((x) => x !== p)].slice(0, RECENTS_CAP);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* non-fatal */
  }
}

// ---- Theme (light default, persisted) ----
const THEME_KEY = "footlight.theme";

function saveTheme(t: "light" | "dark"): void {
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* non-fatal */
  }
}

/** Build an inspector section header (`<div class="fl-sect-h"><span class="fl-label">…`). */
function sectionHeader(text: string): HTMLElement {
  const h = el("div", "fl-sect-h");
  const label = el("span", "fl-label");
  label.textContent = text;
  h.append(label);
  return h;
}

// The brand mark — "row of footlights" (three half-disc lamps, beams up).
// currentColor → --accent via `.fl-lamp`; the same motif as the app icon.
const ICON_BRAND =
  '<svg class="fl-lamp" viewBox="14 12 72 68" fill="currentColor" aria-hidden="true"><g class="beam"><polygon points="27,66 37,66 44,20 20,20"/><polygon points="45,66 55,66 62,20 38,20"/><polygon points="63,66 73,66 80,20 56,20"/></g><rect x="20" y="69" width="60" height="5.5" rx="2.75"/><path d="M24.5,69 A7.5 7.5 0 0 1 39.5,69 Z"/><path d="M42.5,69 A7.5 7.5 0 0 1 57.5,69 Z"/><path d="M60.5,69 A7.5 7.5 0 0 1 75.5,69 Z"/></svg>';

// Inline stroke/fill icons (1.8 stroke, matching the design's set).
const ICON_GEAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2.5l1.3 2.4 2.7-.3 .6 2.6 2.4 1.3-1 2.5 1 2.5-2.4 1.3-.6 2.6-2.7-.3L12 21.5l-1.3-2.4-2.7.3-.6-2.6L5 15.5l1-2.5-1-2.5 2.4-1.3.6-2.6 2.7.3z" stroke-linejoin="round"/></svg>';
const ICON_ACTIVITY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h5M7 13h9" stroke-linecap="round"/></svg>';
const ICON_SUN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round"/></svg>';
const ICON_MOON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 13.5A8 8 0 1110.5 4a6.5 6.5 0 009.5 9.5z" stroke-linejoin="round"/></svg>';
const ICON_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';
const ICON_DOWN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>';
const ICON_HISTORY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/></svg>';
const ICON_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>';
const ICON_PHONE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="3" width="10" height="18" rx="2.2"/><path d="M11 18h2" stroke-linecap="round"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3" stroke-linecap="round"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PREV_CUT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M18 6l-8 6 8 6z" fill="currentColor"/><path d="M6 5.5v13"/></svg>';
const ICON_NEXT_CUT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M6 6l8 6-8 6z" fill="currentColor"/><path d="M18 5.5v13"/></svg>';
const PLAY_GLYPH = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z"/></svg>';
const PAUSE_GLYPH =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
// Spark (assistant), send (composer), check (proposal tick).
const ICON_SPARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>';
const ICON_SEND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M12 5l7 7-7 7"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-9"/></svg>';
