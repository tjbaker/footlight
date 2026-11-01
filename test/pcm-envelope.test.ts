// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Streaming loudness PCM (issue #277): the streamed envelopes must equal the
 * buffered ones bit for bit whatever the chunking (odd byte splits, floats split
 * across reads, unaligned buffers), and below `RMS_CHUNK_CAP` samples they must
 * equal the original per-sample formula exactly. The pinned `cap = 8` fixtures
 * are shared with the Rust mirror (app/src-tauri/src/pcm_envelope.rs).
 */

import { describe, it, expect } from "vitest";

import {
  BucketRmsAccumulator,
  F32leDecoder,
  FrameRmsAccumulator,
  RMS_CHUNK_CAP,
} from "../src/pcm-envelope.js";
import { LOUDNESS_BUCKETS, PcmLoudnessStream, bucketLoudness, onsetEnvelope } from "../src/core.js";

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPcm(n: number, rand: () => number): Float32Array {
  const s = new Float32Array(n);
  // Uneven loudness across the clip so windows differ.
  for (let i = 0; i < n; i++) s[i] = (rand() * 2 - 1) * (0.2 + 0.8 * Math.abs(Math.sin(i / 997)));
  return s;
}

/** The pre-#277 buffered formula, verbatim: every sample summed in order into
 *  window [floor(b*n/B), floor((b+1)*n/B)), RMS, then max-normalized. */
function referenceBucketLoudness(samples: Float32Array, buckets: number): number[] {
  if (buckets <= 0) return [];
  const n = samples.length;
  const out = new Array<number>(buckets).fill(0);
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.floor(((b + 1) * n) / buckets);
    let sumSq = 0;
    for (let i = start; i < end; i++) sumSq += samples[i]! * samples[i]!;
    out[b] = end > start ? Math.sqrt(sumSq / (end - start)) : 0;
  }
  const max = Math.max(0, ...out);
  return max > 0 ? out.map((v) => v / max) : out;
}

/** The pre-#277 onset envelope, verbatim (160-sample frames at 8 kHz, 4 dp). */
function referenceOnsetEnvelope(samples: Float32Array, frameLen = 160): number[] {
  const frames = Math.floor(samples.length / frameLen);
  const out = new Array<number>(frames).fill(0);
  for (let f = 0; f < frames; f++) {
    let sumSq = 0;
    for (let i = f * frameLen; i < (f + 1) * frameLen; i++) sumSq += samples[i]! * samples[i]!;
    out[f] = Math.sqrt(sumSq / frameLen);
  }
  const max = Math.max(0, ...out);
  return max > 0 ? out.map((v) => Math.round((v / max) * 1e4) / 1e4) : out;
}

/** Split `bytes` into random-sized chunks (1..maxChunk), each copied to an
 *  ODD offset inside a bigger buffer so no chunk is 4-byte aligned. */
function randomChunks(bytes: Uint8Array, rand: () => number, maxChunk: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    const len = Math.min(bytes.length - i, 1 + Math.floor(rand() * maxChunk));
    const host = new Uint8Array(len + 3);
    host.set(bytes.subarray(i, i + len), 1);
    chunks.push(host.subarray(1, 1 + len));
    i += len;
  }
  return chunks;
}

function f32leBytes(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);
  samples.forEach((s, i) => view.setFloat32(i * 4, s, true));
  return bytes;
}

describe("F32leDecoder", () => {
  it("reassembles floats split across chunks and holds a trailing partial", () => {
    const bytes = f32leBytes(new Float32Array([1, -0.5, 0.25]));
    const dec = new F32leDecoder();
    const got: number[] = [];
    for (const piece of [bytes.subarray(0, 3), bytes.subarray(3, 5), bytes.subarray(5, 6)]) {
      got.push(...dec.push(piece));
    }
    expect(got).toEqual([1]); // 6 bytes in: one whole float, two held
    got.push(...dec.push(bytes.subarray(6, 12)));
    expect(got).toEqual([1, -0.5, 0.25]);
    // A dangling partial float never surfaces (the buffered path floors it).
    expect([...dec.push(new Uint8Array([0x00, 0x01]))]).toEqual([]);
  });
});

