// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure layout math for the editor's on-canvas caption preview, lifted out of
 * `drawPreviewCaptions` in editor.ts (#125) so it can be unit-tested without a
 * canvas. Given the caption text/placement/style and the preview canvas size,
 * `layoutPreviewCaptions` decides WHAT to draw — the line list (hook above
 * title, newline-split, each at its field's size), the block geometry, the
 * grid anchor, and the per-line CSS font strings. The actual `ctx` painting
 * (stroke/fill, shadow, opaque box, rotation, underline — anything needing
 * `measureText`) stays in editor.ts. Like the preview itself, this mirrors the
 * engine's libass burn only approximately: it is a visual HINT, not the
 * authoritative render.
 */

import {
  parseTextPosition,
  type CaptionStyleState,
  type TextPosH,
} from "./editor-util.js";

/** One preview caption line: its text, px size, and resolved CSS font string. */
export interface PreviewCaptionLine {
  text: string;
  size: number;
  font: string;
}

/** Everything the canvas painter needs, in preview-canvas px. */
export interface PreviewCaptionLayout {
  /** Hook lines (big) then title lines (small), in draw order. */
  lines: PreviewCaptionLine[];
  /** Vertical gap between lines. */
  gap: number;
  /** Edge padding the block keeps from the canvas. */
  pad: number;
  /** Total block height (line sizes + gaps). */
  blockH: number;
  /** Block top edge (y of the first line, textBaseline "top"). */
  top: number;
  /** Anchor x for the block (left/center/right per the horizontal position). */
  x: number;
  /** Horizontal placement — doubles as the canvas `textAlign` value. */
  h: TextPosH;
  /** The hook's px size (the opaque-box padding is derived from it). */
  hookSize: number;
}

/**
 * Mirror the engine: newlines inside hook/title are line breaks, each line
 * rendered at its field's size (blank inner lines kept as spacing, like \N\N).
 */
export function splitCaptionLines(value: string): string[] {
  const t = value.trim();
  return t ? t.split(/\r\n?|\n/).map((s) => s.trim()) : [];
}

/**
 * A bare family name can be rendered by the canvas; a file path can't (no
 * @font-face here), so those fall back to the system UI face for the hint.
 */
export function isFontPath(font: string): boolean {
  return /[\\/]/.test(font) || /\.(ttf|otf|ttc)$/i.test(font);
}

/** The CSS font string for one preview line at `size` px, per the clip style. */
export function previewCaptionFont(cap: CaptionStyleState, size: number): string {
  const family = cap.font && !isFontPath(cap.font) ? `'${cap.font.replace(/'/g, "")}', ` : "";
  const weight = cap.bold ? 800 : 600;
  const style = cap.italic ? "italic " : "";
  return `${style}${weight} ${size}px ${family}system-ui, sans-serif`;
}

/**
 * Lay out the caption block for a `cw`×`ch` preview canvas: hook above title,
 * placed on the 9-zone grid per `textPosition` (vertical top/center/bottom ×
 * horizontal left/center/right). Returns null when there is no text to draw.
 */
export function layoutPreviewCaptions(
  hook: string,
  title: string,
  textPosition: string,
  cap: CaptionStyleState,
  cw: number,
  ch: number,
): PreviewCaptionLayout | null {
  const hookSize = Math.round(ch * 0.052);
  const titleSize = Math.round(ch * 0.036);
  const sized = [
    ...splitCaptionLines(hook).map((text) => ({ text, size: hookSize })),
    ...splitCaptionLines(title).map((text) => ({ text, size: titleSize })),
  ];
  if (sized.length === 0) return null;

  const gap = Math.round(ch * 0.012);
  const pad = Math.round(ch * 0.03);

  // Total block height to place per position.
  const blockH = sized.reduce((sum, l) => sum + l.size, 0) + gap * (sized.length - 1);

  const { v, h } = parseTextPosition(textPosition);
  let top: number;
  if (v === "top") top = pad;
  else if (v === "center") top = (ch - blockH) / 2;
  else top = ch - blockH - pad;

  const x = h === "left" ? pad : h === "right" ? cw - pad : cw / 2;

  const lines = sized.map((l) => ({ ...l, font: previewCaptionFont(cap, l.size) }));
  return { lines, gap, pad, blockH, top, x, h, hookSize };
}
