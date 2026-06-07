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
  type CaptionStyle,
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
import { messages } from "./i18n/index.js";

/** The editor's localized strings (the `editor` namespace of the catalog). */
const m = messages.editor;

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

/**
 * Render flags from Settings → Rendering (persisted under `footlight.render`).
 * Caption STYLE is per-clip now (carried on each `ClipSpec.caption` in the
 * manifest); only the render-wide `burnCaptions` on/off switch lives here.
 */
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
        burnCaptions?: unknown;
      };
      if (typeof p.crf === "number") opts.crf = p.crf;
      if (typeof p.preset === "string") opts.preset = p.preset;
      if (p.audio === "reencode" && typeof p.bitrate === "string") opts.audioBitrate = p.bitrate;
      if (p.dryRun === true) opts.dryRun = true;
      if (p.burnCaptions === true) opts.burnCaptions = true;
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
  /** Caption big line (`hook`) — shot-list data carried in the manifest. */
  hook: string;
  /** Caption secondary line (`title`). */
  title: string;
  /**
   * Caption placement on a 9-zone grid: a vertical keyword
   * (`top` | `center` | `bottom`, default bottom) optionally suffixed with a
   * horizontal one (`-left` | `-center` | `-right`, default center). Stored as the
   * bare vertical keyword when horizontal is center (back-compat: `"bottom"`), or
   * `"<v>-<h>"` otherwise (e.g. `"bottom-left"`, `"top-right"`).
   */
  textPosition: string;
  /**
   * Per-clip caption styling, edited in situ next to the caption text/preview.
   * Fields are always populated here (defaults mirror the engine); `captionStyleToSpec`
   * narrows them to a sparse `CaptionStyle` (omitting defaults) on the saved clip.
   */
  caption: CaptionStyleState;
}

/** Editor working copy of `CaptionStyle` — every field populated for the controls. */
interface CaptionStyleState {
  /** Family name, or a `.ttf`/`.otf`/`.ttc` file path; `""` = system default. */
  font: string;
  /** Fill colour `#RRGGBB`. */
  color: string;
  /** Outline colour `#RRGGBB`. */
  outlineColor: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  shadow: boolean;
  box: boolean;
  /** Opaque-box fill colour `#RRGGBB` (used when `box`). */
  boxColor: string;
  /** Rotation in degrees. */
  angle: number;
}

/** A fresh caption style at the engine defaults (white fill, black outline, flat). */
function defaultCaptionStyle(): CaptionStyleState {
  return {
    font: "",
    color: "#FFFFFF",
    outlineColor: "#000000",
    bold: false,
    italic: false,
    underline: false,
    shadow: false,
    box: false,
    boxColor: "#000000",
    angle: 0,
  };
}

/**
 * Narrow the editor's fully-populated caption style to the sparse `CaptionStyle`
 * stored on a clip: only non-default fields are kept, so manifests stay clean and
 * a clip with default styling carries no `caption` object at all (returns null).
 */
function captionStyleToSpec(c: CaptionStyleState): CaptionStyle | null {
  const out: CaptionStyle = {};
  const font = c.font.trim();
  if (font) out.font = font;
  if (c.color.toUpperCase() !== "#FFFFFF") out.color = c.color;
  if (c.outlineColor.toUpperCase() !== "#000000") out.outlineColor = c.outlineColor;
  if (c.bold) out.bold = true;
  if (c.italic) out.italic = true;
  if (c.underline) out.underline = true;
  if (c.shadow) out.shadow = true;
  if (c.box) {
    out.box = true;
    if (c.boxColor.toUpperCase() !== "#000000") out.boxColor = c.boxColor;
  }
  if (Number.isFinite(c.angle) && c.angle !== 0) out.angle = c.angle;
  return Object.keys(out).length > 0 ? out : null;
}

