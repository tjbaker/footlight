// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The single-clip cutter editor — now a thin COMPOSITION ROOT (#125 Phase 4).
 * `mountEditor` builds the store, builds each view, wires their deps, and
 * mounts the result; everything else lives in its own module:
 *
 *  - `editor-store.ts` — the state container (writes via `store.set`, views
 *    repaint on their own subscriptions);
 *  - `views/topbar.ts`, `views/viewer.ts`, `views/inspector.ts` (+
 *    `views/caption-style.ts`), `views/timeline.ts`, `views/queue.ts`,
 *    `views/assistant.ts`, `views/activity.ts`, `views/history.ts` — the
 *    panels, each owning its DOM + repaints behind an explicit deps seam;
 *  - `transport.ts` — playback/seek (`setT` is the seek/extract-frame core),
 *    the jog bar, and the global keyboard handler;
 *  - `editor-framing.ts` — the pure framing-emission precedence (state →
 *    manifest fields), shared by the views and the actions;
 *  - `editor-actions.ts` — the orchestration that cuts across views: load /
 *    render / history / open-spec / add-clip / assistant commits / session.
 *
 * Cross-module cycles (the views call actions; the actions drive the views)
 * resolve through `(…) => instance.x(…)` deps closures: every instance is a
 * const in this scope, and the closures only fire after mount completes.
 */

import { serializeManifestJSON } from "@manifest";
import { platform, platformName } from "./platform/index.js";
import { initTheme } from "./settings.js";
import { errMsg } from "./editor-util.js";
import {
  contentOrigin,
  currentRegion,
  cropWindowSpec,
  currentOffset,
} from "./editor-framing.js";
import { createEditorStore } from "./editor-store.js";
import { createEditorActions } from "./editor-actions.js";
import { createTransport } from "./transport.js";
import { saveOutdir } from "./editor-prefs.js";
import { el } from "./ui.js";
import { buildTopbar } from "./views/topbar.js";
import { buildActivityPanel } from "./views/activity.js";
import { buildViewer } from "./views/viewer.js";
import { buildInspector } from "./views/inspector.js";
import { buildAssistantView, type AssistantView } from "./views/assistant.js";
import { buildTimeline } from "./views/timeline.js";
import { buildQueueStrip } from "./views/queue.js";

