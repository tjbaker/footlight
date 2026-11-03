// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Footlight audio analysis: the loudness envelopes, swell detection and onset
 * detection that run on the loudness pass's output (the commands themselves
 * live in `commands.ts`).
 *
 * Browser-safe like `core.ts` (no Node built-in imports), which re-exports
 * everything here so existing `core.js` / `engine.js` / `@core` imports keep
 * working.
 */

import { BucketRmsAccumulator, F32leDecoder, FrameRmsAccumulator } from "./pcm-envelope.js";

// ---------------------------------------------------------------------------
// Loudness envelope + swell detection (the loudness timeline feature).
//
// A cheap pass next to `probe`. The PREFERRED path measures *perceived* loudness
// with ffmpeg's `ebur128` filter (momentary LUFS): a perceptual model ranks the
// dynamic moments correctly, where raw RMS mis-ranks bright vs. low-frequency
// content of equal energy. Per-frame `M:` LUFS values are parsed from ebur128's
// log, mapped to 0..1 over a fixed floor/ceiling, and bucketed across the
// duration. The same decode also emits raw PCM for a raw-RMS envelope
// (`bucketLoudness`) that feeds the swell detector. The bar-rendering color lerp, the swell
// heuristic's *relative* thresholds, and the chip UI live elsewhere; this module
// owns only the numbers.
//
// Pure (text/samples in, numbers out) so it stays browser-safe and file-free in
// tests. The native Rust backend (app/src-tauri/src/media.rs) hand-mirrors these
// (same LUFS floor/ceiling + LOUDNESS_BUCKETS count) — keep them in sync when the
// args or mapping here change.
// ---------------------------------------------------------------------------

/** Resolution of the loudness envelope: number of windows across the source. */
export const LOUDNESS_BUCKETS = 160;

/** LUFS mapped to 0 (the quiet floor). Below this reads as silence. */
export const LUFS_FLOOR = -40;
/** LUFS mapped to 1 (the loud ceiling). At/above this reads as full. */
export const LUFS_CEIL = -5;

/** Map one LUFS reading to 0..1 over [LUFS_FLOOR, LUFS_CEIL]; non-finite → 0. */
export function lufsToNormalized(lufs: number): number {
  if (!Number.isFinite(lufs)) return 0;
  const t = (lufs - LUFS_FLOOR) / (LUFS_CEIL - LUFS_FLOOR);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Bucket per-frame momentary-LUFS readings into `buckets` equal-width windows,
 * averaging each window's normalized (0..1) level. Unlike the RMS path this is an
 * ABSOLUTE perceptual scale (not max-normalized), so quiet material reads quiet;
 * the swell heuristic adapts via its own relative thresholds. Non-finite readings
 * are skipped within a window (an all-silence window → 0). Empty input → zeros.
 */
export function bucketLufs(lufs: number[], buckets: number = LOUDNESS_BUCKETS): number[] {
  if (buckets <= 0) return [];
  const out = new Array<number>(buckets).fill(0);
  const n = lufs.length;
  if (n === 0) return out;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.floor(((b + 1) * n) / buckets);
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const v = lufs[i]!;
      if (!Number.isFinite(v)) continue;
      sum += lufsToNormalized(v);
      count++;
    }
    out[b] = count > 0 ? sum / count : 0;
  }
  return out;
}

/**
 * Bucket raw mono PCM float samples into `buckets` equal-width windows, compute
 * the RMS of each window, then normalize the whole array to 0..1 by dividing by
 * the max (guarding max=0 → all zeros). Returns an array of length `buckets`.
 *
 * Pure: pass a `Float32Array` (e.g. from the f32le stdout of
 * `loudnessCombinedArgs`) and a bucket count (default `LOUDNESS_BUCKETS`).
 * Empty input yields all zeros. Runs on the bounded-memory
 * `BucketRmsAccumulator` (shared with `PcmLoudnessStream`): exact per-sample
 * windows below `RMS_CHUNK_CAP` samples, chunk-snapped edges beyond it.
 */
export function bucketLoudness(
  samples: Float32Array,
  buckets: number = LOUDNESS_BUCKETS,
): number[] {
  const acc = new BucketRmsAccumulator();
  acc.push(samples);
  return acc.finish(buckets);
}