/** Hydrate the editor's working caption style from a clip's sparse `CaptionStyle`. */
function captionStyleFromSpec(spec: CaptionStyle | undefined): CaptionStyleState {
  const c = defaultCaptionStyle();
  if (!spec) return c;
  if (typeof spec.font === "string") c.font = spec.font;
  if (typeof spec.color === "string") c.color = spec.color;
  if (typeof spec.outlineColor === "string") c.outlineColor = spec.outlineColor;
  c.bold = spec.bold === true;
  c.italic = spec.italic === true;
  c.underline = spec.underline === true;
  c.shadow = spec.shadow === true;
  c.box = spec.box === true;
  if (typeof spec.boxColor === "string") c.boxColor = spec.boxColor;
  if (typeof spec.angle === "number" && Number.isFinite(spec.angle)) c.angle = spec.angle;
  return c;
}

type TextPosV = "top" | "center" | "bottom";
type TextPosH = "left" | "center" | "right";

/** Split a stored `text_position` into its vertical/horizontal axes. */
function parseTextPosition(value: string | undefined): { v: TextPosV; h: TextPosH } {
  const [rawV, rawH] = (value || "").trim().toLowerCase().split("-");
  const v: TextPosV = rawV === "top" || rawV === "center" ? rawV : "bottom";
  const h: TextPosH = rawH === "left" || rawH === "right" ? rawH : "center";
  return { v, h };
}