export function mountEditor(root: HTMLElement): void {
  const store = createEditorStore();
  const state = store.state;

  const isTauri = platformName === "tauri";

  // The AI assistant dock is built mid-way (its onOpenChange needs the
  // inspector), but the top bar and the transport's hotkeys reference it —
  // forward-declare so their closures can call it (they only fire after the
  // view is assigned).
  // eslint-disable-next-line prefer-const -- assigned once, but referenced above its build site.
  let assistant: AssistantView;

  root.innerHTML = "";
  // Resolve light/dark/System and install the live OS listener (handles a
  // persisted "system" theme correctly on boot — the top-bar toggle is a quick
  // light<->dark override).
  initTheme();

  // ===== top bar (views/topbar.ts) =====
  const topbar = buildTopbar({
    onRender: () => void actions.doRender(),
    onHistory: () => void actions.openHistory(),
    onClear: () => actions.confirmClear(),
    onTogglePreview: () => viewerView.togglePreview(),
    onToggleAssistant: () => assistant.toggle(),
    onToggleActivity: () => {
      if (isTauri) void activity.toggleNative();
      else activity.setOpen(!activity.isOpen());
    },
    onThemeChanged: () => void activity.pushTheme(),
  });

  // ===== Activity / Output panel (views/activity.ts) =====
  // On the web build its floating panel mounts to the body; on Tauri the log
  // is a separate OS window. Its open / has-output state mirrors onto the
  // topbar's toggle button.
  const activity = buildActivityPanel({
    isTauri,
    onToggleState: (s) => topbar.setActivityState(s),
  });
  const setOutput = activity.setOutput;

  const appEl = el("div", "fl-app");
  const main = el("div", "fl-main");

  // ----- viewer column (views/viewer.ts) -----
  // The stage: frame/video/overlay/preview + onboarding, the overlay/preview
  // painting, and the crop/content drag interaction.
  const viewerView = buildViewer(store, {
    currentRegion: () => currentRegion(state),
    contentOrigin: () => contentOrigin(state),
    supportsFilePicker: platform.supportsFilePicker,
    onBrowse: () => void actions.browse(),
    onFocusPath: () => inspectorView.revealSource(),
  });
  topbar.reflectPreview(viewerView.isPreviewOn());
  const viewer = el("div", "fl-viewer");
  viewer.append(viewerView.element); // the transport bar appends under it below

  // ----- inspector column (views/inspector.ts) -----
  // Both tabs (Source/Clip/Framing/Captions/Keyframes/Add + auto-track, with
  // the caption-style cluster in views/caption-style.ts); readouts refresh on
  // its own store subscription.
  const inspectorView = buildInspector(store, {
    platform,
    snapT: (t) => timeline.snapT(t),
    extractFrame: (source, t) => actions.extractCached(source, t),
    currentRegion: () => currentRegion(state),
    contentOrigin: () => contentOrigin(state),
    cropWindowSpec: () => cropWindowSpec(state),
    currentOffset: () => currentOffset(state),
    setWindowDur: (text) => transport.setWindowDur(text),
    renderRegion: () => timeline.renderRegion(),
    renderKf: () => timeline.renderKf(),
    onLoad: () => void actions.load(),
    onBrowse: () => void actions.browse(),
    onBrowseOutdir: () => void actions.browseOutdir(),
    onOutdirChange: (value) => {
      saveOutdir(value);
      actions.saveSessionSoon();
    },
    onAddClip: () => actions.addClip(),
    onAsk: () => assistant.open(),
    ensureApiKey: () => actions.ensureApiKey(),
    getApiKey: () => actions.getApiKey(),
    setOutput,
  });

  // ----- AI assistant dock (views/assistant.ts; slides over the inspector) -----
  // Commits flow back through the actions' applyCommit; proposal "ghost"
  // previews via setGhosts (the viewer/timeline own the drawing); open/close
  // reflects by hiding the inspector + toggling the topbar spark.
  assistant = buildAssistantView({
    store,
    currentRegion: () => currentRegion(state),
    ensureApiKey: () => actions.ensureApiKey(),
    getApiKey: () => actions.getApiKey(),
    applyCommit: (commit) => actions.applyCommit(commit),
    setGhosts: (gs) => actions.setGhosts(gs),
    onOpenChange: (open) => {
      inspectorView.element.style.display = open ? "none" : "";
      topbar.reflectAssistant(open);
    },
  });

  main.append(viewer, inspectorView.element, assistant.element);

  // ===== loudness timeline (views/timeline.ts) =====
  // The track DOM + repaints, the In/Out drag-trim, the hover thumb, the
  // onset-snap toggle and the cut-jump buttons.
  const timeline = buildTimeline(store, {
    seek: (t) => transport.seek(t),
    extractFrame: (source, t) => actions.extractCached(source, t),
    onDetectScenes: () => void actions.doScenes(),
  });

  // ===== transport (transport.ts) =====
  // Playback/seek, the jog bar, and the global keyboard handler. Built after
  // the viewer/timeline views it drives; the timeline's `seek` dep above
  // resolves back to this instance through its closure.
  const transport = createTransport(store, {
    viewer: viewerView,
    timeline,
    assistant: {
      toggle: () => assistant.toggle(),
      isOpen: () => assistant.isOpen(),
      close: () => assistant.close(),
    },
    onAddClip: () => actions.addClip(),
    onPlayError: (msg) => setOutput(msg, "err"),
  });
  viewer.append(transport.element);

  // ===== filmstrip queue (views/queue.ts) =====
  const queueView = buildQueueStrip(store, {
    setThumb: (elm, source, t) => void actions.setThumb(elm, source, t),
    openSpec: (spec, outdir) => void actions.openSpec(spec, outdir),
    getOutdir: () => inspectorView.getOutdir(),
    onAdd: () => actions.addClip(),
    onExportJson: () => {
      if (!state.clips.length) return;
      void platform
        .exportTextFile("footlight-manifest.json", serializeManifestJSON(state.clips))
        .catch((err) => setOutput(errMsg(err), "err"));
    },
    onExportCover: () => void actions.doExportCover(),
  });

  // ===== actions (editor-actions.ts) =====
  // The orchestration across all of the above — built last so it can take the
  // view handles directly.
  const actions = createEditorActions({
    store,
    platform,
    viewer: viewerView,
    timeline,
    transport,
    inspector: inspectorView,
    topbar,
    setOutput,
    setOutDir: activity.setOutDir,
  });

  appEl.append(topbar.element, main, timeline.element, queueView.element);
  root.append(appEl);
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
              void actions.load();
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

  // The views refresh their own DOM on their store subscriptions; the
  // composition root keeps only the queue dependents (the topbar render
  // button + session autosave).
  store.onChange((changed) => {
    if (changed.has("clips")) actions.refreshQueueDependents();
  });

  // Initial readouts (the recents datalist seeds in the inspector's build).
  inspectorView.refreshIO();
  inspectorView.refreshKeyframes();
  actions.refreshQueueDependents();
  // NOTE: the keychain is read lazily (see the actions' ensureApiKey) on first
  // AI use, not here — launching the app must not trigger an OS keychain prompt.
  void actions.restoreSession();
}
