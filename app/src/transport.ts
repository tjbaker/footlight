// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The transport (#125 Phase 4, #187 Slice C) — playback/seek logic plus the
 * jog-bar DOM, as `createTransport(store, deps)`. It owns:
 *
 *  - `setT` (the seek/extract-frame core: debounced ffmpeg frame fetch with a
 *    supersede token) and `seek` (frame extraction vs video playback);
 *  - video mode — play-with-audio via the viewer's <video>, the J/K/L shuttle
 *    (forward via playbackRate, reverse via a step loop), Space play/pause;
 *  - the transport bar: the single play button, the ±1s/±0.1/±1f jog steps,
 *    the in→out duration chip and the timecode readout;
 *  - the global keyboard handler (keyboard-first operation: J/K/L, Space,
 *    arrows, I/O marks, Q/W/Home/End go-tos, S add-clip, [ ] cut jumps, the
 *    assistant hotkeys).
 *
 * It sits ABOVE the viewer and timeline views: they expose the seams it
 * drives (`showFrame`, `setVideoMode`, `nudgeCrop`, `nudgeMarker`, `jumpCut`,
 * `snapT`, …), while their `seek` dep points back here — the editor resolves
 * that cycle by handing the timeline a `(t) => transport.seek(t)` closure.
 * The editor keeps only `setPlayEnabled`/`setWindowDur`/`resetForNewSource`
 * (load + readout glue) and calls `setT` from spec-restore and commits.
 */

import { platform } from "./platform/index.js";
import { messages } from "./i18n/index.js";
import { openShortcuts } from "./shortcuts.js";
import { el, button } from "./ui.js";
import { PAUSE_GLYPH, PLAY_GLYPH } from "./icons.js";
import { clamp, errMsg, escapeHtml } from "./editor-util.js";
import type { EditorStore } from "./editor-store.js";
import type { ViewerView } from "./views/viewer.js";
import type { TimelineView } from "./views/timeline.js";

/** What the transport needs from the editor (everything else it imports). */
export interface TransportDeps {
  /** The stage view — media display, overlay repaint, crop nudge. */
  viewer: ViewerView;
  /** The timeline view — marker nudge/selection, cut jumps, onset snap. */
  timeline: TimelineView;
  /** The assistant dock's hotkey seams (A toggles; Esc closes when open). */
  assistant: { toggle: () => void; isOpen: () => boolean; close: () => void };
  /** Stage the current In/Out + framing as a queue card (the S hotkey). */
  onAddClip: () => void;
  /** Surface a playback error (the Activity / Output panel). */
  onPlayError: (msg: string) => void;
}

/** The transport: its bar element + the seams the editor still drives. */
export interface Transport {
  /** The transport bar (append into the viewer column, under the stage). */
  element: HTMLElement;
  /** Set current time, fetch the frame (debounced unless immediate). */
  setT: (t: number, immediate?: boolean) => Promise<void>;
  /** Seek in the active mode (video playback vs frame extraction). */
  seek: (t: number) => void;
  /** Enable/disable the play button (a loaded source enables it). */
  setPlayEnabled: (on: boolean) => void;
  /** Mirror the In→Out window duration onto the transport chip. */
  setWindowDur: (text: string) => void;
  /** New source: leave video mode and drop the previous player src. */
  resetForNewSource: () => void;
}

export function createTransport(store: EditorStore, deps: TransportDeps): Transport {
  const state = store.state;
  const m = messages.editor;
  const { viewer, timeline } = deps;
  const video = viewer.video;

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

  let frameToken = 0;
  let debounceTimer: number | undefined;

  /** Set current time, fetch the frame (debounced unless immediate). */
  async function setT(t: number, immediate = false): Promise<void> {
    if (!state.dims) return;
    t = clamp(t, 0, state.duration);
    store.set({ t }); // the timeline's playhead follows via its subscription
    tLabel.textContent = `${t.toFixed(3)}s`;
    viewer.setStageTime(t);
    if (debounceTimer) window.clearTimeout(debounceTimer);
    const fetchFrame = async () => {
      const token = ++frameToken;
      try {
        const url = await platform.extractFrame(state.source, state.t);
        if (token !== frameToken) {
          URL.revokeObjectURL(url);
          return; // a newer request superseded this one
        }
        viewer.showFrame(url);
      } catch (err) {
        viewer.showFrameError(errMsg(err));
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
    if (viewer.isVideoMode()) video.currentTime = clamped;
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
    viewer.setVideoMode(true);
  }

  /** Leave video mode: pause and hide the player (the frame img takes over again). */
  function exitVideoMode(): void {
    shuttleRate = 0;
    stopReverseLoop();
    if (!video.paused) video.pause();
    viewer.setVideoMode(false);
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
      if (!viewer.isVideoMode()) await enterVideoMode();
    } catch (err) {
      deps.onPlayError(errMsg(err));
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
      if (!viewer.isVideoMode()) await enterVideoMode();
    } catch (err) {
      deps.onPlayError(errMsg(err));
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
    if (!viewer.isVideoMode()) return;
    store.set({ t: video.currentTime }); // the timeline's playhead follows
    tLabel.textContent = `${state.t.toFixed(3)}s`;
    viewer.setStageTime(state.t);
    viewer.drawOverlay();
  });

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
      deps.assistant.toggle();
      return;
    }
    if (deps.assistant.isOpen() && e.key === "Escape") {
      deps.assistant.close();
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
          viewer.nudgeCrop(dir * CROP_NUDGE_PX, 0);
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
          viewer.nudgeCrop(0, (e.key === "ArrowDown" ? 1 : -1) * CROP_NUDGE_PX);
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
          store.set({ inPoint: timeline.snapT(state.t) }); // identity unless onset snap is ON
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
          store.set({ outPoint: timeline.snapT(state.t) }); // identity unless onset snap is ON
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
        deps.onAddClip();
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

  return {
    element: transport,
    setT,
    seek,
    setPlayEnabled: (on: boolean): void => {
      playBtn.disabled = !on;
    },
    setWindowDur: (text: string): void => {
      const valEl = ioChip.querySelector(".val");
      if (valEl) valEl.textContent = text;
    },
    resetForNewSource: (): void => {
      exitVideoMode();
      video.removeAttribute("src");
    },
  };
}
