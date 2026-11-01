// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Source analysis commands: frame extraction, probe (ffprobe + cropdetect),
//! scene cuts and the loudness envelopes, plus the per-call temp-file helper.
//!
//! The ffmpeg/ffprobe arg arrays and output parsers below are a HAND MIRROR of
//! the canonical pure builders in src/core.ts (frameExtractArgs, ffprobeStreamArgs
//! / parseProbe, cropdetectArgs / parseCropdetect, scenesArgs / parseScenes) — the
//! CLI and the Node dev server import those directly; Rust can't, so keep this in
//! sync when they change.

use serde::Serialize;
use tokio::process::Command;

use crate::pcm_envelope::LoudnessPcm;
use crate::subprocess::{self, run_output, run_streaming, Kind};

#[derive(Serialize)]
pub(crate) struct ProbeResult {
    width: u32,
    height: u32,
    duration: f64,
    cropdetect: Option<String>,
}

/// A fresh, uniquely named temp file (`<prefix><random><suffix>`) that is
/// deleted when the returned guard drops. Every call gets its own path, so
/// concurrent commands (e.g. the loop-seam panel's paired In/Out frame grabs)
/// never write the same file (#249). The file is created empty (O_EXCL, so the
/// name is ours) and its handle closed, so a child process can overwrite it.
pub(crate) fn unique_temp_path(prefix: &str, suffix: &str) -> Result<tempfile::TempPath, String> {
    tempfile::Builder::new()
        .prefix(prefix)
        .suffix(suffix)
        .tempfile()
        .map(|f| f.into_temp_path())
        .map_err(|e| format!("create temp file: {e}"))
}

/// Extract a single accurate frame at `t` seconds and return the JPEG bytes
/// (the frontend wraps them in a `blob:` object URL, like the web backend).
/// Accuracy comes from ffmpeg INPUT-seek (`-ss` before `-i`) per displayed frame.
// NOTE: these commands shell out to ffmpeg/ffprobe/node and can run for many
// seconds (cropdetect, scene decode, a full render, or an Auto-track pass). They
// MUST be `async`: in Tauri a synchronous command runs on the main thread and
// freezes the entire UI (the spinning-beachball hang) until it returns. Marking
// them `async` makes Tauri run them off the main thread so the window stays live.
#[tauri::command]
pub(crate) async fn extract_frame(source: String, t: f64) -> Result<tauri::ipc::Response, String> {
    extract_frame_bytes(&source, t)
        .await
        .map(tauri::ipc::Response::new)
}

/// The body of `extract_frame`: ffmpeg writes the frame to a per-call temp JPEG,
/// whose bytes are read back and returned; the temp file is deleted on return.
async fn extract_frame_bytes(source: &str, t: f64) -> Result<Vec<u8>, String> {
    // Declared before the temp file, so quitting waits for its deletion.
    let _hold = subprocess::hold(Kind::Analysis);
    let path = unique_temp_path("footlight_frame_", ".jpg")?;
    let out = path.to_string_lossy().to_string();

    // Primary: accurate INPUT-seek to t. If t lands at/after the source's end
    // (seeking to the clip end, or the final sampled still), this decodes no
    // frame and the mjpeg encoder fails with no packets — fall back to grabbing
    // the last available frame by seeking relative to EOF, mirroring the shared
    // frameExtractArgs / frameExtractTailArgs pair the web backend uses.
    let t_str = t.to_string();
    let wrote = run_frame_extract(&["-ss", &t_str], source, &out).await?
        || run_frame_extract(&["-sseof", "-0.2"], source, &out).await?;
    if !wrote {
        return Err("ffmpeg frame extraction failed".into());
    }
    std::fs::read(&path).map_err(|e| format!("read extracted frame: {e}"))
    // `path` drops here, deleting the temp JPEG.
}