// Tunable thresholds for the swell heuristic — kept named so they are easy to
// adjust. A swell is a rising run whose climb is large RELATIVE TO THE
// ENVELOPE'S OWN DYNAMIC RANGE (not against an absolute "near-silence" floor),
// so it fires on compressed live-music audio that never drops to silence — the
// project's actual target footage — and not just on clips with true quiet parts.
/** Moving-average half-pass window (buckets) used to smooth before detection. */
export const SWELL_SMOOTH_WINDOW = 3;
/** A swell starts from the QUIET band — its trough must sit at or below this
 *  fraction up the envelope's own dynamic range (p10..p90). */
export const SWELL_TROUGH_FRAC = 0.3;
/** …and arrives at the LOUD band — its peak must reach at least this far up the
 *  range. The gap between the two bands is what makes a rise a real swell. */
export const SWELL_TOP_FRAC = 0.7;
/** A swell's rise must also cover at least this fraction of the dynamic range. */
export const SWELL_RISE_FRAC = 0.45;
/** Absolute floor (normalized 0..1) on the rise magnitude, so shallow choppiness
 *  in loud material can't masquerade as a swell. */
export const SWELL_MIN_RISE = 0.18;
/** If the envelope's p10..p90 spread is below this, it is too flat to hold a
 *  meaningful swell — detect none. */
export const SWELL_MIN_RANGE = 0.1;
/** While extending a rise, stop once it falls this far below the running peak
 *  (the rise is over — don't span across into the next valley). */
export const SWELL_DROP_TOL = 0.15;
/** Max span (seconds) over which the rise must happen to count as a swell. */
export const SWELL_MAX_SPAN_SEC = 6;
/** Merge markers closer together than this many seconds into one. */
export const SWELL_MERGE_SEC = 2;

/**
 * Centered moving average with a half-window of `halfWindow` entries each side
 * (truncated at the edges), shared by `detectSwells` and `detectOnsets`.
 */
function movingAverage(values: number[], halfWindow: number): number[] {
  const n = values.length;
  const w = Math.max(0, Math.floor(halfWindow));
  const smooth = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      sum += values[j]!;
      count++;
    }
    smooth[i] = sum / count;
  }
  return smooth;
}

/**
 * Detect "swell" suggestions — quiet→loud build-ups — in a normalized loudness
 * envelope. Explainable heuristic (this is a *suggestion*, never a verdict),
 * tuned for live-music footage where the audio is loud throughout and the
 * interesting moments are *relative* dips-then-rises, not silence→loud:
 *   (a) smooth the envelope with a small moving average;
 *   (b) measure the envelope's own dynamic range from its p10..p90 spread; if
 *       that spread is below `SWELL_MIN_RANGE` the track is too flat → none;
 *   (c) from each trough, extend a rise (allowing minor dips up to
 *       `SWELL_DROP_TOL`) within `SWELL_MAX_SPAN_SEC`; it counts as a swell when
 *       the climb covers ≥ `SWELL_RISE_FRAC` of the range (and ≥ `SWELL_MIN_RISE`
 *       absolute) AND the peak lands in the top `SWELL_TOP_FRAC` of the range;
 *   (d) emit a marker at the steepest point of each qualifying rise, then merge
 *       markers closer than `SWELL_MERGE_SEC`.
 *
 * Returns markers in seconds, labelled `"quiet → loud"`. Pure: envelope in,
 * markers out.
 */
