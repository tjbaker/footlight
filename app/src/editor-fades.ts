// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure helpers for per-clip fades (issue #165) and the loop-seam check, lifted
 * out of `editor.ts` so they are unit-testable without the DOM. The fade fields
 * are simple scalars (seconds); the interesting parts are the input parsing
 * (free-text number field → a safe non-negative value), the sparse spec
 * round-trip (omit zeros so manifests stay clean), the fits-the-clip
 * validation mirrored from the engine, and the loop-seam frame times.
 */

import type { ClipSpec } from "@manifest";

/** The editor's working fade values, in seconds (0 = no fade). */
export interface FadeState {
  fadeIn: number;
  fadeOut: number;
}

/**
 * Parse a fade text-field value into seconds: trims, accepts plain non-negative
 * numbers, and degrades anything unusable (empty, NaN, negative, non-finite) to
 * 0 — the field is a small numeric input, so "garbage means no fade" beats an
 * error state mid-typing. Values are ms-rounded to match the engine's f3 output.
 */
export function parseFadeField(raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1000) / 1000;
}

/**
 * Narrow the working fades to the sparse manifest fields: only positive values
 * are kept (JSON carries them as plain numbers; the CSV serializer stringifies
 * them), so a clip without fades carries neither field.
 */
export function fadesToSpec(f: FadeState): Pick<ClipSpec, "fade_in" | "fade_out"> {
  const out: Pick<ClipSpec, "fade_in" | "fade_out"> = {};
  if (f.fadeIn > 0) out.fade_in = f.fadeIn;
  if (f.fadeOut > 0) out.fade_out = f.fadeOut;
  return out;
}

/** Hydrate working fades from a clip spec (absent/invalid → 0). */
export function fadesFromSpec(spec: Pick<ClipSpec, "fade_in" | "fade_out">): FadeState {
  const norm = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  return { fadeIn: norm(spec.fade_in), fadeOut: norm(spec.fade_out) };
}

/**
 * Whether the fades fit the clip window — mirrors the engine's early error
 * (`fade_in + fade_out` must not exceed the clip duration) so the editor can
 * refuse to queue a clip the render would reject.
 */
export function fadesFit(f: FadeState, durationSec: number): boolean {
  return f.fadeIn + f.fadeOut <= durationSec;
}

/**
 * The two source times the loop-seam check extracts: the In frame and the LAST
 * frame inside the clip (Out is exclusive — the frame at `outPoint` is the
 * first one NOT in the clip — so step one frame back, clamped to In). Seeing
 * these side by side shows how the clip will loop: out-frame → in-frame.
 */
export function loopSeamTimes(
  inPoint: number,
  outPoint: number,
  fps: number,
): { inT: number; outT: number } {
  const frame = fps > 0 ? 1 / fps : 1 / 30;
  return { inT: inPoint, outT: Math.max(inPoint, outPoint - frame) };
}
