// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Streaming RMS envelopes over the loudness pass's mono f32le PCM (#277).
//!
//! HAND MIRROR of src/pcm-envelope.ts (plus core.ts `PcmLoudnessStream`);
//! Rust can't import the TS, so the tests below pin the same fixtures. The
//! loudness command feeds ffmpeg's stdout through [`LoudnessPcm`] as it
//! arrives instead of buffering the whole decode (about 32 KB/s of audio):
//!
//! - [`F32leDecoder`] turns byte chunks of any size into samples, holding a
//!   float split across two reads until its last byte lands.
//! - [`FrameRms`] is the fixed-frame RMS behind the onset envelope. Frame
//!   edges are known up front, so it is exact.
//! - [`BucketRms`] is the equal-width-bucket RMS behind `detect`. Its edges
//!   (`b * n / buckets`) depend on the total sample count, unknown until EOF,
//!   so it keeps under `cap` chunk sums: below `cap` samples every chunk is
//!   one sample (exactly the per-sample formula); past it adjacent chunks
//!   merge, so edges snap to a chunk start, at most `2 * n / cap` samples off.

/// Chunk-sum budget of [`BucketRms`] (2 MiB of f64). Keep in sync with
/// pcm-envelope.ts `RMS_CHUNK_CAP`.
pub const RMS_CHUNK_CAP: usize = 1 << 18;

/// Decode little-endian f32 PCM from byte chunks of any size.
#[derive(Default)]
pub struct F32leDecoder {
    carry: [u8; 4],
    carry_len: usize,
}

impl F32leDecoder {
    /// Call `on_sample` for each whole sample completed by `bytes`. Up to 3
    /// trailing bytes are held for the next call (dropped if none comes).
    pub fn push(&mut self, mut bytes: &[u8], mut on_sample: impl FnMut(f32)) {
        if self.carry_len > 0 {
            let take = (4 - self.carry_len).min(bytes.len());
            self.carry[self.carry_len..self.carry_len + take].copy_from_slice(&bytes[..take]);
            self.carry_len += take;
            bytes = &bytes[take..];
            if self.carry_len < 4 {
                return;
            }
            on_sample(f32::from_le_bytes(self.carry));
            self.carry_len = 0;
        }
        let mut whole = bytes.chunks_exact(4);
        for b in &mut whole {
            on_sample(f32::from_le_bytes([b[0], b[1], b[2], b[3]]));
        }
        let rest = whole.remainder();
        self.carry[..rest.len()].copy_from_slice(rest);
        self.carry_len = rest.len();
    }
}

/// Max-normalize RMS values to 0..1 in place (max <= 0 leaves them, so
/// all-silence stays zeros); `decimals` rounds each normalized value.
fn normalize_max(values: &mut [f64], decimals: Option<i32>) {
    let mut max = 0.0f64;
    for &v in values.iter() {
        if v > max {
            max = v;
        }
    }
    if max <= 0.0 {
        return;
    }
    let scale = decimals.map(|d| 10f64.powi(d));
    for v in values.iter_mut() {
        let n = *v / max;
        *v = match scale {
            Some(s) => (n * s).round() / s,
            None => n,
        };
    }
}

/// RMS of fixed `frame_len`-sample frames; a trailing partial frame is dropped.
pub struct FrameRms {
    frame_len: usize,
    rms: Vec<f64>,
    sum_sq: f64,
    count: usize,
}

impl FrameRms {
    pub fn new(frame_len: usize) -> Self {
        assert!(frame_len >= 1, "frame_len must be >= 1");
        FrameRms {
            frame_len,
            rms: Vec::new(),
            sum_sq: 0.0,
            count: 0,
        }
    }

    pub fn push(&mut self, s: f32) {
        let v = s as f64;
        self.sum_sq += v * v;
        self.count += 1;
        if self.count == self.frame_len {
            self.rms.push((self.sum_sq / self.frame_len as f64).sqrt());
            self.sum_sq = 0.0;
            self.count = 0;
        }
    }

    /// The per-frame RMS so far, max-normalized.
    pub fn finish(&self, decimals: Option<i32>) -> Vec<f64> {
        let mut out = self.rms.clone();
        normalize_max(&mut out, decimals);
        out
    }
}

/// RMS of equal-width buckets over a stream of unknown length, in bounded
/// memory (see the module docs for when it is exact).
pub struct BucketRms {
    cap: usize,
    /// Sum of squares of each FULL chunk of `chunk_len` samples, in order.
    sums: Vec<f64>,
    chunk_len: usize,
    part_sum: f64,
    part_count: usize,
}

impl BucketRms {
    pub fn new(cap: usize) -> Self {
        assert!(cap >= 2 && cap % 2 == 0, "cap must be an even number >= 2");
        BucketRms {
            cap,
            sums: Vec::new(),
            chunk_len: 1,
            part_sum: 0.0,
            part_count: 0,
        }
    }

