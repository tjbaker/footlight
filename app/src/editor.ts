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
  cropBoxToWindow,
  contentCropFromBox,
  scheduleToString,
  serializeManifestJSON,
  specToEditorState,
  type Dims,
  type ClipSpec,
} from "@manifest";
import type { GhostPreview, CommitOp } from "@assistant-types";
import { platform, platformName } from "./platform/index.js";
import { messages } from "./i18n/index.js";
import { createTransport } from "./transport.js";

/** The editor's localized strings (the `editor` namespace of the catalog). */
const m = messages.editor;

import type { HistoryEntry, SessionData } from "./platform/types.js";
import { openSettings, initTheme } from "./settings.js";
import { migrateLegacyApiKey, GEMINI_API_KEY_SECRET } from "./autotrack.js";
import {
  captionStyleToSpec,
  captionStyleFromSpec,
  parseTextPosition,
  joinTextPosition,
  errMsg,
} from "./editor-util.js";
import { cropWindowSpec as cropWindowSpecPure } from "./editor-crop.js";
import { currentRegion as currentRegionPure, offsetForBox } from "./editor-offset.js";
import { applyCommitToState } from "./editor-commit.js";
import { fadesToSpec, fadesFromSpec, fadesFit } from "./editor-fades.js";
import { pushKeyframes } from "./editor-push.js";
import { createEditorStore, hasActiveTrack, clipLength, type EditorState } from "./editor-store.js";
import { el, button } from "./ui.js";
import {
  ICON_ACTIVITY,
  ICON_BRAND,
  ICON_GEAR,
  ICON_HISTORY,
  ICON_MOON,
  ICON_PHONE,
  ICON_SPARK,
  ICON_SUN,
} from "./icons.js";
import { openHistoryModal } from "./views/history.js";
import { buildQueueStrip } from "./views/queue.js";
import { buildActivityPanel } from "./views/activity.js";
import { buildAssistantView, type AssistantView } from "./views/assistant.js";
import { buildTimeline } from "./views/timeline.js";
import { buildViewer } from "./views/viewer.js";
import { buildInspector } from "./views/inspector.js";
import { renderOptions, saveOutdir, pushRecent, saveTheme } from "./editor-prefs.js";

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
  // interaction. `currentRegion`/`contentOrigin` are the editor's framing
  // wrappers (`framingToSpec` and the readouts share them).
  const viewerView = buildViewer(store, {
    currentRegion: () => currentRegion(),
    contentOrigin: () => contentOrigin(),
    supportsFilePicker: platform.supportsFilePicker,
    onBrowse: () => void browse(),
    onFocusPath: () => inspectorView.revealSource(),
  });
  reflectPreviewBtn(viewerView.isPreviewOn());
  // Commits and spec-restore repaint the overlay directly (their writes bypass
  // the store) — keep the view's repaint reachable as a plain local.
  const drawOverlay = viewerView.drawOverlay;

  // The viewer column: the stage on top; the transport bar (transport.ts,
  // built after the timeline view below) appends under it.
  const viewer = el("div", "fl-viewer");
  viewer.append(viewerView.element);

  // ----- inspector column (views/inspector.ts) -----
  // The view owns both tabs (Source/Clip/Framing/Captions/Keyframes/Add +
  // auto-track, with the caption-style cluster in views/caption-style.ts) and
  // refreshes its readouts on its own store subscription; the editor keeps the
  // orchestration (load/browse/render/add-clip) and reaches the fields through
  // the view's seams. Cross-module deps (timeline, transport, assistant) are
  // closures - those instances are built below.
  const inspectorView = buildInspector(store, {
    platform,
    snapT: (t) => timeline.snapT(t),
    extractFrame: (source, t) => extractCached(source, t),
    currentRegion: () => currentRegion(),
    contentOrigin: () => contentOrigin(),
    cropWindowSpec: () => cropWindowSpec(),
    currentOffset: () => currentOffset(),
    setWindowDur: (text) => transport.setWindowDur(text),
    renderRegion: () => timeline.renderRegion(),
    renderKf: () => timeline.renderKf(),
    onLoad: () => void load(),
    onBrowse: () => void browse(),
    onBrowseOutdir: () => void browseOutdir(),
    onOutdirChange: (value) => {
      saveOutdir(value);
      saveSessionSoon();
    },
    onAddClip: () => addClip(),
    onAsk: () => assistant.open(),
    ensureApiKey,
    getApiKey: () => apiKey,
    setOutput,
  });

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
      inspectorView.element.style.display = open ? "none" : "";
      assistantBtn.classList.toggle("on", open);
    },
  });

  main.append(viewer, inspectorView.element, assistant.element);

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

  // ===== transport (transport.ts) =====
  // Playback/seek (`setT` is the seek/extract-frame core), the jog bar, and
  // the global keyboard handler. Built after the viewer/timeline views it
  // drives; the timeline's `seek` dep above resolves back to this instance
  // through its closure (the setT ⇄ views cycle, as one explicit seam).
  const transport = createTransport(store, {
    viewer: viewerView,
    timeline,
    assistant: {
      toggle: () => assistant.toggle(),
      isOpen: () => assistant.isOpen(),
      close: () => assistant.close(),
    },
    onAddClip: () => addClip(),
    onPlayError: (msg) => setOutput(msg, "err"),
  });
  viewer.append(transport.element);
  const setT = transport.setT;
  const seek = transport.seek;

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

  // ===== filmstrip queue (views/queue.ts) =====
  // The view owns the card rendering (reacting to `clips`); the editor supplies
  // the thumbnail painter, the open/outdir hooks, and the add/export handlers.
  // The render button + session autosave also react to `clips` — those stay as
  // the editor's own store subscription below, not driven from the view.
  const queueView = buildQueueStrip(store, {
    setThumb: (elm, source, t) => void setThumb(elm, source, t),
    openSpec: (spec, outdir) => void openSpec(spec, outdir),
    getOutdir: () => inspectorView.getOutdir(),
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
    const name = inspectorView.getName();
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
              inspectorView.setSource(path);
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
        inspectorView.setDropHint();
        inspectorView.focusSource();
      }
    });
  }

  // ---------- behavior ----------

  /** Open the native file picker; on a pick, fill the field and load it. */
  async function browse(): Promise<void> {
    try {
      const picked = await platform.pickSourceFile();
      if (!picked) return; // cancelled
      inspectorView.setSource(picked);
      await load();
    } catch (err) {
      inspectorView.setSourceError(errMsg(err));
    }
  }

  async function load(): Promise<void> {
    const source = inspectorView.getSource();
    if (!source) {
      inspectorView.setSourceError(m.source.enterPath);
      inspectorView.focusSource();
      return;
    }
    inspectorView.setProbing();
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
      inspectorView.setProbeResult(p);
      crumbPath.textContent = source.split(/[\\/]/).pop() || source;
      crumbDot.classList.add("live");
      viewerView.setLoaded();
      transport.setPlayEnabled(true);
      pushRecent(source);
      inspectorView.refreshRecents();
      saveSessionSoon();
      void loadLoudness(source);
      void autoDetectScenes(source);
      // New source → start in frame mode; drop any previous player source.
      transport.resetForNewSource();
      // Default 9:16 crop box: full height, centered.
      viewerView.initCropBox();
      await setT(state.t, true);
    } catch (err) {
      inspectorView.setSourceError(errMsg(err));
    }
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

  /**
   * The working region a `crop_offset` is computed against. Thin wrapper over the
   * pure `editor-offset` math, reading the editor's live state.
   */
  function currentRegion(): Dims {
    return currentRegionPure(state.contentMode, state.contentBox, state.dims!);
  }

  // The inspector/viewer/timeline views refresh their own DOM on their store
  // subscriptions; the editor's subscription keeps only the queue dependents
  // (the render button + session autosave).
  store.onChange((changed) => {
    if (changed.has("clips")) refreshQueueDependents();
  });

  function currentOffset(): string {
    if (!state.cropBox || !state.dims) return "center";
    return offsetForBox(state.cropBox, state.contentMode, state.contentBox, currentRegion());
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
          inspectorView.refreshIO();
          break;
        case "seekToIn":
          void setT(state.inPoint!, true);
          break;
        case "refreshContentReadout":
          inspectorView.refreshContentReadout();
          break;
        case "refreshCropReadout":
          inspectorView.refreshCropReadout();
          break;
        case "drawOverlay":
          drawOverlay();
          break;
        case "detectScenes":
          void doScenes();
          break;
        case "refreshKeyframes":
          inspectorView.refreshKeyframes();
          break;
        case "trackStatus":
          inspectorView.setTrackStatusCount(fx.count);
          break;
        case "stagedRender":
          setOutput(m.activity.stagedForRender);
          break;
      }
    }
    return { applied: res.applied, staged: res.staged };
  }

  function addClip(): void {
    const flashErr = inspectorView.flashError;
    flashErr(""); // clear any previous validation message
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
    const name = inspectorView.getName();
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
    inspectorView.clearName();
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
    if (!state.clips.length) return inspectorView.flashError(m.errors.addAtLeastOne);
    const outdir = inspectorView.getOutdir() || (await platform.defaultOutdir());
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
        inspectorView.focusOutdir();
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
      inspectorView.setOutdir(picked);
      saveOutdir(picked);
    } catch (err) {
      setOutput(errMsg(err), "err");
    }
  }

  async function doScenes(): Promise<void> {
    if (!state.source) return inspectorView.flashError(m.errors.loadSourceFirst);
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
    inspectorView.setSource(spec.source_file);
    if (outdir) {
      inspectorView.setOutdir(outdir);
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
    // Re-sync the inspector's inputs/selects/style controls from the restored
    // state (the patch above landed it all on the store).
    inspectorView.syncFromState(r.name);
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
        outdir: inspectorView.getOutdir(),
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
    if (data.outdir) inspectorView.setOutdir(data.outdir);
    if (Array.isArray(data.clips) && data.clips.length) {
      store.set({ clips: data.clips });
    }
    if (data.source) {
      inspectorView.setSource(data.source);
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
        outdir: inspectorView.getOutdir(),
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

  // Initial readouts (the recents datalist seeds in the inspector's build).
  inspectorView.refreshIO();
  inspectorView.refreshKeyframes();
  refreshQueueDependents();
  // NOTE: the keychain is read lazily (see `ensureApiKey`) on first AI use, not
  // here — launching the app must not trigger an OS keychain prompt.
  void restoreSession();
}

// ---------- small helpers ----------

/** Max number of past renders kept in the history. */
const HISTORY_CAP = 50;
