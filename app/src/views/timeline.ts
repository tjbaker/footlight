// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The loudness-timeline VIEW (#125 Phase 4). `buildTimeline(store, deps)` owns
 * the full-width track under the viewer — the normalized RMS waveform, scene
 * cuts, onset ticks, the In/Out region, keyframe diamonds, assistant ghost
 * previews, the live playhead, the swell chips above the track, the hover-scrub
 * thumbnail, the onset-snap toggle, and the prev/next-cut jump buttons — plus
 * the track's pointer interaction (the app's single scrubber AND trimmer).
 *
 * Repaints are REACTIVE where the data flows through `store.set` (duration, t,
 * sceneCuts, loudness, swells, onsets). `renderRegion`/`renderKf` are ALSO
 * exposed on the view handle: assistant commits still mutate In/Out/keyframes
 * directly (no store notification), so the editor's `refreshIO`/
 * `refreshKeyframes` keep driving those two explicitly. Ghosts are pushed via
 * `renderGhosts(gs)` — the editor's `setGhosts` seam to the assistant view.
 *
 * The editor supplies what the view can't do itself via `deps`: `seek` (frame
 * extraction vs video playback is the transport's call), the cached frame
 * extractor behind the hover thumb, and the scene-detect action (a platform
 * fetch).
 */

import { LOUDNESS_BUCKETS } from "@core";
import type { GhostPreview } from "@assistant-types";
import { messages } from "../i18n/index.js";
import { el, button } from "../ui.js";
import { ICON_NEXT_CUT, ICON_PREV_CUT } from "../icons.js";
import { clamp, round3, fmtClock, escapeHtml } from "../editor-util.js";
import { loadSnapPref, saveSnapPref } from "../editor-prefs.js";
import { snapToOnset } from "../editor-snap.js";
import type { EditorStore } from "../editor-store.js";

/** What the timeline needs from the editor (everything else it imports). */
export interface TimelineViewDeps {
  /** Seek in the active mode (video playback vs frame extraction). */
  seek: (t: number) => void;
  /** Fetch (cached) the source frame at `t` as an image URL — the hover thumb. */
  extractFrame: (source: string, t: number) => Promise<string>;
  /** Run scene detection for the loaded source (the "Detect scenes" button). */
  onDetectScenes: () => void;
}

/** The timeline view: its root element + the seams the editor still drives. */
export interface TimelineView {
  element: HTMLElement;
  /** `t` snapped to the nearest onset when the snap toggle is on (else unchanged). */
  snapT: (t: number) => number;
  /** Seek to the nearest scene cut before (dir<0) or after (dir>0) the playhead. */
  jumpCut: (dir: number) => void;
  /** Select the In/Out marker that ←/→ will nudge (null clears the selection). */
  setSelectedMarker: (m: "in" | "out" | null) => void;
  /** Nudge the selected In/Out marker by `delta` seconds; false when none is selected. */
  nudgeMarker: (delta: number) => boolean;
  /** Repaint the In/Out region (commit writes bypass the store — see refreshIO). */
  renderRegion: () => void;
  /** Repaint the keyframe diamonds (same direct-write seam as renderRegion). */
  renderKf: () => void;
  /** Replace the pending assistant ghost set and repaint its timeline previews. */
  renderGhosts: (ghosts: GhostPreview[]) => void;
  /** Toggle the waveform's loading shimmer (and repaint the bars). */
  setWaveLoading: (loading: boolean) => void;
}