    pub fn push(&mut self, s: f32) {
        let v = s as f64;
        self.part_sum += v * v;
        self.part_count += 1;
        if self.part_count == self.chunk_len {
            self.sums.push(self.part_sum);
            self.part_sum = 0.0;
            self.part_count = 0;
            if self.sums.len() == self.cap {
                // Merge adjacent pairs: half as many chunks, twice as long.
                let half = self.sums.len() / 2;
                for i in 0..half {
                    self.sums[i] = self.sums[2 * i] + self.sums[2 * i + 1];
                }
                self.sums.truncate(half);
                self.chunk_len *= 2;
            }
        }
    }

    /// RMS of each of `buckets` windows (window b spans chunks
    /// [b*m/buckets, (b+1)*m/buckets) of the m chunks, a trailing partial
    /// chunk included; an empty window -> 0), max-normalized to 0..1.
    pub fn finish(&self, buckets: usize) -> Vec<f64> {
        let full = self.sums.len();
        let m = full + usize::from(self.part_count > 0);
        let mut out = vec![0.0f64; buckets];
        for (b, slot) in out.iter_mut().enumerate() {
            let start = (b * m) / buckets;
            let end = ((b + 1) * m) / buckets;
            let mut sum_sq = 0.0f64;
            let mut count = 0usize;
            for i in start..end {
                if i < full {
                    sum_sq += self.sums[i];
                    count += self.chunk_len;
                } else {
                    sum_sq += self.part_sum;
                    count += self.part_count;
                }
            }
            *slot = if count > 0 {
                (sum_sq / count as f64).sqrt()
            } else {
                0.0
            };
        }
        normalize_max(&mut out, None);
        out
    }
}

/// The loudness pass's PCM half, streamed: `push` stdout chunks as they
/// arrive, then `finish` for (`detect`, `onset_envelope`). Mirrors core.ts
/// `PcmLoudnessStream`.
pub struct LoudnessPcm {
    decoder: F32leDecoder,
    detect: BucketRms,
    onset: FrameRms,
    /// Total stdout bytes seen (the command's "no PCM at all" check).
    pub bytes: usize,
}