/// Args for one single-frame ffmpeg extraction with the given seek args, writing
/// a JPEG to `out`. HAND MIRROR of the seek-prefix split in core.ts
/// `frameExtractArgs` / `frameExtractTailArgs` (`-ss <t>` vs `-sseof -0.2`),
/// except the native shell writes a temp file instead of MJPEG on stdout.
fn frame_extract_args<'a>(seek: &[&'a str], source: &'a str, out: &'a str) -> Vec<&'a str> {
    let mut args: Vec<&str> = vec!["-hide_banner", "-loglevel", "error", "-y"];
    args.extend_from_slice(seek);
    args.extend_from_slice(&["-i", source, "-frames:v", "1", "-q:v", "3", out]);
    args
}

/// Run one single-frame ffmpeg extraction with the given seek args, writing a
/// JPEG to `out`. Returns Ok(true) only when ffmpeg succeeded AND wrote a
/// non-empty file (a seek past EOF exits non-zero / writes nothing).
async fn run_frame_extract(seek: &[&str], source: &str, out: &str) -> Result<bool, String> {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(frame_extract_args(seek, source, out));
    let status = run_output(cmd, "ffmpeg", Kind::Analysis).await?.status;
    let wrote = std::fs::metadata(out).map(|m| m.len() > 0).unwrap_or(false);
    Ok(status.success() && wrote)
}

/// ffprobe args for the first video stream's width/height + container duration.
/// HAND MIRROR of core.ts `ffprobeStreamArgs` — keep in sync.
pub(crate) fn ffprobe_stream_args(source: &str) -> Vec<&str> {
    vec![
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        source,
    ]
}

/// Parse `ffprobe_stream_args` JSON stdout into (width, height, duration),
/// defaulting missing fields to 0. HAND MIRROR of core.ts `parseProbe` (which
/// also throws only on unparseable JSON).
pub(crate) fn parse_probe(stdout: &[u8]) -> Result<(u32, u32, f64), String> {
    let json: serde_json::Value = serde_json::from_slice(stdout)
        .map_err(|e| format!("ffprobe returned unparseable output: {e}"))?;

    let stream = json
        .get("streams")
        .and_then(|s| s.get(0))
        .cloned()
        .unwrap_or_default();
    let width = stream.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let height = stream.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    Ok((width, height, duration))
}

/// ffmpeg args for a cropdetect (BLACK BARS ONLY) probe; the analysis lands on
/// stderr — pass it to `last_crop_suggestion`. HAND MIRROR of core.ts
/// `cropdetectArgs` — keep in sync.
fn cropdetect_args(source: &str) -> Vec<&str> {
    vec![
        "-hide_banner",
        "-ss",
        "60",
        "-i",
        source,
        "-vf",
        "cropdetect=limit=24:round=2",
        "-frames:v",
        "300",
        "-f",
        "null",
        "-",
    ]
}

/// Probe width, height, duration via ffprobe + a cropdetect (black-bar) hint.
#[tauri::command]
pub(crate) async fn probe(source: String) -> Result<ProbeResult, String> {
    let mut cmd = Command::new("ffprobe");
    cmd.args(ffprobe_stream_args(&source));
    let probe_out = run_output(cmd, "ffprobe", Kind::Analysis).await?;

    if !probe_out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&probe_out.stderr)
        ));
    }

    let (width, height, duration) = parse_probe(&probe_out.stdout)?;

    // cropdetect — black bars only (mirrors the dev server / CLI).
    let mut cmd = Command::new("ffmpeg");
    cmd.args(cropdetect_args(&source));
    let cd = run_output(cmd, "ffmpeg", Kind::Analysis).await?;
    let stderr = String::from_utf8_lossy(&cd.stderr);
    let cropdetect = last_crop_suggestion(&stderr);

    Ok(ProbeResult {
        width,
        height,
        duration,
        cropdetect,
    })
}

/// ffmpeg args for scene-cut detection (downscale → scene filter → showinfo).
/// HAND MIRROR of core.ts `scenesArgs` (SCENE_THRESHOLD = 0.4) — keep in sync.
fn scenes_args(source: &str) -> Vec<&str> {
    vec![
        "-hide_banner",
        "-i",
        source,
        "-vf",
        "scale=-2:144,select='gt(scene,0.4)',showinfo",
        "-f",
        "null",
        "-",
    ]
}