export function detectSwells(
  loudness: number[],
  durationSec: number,
): { t: number; label: string }[] {
  const n = loudness.length;
  if (n < 2 || !(durationSec > 0)) return [];

  // (a) Smooth with a small centered moving average.
  const smooth = movingAverage(loudness, SWELL_SMOOTH_WINDOW);

  // Map a bucket index to a source-seconds timestamp (bucket center).
  const toSec = (idx: number): number => Number((((idx + 0.5) / n) * durationSec).toFixed(3));
  // Max bucket span allowed for a rise, derived from the time budget.
  const maxSpanBuckets = Math.max(1, Math.ceil((SWELL_MAX_SPAN_SEC / durationSec) * n));

  // (b) Derive thresholds from the envelope's OWN dynamic range (p10..p90), so
  // detection adapts to compressed/loud material instead of an absolute floor.
  const sorted = smooth.slice().sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))]!;
  const p10 = at(0.1);
  const p90 = at(0.9);
  const range = p90 - p10;
  if (range < SWELL_MIN_RANGE) return []; // too flat to hold a meaningful swell
  const troughThresh = p10 + SWELL_TROUGH_FRAC * range;
  const peakThresh = p10 + SWELL_TOP_FRAC * range;
  const riseThresh = Math.max(SWELL_MIN_RISE, SWELL_RISE_FRAC * range);

  // (c) From each QUIET-band seed, extend a rise (tolerating minor dips) within
  // the span budget; it qualifies when the peak reaches the LOUD band and the
  // climb clears `riseThresh`. On a hit, mark the steepest step and resume past
  // the peak.
  const markers: number[] = [];
  let i = 0;
  while (i < n) {
    if (smooth[i]! > troughThresh) {
      i++;
      continue; // not a genuine low — a swell must build up from the quiet band
    }
    let peak = smooth[i]!;
    let peakIdx = i;
    let j = i;
    while (j + 1 < n && j - i < maxSpanBuckets) {
      j++;
      const v = smooth[j]!;
      if (v > peak) {
        peak = v;
        peakIdx = j;
      } else if (peak - v > SWELL_DROP_TOL) {
        break; // fell well off the peak — the rise is over
      }
    }
    const rise = peak - smooth[i]!;
    if (rise >= riseThresh && peak >= peakThresh && peakIdx > i) {
      // Steepest point = bucket with the largest positive step in [i, peakIdx].
      let steepIdx = i;
      let steepSlope = -Infinity;
      for (let k = i; k < peakIdx; k++) {
        const slope = smooth[k + 1]! - smooth[k]!;
        if (slope > steepSlope) {
          steepSlope = slope;
          steepIdx = k;
        }
      }
      markers.push(toSec(steepIdx));
      i = peakIdx + 1; // resume past this run's peak
      continue;
    }
    i++;
  }

  // (d) Merge markers closer than SWELL_MERGE_SEC (keep the earlier one).
  const merged: number[] = [];
  for (const t of markers) {
    if (merged.length > 0 && t - merged[merged.length - 1]! < SWELL_MERGE_SEC) continue;
    merged.push(t);
  }

  return merged.map((t) => ({ t, label: "quiet → loud" }));
}

// ---------------------------------------------------------------------------
// Onset detection (the In/Out beat-snap feature, issue #164).
//
// Music footage has no transcript — audio IS the signal — and a cut that lands
// off the musical phrase reads amateur instantly. The 160-bucket display
// envelope above is far too coarse for beats (~1 bucket ≈ 2s on a 5-min source),
// so onsets get their own FINE envelope: fixed `ONSET_FRAME_SEC` RMS frames over
// the same 8 kHz mono PCM the loudness pass already decodes (no extra ffmpeg
// run). The backends compute `onsetEnvelope` next to the two display envelopes
// and ship it across the platform boundary; the frontend derives the onset list
// with `detectOnsets` — the same split as `detect` → `detectSwells`.
//
// Pure (samples/envelope in, numbers out), browser-safe and file-free in tests.
// The native Rust backend (app/src-tauri/src/pcm_envelope.rs) hand-mirrors
// `onsetEnvelope` (same frame size + rounding) — keep them in sync.
// ---------------------------------------------------------------------------

/** Onset-envelope frame length in seconds (50 Hz — fine enough that a snapped
 *  cut lands within ±half a video frame of the audible hit). */
export const ONSET_FRAME_SEC = 0.02;

/**
 * Per-frame RMS envelope at `ONSET_FRAME_SEC` resolution, max-normalized to
 * 0..1 (all-silence stays zeros, like `bucketLoudness`). A trailing partial
 * frame is dropped. Values are rounded to 4 decimals — far below anything the
 * detector can distinguish — so the envelope serializes compactly across the
 * platform boundary and the Rust mirror can pin identical fixtures.
 */
export function onsetEnvelope(samples: Float32Array, sampleRate = 8000): number[] {
  const acc = new FrameRmsAccumulator(onsetFrameLen(sampleRate));
  acc.push(samples);
  return acc.finish(ONSET_DECIMALS);
}

/** Onset-envelope rounding (decimal places). */
const ONSET_DECIMALS = 4;

/** Samples per onset frame at `sampleRate` (at least 1). */
function onsetFrameLen(sampleRate: number): number {
  return Math.max(1, Math.round(sampleRate * ONSET_FRAME_SEC));
}

/**
 * The loudness pass's PCM half, STREAMED (issue #277): feed the f32le stdout of
 * `loudnessCombinedArgs` chunk by chunk as it arrives (any size, floats may
 * split across chunks), then `finish()` for the `detect` envelope
 * (`bucketLoudness`, `LOUDNESS_BUCKETS` windows) and the `onsetEnvelope`. Both
 * come from the same accumulators the buffered functions use, so feeding all
 * the bytes at once or in pieces gives identical results, and memory for the
 * PCM stays bounded however long the source is (see pcm-envelope.ts).
 */
