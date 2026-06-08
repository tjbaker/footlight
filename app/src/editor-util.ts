// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure, DOM-free helpers lifted out of `editor.ts` so they can be unit-tested in
 * isolation (the editor itself is one big `mountEditor()` closure that touches the
 * DOM on import). Nothing here reads `document`/`window`, localStorage, or the
 * i18n catalog — just data in, data out. The caption-style ↔ spec round-trip is
 * the important one: it decides what each clip carries in the manifest.
 */

import { parseTimestamp } from "@core";
import type { CaptionStyle, ClipSpec } from "@manifest";

// ---- caption style (editor working copy ↔ sparse manifest spec) ----

/** Editor working copy of `CaptionStyle` — every field populated for the controls. */
export interface CaptionStyleState {
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
export function defaultCaptionStyle(): CaptionStyleState {
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
export function captionStyleToSpec(c: CaptionStyleState): CaptionStyle | null {
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
export function captionStyleFromSpec(spec: CaptionStyle | undefined): CaptionStyleState {
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

// ---- caption placement (9-zone grid) ----

export type TextPosV = "top" | "center" | "bottom";
export type TextPosH = "left" | "center" | "right";

/** Split a stored `text_position` into its vertical/horizontal axes. */
export function parseTextPosition(value: string | undefined): { v: TextPosV; h: TextPosH } {
  const [rawV, rawH] = (value || "").trim().toLowerCase().split("-");
  const v: TextPosV = rawV === "top" || rawV === "center" ? rawV : "bottom";
  const h: TextPosH = rawH === "left" || rawH === "right" ? rawH : "center";
  return { v, h };
}

/** Combine the two axes back into a stored value (`"<v>"` or `"<v>-<h>"`). */
export function joinTextPosition(v: TextPosV, h: TextPosH): string {
  return h === "center" ? v : `${v}-${h}`;
}

// ---- scalar / string utilities ----

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function roundEvenLocal(n: number): number {
  const i = Math.round(n);
  return i - (i % 2);
}

export function shorten(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.length > 28 ? base.slice(0, 25) + "…" : base;
}

/** Format seconds as `m:ss` (ruler ticks) or `m:ss.mmm` (playhead bubble). */
export function fmtClock(sec: number, withMs: boolean): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  if (!withMs) return base;
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${base}.${String(ms).padStart(3, "0")}`;
}

/** Timecode `mm:ss.s` (e.g. 62.04 → "01:02.0"). */
export function fmtTC(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Basename of a path (no truncation; the caller's CSS handles overflow). */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Parse a timestamp string to seconds, or NaN if unparseable. */
export function safeParse(ts: string): number {
  try {
    return parseTimestamp(ts);
  } catch {
    return NaN;
  }
}

/** Escape a string for safe interpolation into innerHTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Keyframe count for a clip (track path points or schedule switch points). */
export function kfCount(spec: ClipSpec): number {
  if (spec.cropPath?.length) return spec.cropPath.length;
  const off = spec.crop_offset ?? "";
  if (off.includes("=")) return off.split(";").filter((p) => p.includes("=")).length;
  return 0;
}
