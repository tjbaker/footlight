// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The inspector column VIEW (#125 Phase 4): the Frame tab (Source, Clip,
 * Framing, Captions, Keyframes, Add sections), the Track-subject tab
 * (auto-track), the tab switch, and the "Ask" entry into the assistant, as
 * `buildInspector(store, deps)`. The per-clip caption STYLE cluster (font
 * picker + colour/emphasis/effects controls) is the sibling
 * `views/caption-style.ts`; this view mounts its element and re-syncs it on
 * clip restore.
 *
 * The view owns its readouts and refreshes them on its own store subscription
 * (In/Out grid, framing mode, crop/content/push/schedule readouts, fade
 * hint). The refresh functions are ALSO exposed on the handle: assistant
 * commits still mutate state directly (no store notification), so the
 * editor's `applyCommit` keeps driving them explicitly — and `refreshIO`
 * fans out to the transport chip + timeline layers via deps closures.
 *
 * The editor keeps the ORCHESTRATION (load/browse/render/add-clip — they
 * touch the topbar, viewer, transport, queue and session) and reaches the
 * inspector's fields through narrow seams (`getSource`/`setProbeResult`/
 * `getOutdir`/`getName`/`flashError`/`syncFromState`, …).
 */

import { contentCropFromBox, scheduleToString, type Dims } from "@manifest";
import { planSampleTimes, samplesToCropPath } from "@track";
import { messages } from "../i18n/index.js";
import type { FootlightPlatform, ProbeResult } from "../platform/types.js";
import { el, input, textarea, autosize, button, sectionHeader } from "../ui.js";
import { ICON_DOWN, ICON_FOLDER, ICON_PLUS, ICON_SPARK } from "../icons.js";
import {
  parseTextPosition,
  joinTextPosition,
  round3,
  errMsg,
  escapeHtml,
  type TextPosV,
  type TextPosH,
} from "../editor-util.js";
import { parseFadeField, loopSeamTimes } from "../editor-fades.js";
import { boxToRegionWindow, describePush } from "../editor-push.js";
import { hasActiveTrack, type EditorStore } from "../editor-store.js";
import { loadRecents, loadOutdir } from "../editor-prefs.js";
import {
  loadAutoTrackSettings,
  saveAutoTrackSettings,
  type AutoTrackSettings,
} from "../autotrack.js";
import { buildCaptionStyle } from "./caption-style.js";

/** What the inspector needs from the editor (everything else it imports). */
export interface InspectorViewDeps {
  platform: FootlightPlatform;
  /** `t` snapped per the timeline's onset-snap toggle (the Set In/Out buttons). */
  snapT: (t: number) => number;
  /** Fetch (cached) the source frame at `t` as an image URL — the loop seam. */
  extractFrame: (source: string, t: number) => Promise<string>;
  // The editor's framing wrappers (framingToSpec and the viewer share them).
  currentRegion: () => Dims;
  contentOrigin: () => { x: number; y: number } | null;
  cropWindowSpec: () => { x: number; y: number; w: number; h: number } | null;
  currentOffset: () => string;
  // Cross-cutting refreshIO repaints (the transport chip + timeline layers).
  setWindowDur: (text: string) => void;
  renderRegion: () => void;
  renderKf: () => void;
  // Actions the editor orchestrates.
  onLoad: () => void;
  onBrowse: () => void;
  onBrowseOutdir: () => void;
  onOutdirChange: (value: string) => void;
  onAddClip: () => void;
  onAsk: () => void;
  // Auto-track BYOK key (the lazy keychain read lives in the editor).
  ensureApiKey: () => Promise<void>;
  getApiKey: () => string;
  /** Write to the shared Output panel (auto-track results/errors). */
  setOutput: (text: string, kind?: "ok" | "err") => void;
}

/** The inspector view: its column element + the seams the editor drives. */
export interface InspectorView {
  element: HTMLElement;
  // -- Source / Destination fields --
  getSource: () => string;
  setSource: (v: string) => void;
  focusSource: () => void;
  /** Focus AND scroll the source field into view (the onboarding paste hint). */
  revealSource: () => void;
  setProbing: () => void;
  setProbeResult: (p: ProbeResult) => void;
  setSourceError: (msg: string) => void;
  /** The web-drop hint (a dropped file exposes no path — paste it instead). */
  setDropHint: () => void;
  refreshRecents: () => void;
  getOutdir: () => string;
  setOutdir: (v: string) => void;
  focusOutdir: () => void;
  // -- Readout refreshes (commit writes bypass the store — see applyCommit) --
  refreshIO: () => void;
  refreshKeyframes: () => void;
  refreshCropReadout: () => void;
  refreshContentReadout: () => void;
  // -- Add-clip seams --
  getName: () => string;
  clearName: () => void;
  flashError: (msg: string) => void;
  /** Re-sync name/caption/fade inputs and style controls from state (clip restore). */
  syncFromState: (name: string) => void;
  /** The assistant-commit track effect: "N keyframes from the assistant". */
  setTrackStatusCount: (count: number) => void;
}