export class PcmLoudnessStream {
  private readonly decoder = new F32leDecoder();
  private readonly detect = new BucketRmsAccumulator();
  private readonly onset: FrameRmsAccumulator;
  /** Total stdout bytes seen (the handler's "no PCM at all" check). */
  bytes = 0;

  constructor(sampleRate = 8000) {
    this.onset = new FrameRmsAccumulator(onsetFrameLen(sampleRate));
  }

  push(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    const samples = this.decoder.push(chunk);
    this.detect.push(samples);
    this.onset.push(samples);
  }

  finish(): { detect: number[]; onsetEnvelope: number[] } {
    return {
      detect: this.detect.finish(LOUDNESS_BUCKETS),
      onsetEnvelope: this.onset.finish(ONSET_DECIMALS),
    };
  }
}

// Tunable thresholds for the onset detector — named so they are easy to adjust.
// An onset is a frame-to-frame energy RISE that stands out from its local
// neighborhood (adaptive threshold), so detection works on quiet and loud
// material alike without an absolute level gate.
/** Moving-average half-pass window (frames) used to smooth before detection. */
export const ONSET_SMOOTH_WINDOW = 1;
/** Width (seconds) of the centered window the adaptive threshold averages over. */
export const ONSET_THRESHOLD_WINDOW_SEC = 1;
/** A rise must exceed the local mean rise by this factor… */
export const ONSET_THRESHOLD_FACTOR = 1.5;
/** …plus this absolute floor (normalized 0..1), so noise-floor jitter and slow
 *  crescendos can't masquerade as onsets. */
export const ONSET_THRESHOLD_DELTA = 0.05;
/** Merge onsets closer together than this many seconds (keep the earlier one). */
export const ONSET_MIN_GAP_SEC = 0.1;

/**
 * Detect energy onsets — drum hits, note attacks, phrase starts — in an
 * `onsetEnvelope`. Classic spectral-flux-style recipe on the energy envelope:
 *   (a) smooth with a small moving average;
 *   (b) half-wave-rectified difference d[i] = max(0, env[i] − env[i−1]) — only
 *       energy RISES count, decays never do;
 *   (c) adaptive threshold: d[i] qualifies when it exceeds the local mean rise
 *       (±`ONSET_THRESHOLD_WINDOW_SEC`/2) × `ONSET_THRESHOLD_FACTOR` +
 *       `ONSET_THRESHOLD_DELTA`, and is a local maximum of d;
 *   (d) merge hits closer than `ONSET_MIN_GAP_SEC`.
 *
 * Returns onset times in seconds, ascending. Times are the START of the rising
 * frame (smoothing biases ≤1 frame early — erring on the cut-before-the-beat
 * side, which is the right side to err on). Pure: envelope in, seconds out.
 */
export function detectOnsets(envelope: number[], frameSec = ONSET_FRAME_SEC): number[] {
  const n = envelope.length;
  if (n < 3 || !(frameSec > 0)) return [];

  // (a) Smooth with a small centered moving average (same smoother as detectSwells).
  const smooth = movingAverage(envelope, ONSET_SMOOTH_WINDOW);

  // (b) Half-wave-rectified first difference (d[0] = 0: a source that starts
  // loud is not an "onset" — there is nothing before it to cut against).
  const d = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) d[i] = Math.max(0, smooth[i]! - smooth[i - 1]!);

  // Prefix sums so each frame's local-mean threshold is O(1).
  const prefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + d[i]!;
  const halfWin = Math.max(1, Math.round(ONSET_THRESHOLD_WINDOW_SEC / 2 / frameSec));

  // (c) Adaptive threshold + local-maximum peak picking.
  const onsets: number[] = [];
  for (let i = 1; i < n; i++) {
    const di = d[i]!;
    if (di <= 0) continue;
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(n - 1, i + halfWin);
    const localMean = (prefix[hi + 1]! - prefix[lo]!) / (hi - lo + 1);
    if (di < ONSET_THRESHOLD_FACTOR * localMean + ONSET_THRESHOLD_DELTA) continue;
    // Local max of the rise (ties break toward the earlier frame).
    if (di <= d[i - 1]! || (i + 1 < n && di < d[i + 1]!)) continue;
    // (d) Enforce the minimum gap (keep the earlier onset).
    const t = Number((i * frameSec).toFixed(3));
    if (onsets.length > 0 && t - onsets[onsets.length - 1]! < ONSET_MIN_GAP_SEC) continue;
    onsets.push(t);
  }
  return onsets;
}