/** Combine the two axes back into a stored value (`"<v>"` or `"<v>-<h>"`). */
function joinTextPosition(v: TextPosV, h: TextPosH): string {
  return h === "center" ? v : `${v}-${h}`;
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
    hook: "",
    title: "",
    textPosition: "bottom",
    caption: defaultCaptionStyle(),
  };

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
  actions.append(renderBtn, previewBtn, assistantBtn, historyBtn, activityToggle, clearBtn, themeBtn, settingsBtn);
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
  const emptyMsg = el("div", "fl-stage-center");
  emptyMsg.innerHTML =
    `<div class="fl-hero-h">${escapeHtml(m.stage.heroH)}</div>` +
    `<div class="fl-hero-sub">${escapeHtml(m.stage.heroSub)}</div>` +
    `<div class="fl-hero-cta">${escapeHtml(m.stage.heroCta)}</div>`;
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
  const setInBtn = button("", "fl-btn", () => {
    state.inPoint = state.t;
    refreshIO();
  });
  setInBtn.innerHTML = `<span class="idot in"></span>${escapeHtml(m.clip.setIn)}`;
  setInBtn.title = m.clip.setInTitle;
  const setOutBtn = button("", "fl-btn", () => {
    state.outPoint = state.t;
    refreshIO();
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

  const framingSect = el("div", "fl-sect");
  framingSect.append(sectionHeader(m.framing.header));
  const cropReadout = el("div", "fl-readout");
  cropReadout.textContent = m.framing.loadASource;
  framingSect.append(cropReadout);
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
  const hookInput = input("text", m.captions.hookPlaceholder);
  hookInput.title = m.captions.hookTitle;
  hookInput.addEventListener("input", () => {
    state.hook = hookInput.value;
    drawPreview();
  });
  hookField.append(hookInput);
  const titleCapField = el("div", "fl-field");
  titleCapField.style.marginBottom = "8px";
  const titleCapInput = input("text", m.captions.titlePlaceholder);
  titleCapInput.title = m.captions.titleTitle;
  titleCapInput.addEventListener("input", () => {
    state.title = titleCapInput.value;
    drawPreview();
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
    state.textPosition = joinTextPosition(
      posVSelect.value as TextPosV,
      posHSelect.value as TextPosH,
    );
    drawPreview();
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
      state.caption.font = fontPathInput.value.trim();
      drawPreview();
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
    fontPopup.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
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
        state.caption.font = "";
        fontPathInput.value = "";
      } else if (opt.value === FONT_CUSTOM) {
        // Reveal the free-text field; keep whatever path is already there.
        state.caption.font = fontPathInput.value.trim();
      } else {
        // A folder font sets caption.font = its file path (engine resolves the
        // family + fontsdir); a system font sets caption.font = the family.
        state.caption.font = opt.path ?? opt.value;
      }
      const realFont = opt.value !== FONT_DEFAULT && opt.value !== FONT_CUSTOM;
      syncFontTrigger(
        opt.value === FONT_CUSTOM ? FONT_CUSTOM : state.caption.font || FONT_DEFAULT,
        realFont && opt.path ? { label: opt.label, face: opt.face ?? opt.label } : undefined,
      );
      closeFontPopup();
      if (opt.value === FONT_CUSTOM) fontPathInput.focus();
      else fontTrigger.focus();
      drawPreview();
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
    const sysFamilies = Array.from(new Set(sysFonts.map((f) => f.family).filter((f) => f.trim())))
      .filter((f) => !userKeys.has(f.toLowerCase()));
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
  function colorControl(
    label: string,
    get: () => string,
    set: (v: string) => void,
  ): HTMLElement {
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
      drawPreview();
    });
    (swatch as HTMLInputElement & { _sync?: () => void })._sync = () => {
      swatch.value = get();
      hex.textContent = get().toUpperCase();
    };
    row.append(lab, swatch, hex);
    return row;
  }
  const fillRow = colorControl(m.captions.fill, () => state.caption.color, (v) => (state.caption.color = v));
  const outlineRow = colorControl(
    m.captions.outline,
    () => state.caption.outlineColor,
    (v) => (state.caption.outlineColor = v),
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
      drawPreview();
    });
    (b as HTMLButtonElement & { _sync?: () => void })._sync = refresh;
    refresh();
    return b;
  }
  const boldBtn = toggleBtn("B", "font-weight:700;", m.captions.bold, () => state.caption.bold, (v) => (state.caption.bold = v));
  const italicBtn = toggleBtn("I", "font-style:italic;", m.captions.italic, () => state.caption.italic, (v) => (state.caption.italic = v));
  const underlineBtn = toggleBtn("U", "text-decoration:underline;", m.captions.underline, () => state.caption.underline, (v) => (state.caption.underline = v));
  const emphasisRow = el("div", "fl-rowg");
  emphasisRow.style.gap = "6px";
  emphasisRow.append(boldBtn, italicBtn, underlineBtn);

  const boxColorRow = colorControl(m.captions.boxColor, () => state.caption.boxColor, (v) => (state.caption.boxColor = v));
  const shadowBtn = toggleBtn(m.captions.shadow, "", m.captions.shadowTitle, () => state.caption.shadow, (v) => (state.caption.shadow = v));
  const boxBtn = toggleBtn(m.captions.box, "", m.captions.boxTitle, () => state.caption.box, (v) => {
    state.caption.box = v;
    boxColorRow.style.display = v ? "" : "none";
  });
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
    state.caption.angle = Number(angleInput.value);
    angleVal.textContent = `${state.caption.angle}°`;
    drawPreview();
  });
  angleRow.append(angleLab, angleInput, angleVal);

  styleWrap.append(fontRow, fontField, fillRow, outlineRow, emphasisRow, fxRow, boxColorRow, angleRow);

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
    state.keyframes = [];
    refreshKeyframes();
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
  cutsChip.innerHTML = `<span class="lab">${escapeHtml(m.timeline.cutsLabel)}</span><span class="val">0</span>`;
  const swellsChip = el("span", "fl-rdchip swell");
  swellsChip.innerHTML = `<span class="lab">${escapeHtml(m.timeline.swellsLabel)}</span><span class="val">0</span>`;
  const scenesBtn = button(m.timeline.detectScenes, "fl-btn sm", doScenes);
  scenesBtn.title = m.timeline.detectScenesTitle;
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
      chip.title = `${m.timeline.seekSwellPrefix}${fmtClock(sw.t, true)}${m.timeline.seekSwellSuffix}`;
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
          state.inPoint = state.t;
          refreshIO();
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
          state.outPoint = state.t;
          refreshIO();
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
  filmstrip.append(queueLabel, clipList, addCard, fsSpacer, exportBtn);

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
        dimsLine.innerHTML =
          `<span class="err-text">${escapeHtml(m.source.dropHint)}</span>`;
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
        `<span class="err-text">${escapeHtml(m.source.enterPath)}</span>`;
      srcInput.focus();
      return;
    }
    dimsLine.textContent = m.source.probing;
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
        ? state.sceneCuts.filter((c) => c < state.t - eps).sort((a, b) => a - b).pop()
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
    drawPreviewCaptions(ctx, cw, ch);
  }

  /**
   * Rough on-canvas approximation of the burned caption: hook above title,
   * placed on the 9-zone grid per text_position (vertical top/center/bottom ×
   * horizontal left/center/right) and styled per the clip's `caption` (fill /
   * outline colour, bold/italic/underline, drop shadow, opaque box, rotation,
   * and the font family when it's a name the browser can render). This is a
   * runtime-visual HINT only — the AUTHORITATIVE render is the engine's libass
   * (`--burn-captions`); spacing/fonts/metrics will differ.
   */
  function drawPreviewCaptions(
    ctx: CanvasRenderingContext2D,
    cw: number,
    ch: number,
  ): void {
    const hook = state.hook.trim();
    const title = state.title.trim();
    if (!hook && !title) return;

    const cap = state.caption;
    const hookSize = Math.round(ch * 0.052);
    const titleSize = Math.round(ch * 0.036);
    const gap = Math.round(ch * 0.012);
    const pad = Math.round(ch * 0.03);

    // Total block height to place per position.
    const hookH = hook ? hookSize : 0;
    const titleH = title ? titleSize : 0;
    const blockH = hookH + titleH + (hook && title ? gap : 0);

    const { v, h } = parseTextPosition(state.textPosition);
    let top: number;
    if (v === "top") top = pad;
    else if (v === "center") top = (ch - blockH) / 2;
    else top = ch - blockH - pad;

    // A bare family name can be rendered by the canvas; a file path can't (no
    // @font-face here), so those fall back to the system UI face for the hint.
    const isPath = /[\\/]/.test(cap.font) || /\.(ttf|otf|ttc)$/i.test(cap.font);
    const family = cap.font && !isPath ? `'${cap.font.replace(/'/g, "")}', ` : "";
    const weight = cap.bold ? 800 : 600;
    const style = cap.italic ? "italic " : "";
    const fontFor = (size: number): string => `${style}${weight} ${size}px ${family}system-ui, sans-serif`;

    ctx.save();
    ctx.textAlign = h === "left" ? "left" : h === "right" ? "right" : "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    const x = h === "left" ? pad : h === "right" ? cw - pad : cw / 2;

    // Rotate the whole block around its anchor (ASS positive angle = CCW).
    if (cap.angle) {
      ctx.translate(x, top + blockH / 2);
      ctx.rotate((-cap.angle * Math.PI) / 180);
      ctx.translate(-x, -(top + blockH / 2));
    }

    // Opaque box behind the block, sized to the widest line.
    if (cap.box) {
      let widest = 0;
      if (hook) {
        ctx.font = fontFor(hookSize);
        widest = Math.max(widest, ctx.measureText(hook).width);
      }
      if (title) {
        ctx.font = fontFor(titleSize);
        widest = Math.max(widest, ctx.measureText(title).width);
      }
      const bpad = Math.round(hookSize * 0.18);
      const bx = h === "left" ? x - bpad : h === "right" ? x - widest - bpad : x - widest / 2 - bpad;
      ctx.fillStyle = cap.boxColor;
      ctx.fillRect(bx, top - bpad, widest + bpad * 2, blockH + bpad * 2);
    }

    let y = top;
    const drawLine = (text: string, size: number): void => {
      ctx.font = fontFor(size);
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
    if (hook) drawLine(hook, hookSize);
    if (title) drawLine(title, titleSize);
    ctx.restore();
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
      state.cropPath && state.cropPath.length > 0
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
      flashErr(m.keyframes.needIn);
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
        state.cropPath = null;
        trackStatus.textContent = m.track.statusNoBoxes;
        setOutput(m.track.noBoxesOutput);
      } else {
        state.cropPath = path;
        trackStatus.textContent = `${m.track.statusOnPrefix}${path.length}${m.track.statusOnSuffix}`;
        setOutput(
          `${m.track.resultPrefix}${path.length}${m.track.resultMid}${samples.length}${m.track.resultSuffix}`,
          "ok",
        );
      }
      drawOverlay();
      refreshIO();
    } catch (err) {
      state.cropPath = null;
      trackStatus.textContent = m.track.statusFailed;
      setOutput(`${m.track.failedOutputPrefix}${errMsg(err)}`, "err");
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
    trackStatus.textContent = m.track.statusNone;
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
        trackStatus.textContent = `${m.assistant.trackFromAssistantPrefix}${state.cropPath.length}${m.assistant.trackFromAssistantSuffix}`;
        drawOverlay();
        refreshIO();
        return { applied: true, staged: false };
      }
      case "render": {
        // STAGE only — never auto-fire. Surface a hint; the manual Render button
        // owns the encode.
        setOutput(m.activity.stagedForRender);
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
    if (!state.source || !state.dims) return flashErr(m.errors.loadSourceFirst);
    if (state.inPoint == null || state.outPoint == null)
      return flashErr(m.errors.setInOut);
    if (state.outPoint <= state.inPoint) return flashErr(m.errors.outAfterIn);

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

    // Caption shot-list data (SPEC §6.5) — carried in the manifest regardless
    // of whether burn-in is enabled at render. Trim; omit empty fields.
    const hook = state.hook.trim();
    const title = state.title.trim();
    if (hook) spec.hook = hook;
    if (title) spec.title = title;
    // Omit the default (bottom-center, stored as "bottom") to keep manifests clean.
    if ((hook || title) && state.textPosition !== "bottom") spec.text_position = state.textPosition;
    // Per-clip caption style (omitting engine defaults). Only meaningful with text.
    if (hook || title) {
      const cap = captionStyleToSpec(state.caption);
      if (cap) spec.caption = cap;
    }

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
        state.clips.splice(i + 1, 0, structuredClone(spec));
        refreshManifest();
      });
      const del = el("button", "fl-clip-x") as HTMLButtonElement;
      del.textContent = "✕";
      del.title = m.queue.removeTitle;
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
      ? `${escapeHtml(m.queue.queueLabel)} <span class="n">${state.clips.length}</span> · <span class="n">${fmtClock(total, false)}</span>`
      : `${escapeHtml(m.queue.queueLabel)} <span class="n">0</span>`;
    renderBtn.textContent = state.clips.length ? `${m.queue.renderN} ${state.clips.length}` : m.topbar.render;
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
    state.inPoint = r.inPoint;
    state.outPoint = r.outPoint;
    state.contentMode = r.contentMode;
    state.contentBox = r.contentBox;
    state.cropBox = r.cropBox;
    state.keyframes = r.keyframes;
    state.cropPath = r.cropPath;
    nameInput.value = r.name;
    // Caption fields aren't part of specToEditorState (they live untouched in
    // the manifest module); read them straight off the spec for round-trip.
    state.hook = spec.hook ?? "";
    state.title = spec.title ?? "";
    // Re-normalize through the parse/join round-trip so any 9-zone value (or a
    // legacy bare keyword) restores cleanly and the two selects reflect it.
    const restored = parseTextPosition(spec.text_position);
    state.textPosition = joinTextPosition(restored.v, restored.h);
    hookInput.value = state.hook;
    titleCapInput.value = state.title;
    syncSelectsFromPos();
    state.caption = captionStyleFromSpec(spec.caption);
    syncCaptionControls();
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
    modal.setAttribute("aria-label", m.history.ariaLabel);

    // header: title + N renders · spacer · Clear all · close
    const head = el("div", "fl-modal-h");
    const titleWrap = el("div");
    titleWrap.style.cssText = "display:flex; align-items:center; gap:11px;";
    const title = el("span", "fl-label");
    title.style.fontSize = "13px";
    title.textContent = m.history.title;
    const countPill = el("span", "fl-pill ghost");
    titleWrap.append(title, countPill);
    const clearBtn = button(m.history.clearAll, "fl-btn sm ghost danger", () => {
      entries = [];
      void save();
      draw();
    });
    const closeBtn = button("", "fl-iconbtn");
    closeBtn.innerHTML = ICON_X;
    closeBtn.title = m.common.close;
    head.append(titleWrap, el("span", "fl-spacer"), clearBtn, closeBtn);

    // tools: filter field + "stored · local" chip
    const tools = el("div", "fl-modal-tools");
    const filterField = el("div", "fl-field");
    filterField.style.flex = "1";
    filterField.innerHTML = `<span class="ic">${ICON_SEARCH}</span>`;
    const filterInput = input("text", m.history.filterPlaceholder);
    filterField.append(filterInput);
    const storedChip = el("span", "fl-rdchip");
    storedChip.innerHTML = `<span class="lab">${escapeHtml(m.history.storedLabel)}</span><span class="val">${escapeHtml(m.history.storedValue)}</span>`;
    tools.append(filterField, storedChip);
    filterInput.addEventListener("input", () => draw());

    const body = el("div", "fl-modal-body");
    const empty = el("div", "hint");
    empty.style.padding = "24px 8px";
    empty.textContent = m.history.emptyHint;

    const foot = el("div", "fl-modal-foot");
    foot.innerHTML =
      '<span class="idot in" style="background:var(--accent)"></span>' +
      m.history.footHtmlBody;

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
        `<span class="sep">·</span><span class="k">${escapeHtml(m.clip.durKey)}</span><span class="v accent">${dur}</span>` +
        (kf > 0 ? `<span class="sep">·</span><span class="k">kf</span><span class="v">${kf}</span>` : "") +
        `<span class="sep">·</span><span class="path">${escapeHtml(entry.outdir)}</span>`;
      meta.append(top, src, read);

      const side = el("div", "fl-hist-side");
      const time = el("span", "fl-hist-time");
      time.textContent = fmtClockTime(entry.ts);
      const actions = el("div", "fl-hist-actions");
      const openBtn = button(m.history.open, "fl-btn sm primary", () => {
        dismiss();
        void openSpec(entry.spec, entry.outdir);
      });
      const rm = button("", "fl-iconbtn sm rm");
      rm.innerHTML = ICON_TRASH;
      rm.title = m.history.removeTitle;
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
      countPill.textContent = `${entries.length} ${entries.length === 1 ? m.history.renderSingular : m.history.renderPlural}`;
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
        none.textContent = m.history.noMatches;
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
  if (diff <= 0) return m.history.today;
  if (diff === 1) return m.history.yesterday;
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The clip's framing mode as a pill: track / punch-in / keyframes / fixed offset. */
function offsetMode(spec: ClipSpec): { label: string; ghost: boolean } {
  if (spec.cropPath?.length) return { label: m.history.modeTrack, ghost: false };
  if (spec.cropWindow) return { label: m.history.modePunchIn, ghost: false };
  const off = spec.crop_offset ?? m.framing.defaultOffset;
  if (off.includes(";") || off.includes("=")) return { label: m.history.modeKeyframes, ghost: false };
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

/**
 * The persisted output folder, or `""` when the user has never chosen one — the
 * caller then seeds the platform default (native: a folder in ~/Movies) via
 * `platform.defaultOutdir()`. (Returning `""` here, not `"clips"`, is what lets a
 * fresh native install adopt a real home-dir folder instead of a relative path
 * next to the app bundle — issue #58.)
 */
function loadOutdir(): string {
  try {
    return localStorage.getItem(OUTDIR_KEY) || "";
  } catch {
    return "";
  }
}

function saveOutdir(value: string): void {
  try {
    const v = value.trim();
    if (v) localStorage.setItem(OUTDIR_KEY, v);
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
