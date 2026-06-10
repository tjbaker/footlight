// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The frame-viewer stage VIEW (#125 Phase 4). `buildViewer(store, deps)` owns
 * the stage — the frame image, the (transport-driven) video element, the crop
 * overlay canvas, the first-launch onboarding, and the floating live 9:16
 * output preview — plus everything painted on it: `drawOverlay` (the 9:16 crop
 * box, content box, push ghost, assistant ghost proposals), the preview redraw
 * (with its caption approximation), and the crop/content drag-resize-draw
 * pointer interaction.
 *
 * Repaints are REACTIVE for the framing/caption keys that flow through
 * `store.set`; `drawOverlay` is ALSO exposed on the view handle because
 * assistant commits and the transport's video tick repaint it explicitly.
 * Ghost proposals are pushed via `renderGhosts(gs)` — the editor's `setGhosts`
 * seam to the assistant view (the timeline keeps its own copy for the track).
 *
 * The transport (still in the editor; #187 Slice C) drives playback through
 * the exposed seams: the raw `video` element, `isVideoMode`/`setVideoMode`
 * (which media element is shown), `showFrame`/`showFrameError` (the extracted
 * frame), and `setStageTime`. The editor supplies `currentRegion`/
 * `contentOrigin` (its framing wrappers — `framingToSpec` and the readouts
 * share them) and the onboarding's browse/paste actions via `deps`.
 */

import { TARGET_AR } from "@core";
import type { Box, Dims } from "@manifest";
import type { GhostPreview } from "@assistant-types";
import { openGuide } from "../help.js";
import { messages } from "../i18n/index.js";
import { el, button } from "../ui.js";
import { ICON_BRAND, ICON_DOWN } from "../icons.js";
import { clamp, roundEvenLocal, escapeHtml } from "../editor-util.js";
import {
  edgeHits,
  insideBox,
  resizeCrop,
  fullHeightCropBox,
  parseContentCropPx,
  cropRegionRect as regionRectPure,
} from "../editor-crop.js";
import { trackedBoxXAt } from "../editor-offset.js";
import { pushKeyframes, pushPreviewBox } from "../editor-push.js";
import { hasActiveTrack, isCropInteractive, clipLength } from "../editor-store.js";
import { loadPreviewPref, savePreviewPref } from "../editor-prefs.js";
import { layoutPreviewCaptions, type PreviewCaptionLine } from "../editor-caption-preview.js";
import type { EditorStore } from "../editor-store.js";

/** What the viewer needs from the editor (everything else it imports). */
export interface ViewerViewDeps {
  /** The working region a `crop_offset` is computed against (the editor's wrapper). */
  currentRegion: () => Dims;
  /** Content-box origin when content mode is active (source ↔ region shift). */
  contentOrigin: () => { x: number; y: number } | null;
  /** Whether the platform has a native picker (drag-drop + Browse onboarding). */
  supportsFilePicker: boolean;
  /** Open the native file picker (the onboarding Browse button). */
  onBrowse: () => void;
  /** Focus the source-path field (the onboarding paste hint). */
  onFocusPath: () => void;
}

/** The viewer view: the stage element + the seams the editor still drives. */
export interface ViewerView {
  /** The stage (append into the viewer column, above the transport). */
  element: HTMLElement;
  /** The playback element — the transport owns play/shuttle/src (#187 Slice C). */
  video: HTMLVideoElement;
  /** Whether the video element (vs the extracted frame) is the shown media. */
  isVideoMode: () => boolean;
  /** Switch the shown media: true reveals the video (and syncs the overlay
   *  to it); false hides it so the frame image takes over again. */
  setVideoMode: (on: boolean) => void;
  /** Show an extracted frame URL (revoking the previous blob). */
  showFrame: (url: string) => void;
  /** Show a frame-extraction error on the stage's center message. */
  showFrameError: (msg: string) => void;
  /** Mirror the playhead time onto the stage's time tag. */
  setStageTime: (t: number) => void;
  /** Leave the empty (onboarding) stage state — a source is loaded. */
  setLoaded: () => void;
  /** Reflect a drag-and-drop hover on the stage. */
  setDropActive: (on: boolean) => void;
  /** Repaint the crop overlay (commits and the video tick drive it directly). */
  drawOverlay: () => void;
  /** Replace the pending assistant ghost set and repaint the stage previews. */
  renderGhosts: (ghosts: GhostPreview[]) => void;
  /** Flip the live 9:16 output preview; returns the new on-state. */
  togglePreview: () => boolean;
  /** Whether the live 9:16 output preview is shown (persisted, default on). */
  isPreviewOn: () => boolean;
  /** Nudge the crop box within the working region (Alt+arrows). */
  nudgeCrop: (dx: number, dy: number) => void;
  /** Reset the crop box (and content box) to the source-frame defaults. */
  initCropBox: () => void;
}

export function buildViewer(store: EditorStore, deps: ViewerViewDeps): ViewerView {
  const state = store.state;
  const m = messages.editor;

  // Whether the live 9:16 output preview is shown (persisted, default on).
  let previewOn = loadPreviewPref();

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
  const canDrop = deps.supportsFilePicker;
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
  // Wire the interactive bits to the editor's handlers (reuse, don't rebuild).
  emptyMsg.querySelector(".fl-drop-browse")?.addEventListener("click", () => deps.onBrowse());
  emptyMsg.querySelector(".fl-drop-paste")?.addEventListener("click", () => deps.onFocusPath());
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

  /**
   * Pending assistant ghost previews (dashed, preview-only) drawn on the stage
   * while proposals await Accept / Step / Discard. Pushed via the exposed
   * `renderGhosts`; nothing here mutates editor state — that's the commit's job.
   */
  let ghostPreviews: GhostPreview[] = [];

  // Whether the <video> (vs the extracted frame img) is the shown media — the
  // transport flips it via `setVideoMode`.
  let videoMode = false;

  /** Whichever media element is shown — the <video> in playback mode, else the frame img. */
  function currentMedia(): HTMLElement {
    return videoMode ? video : img;
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

  // Resize the overlay canvas to the displayed image and (re)draw the box.
  img.addEventListener("load", () => {
    syncOverlay();
    drawOverlay();
  });
  window.addEventListener("resize", () => {
    syncOverlay();
    drawOverlay();
  });
  video.addEventListener("loadedmetadata", () => {
    syncOverlay();
    drawOverlay();
  });

  function syncOverlay(): void {
    if (!state.dims) return;
    const media = currentMedia();
    const rect = media.getBoundingClientRect();
    overlay.width = rect.width;
    overlay.height = rect.height;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.display = "block";
    // Position the overlay exactly over the active media element.
    overlay.style.left = `${media.offsetLeft}px`;
    overlay.style.top = `${media.offsetTop}px`;
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
        const g = pushPreviewBox(pushKfs, rel, deps.contentOrigin());
        ctx.strokeStyle = "#7ab8ff";
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(g.x * s, g.y * s, g.w * s, g.h * s);
        ctx.setLineDash([]);
      }
      // Corner handles signal the box is resizable into a punch-in (hidden while
      // an AI track owns the framing).
      if (isCropInteractive(state)) {
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
    const zoom = b.h > 0 ? deps.currentRegion().height / b.h : 1;
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
   * The working region the crop box lives in (source px): content box when
   * content-crop mode is active (and drawn), else the full frame. Thin wrapper
   * over the pure `editor-crop` math, reading the live state.
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

  /** Nudge the crop box within the working region (Alt+arrows). */
  function nudgeCrop(dx: number, dy: number): void {
    if (!state.cropBox || !isCropInteractive(state)) return;
    const r = cropRegionRect();
    // A FRESH box through the store (not in-place x/y writes) so the readout +
    // overlay render via subscription, like the pointer drags.
    const box = { ...state.cropBox };
    if (dx) {
      box.x = clamp(box.x + dx, r.x0, Math.max(r.x0, r.x1 - box.w));
    }
    if (dy && box.h < r.y1 - r.y0 - 2) {
      box.y = clamp(box.y + dy, r.y0, Math.max(r.y0, r.y1 - box.h));
    }
    store.set({ cropBox: box });
  }

  /** Cursor hinting the move/resize/draw affordance under the pointer. */
  function hoverCursor(px: number, py: number): string {
    const margin = EDGE_MARGIN_PX / state.displayScale;
    if (state.contentMode) {
      const b = state.contentBox;
      if (b && b.w > 2 && b.h > 2) {
        const ed = edgeHits(px, py, b, margin);
        if ((ed.l && ed.t) || (ed.r && ed.b)) return "nwse-resize";
        if ((ed.r && ed.t) || (ed.l && ed.b)) return "nesw-resize";
        if (ed.l || ed.r) return "ew-resize";
        if (ed.t || ed.b) return "ns-resize";
        if (insideBox(px, py, b)) return "move";
      }
      return "crosshair"; // empty area → draw a fresh box
    }
    if (state.cropBox && isCropInteractive(state)) {
      const b = state.cropBox;
      const ed = edgeHits(px, py, b, margin);
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
      const margin = EDGE_MARGIN_PX / s;
      const b = state.contentBox;
      // Grab an existing box (edges → resize, interior → move); only DRAW a fresh
      // box when the press lands outside it (or there is no usable box yet).
      if (b && b.w > 2 && b.h > 2 && insideBox(px, py, b, margin)) {
        const edges = edgeHits(px, py, b, margin);
        drag =
          edges.l || edges.r || edges.t || edges.b
            ? { startX: px, startY: py, box: { ...b }, mode: "resize-content", edges }
            : { startX: px, startY: py, box: { ...b }, mode: "move-content" };
      } else {
        drag = { startX: px, startY: py, box: { x: px, y: py, w: 0, h: 0 }, mode: "draw-content" };
        state.contentBox = { x: px, y: py, w: 0, h: 0 };
        drawOverlay();
      }
    } else if (state.cropBox && isCropInteractive(state)) {
      const margin = EDGE_MARGIN_PX / s;
      const ed = edgeHits(px, py, state.cropBox, margin);
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
    // overlay + readouts exactly once per change.
  });

  overlay.addEventListener("pointerup", (e) => {
    overlay.releasePointerCapture(e.pointerId);
    overlay.classList.remove("dragging");
    drag = null;
  });

  // Double-click the framing box (normal mode) to undo a punch-in: reset to the
  // default full-height, centered 9:16 window.
  overlay.addEventListener("dblclick", () => {
    if (state.contentMode || !state.cropBox || !isCropInteractive(state)) return;
    resetCropBoxFullHeight();
  });

  // Reactive repaints for the framing/caption keys that flow through
  // `store.set` (assistant commits and the video tick bypass the store — the
  // editor drives those repaints through the exposed drawOverlay).
  const any = (changed: ReadonlySet<string>, ...keys: string[]): boolean =>
    keys.some((k) => changed.has(k));
  store.onChange((changed) => {
    if (any(changed, "cropBox", "contentBox", "contentMode", "keyframes", "cropPath", "push")) {
      drawOverlay();
    }
    if (any(changed, "hook", "title", "textPosition", "caption")) drawPreview();
  });

  return {
    element: stage,
    video,
    isVideoMode: () => videoMode,
    setVideoMode: (on: boolean): void => {
      videoMode = on;
      if (on) {
        img.style.display = "none";
        emptyMsg.style.display = "none";
        video.style.display = "block";
        syncOverlay();
        drawOverlay();
      } else {
        video.style.display = "none";
      }
    },
    showFrame: (url: string): void => {
      const prev = img.src;
      img.src = url;
      img.style.display = "block";
      emptyMsg.style.display = "none";
      if (prev.startsWith("blob:")) URL.revokeObjectURL(prev);
    },
    showFrameError: (msg: string): void => {
      emptyMsg.textContent = msg;
      emptyMsg.style.display = "block";
    },
    setStageTime: (t: number): void => {
      stageTimeTag.textContent = `t = ${t.toFixed(3)}s`;
    },
    setLoaded: (): void => {
      stage.classList.remove("empty");
    },
    setDropActive: (on: boolean): void => {
      stage.classList.toggle("dropping", on);
    },
    drawOverlay,
    renderGhosts: (ghosts: GhostPreview[]): void => {
      ghostPreviews = ghosts;
      drawOverlay();
    },
    togglePreview: (): boolean => {
      previewOn = !previewOn;
      savePreviewPref(previewOn);
      drawPreview();
      return previewOn;
    },
    isPreviewOn: () => previewOn,
    nudgeCrop,
    initCropBox,
  };
}
