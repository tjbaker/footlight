// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Streaming RMS envelopes over mono f32le PCM (issue #277).
 *
 * The loudness pass decodes the whole source to 8 kHz f32 PCM (about 32 KB/s,
 * so a 3-hour concert is about 345 MB). Instead of buffering all of it, the
 * backends feed stdout chunks through these accumulators as they arrive:
 *
 *   • `F32leDecoder` turns arbitrary byte chunks into samples, holding a float
 *     that is split across two reads until its last byte lands.
 *   • `FrameRmsAccumulator` is the fixed-frame RMS behind `onsetEnvelope`.
 *     Frame edges are known up front, so it is exact: one running sum per frame.
 *   • `BucketRmsAccumulator` is the equal-width-bucket RMS behind
 *     `bucketLoudness`. Bucket edges (`floor(b * n / buckets)`) depend on the
 *     total sample count `n`, which is unknown until EOF, so no bounded-memory
 *     stream can hit them exactly for every `n`. It keeps under `cap` chunk
 *     sums instead: while `n < cap` every chunk is ONE sample, so the edges and
 *     the summation order are exactly the per-sample formula's (every sample
 *     summed in order into its `floor(b * n / buckets)` window); past `cap` the
 *     chunks double (adjacent pairs merge), so edges snap to a chunk start, at
 *     most `2 * n / cap` samples off.
 *
 * Memory is constant in source duration for the PCM itself: `cap` chunk sums
 * plus 3 carry bytes. The onset envelope is OUTPUT (one value per 20 ms frame,
 * shipped to the frontend), so it grows with duration at 1/frameLen of the PCM.
 *
 * Pure (bytes/samples in, numbers out), browser-safe and file-free in tests.
 * core.ts builds `bucketLoudness` / `onsetEnvelope` / `PcmLoudnessStream` on
 * these, so buffered and streamed results come from ONE implementation. The
 * native Rust backend (app/src-tauri/src/pcm_envelope.rs) hand-mirrors this
 * module, pinned to the same fixtures.
 */

/**
 * Chunk-sum budget of `BucketRmsAccumulator` (2 MiB of f64). Below this many
 * samples (about 32.8 s at 8 kHz) its buckets are exactly the per-sample formula's;
 * beyond it a bucket edge is at most `2 * n / RMS_CHUNK_CAP` samples off, about
 * 0.12% of a bucket's width at 160 buckets.
 */
export const RMS_CHUNK_CAP = 1 << 18;

/** Decode little-endian f32 PCM from byte chunks of any size and alignment. */
export class F32leDecoder {
  private readonly carry = new Uint8Array(4);
  private readonly carryView = new DataView(this.carry.buffer);
  private carryLen = 0;

  /**
   * The whole samples completed by `bytes`. Up to 3 trailing bytes are held for
   * the next call (and dropped if none comes, like the buffered path's floor).
   */
  push(bytes: Uint8Array): Float32Array {
    const out = new Float32Array(Math.floor((this.carryLen + bytes.length) / 4));
    let i = 0;
    let k = 0;
    if (this.carryLen > 0) {
      while (this.carryLen < 4 && i < bytes.length) this.carry[this.carryLen++] = bytes[i++]!;
      if (this.carryLen < 4) return out;
      out[k++] = this.carryView.getFloat32(0, true);
      this.carryLen = 0;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (; i + 4 <= bytes.length; i += 4) out[k++] = view.getFloat32(i, true);
    while (i < bytes.length) this.carry[this.carryLen++] = bytes[i++]!;
    return out;
  }
}

/**
 * Max-normalize RMS values to 0..1 in place (max <= 0 leaves them as they are,
 * so all-silence stays zeros). `decimals`, when given, rounds each normalized
 * value to that many places.
 */
function normalizeMax(values: number[], decimals?: number): number[] {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (max <= 0) return values;
  const scale = decimals === undefined ? undefined : 10 ** decimals;
  for (let k = 0; k < values.length; k++) {
    const v = values[k]! / max;
    values[k] = scale === undefined ? v : Math.round(v * scale) / scale;
  }
  return values;
}

/** RMS of fixed `frameLen`-sample frames; a trailing partial frame is dropped. */
export class FrameRmsAccumulator {
  private readonly rms: number[] = [];
  private sumSq = 0;
  private count = 0;

  constructor(private readonly frameLen: number) {
    if (!(frameLen >= 1)) throw new Error("frameLen must be >= 1");
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      this.sumSq += s * s;
      if (++this.count === this.frameLen) {
        this.rms.push(Math.sqrt(this.sumSq / this.frameLen));
        this.sumSq = 0;
        this.count = 0;
      }
    }
  }

  /** The per-frame RMS so far, max-normalized (see `normalizeMax`). */
  finish(decimals?: number): number[] {
    return normalizeMax(this.rms.slice(), decimals);
  }
}

/**
 * RMS of `buckets` equal-width windows over a stream of unknown length, in
 * bounded memory (see the module comment for when it is exact).
 */
export class BucketRmsAccumulator {
  /** Sum of squares of each FULL chunk of `chunkLen` samples, in order. */
  private readonly sums: number[] = [];
  private chunkLen = 1;
  private partSum = 0;
  private partCount = 0;

  constructor(private readonly cap: number = RMS_CHUNK_CAP) {
    if (!(cap >= 2 && cap % 2 === 0)) throw new Error("cap must be an even number >= 2");
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      this.partSum += s * s;
      if (++this.partCount === this.chunkLen) {
        this.sums.push(this.partSum);
        this.partSum = 0;
        this.partCount = 0;
        if (this.sums.length === this.cap) this.coarsen();
      }
    }
  }

  /** Merge adjacent chunk pairs: half as many chunks, each twice as long. */
  private coarsen(): void {
    const half = this.sums.length / 2;
    for (let i = 0; i < half; i++) this.sums[i] = this.sums[2 * i]! + this.sums[2 * i + 1]!;
    this.sums.length = half;
    this.chunkLen *= 2;
  }

  /**
   * The RMS of each of `buckets` windows (window b spans chunks
   * [floor(b*m/buckets), floor((b+1)*m/buckets)) of the m chunks, a trailing
   * partial chunk included; an empty window → 0), max-normalized to 0..1.
   */
  finish(buckets: number): number[] {
    if (buckets <= 0) return [];
    const full = this.sums.length;
    const m = full + (this.partCount > 0 ? 1 : 0);
    const out = new Array<number>(buckets).fill(0);
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor((b * m) / buckets);
      const end = Math.floor(((b + 1) * m) / buckets);
      let sumSq = 0;
      let count = 0;
      for (let i = start; i < end; i++) {
        if (i < full) {
          sumSq += this.sums[i]!;
          count += this.chunkLen;
        } else {
          sumSq += this.partSum;
          count += this.partCount;
        }
      }
      out[b] = count > 0 ? Math.sqrt(sumSq / count) : 0;
    }
    return normalizeMax(out);
  }
}