/// Parse scene-cut timestamps (seconds, rounded to ms) from showinfo's
/// `pts_time:` markers on stderr. HAND MIRROR of core.ts `parseScenes`.
fn parse_scenes(stderr: &str) -> Vec<f64> {
    let mut times = Vec::new();
    for token in stderr.split("pts_time:").skip(1) {
        let num: String = token
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if let Ok(t) = num.parse::<f64>() {
            times.push((t * 1000.0).round() / 1000.0);
        }
    }
    times
}

/// Detect scene-cut timestamps (seconds), mirroring the CLI's scenes command.
#[tauri::command]
pub(crate) async fn scenes(source: String) -> Result<Vec<f64>, String> {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(scenes_args(&source));
    let out = run_output(cmd, "ffmpeg", Kind::Analysis).await?;

    let stderr = String::from_utf8_lossy(&out.stderr);
    Ok(parse_scenes(&stderr))
}

#[derive(Serialize)]
pub(crate) struct LoudnessResult {
    display: Vec<f64>,
    detect: Vec<f64>,
    #[serde(rename = "onsetEnvelope")]
    onset_envelope: Vec<f64>,
}

// Keep these in sync with core.ts LOUDNESS_BUCKETS / LUFS_FLOOR / LUFS_CEIL /
// ONSET_FRAME_SEC.
const LOUDNESS_BUCKETS: usize = 160;
const LUFS_FLOOR: f64 = -40.0;
const LUFS_CEIL: f64 = -5.0;
const ONSET_FRAME_SEC: f64 = 0.02;

/// ffmpeg args for the one-pass loudness run: the ebur128 analysis filter logs
/// per-frame momentary LUFS to stderr while mono 8 kHz f32le PCM lands on
/// stdout. HAND MIRROR of core.ts `loudnessCombinedArgs` — keep in sync.
fn loudness_combined_args(source: &str) -> Vec<&str> {
    vec![
        "-hide_banner",
        "-nostats",
        // verbose REQUIRED: ebur128 prints per-frame `M:` only above `info`.
        "-loglevel",
        "verbose",
        "-i",
        source,
        "-af",
        "ebur128=metadata=1",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "f32le",
        "-",
    ]
}

/// Per-frame momentary `M:` LUFS readings from ebur128's verbose log, in time
/// order. Unparseable/non-finite readings (-inf/nan over silence / startup) ->
/// the floor (-∞). HAND MIRROR of core.ts `parseEbur128Momentary`.
fn parse_ebur128_momentary(log: &str) -> Vec<f64> {
    let mut momentary: Vec<f64> = Vec::new();
    for line in log.lines() {
        if let Some(idx) = line.find("M:") {
            let tok = line[idx + 2..].split_whitespace().next().unwrap_or("");
            momentary.push(tok.parse::<f64>().unwrap_or(f64::NEG_INFINITY));
        }
    }
    momentary
}

/// Map one LUFS reading to 0..1 over [LUFS_FLOOR, LUFS_CEIL]; non-finite -> 0.
/// HAND MIRROR of core.ts `lufsToNormalized`.
fn lufs_to_normalized(lufs: f64) -> f64 {
    if !lufs.is_finite() {
        return 0.0;
    }
    ((lufs - LUFS_FLOOR) / (LUFS_CEIL - LUFS_FLOOR)).clamp(0.0, 1.0)
}

/// Bucket momentary LUFS into `buckets` windows of averaged normalized (0..1)
/// levels — an ABSOLUTE perceptual scale (not max-normalized). Non-finite
/// readings are skipped within a window (an all-silence window -> 0). HAND
/// MIRROR of core.ts `bucketLufs`.
fn bucket_lufs(momentary: &[f64], buckets: usize) -> Vec<f64> {
    let mn = momentary.len();
    let mut display = vec![0.0f64; buckets];
    if mn > 0 {
        for (b, slot) in display.iter_mut().enumerate() {
            let start = (b * mn) / buckets;
            let end = ((b + 1) * mn) / buckets;
            let mut sum = 0.0f64;
            let mut count = 0usize;
            for v in &momentary[start..end] {
                if v.is_finite() {
                    sum += lufs_to_normalized(*v);
                    count += 1;
                }
            }
            *slot = if count > 0 { sum / count as f64 } else { 0.0 };
        }
    }
    display
}

