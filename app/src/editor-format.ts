// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Display-formatting helpers lifted out of editor.ts (#125) so they can be
 * unit-tested without a DOM. Unlike `editor-util.ts` (which is catalog-free),
 * these are LOCALE-AWARE: the history labels read the active i18n catalog and
 * the clock/date formatters go through `toLocale*String`. Still data in, data
 * out — nothing here touches `document`, localStorage, or the platform.
 */

import { parseTimestamp } from "@core";
import type { ClipSpec } from "@manifest";
import type { ProposedAction, GhostPreview } from "@assistant-types";
import { messages } from "./i18n/index.js";

/** The editor's localized strings (the `editor` namespace of the catalog). */
const m = messages.editor;

/** Clip duration in seconds (0 if unparseable). */
export function clipDur(spec: ClipSpec): number {
  try {
    return Math.max(0, parseTimestamp(spec.out_point) - parseTimestamp(spec.in_point));
  } catch {
    return 0;
  }
}

/** Format a tiny USD cost: 4 decimals under a dollar (fractions of a cent), 2 above. */
export function fmtUsd(v: number): string {
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

/** The ghost previews for the not-yet-committed actions (index `from` onward). */
export function ghostsFrom(actions: ProposedAction[], from: number): GhostPreview[] {
  return actions
    .slice(from)
    .map((a) => a.ghost)
    .filter((g): g is GhostPreview => g != null);
}

// ---- history-modal formatting helpers ----

/** Wall-clock render time for an entry (e.g. "2:18 PM"). */
export function fmtClockTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Day-divider label for an entry: "Today" / "Yesterday" / "Mon D". */
export function dayLabel(ts: number): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day = new Date(ts);
  const diff = Math.round((startOfDay(new Date()) - startOfDay(day)) / 86400000);
  if (diff <= 0) return m.history.today;
  if (diff === 1) return m.history.yesterday;
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The clip's framing mode as a pill: track / punch-in / keyframes / fixed offset. */
export function offsetMode(spec: ClipSpec): { label: string; ghost: boolean } {
  if (spec.cropPath?.length) return { label: m.history.modeTrack, ghost: false };
  if (spec.cropWindow) return { label: m.history.modePunchIn, ghost: false };
  const off = spec.crop_offset ?? m.framing.defaultOffset;
  if (off.includes(";") || off.includes("=")) return { label: m.history.modeKeyframes, ghost: false };
  return { label: off, ghost: true };
}