export function buildInspector(store: EditorStore, deps: InspectorViewDeps): InspectorView {
  const state = store.state;
  const m = messages.editor;
  const { platform } = deps;

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
  const loadBtn = button(m.source.load, "fl-btn sm", () => deps.onLoad());
  const srcField = el("div", "fl-field path");
  srcField.innerHTML = `<span class="ic">${ICON_FOLDER}</span>`;
  srcField.append(srcInput, recentsList);
  const srcRow = el("div", "fl-rowg");
  srcRow.append(srcField);
  if (platform.supportsFilePicker) {
    const browseBtn = button(m.source.browse, "fl-btn sm", () => deps.onBrowse());
    browseBtn.style.flex = "none";
    srcRow.append(browseBtn);
  } else {
    loadBtn.style.flex = "none";
    srcRow.append(loadBtn);
  }
  loadBtn.addEventListener("click", () => deps.onLoad());
  srcInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") deps.onLoad();
  });
  const dimsLine = el("div", "hint");
  dimsLine.textContent = m.source.notLoaded;
  const cropdetectLine = el("div", "hint");
  const outdirInput = input("text", m.source.destPlaceholder);
  outdirInput.classList.add("mono");
  outdirInput.value = loadOutdir();
  outdirInput.title = m.source.destTitle;
  outdirInput.addEventListener("change", () => {
    deps.onOutdirChange(outdirInput.value);
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
    const browseDest = button(m.source.browse, "fl-btn sm", () => deps.onBrowseOutdir());
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
    store.set({ inPoint: deps.snapT(state.t) });
  });
  setInBtn.innerHTML = `<span class="idot in"></span>${escapeHtml(m.clip.setIn)}`;
  setInBtn.title = m.clip.setInTitle;
  const setOutBtn = button("", "fl-btn", () => {
    store.set({ outPoint: deps.snapT(state.t) });
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
        deps.extractFrame(state.source, outT),
        deps.extractFrame(state.source, inT),
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
      ? boxToRegionWindow(state.cropBox, deps.contentOrigin(), deps.currentRegion())
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

  // Per-clip caption STYLE (views/caption-style.ts): font + colour + emphasis +
  // effects + rotation, edited in situ so each clip can look different.
  const captionStyle = buildCaptionStyle(store, platform);

  capSect.append(hookField, titleCapField, posField, captionStyle.element);

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
  const addClipBtn = button("", "fl-btn lg primary", () => deps.onAddClip());
  addClipBtn.innerHTML = `${ICON_PLUS}${escapeHtml(m.add.addClip)}`;
  addClipBtn.title = m.add.addClipTitle;
  const clipErr = el("div", "err-text");
  addSect.append(nameField, addClipBtn, clipErr);

  framePane.append(srcSect, clipSect, framingSect, capSect, kfSect, addSect);

  // -- Track tab (auto-track) --
  const autoTrack: AutoTrackSettings = loadAutoTrackSettings();
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
  const askBtn = button("", "fl-btn", () => deps.onAsk());
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

  // ---- readouts ----

  function refreshCropReadout(): void {
    if (!state.cropBox || !state.dims) return;
    const win = deps.cropWindowSpec();
    if (win) {
      const region = deps.currentRegion();
      const zoom = (region.height / win.h).toFixed(2);
      cropReadout.textContent = `${m.framing.punchInPrefix}${win.w}×${win.h} @ (${win.x},${win.y})${m.framing.zoomMid}${zoom}${m.framing.resetSuffix}`;
    } else {
      // Full-height box → plain horizontal crop_offset, relative to the content
      // box when one is active (exactly what `currentOffset` computes).
      cropReadout.textContent = `${m.framing.cropOffsetPrefix}${deps.currentOffset()}`;
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
          : deps.cropWindowSpec()
            ? m.framing.modePunchIn
            : state.keyframes.length
              ? m.framing.modeSchedule
              : deps.currentOffset();
    deps.setWindowDur(dur);
    // Explicit (not view-subscription) repaints: assistant commits write
    // In/Out/keyframes directly, without a store notification.
    deps.renderRegion();
    deps.renderKf(); // keyframe positions are clip-relative to In
    void refreshLoopSeam(); // the seam frames track In/Out while the panel is open
  }

  function addKeyframe(): void {
    if (state.inPoint == null) {
      flashErr(m.keyframes.needIn);
      return;
    }
    const rel = Math.max(0, state.t - state.inPoint);
    store.set({ keyframes: [...state.keyframes, { t: round3(rel), offset: deps.currentOffset() }] });
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
    deps.renderKf();
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
    await deps.ensureApiKey();
    const apiKey = deps.getApiKey();
    if (!apiKey.trim()) {
      trackStatus.textContent = m.track.statusNeedKey;
      return;
    }

    const inPt = state.inPoint;
    const shotEnd = state.outPoint - inPt; // clip-relative shot length
    const region = deps.currentRegion();
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
        deps.setOutput(m.track.noBoxesOutput);
      } else {
        store.set({ cropPath: path });
        trackStatus.textContent = `${m.track.statusOnPrefix}${path.length}${m.track.statusOnSuffix}`;
        deps.setOutput(
          `${m.track.resultPrefix}${path.length}${m.track.resultMid}${samples.length}${m.track.resultSuffix}`,
          "ok",
        );
      }
    } catch (err) {
      store.set({ cropPath: null });
      trackStatus.textContent = m.track.statusFailed;
      deps.setOutput(`${m.track.failedOutputPrefix}${errMsg(err)}`, "err");
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

  function flashErr(msg: string): void {
    clipErr.textContent = msg;
  }

  // Reactive refreshes for the keys that flow through `store.set` (assistant
  // commits bypass the store — the editor's applyCommit drives the exposed
  // refreshes directly).
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
    if (any(changed, "fadeIn", "fadeOut")) refreshFadeHint();
  });
  refreshRecents();

  return {
    element: inspector,
    getSource: () => srcInput.value.trim(),
    setSource: (v: string): void => {
      srcInput.value = v;
    },
    focusSource: (): void => {
      srcInput.focus();
    },
    revealSource: (): void => {
      srcInput.focus();
      srcInput.scrollIntoView({ block: "nearest" });
    },
    setProbing: (): void => {
      dimsLine.textContent = m.source.probing;
      cropdetectLine.textContent = "";
    },
    setProbeResult: (p: ProbeResult): void => {
      dimsLine.innerHTML =
        '<div class="fl-readgrid">' +
        `<div><span class="k">${escapeHtml(m.source.dimKey)}</span><span class="v">${p.width}×${p.height}</span></div>` +
        `<div><span class="k">${escapeHtml(m.source.durKey)}</span><span class="v">${p.duration.toFixed(2)}s</span></div>` +
        `<div><span class="k">${escapeHtml(m.source.arKey)}</span><span class="v">${(p.width / p.height).toFixed(3)}</span></div>` +
        "</div>";
      cropdetectLine.textContent = p.cropdetect
        ? `${m.source.cropdetectPrefix}${p.cropdetect}`
        : m.source.cropdetectNone;
    },
    setSourceError: (msg: string): void => {
      dimsLine.innerHTML = `<span class="err-text">${escapeHtml(msg)}</span>`;
    },
    setDropHint: (): void => {
      dimsLine.innerHTML = `<span class="err-text">${escapeHtml(m.source.dropHint)}</span>`;
    },
    refreshRecents,
    getOutdir: () => outdirInput.value.trim(),
    setOutdir: (v: string): void => {
      outdirInput.value = v;
    },
    focusOutdir: (): void => {
      outdirInput.focus();
      try {
        outdirInput.select();
      } catch {
        /* not selectable — focus is enough */
      }
    },
    refreshIO,
    refreshKeyframes,
    refreshCropReadout,
    refreshContentReadout,
    getName: () => nameInput.value.trim(),
    clearName: (): void => {
      nameInput.value = "";
    },
    flashError: flashErr,
    syncFromState: (name: string): void => {
      nameInput.value = name;
      hookInput.value = state.hook;
      titleCapInput.value = state.title;
      autosize(hookInput);
      autosize(titleCapInput);
      fadeInInput.value = state.fadeIn > 0 ? String(state.fadeIn) : "";
      fadeOutInput.value = state.fadeOut > 0 ? String(state.fadeOut) : "";
      syncSelectsFromPos();
      captionStyle.sync();
    },
    setTrackStatusCount: (count: number): void => {
      trackStatus.textContent = `${m.assistant.trackFromAssistantPrefix}${count}${m.assistant.trackFromAssistantSuffix}`;
    },
  };
}