/// Samples per onset frame at `sample_rate` (at least 1). HAND MIRROR of
/// core.ts `onsetFrameLen`.
pub(crate) fn onset_frame_len(sample_rate: f64) -> usize {
    ((sample_rate * ONSET_FRAME_SEC).round() as usize).max(1)
}

/// Onset-envelope rounding (decimal places); core.ts `ONSET_DECIMALS`.
const ONSET_DECIMALS: i32 = 4;

/// Compute the timeline's audio envelopes (0..1) in ONE ffmpeg pass.
/// Mirrors core.ts `loudnessCombinedArgs` + `parseEbur128Momentary`/`bucketLufs`
/// (display) + `bucketLoudness` (detect) + `onsetEnvelope` (onset_envelope);
/// Rust can't import the TS. The ebur128 analysis filter passes audio through,
/// so the same run logs per-frame momentary LUFS to stderr (→ `display`, the
/// perceptual bars) AND emits mono 8 kHz f32le PCM on stdout (→ `detect`, the
/// raw-energy RMS the swell detector needs, and → `onset_envelope`, the fine
/// envelope the beat-snap onset detector needs). Keep LOUDNESS_BUCKETS (160),
/// the LUFS floor/ceiling, and ONSET_FRAME_SEC in sync with core.ts.
#[tauri::command]
pub(crate) async fn loudness(source: String) -> Result<LoudnessResult, String> {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(loudness_combined_args(&source));
    // --- detect + onset envelope: the mono 8 kHz f32le PCM on stdout is folded
    // in as it streams (mirrors core.ts PcmLoudnessStream, #277), so memory
    // stays flat however long the source is.
    let mut pcm = LoudnessPcm::new(onset_frame_len(8000.0));
    let out = run_streaming(cmd, "ffmpeg", Kind::Analysis, |chunk| pcm.push(chunk)).await?;

    // --- display: per-frame momentary `M:` LUFS from stderr (mirrors bucketLufs).
    let log = String::from_utf8_lossy(&out.stderr);
    let momentary = parse_ebur128_momentary(&log);

    if !out.status.success() && momentary.is_empty() && pcm.bytes == 0 {
        return Err(format!("loudness failed: {log}"));
    }

    let display = bucket_lufs(&momentary, LOUDNESS_BUCKETS);
    let (detect, onset_env) = pcm.finish(LOUDNESS_BUCKETS, ONSET_DECIMALS);

    Ok(LoudnessResult {
        display,
        detect,
        onset_envelope: onset_env,
    })
}

/// Pull the LAST `crop=W:H:X:Y` suggestion out of cropdetect stderr.
fn last_crop_suggestion(stderr: &str) -> Option<String> {
    let mut last = None;
    for token in stderr.split("crop=").skip(1) {
        let candidate: String = token
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == ':')
            .collect();
        if candidate.matches(':').count() == 3 {
            last = Some(candidate);
        }
    }
    last
}

// Unit tests for the pure pieces of the shell: the hand-mirrored ffmpeg/ffprobe
// arg builders and output parsers, plus the path helpers. Where a piece mirrors
// src/core.ts, the test mirrors the corresponding vitest case (cited per test)
// with the SAME inputs and expected values, so drift between the two
// implementations fails one suite or the other.
#[cfg(test)]
mod tests {
    use super::*;

    // --- probe (ffprobe + cropdetect) ------------------------------------

    /// Mirrors test/commands.test.ts "ffprobeStreamArgs / parseProbe" — requests
    /// width, height and container duration for the first video stream.
    #[test]
    fn ffprobe_stream_args_requests_dims_and_duration() {
        let a = ffprobe_stream_args("in.mp4");
        assert!(a.contains(&"stream=width,height:format=duration"));
        assert!(a.contains(&"v:0"));
        assert_eq!(*a.last().unwrap(), "in.mp4");
    }

