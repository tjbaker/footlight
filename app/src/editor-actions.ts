// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's ACTIONS (#125 Phase 4) — the orchestration layer between the
 * views, as `createEditorActions(deps)`. Where a view owns one panel's DOM,
 * an action cuts across them: `load` probes a source and fans out to the
 * inspector/viewer/transport/timeline/topbar; `doRender` pre-flights, renders
 * and records history; `openSpec` rehydrates a stored clip through `load` and
 * the store; `addClip` emits the manifest row (via the pure
 * `editor-framing.ts` precedence); `applyCommit` runs an assistant commit's
 * UI effects; the session functions autosave/restore/clear the workspace.
 *
 * Built LAST in `mountEditor` (it takes every view handle directly); the
 * views reach back through `(…) => actions.x(…)` deps closures, which is the
 * same one-instance-built-later seam the transport ⇄ timeline cycle uses.
 */

import { detectSwells, detectOnsets, coverOutName } from "@core";
import {
  serializeManifestJSON,
  specToEditorState,
  type ClipSpec,
} from "@manifest";
import type { GhostPreview, CommitOp } from "@assistant-types";
import { messages } from "./i18n/index.js";
import type { FootlightPlatform, HistoryEntry, SessionData } from "./platform/types.js";
import { migrateLegacyApiKey, GEMINI_API_KEY_SECRET } from "./autotrack.js";
import {
  captionStyleToSpec,
  captionStyleFromSpec,
  parseTextPosition,
  joinTextPosition,
  errMsg,
} from "./editor-util.js";
import { applyCommitToState } from "./editor-commit.js";
import { fadesToSpec, fadesFromSpec, fadesFit } from "./editor-fades.js";
import { framingToSpec } from "./editor-framing.js";
import type { EditorStore, EditorState } from "./editor-store.js";
import { el, button } from "./ui.js";
import { openHistoryModal } from "./views/history.js";
import { renderOptions, saveOutdir, pushRecent } from "./editor-prefs.js";
import type { ViewerView } from "./views/viewer.js";
import type { TimelineView } from "./views/timeline.js";
import type { InspectorView } from "./views/inspector.js";
import type { TopbarView } from "./views/topbar.js";
import type { Transport } from "./transport.js";

/** Max number of past renders kept in the history. */
const HISTORY_CAP = 50;

/** Every handle the actions cut across (built before this, in mountEditor). */
export interface EditorActionsDeps {
  store: EditorStore;
  platform: FootlightPlatform;
  viewer: ViewerView;
  timeline: TimelineView;
  transport: Transport;
  inspector: InspectorView;
  topbar: TopbarView;
  /** Write to the shared Output panel (render / scene-detect / auto-track). */
  setOutput: (text: string, kind?: "ok" | "err") => void;
  /** Surface the resolved output directory on the Activity panel. */
  setOutDir: (dir: string) => void;
}

export interface EditorActions {
  browse: () => Promise<void>;
  load: () => Promise<void>;
  doScenes: () => Promise<void>;
  doRender: () => Promise<void>;
  browseOutdir: () => Promise<void>;
  openSpec: (spec: ClipSpec, outdir?: string) => Promise<void>;
  openHistory: () => Promise<void>;
  doExportCover: () => Promise<void>;
  addClip: () => void;
  applyCommit: (commit: CommitOp) => { applied: boolean; staged: boolean };
  setGhosts: (gs: GhostPreview[]) => void;
  /** Fetch (cached) the source frame at `t` as an image URL. */
  extractCached: (source: string, t: number) => Promise<string>;
  /** Fill a `.fl-thumb` with the source frame at `t` (object-fit cover). */
  setThumb: (elm: HTMLElement, source: string, t: number) => Promise<void>;
  /** Reflect the queue length on the Render button + autosave the session. */
  refreshQueueDependents: () => void;
  saveSessionSoon: () => void;
  restoreSession: () => Promise<void>;
  confirmClear: () => void;
  /** LAZILY load the BYOK key from the keychain (first AI use, never launch). */
  ensureApiKey: () => Promise<void>;
  getApiKey: () => string;
}