describe("bucketLoudness stays the per-sample formula below RMS_CHUNK_CAP", () => {
  const rand = rng(277);
  for (const n of [0, 1, 3, 159, 160, 161, 479, 1000, 4801, 12_345]) {
    it(`n=${n}, ${LOUDNESS_BUCKETS} and 7 buckets`, () => {
      const s = randomPcm(n, rand);
      expect(bucketLoudness(s, LOUDNESS_BUCKETS)).toEqual(
        referenceBucketLoudness(s, LOUDNESS_BUCKETS),
      );
      expect(bucketLoudness(s, 7)).toEqual(referenceBucketLoudness(s, 7));
      expect(onsetEnvelope(s)).toEqual(referenceOnsetEnvelope(s));
    });
  }
});

describe("PcmLoudnessStream equals the buffered envelopes for any chunking", () => {
  const rand = rng(331);
  for (const n of [0, 1, 2, 161, 1601, 9999, RMS_CHUNK_CAP - 1, RMS_CHUNK_CAP + 12_345]) {
    it(`n=${n}`, () => {
      const s = randomPcm(n, rand);
      const bytes = f32leBytes(s);
      // Tiny chunks for short inputs (every split position), big ones for long.
      const maxChunk = n < 10_000 ? 9 : 65_537;
      const stream = new PcmLoudnessStream();
      for (const c of randomChunks(bytes, rand, maxChunk)) stream.push(c);
      // A stray partial float at EOF is dropped, like the buffered floor.
      stream.push(new Uint8Array([0x7f]));
      expect(stream.bytes).toBe(bytes.length + 1);
      expect(stream.finish()).toEqual({
        detect: bucketLoudness(s, LOUDNESS_BUCKETS),
        onsetEnvelope: onsetEnvelope(s),
      });
    });
  }

  it("onsets stay the exact per-frame formula at any length", () => {
    const s = randomPcm(RMS_CHUNK_CAP + 4321, rng(7));
    expect(onsetEnvelope(s)).toEqual(referenceOnsetEnvelope(s));
  });

  it("past RMS_CHUNK_CAP, buckets stay within a hair of the per-sample formula", () => {
    // Edges snap by at most 2n/cap samples (~0.12% of a bucket at 160 buckets).
    const s = randomPcm(3 * RMS_CHUNK_CAP + 777, rng(9));
    const got = bucketLoudness(s, LOUDNESS_BUCKETS);
    const ref = referenceBucketLoudness(s, LOUDNESS_BUCKETS);
    expect(got).toHaveLength(LOUDNESS_BUCKETS);
    for (let b = 0; b < LOUDNESS_BUCKETS; b++)
      expect(Math.abs(got[b]! - ref[b]!)).toBeLessThan(5e-3);
  });
});

describe("BucketRmsAccumulator coarsening (pinned; mirrored in Rust)", () => {
  // 37 samples, cap 8: chunks double at 8, 16 and 32 samples, leaving four
  // 8-sample chunks and a 5-sample partial — one chunk per bucket.
  const fixture = new Float32Array(37).map((_, i) => (((i * 7) % 11) - 5) / 8);

  it("matches the pinned cap=8 output", () => {
    const acc = new BucketRmsAccumulator(8);
    acc.push(fixture);
    expect(acc.finish(5)).toEqual([
      0.943308278599619, 0.9489065964643515, 0.9205746178983234, 0.9205746178983234, 1,
    ]);
  });

  it("is independent of how the samples are split", () => {
    const rand = rng(5);
    for (let trial = 0; trial < 50; trial++) {
      const s = randomPcm(1 + Math.floor(rand() * 500), rand);
      const whole = new BucketRmsAccumulator(8);
      whole.push(s);
      const split = new BucketRmsAccumulator(8);
      for (let i = 0; i < s.length;) {
        const len = 1 + Math.floor(rand() * 13);
        split.push(s.subarray(i, i + len));
        i += len;
      }
      expect(split.finish(LOUDNESS_BUCKETS)).toEqual(whole.finish(LOUDNESS_BUCKETS));
      expect(split.finish(3)).toEqual(whole.finish(3));
    }
  });

  it("rejects a cap that cannot halve", () => {
    expect(() => new BucketRmsAccumulator(3)).toThrow();
    expect(() => new FrameRmsAccumulator(0)).toThrow();
  });
});

describe("FrameRmsAccumulator (pinned; mirrored in Rust)", () => {
  it("matches the pinned frameLen=6 output and drops the partial frame", () => {
    const fixture = new Float32Array(37).map((_, i) => (((i * 7) % 11) - 5) / 8);
    const acc = new FrameRmsAccumulator(6);
    acc.push(fixture);
    expect(acc.finish(4)).toEqual([1, 0.9926, 0.9315, 0.8993, 0.8993, 0.9315]);
  });
});