    /// Mirrors test/commands.test.ts "parses width/height/duration".
    #[test]
    fn parse_probe_parses_width_height_duration() {
        let out = br#"{"streams":[{"width":1920,"height":1080}],"format":{"duration":"12.5"}}"#;
        assert_eq!(parse_probe(out).unwrap(), (1920, 1080, 12.5));
    }

    /// Mirrors test/commands.test.ts "defaults missing fields to 0".
    #[test]
    fn parse_probe_defaults_missing_fields_to_zero() {
        assert_eq!(parse_probe(b"{}").unwrap(), (0, 0, 0.0));
    }

    #[test]
    fn parse_probe_rejects_unparseable_output() {
        assert!(parse_probe(b"not json").is_err());
    }

    /// Mirrors test/commands.test.ts "builds a black-bars-only cropdetect probe".
    #[test]
    fn cropdetect_args_black_bars_probe() {
        assert!(cropdetect_args("in.mp4").contains(&"cropdetect=limit=24:round=2"));
    }

    /// Mirrors test/commands.test.ts "returns the LAST crop= suggestion from
    /// stderr" (same stderr fixture as parseCropdetect's test).
    #[test]
    fn last_crop_suggestion_returns_last_match() {
        let stderr = "crop=100:100:0:0\nnoise\ncrop=1080:1920:420:0\n";
        assert_eq!(
            last_crop_suggestion(stderr).as_deref(),
            Some("1080:1920:420:0")
        );
    }

    /// Mirrors test/commands.test.ts "returns null when no crop= suggestion".
    #[test]
    fn last_crop_suggestion_none_without_match() {
        assert_eq!(last_crop_suggestion("no black bars here"), None);
    }

    // --- extract_frame ----------------------------------------------------

    /// Mirrors test/commands.test.ts "INPUT-seeks (-ss before -i)"; the native
    /// shell writes a temp JPEG (with -y) instead of MJPEG on stdout.
    #[test]
    fn frame_extract_args_input_seeks_before_i() {
        let a = frame_extract_args(&["-ss", "3.5"], "in.mp4", "/tmp/f.jpg");
        let ss = a.iter().position(|s| *s == "-ss").unwrap();
        let i = a.iter().position(|s| *s == "-i").unwrap();
        assert!(ss < i, "-ss must be an INPUT option (before -i)");
        assert_eq!(a[ss + 1], "3.5");
        assert!(
            a.contains(&"-y"),
            "must overwrite the pre-created temp file"
        );
        assert_eq!(*a.last().unwrap(), "/tmp/f.jpg");
    }

    /// Mirrors test/commands.test.ts "frameExtractTailArgs" — the EOF fallback
    /// seeks relative to EOF; extract_frame passes `-sseof -0.2`, core.ts
    /// FRAME_TAIL_SEEK_SEC = 0.2.
    #[test]
    fn frame_extract_args_eof_fallback_seeks_from_eof() {
        let a = frame_extract_args(&["-sseof", "-0.2"], "in.mp4", "/tmp/f.jpg");
        let sseof = a.iter().position(|s| *s == "-sseof").unwrap();
        assert!(sseof < a.iter().position(|s| *s == "-i").unwrap());
        assert!(a[sseof + 1].parse::<f64>().unwrap() < 0.0);
        assert!(!a.contains(&"-ss"));
    }

    // --- per-call temp files (#249) ---------------------------------------

    /// Two calls (even concurrent ones) get distinct paths, each guard's file
    /// exists while held, and dropping the guard deletes it.
    #[test]
    fn unique_temp_path_is_distinct_per_call_and_deleted_on_drop() {
        let (a, b) = std::thread::scope(|s| {
            let ha = s.spawn(|| unique_temp_path("footlight_test_", ".json").unwrap());
            let hb = s.spawn(|| unique_temp_path("footlight_test_", ".json").unwrap());
            (ha.join().unwrap(), hb.join().unwrap())
        });
        assert_ne!(
            a.to_path_buf(),
            b.to_path_buf(),
            "concurrent calls must not share a path"
        );
        for p in [&a, &b] {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            assert!(
                name.starts_with("footlight_test_") && name.ends_with(".json"),
                "{name}"
            );
            assert!(p.exists());
        }
        let (pa, pb) = (a.to_path_buf(), b.to_path_buf());
        drop(a);
        drop(b);
        assert!(!pa.exists(), "temp file must be deleted after use");
        assert!(!pb.exists(), "temp file must be deleted after use");
    }