impl LoudnessPcm {
    /// `onset_frame_len` samples per onset frame (core.ts `onsetFrameLen`).
    pub fn new(onset_frame_len: usize) -> Self {
        LoudnessPcm {
            decoder: F32leDecoder::default(),
            detect: BucketRms::new(RMS_CHUNK_CAP),
            onset: FrameRms::new(onset_frame_len),
            bytes: 0,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.bytes += chunk.len();
        let (detect, onset) = (&mut self.detect, &mut self.onset);
        self.decoder.push(chunk, |s| {
            detect.push(s);
            onset.push(s);
        });
    }

    /// (`detect` over `buckets` windows, the onset envelope rounded to
    /// `onset_decimals`).
    pub fn finish(&self, buckets: usize, onset_decimals: i32) -> (Vec<f64>, Vec<f64>) {
        (
            self.detect.finish(buckets),
            self.onset.finish(Some(onset_decimals)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Buffered helpers over the accumulators (what core.ts `bucketLoudness`
    /// / `onsetEnvelope` are), so the tests below read like their TS twins.
    fn bucket_loudness(samples: &[f32], buckets: usize) -> Vec<f64> {
        let mut acc = BucketRms::new(RMS_CHUNK_CAP);
        samples.iter().for_each(|&s| acc.push(s));
        acc.finish(buckets)
    }

    fn onset_envelope(samples: &[f32], sample_rate: f64) -> Vec<f64> {
        let mut acc = FrameRms::new(crate::onset_frame_len(sample_rate));
        samples.iter().for_each(|&s| acc.push(s));
        acc.finish(Some(4))
    }

    fn f32le(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    /// The fixture shared with test/pcm-envelope.test.ts.
    fn fixture() -> Vec<f32> {
        (0..37)
            .map(|i| (((i * 7) % 11) as f32 - 5.0) / 8.0)
            .collect()
    }

    #[test]
    fn decoder_reassembles_split_floats_and_holds_a_partial() {
        let bytes = f32le(&[1.0, -0.5, 0.25]);
        let mut dec = F32leDecoder::default();
        let mut got = Vec::new();
        for piece in [&bytes[0..3], &bytes[3..5], &bytes[5..6]] {
            dec.push(piece, |s| got.push(s));
        }
        assert_eq!(got, vec![1.0]);
        dec.push(&bytes[6..12], |s| got.push(s));
        assert_eq!(got, vec![1.0, -0.5, 0.25]);
        dec.push(&[0x00, 0x01], |s| got.push(s)); // dangling partial never surfaces
        assert_eq!(got.len(), 3);
    }

    /// Mirrors test/pcm-envelope.test.ts "matches the pinned cap=8 output".
    #[test]
    fn bucket_rms_pinned_cap_8() {
        let mut acc = BucketRms::new(8);
        fixture().into_iter().for_each(|s| acc.push(s));
        assert_eq!(
            acc.finish(5),
            vec![
                0.943308278599619,
                0.9489065964643515,
                0.9205746178983234,
                0.9205746178983234,
                1.0
            ]
        );
    }

    /// Mirrors test/pcm-envelope.test.ts "matches the pinned frameLen=6 output".
    #[test]
    fn frame_rms_pinned_frame_len_6() {
        let mut acc = FrameRms::new(6);
        fixture().into_iter().for_each(|s| acc.push(s));
        assert_eq!(
            acc.finish(Some(4)),
            vec![1.0, 0.9926, 0.9315, 0.8993, 0.8993, 0.9315]
        );
    }

    /// Streaming in odd byte pieces equals feeding the samples directly, on
    /// both sides of the chunk cap (mirrors the TS chunking property test).
    #[test]
    fn loudness_pcm_is_independent_of_byte_chunking() {
        for n in [0usize, 1, 161, 1601, RMS_CHUNK_CAP + 12_345] {
            let samples: Vec<f32> = (0..n)
                .map(|i| ((i as f32) * 0.37).sin() * (0.2 + (i % 997) as f32 / 1250.0))
                .collect();
            let bytes = f32le(&samples);
            let mut stream = LoudnessPcm::new(160);
            let (mut i, mut len) = (0usize, 1usize);
            while i < bytes.len() {
                let end = (i + len).min(bytes.len());
                stream.push(&bytes[i..end]);
                i = end;
                len = len % 4099 + 1; // 1..4099-byte pieces, mostly unaligned
            }
            assert_eq!(stream.bytes, bytes.len());
            let (detect, onset) = stream.finish(160, 4);
            assert_eq!(detect, bucket_loudness(&samples, 160), "n={n}");
            assert_eq!(onset, onset_envelope(&samples, 8000.0), "n={n}");
        }
    }

    // --- moved from main.rs: the bucketLoudness / onsetEnvelope mirrors ------

    /// Mirrors test/loudness.test.ts "normalizes so the max value is exactly 1
    /// (a rising ramp)" — same 8000-sample ramp, 80 buckets.
    #[test]
    fn bucket_loudness_normalizes_rising_ramp_to_max_one() {
        let n = 8000usize;
        let samples: Vec<f32> = (0..n).map(|i| i as f32 / n as f32).collect();
        let out = bucket_loudness(&samples, 80);
        assert_eq!(out.len(), 80);
        let max = out.iter().cloned().fold(0.0f64, f64::max);
        assert!((max - 1.0).abs() < 1e-10);
        // Monotonic non-decreasing for a ramp (RMS rises with the window).
        for b in 1..out.len() {
            assert!(out[b] >= out[b - 1] - 1e-9);
        }
        // Last bucket is the loud end, first is the quiet end.
        assert!((out[79] - 1.0).abs() < 1e-10);
        assert!(out[0] < out[79]);
    }

    /// Mirrors test/loudness.test.ts "returns all zeros for empty input or
    /// all-silence".
    #[test]
    fn bucket_loudness_zeros_for_empty_or_silence() {
        assert_eq!(bucket_loudness(&[], 10), vec![0.0; 10]);
        assert_eq!(bucket_loudness(&[0.0f32; 500], 10), vec![0.0; 10]);
    }

    /// Mirrors test/onsets.test.ts "pinned: per-frame RMS, normalized and
    /// rounded to 4 decimals (rate 200)" — sample rate 200 → 4 samples/frame,
    /// so [1,1,0,0] → RMS √0.5 and [1,1,1,1] → RMS 1; normalized + rounded →
    /// [0.7071, 1].
    // 0.7071 is the TS fixture's 4-decimal rounded output, not a stand-in for
    // FRAC_1_SQRT_2 (the unrounded constant would fail the assertion).
    #[allow(clippy::approx_constant)]
    #[test]
    fn onset_envelope_pinned_fixture() {
        let samples = [1.0f32, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0];
        assert_eq!(onset_envelope(&samples, 200.0), vec![0.7071, 1.0]);
    }

    /// Mirrors test/onsets.test.ts "pinned: silence stays zeros; a partial
    /// trailing frame is dropped (rate 200)".
    #[test]
    fn onset_envelope_silence_and_partial() {
        assert_eq!(onset_envelope(&[0.0f32; 6], 200.0), vec![0.0]);
    }

    /// Mirrors test/onsets.test.ts "emits one RMS frame per ONSET_FRAME_SEC,
    /// dropping a trailing partial frame" — 8 kHz × 0.02 s = 160 samples/frame;
    /// 1.01 s → 50 full frames (+ a dropped partial).
    #[test]
    fn onset_envelope_frame_count_at_8khz() {
        let samples = vec![0.5f32; (8000.0f64 * 1.01).round() as usize];
        assert_eq!(onset_envelope(&samples, 8000.0).len(), 50);
    }

    /// Mirrors test/onsets.test.ts "returns [] for empty input" (envelope half).
    #[test]
    fn onset_envelope_empty_input() {
        assert!(onset_envelope(&[], 8000.0).is_empty());
    }
}