export function buildTimeline(store: EditorStore, deps: TimelineViewDeps): TimelineView {
  const state = store.state;
  const m = messages.editor;

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
  const scenesBtn = button(m.timeline.detectScenes, "fl-btn sm", () => deps.onDetectScenes());
  scenesBtn.title = m.timeline.detectScenesTitle;
  tlInfo.append(cutsChip, swellsChip, snapBtn, scenesBtn);

  /** `t` snapped to the nearest onset when the toggle is on (else unchanged). */
  const snapT = (t: number): number => (snapOn ? snapToOnset(t, state.onsets) : t);

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
    if (target != null) deps.seek(target);
  }

  timeline.append(tlCluster, tlCol, tlInfo);

  // ----- timeline rendering -----
  const pct = (t: number): string => `${clamp((t / (state.duration || 1)) * 100, 0, 100)}%`;

  /**
   * Pending assistant ghost previews (dashed, preview-only) drawn on the
   * timeline while proposals await Accept / Step / Discard. Pushed via the
   * exposed `renderGhosts`; nothing here mutates editor state — that's the
   * commit's job. (The stage crop-box ghosts are the viewer's copy.)
   */
  let ghostPreviews: GhostPreview[] = [];

  /** Waveform loading shimmer (on while the loudness fetch is in flight). */
  let waveLoading = false;

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

  function renderWave(): void {
    tlWave.innerHTML = "";
    tlWave.classList.toggle("loading", waveLoading);
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
      const chip = button("", "fl-suggest", () => deps.seek(Math.max(0, sw.t - 0.4)));
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
   * `renderKf`). The stage crop-box ghost is drawn by the viewer's overlay.
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

  function movePlayhead(): void {
    if (!(state.duration > 0)) {
      tlPlayhead.style.display = "none";
      return;
    }
    tlPlayhead.style.display = "block";
    tlPlayhead.style.left = pct(state.t);
    tlBubble.textContent = fmtClock(state.t, true);
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
      deps.seek(state.inPoint);
      return true;
    }
    if (selectedMarker === "out" && state.outPoint != null) {
      store.set({
        outPoint: round3(clamp(state.outPoint + delta, state.inPoint ?? 0, state.duration)),
      });
      deps.seek(state.outPoint);
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
      deps.seek(t);
    } else if (tlDrag === "in") {
      store.set({ inPoint: round3(clamp(t, 0, state.outPoint ?? state.duration)) });
      deps.seek(t);
    } else if (tlDrag === "out") {
      store.set({ outPoint: round3(clamp(t, state.inPoint ?? 0, state.duration)) });
      deps.seek(t);
    }
  });
  const endTlDrag = (e: PointerEvent) => {
    if (tlDrag == null) return;
    tlTrack.releasePointerCapture(e.pointerId);
    if (tlDrag === "region" && !tlMoved) {
      // A plain click: seek there and drop any marker selection.
      setSelectedMarker(null);
      deps.seek(regionAnchor);
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
      void deps.extractFrame(state.source, Math.round(t * 2) / 2).then(
        (url) => {
          if (token === hoverToken) tlHoverImg.src = url;
        },
        () => undefined,
      );
    }, 90);
  }
  tlTrack.addEventListener("pointerleave", hideHoverThumb);

  // Reactive repaints for everything whose data flows through `store.set`
  // (In/Out + keyframes also reach this view via the exposed renderRegion /
  // renderKf — assistant commits mutate them without notifying).
  const any = (changed: ReadonlySet<string>, ...keys: string[]): boolean =>
    keys.some((k) => changed.has(k));
  store.onChange((changed) => {
    if (changed.has("duration")) renderRuler();
    if (any(changed, "duration", "sceneCuts")) renderCuts();
    if (changed.has("loudness")) renderWave();
    if (any(changed, "duration", "swells")) renderSwells();
    if (any(changed, "duration", "onsets")) renderOnsets();
    if (any(changed, "duration", "t")) movePlayhead();
  });
  renderWave();

  return {
    element: timeline,
    snapT,
    jumpCut,
    setSelectedMarker,
    nudgeMarker,
    renderRegion,
    renderKf,
    renderGhosts: (ghosts: GhostPreview[]): void => {
      ghostPreviews = ghosts;
      renderGhosts();
    },
    setWaveLoading: (loading: boolean): void => {
      waveLoading = loading;
      renderWave();
    },
  };
}