    /// Two concurrent frame grabs at different timestamps return different
    /// frames (the loop-seam panel's paired In/Out fetch). Before #249 both
    /// wrote one per-process JPEG, so one call returned the other's frame.
    /// Needs ffmpeg on PATH; skipped (with a note) when it is absent.
    #[test]
    fn concurrent_extract_frame_calls_return_their_own_frames() {
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_err()
        {
            eprintln!("skipping: ffmpeg not on PATH");
            return;
        }
        // testsrc burns a running frame counter, so every frame differs.
        let src = unique_temp_path("footlight_test_src_", ".mp4").unwrap();
        let src_s = src.to_string_lossy().to_string();
        let ok = std::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"])
            .args([
                "-i",
                "testsrc=duration=2:size=160x120:rate=25",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&src_s)
            .status()
            .unwrap()
            .success();
        assert!(ok, "failed to synthesize the test source");

        let rt = tokio::runtime::Runtime::new().unwrap();
        let (early, late) = rt.block_on(async {
            tokio::join!(
                extract_frame_bytes(&src_s, 0.2),
                extract_frame_bytes(&src_s, 1.6)
            )
        });
        let (early, late) = (early.unwrap(), late.unwrap());
        let solo_early = rt.block_on(extract_frame_bytes(&src_s, 0.2)).unwrap();
        let solo_late = rt.block_on(extract_frame_bytes(&src_s, 1.6)).unwrap();
        assert!(early.starts_with(&[0xFF, 0xD8]), "not a JPEG");
        assert_ne!(
            early, late,
            "concurrent grabs must not share one output file"
        );
        assert_eq!(
            early, solo_early,
            "the early grab returned someone else's frame"
        );
        assert_eq!(
            late, solo_late,
            "the late grab returned someone else's frame"
        );
    }

    // --- scenes -----------------------------------------------------------

    /// Mirrors test/commands.test.ts "downscales to 144p before the
    /// shared-threshold scene filter" (SCENE_THRESHOLD = 0.4 in core.ts).
    #[test]
    fn scenes_args_downscale_then_scene_filter() {
        assert!(scenes_args("in.mp4").contains(&"scale=-2:144,select='gt(scene,0.4)',showinfo"));
    }

    /// Mirrors test/commands.test.ts "parses pts_time markers, rounded to
    /// milliseconds" (same stderr fixture as parseScenes's test).
    #[test]
    fn parse_scenes_rounds_to_ms() {
        let stderr = "frame pts_time:14.5001 info\n pts_time:21 end";
        assert_eq!(parse_scenes(stderr), vec![14.5, 21.0]);
    }

    /// Mirrors test/commands.test.ts "returns an empty array when no cuts".
    #[test]
    fn parse_scenes_empty_without_cuts() {
        assert!(parse_scenes("no markers").is_empty());
    }

    // --- loudness ---------------------------------------------------------

    /// Mirrors test/loudness.test.ts "loudnessCombinedArgs" — the exact argv,
    /// element for element.
    #[test]
    fn loudness_combined_args_one_pass_pcm_and_lufs() {
        assert_eq!(
            loudness_combined_args("in.mp4"),
            vec![
                "-hide_banner",
                "-nostats",
                "-loglevel",
                "verbose",
                "-i",
                "in.mp4",
                "-af",
                "ebur128=metadata=1",
                "-ac",
                "1",
                "-ar",
                "8000",
                "-f",
                "f32le",
                "-",
            ]
        );
    }

    /// Mirrors test/loudness.test.ts "extracts every M: value in order, handling
    /// the no-space format" (same log fixture as parseEbur128Momentary's test).
    #[test]
    fn parse_ebur128_momentary_extracts_m_values_in_order() {
        let log = [
            "[Parsed_ebur128_0 @ 0x1] t: 0.0999  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS",
            "[Parsed_ebur128_0 @ 0x1] t: 0.1999  TARGET:-23 LUFS    M: -22.4 S:-30.1      I: -25.0 LUFS",
            "[Parsed_ebur128_0 @ 0x1] t: 0.2999  TARGET:-23 LUFS    M:-9.5 S:-12.0        I: -18.0 LUFS",
            "some unrelated verbose line without the field",
        ]
        .join("\n");
        assert_eq!(parse_ebur128_momentary(&log), vec![-120.7, -22.4, -9.5]);
    }

    /// Mirrors test/loudness.test.ts "maps -inf / nan readings to -Infinity".
    /// TS pins both to -Infinity; here `-inf` parses to -∞ and `nan` to NaN —
    /// both NON-FINITE, which is all the downstream bucketing distinguishes.
    #[test]
    fn parse_ebur128_momentary_non_finite_readings() {
        let out = parse_ebur128_momentary("M:-inf x\nM:nan y\nM:-12.0 z");
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], f64::NEG_INFINITY);
        assert!(!out[1].is_finite());
        assert_eq!(out[2], -12.0);
    }

    /// Mirrors test/loudness.test.ts "returns [] when there are no M: lines".
    #[test]
    fn parse_ebur128_momentary_empty_without_m_lines() {
        assert!(parse_ebur128_momentary("no fields here\nSummary:\n  I: -16 LUFS").is_empty());
    }

    /// Mirrors test/loudness.test.ts "lufsToNormalized" (floor -> 0, ceiling ->
    /// 1, midpoint ~0.5, out-of-range clamped, non-finite -> 0).
    #[test]
    fn lufs_to_normalized_maps_floor_to_ceiling() {
        assert_eq!(lufs_to_normalized(LUFS_FLOOR), 0.0);
        assert_eq!(lufs_to_normalized(LUFS_CEIL), 1.0);
        assert!((lufs_to_normalized((LUFS_FLOOR + LUFS_CEIL) / 2.0) - 0.5).abs() < 1e-10);
        assert_eq!(lufs_to_normalized(0.0), 1.0); // above ceiling
        assert_eq!(lufs_to_normalized(-100.0), 0.0); // below floor
        assert_eq!(lufs_to_normalized(f64::NEG_INFINITY), 0.0);
        assert_eq!(lufs_to_normalized(f64::NAN), 0.0);
    }

    /// Mirrors test/loudness.test.ts "returns exactly `buckets` values,
    /// averaging normalized levels" ([ceil, ceil, floor, floor] / 2 -> [1, 0]).
    #[test]
    fn bucket_lufs_averages_normalized_windows() {
        let lufs = [LUFS_CEIL, LUFS_CEIL, LUFS_FLOOR, LUFS_FLOOR];
        assert_eq!(bucket_lufs(&lufs, 2), vec![1.0, 0.0]);
        assert_eq!(bucket_lufs(&lufs, LOUDNESS_BUCKETS).len(), LOUDNESS_BUCKETS);
    }

    /// Mirrors test/loudness.test.ts "skips non-finite readings; an all-silence
    /// window is 0".
    #[test]
    fn bucket_lufs_skips_non_finite_readings() {
        let lufs = [
            f64::NEG_INFINITY,
            LUFS_CEIL,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        assert_eq!(bucket_lufs(&lufs, 2), vec![1.0, 0.0]);
    }

    /// Mirrors test/loudness.test.ts "is an absolute scale — quiet material
    /// never reaches 1".
    #[test]
    fn bucket_lufs_absolute_scale_quiet_stays_below_one() {
        let quiet = [-25.0f64; 20];
        for v in bucket_lufs(&quiet, 4) {
            assert!(v > 0.0 && v < 1.0);
        }
    }

    /// Mirrors test/loudness.test.ts "returns zeros for empty input".
    #[test]
    fn bucket_lufs_zeros_for_empty_input() {
        assert_eq!(bucket_lufs(&[], 5), vec![0.0; 5]);
    }
}