export function createEditorActions(deps: EditorActionsDeps): EditorActions {
  const { store, platform, viewer, timeline, transport, inspector, topbar, setOutput, setOutDir } =
    deps;
  const state = store.state;
  const m = messages.editor;

  /** Open the native file picker; on a pick, fill the field and load it. */
  async function browse(): Promise<void> {
    try {
      const picked = await platform.pickSourceFile();
      if (!picked) return; // cancelled
      inspector.setSource(picked);
      await load();
    } catch (err) {
      inspector.setSourceError(errMsg(err));
    }
  }

  async function load(): Promise<void> {
    const source = inspector.getSource();
    if (!source) {
      inspector.setSourceError(m.source.enterPath);
      inspector.focusSource();
      return;
    }
    inspector.setProbing();
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
      inspector.setProbeResult(p);
      topbar.setSourceCrumb(source.split(/[\\/]/).pop() || source);
      viewer.setLoaded();
      transport.setPlayEnabled(true);
      pushRecent(source);
      inspector.refreshRecents();
      saveSessionSoon();
      void loadLoudness(source);
      void autoDetectScenes(source);
      // New source → start in frame mode; drop any previous player source.
      transport.resetForNewSource();
      // Default 9:16 crop box: full height, centered.
      viewer.initCropBox();
      await transport.setT(state.t, true);
    } catch (err) {
      inspector.setSourceError(errMsg(err));
    }
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

  async function doScenes(): Promise<void> {
    if (!state.source) return inspector.flashError(m.errors.loadSourceFirst);
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

  /** Write to the shared Output panel (render / scene-detect / auto-track). */
  async function doRender(): Promise<void> {
    if (!state.clips.length) return inspector.flashError(m.errors.addAtLeastOne);
    const outdir = inspector.getOutdir() || (await platform.defaultOutdir());
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
        inspector.focusOutdir();
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
      inspector.setOutdir(picked);
      saveOutdir(picked);
    } catch (err) {
      setOutput(errMsg(err), "err");
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
    inspector.setSource(spec.source_file);
    if (outdir) {
      inspector.setOutdir(outdir);
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
    inspector.syncFromState(r.name);
    await transport.setT(r.inPoint, true);
    viewer.drawOverlay(); // setT redraws the frame; ensure the overlay lands after it
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
    Object.assign(spec, framingToSpec(state, state.t));
    const name = inspector.getName();
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

  function addClip(): void {
    const flashErr = inspector.flashError;
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
    Object.assign(spec, framingToSpec(state));
    const name = inspector.getName();
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
    inspector.clearName();
  }

  /**
   * Apply ONE accepted commit: the state transition is the pure
   * `applyCommitToState` (editor-commit.ts); this wrapper runs the UI effects
   * it returns, in order, against the view handles.
   */
  function applyCommit(commit: CommitOp): { applied: boolean; staged: boolean } {
    const res = applyCommitToState(state, commit);
    for (const fx of res.effects) {
      switch (fx.kind) {
        case "refreshIO":
          inspector.refreshIO();
          break;
        case "seekToIn":
          void transport.setT(state.inPoint!, true);
          break;
        case "refreshContentReadout":
          inspector.refreshContentReadout();
          break;
        case "refreshCropReadout":
          inspector.refreshCropReadout();
          break;
        case "drawOverlay":
          viewer.drawOverlay();
          break;
        case "detectScenes":
          void doScenes();
          break;
        case "refreshKeyframes":
          inspector.refreshKeyframes();
          break;
        case "trackStatus":
          inspector.setTrackStatusCount(fx.count);
          break;
        case "stagedRender":
          setOutput(m.activity.stagedForRender);
          break;
      }
    }
    return { applied: res.applied, staged: res.staged };
  }

  /** Replace the pending assistant ghost set and repaint the stage + timeline
   *  previews (each view keeps its own copy; nothing here mutates editor
   *  state — that's the commit's job). */
  function setGhosts(gs: GhostPreview[]): void {
    timeline.renderGhosts(gs);
    viewer.renderGhosts(gs);
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

  /**
   * The render button's label/disabled state and the session autosave react to
   * the queue too — but they cut across the topbar and the session (the queue
   * VIEW owns only the cards), so they live here: the editor's clips
   * subscription and the initial mount both call this.
   */
  function refreshQueueDependents(): void {
    topbar.setRenderCount(state.clips.length);
    void saveSessionSoon();
  }

  // ---------- session (project) persistence ----------
  let sessionTimer: number | undefined;
  /** Debounced autosave of the working session (source + queue + outdir). */
  function saveSessionSoon(): void {
    if (sessionTimer) window.clearTimeout(sessionTimer);
    sessionTimer = window.setTimeout(() => {
      const data: SessionData = {
        source: state.source,
        outdir: inspector.getOutdir(),
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
    if (data.outdir) inspector.setOutdir(data.outdir);
    if (Array.isArray(data.clips) && data.clips.length) {
      store.set({ clips: data.clips });
    }
    if (data.source) {
      inspector.setSource(data.source);
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
        outdir: inspector.getOutdir(),
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

  // The BYOK Gemini key lives in the OS keychain (via `secretStore`), not in
  // the auto-track blob. Read LAZILY on first AI use — never at launch — so
  // the native app doesn't prompt for keychain access unless you actually use
  // the assistant / Auto-track.
  let apiKey = "";
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

  return {
    browse,
    load,
    doScenes,
    doRender,
    browseOutdir,
    openSpec,
    openHistory,
    doExportCover,
    addClip,
    applyCommit,
    setGhosts,
    extractCached,
    setThumb,
    refreshQueueDependents,
    saveSessionSoon,
    restoreSession,
    confirmClear,
    ensureApiKey,
    getApiKey: () => apiKey,
  };
}
