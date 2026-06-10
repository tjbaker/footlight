// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Footlight native (Tauri) shell.
//!
//! Mirrors the Node dev backend (app/dev-server/server.mjs): each
//! `#[tauri::command]` shells out to ffmpeg / ffprobe / the footlight CLI via
//! `std::process::Command`, so the frontend's `tauriPlatform` adapter has the
//! exact same capabilities as `webPlatform`. The native Help menu mirrors the
//! in-app Help dropdown (About / Report a Bug / View on GitHub).
//!
//! The ffmpeg/ffprobe arg arrays and output parsers below are a HAND MIRROR of
//! the canonical pure builders in src/core.ts (frameExtractArgs, ffprobeStreamArgs
//! / parseProbe, cropdetectArgs / parseCropdetect, scenesArgs / parseScenes) — the
//! CLI and the Node dev server import those directly; Rust can't, so keep this in
//! sync when they change.
//!
//! NOTE: this requires the Rust toolchain (rustup + `cargo tauri`) to build and
//! was NOT compiled in the environment where it was authored — see README.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const REPO_URL: &str = "https://github.com/tjbaker/footlight";
const ISSUES_NEW_URL: &str = "https://github.com/tjbaker/footlight/issues/new";

/// Keyring service name for the secretStore commands. MUST match the bundle
/// identifier in tauri.conf.json (`com.tjbaker.footlight`) so stored secrets are
/// namespaced to this app in the OS keychain.
const KEYRING_SERVICE: &str = "com.tjbaker.footlight";

#[derive(Serialize)]
struct ProbeResult {
    width: u32,
    height: u32,
    duration: f64,
    cropdetect: Option<String>,
}

#[derive(Serialize)]
struct RenderResult {
    ok: bool,
    log: String,
}

#[derive(Serialize)]
struct OutdirCheck {
    ok: bool,
    resolved: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Extract a single accurate frame at `t` seconds; write a temp JPEG and return
/// its absolute path (the frontend wraps it with the Tauri asset protocol).
/// Accuracy comes from ffmpeg INPUT-seek (`-ss` before `-i`) per displayed frame.
// NOTE: these commands shell out to ffmpeg/ffprobe/node and can run for many
// seconds (cropdetect, scene decode, a full render, or an Auto-track pass). They
// MUST be `async`: in Tauri a synchronous command runs on the main thread and
// freezes the entire UI (the spinning-beachball hang) until it returns. Marking
// them `async` makes Tauri run them off the main thread so the window stays live.
#[tauri::command]
async fn extract_frame(source: String, t: f64) -> Result<String, String> {
    let mut path = std::env::temp_dir();
    path.push(format!("footlight_frame_{}.jpg", std::process::id()));
    let out = path.to_string_lossy().to_string();

    // Primary: accurate INPUT-seek to t. If t lands at/after the source's end
    // (seeking to the clip end, or the final sampled still), this decodes no
    // frame and the mjpeg encoder fails with no packets — fall back to grabbing
    // the last available frame by seeking relative to EOF, mirroring the shared
    // frameExtractArgs / frameExtractTailArgs pair the web backend uses.
    let t_str = t.to_string();
    if run_frame_extract(&["-ss", &t_str], &source, &out)? {
        return Ok(out);
    }
    if run_frame_extract(&["-sseof", "-0.2"], &source, &out)? {
        return Ok(out);
    }
    Err("ffmpeg frame extraction failed".into())
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
fn run_frame_extract(seek: &[&str], source: &str, out: &str) -> Result<bool, String> {
    let status = Command::new("ffmpeg")
        .args(frame_extract_args(seek, source, out))
        .status()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
    let wrote = std::fs::metadata(out).map(|m| m.len() > 0).unwrap_or(false);
    Ok(status.success() && wrote)
}

/// ffprobe args for the first video stream's width/height + container duration.
/// HAND MIRROR of core.ts `ffprobeStreamArgs` — keep in sync.
fn ffprobe_stream_args(source: &str) -> Vec<&str> {
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
fn parse_probe(stdout: &[u8]) -> Result<(u32, u32, f64), String> {
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
async fn probe(source: String) -> Result<ProbeResult, String> {
    let probe_out = Command::new("ffprobe")
        .args(ffprobe_stream_args(&source))
        .output()
        .map_err(|e| format!("failed to spawn ffprobe: {e}"))?;

    if !probe_out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&probe_out.stderr)
        ));
    }

    let (width, height, duration) = parse_probe(&probe_out.stdout)?;

    // cropdetect — black bars only (mirrors the dev server / CLI).
    let cd = Command::new("ffmpeg")
        .args(cropdetect_args(&source))
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
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
async fn scenes(source: String) -> Result<Vec<f64>, String> {
    let out = Command::new("ffmpeg")
        .args(scenes_args(&source))
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    let stderr = String::from_utf8_lossy(&out.stderr);
    Ok(parse_scenes(&stderr))
}

// ---------------------------------------------------------------------------
// Cover-frame export (issue #166): one frame at source time t, cropped through
// the clip's ACTIVE framing, scaled to 1080×1920 and written as a PNG. The crop
// math below — parse_timestamp / parse_content_crop / parse_crop_schedule /
// compute_crop / schedule_offset_at / eased_crop_x_at / cover_frame_args — is a
// HAND MIRROR of the canonical pure builders in src/core.ts (same names, camel-
// cased); the dev server imports those directly, Rust can't, so keep this block
// in sync when they change. The #[cfg(test)] cases below pin the SAME fixture
// values as test/cover.test.ts.
// ---------------------------------------------------------------------------

/// One keyframe of an eased crop path (clip-relative seconds → crop x px).
#[derive(Deserialize)]
struct CoverKeyframe {
    t: f64,
    x: f64,
}

/// An explicit punch-in / zoom crop window in working-region pixels.
#[derive(Deserialize)]
struct CoverWindow {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// The slice of a ClipSpec the cover export needs (the frontend passes the full
/// spec; unknown fields are ignored). Field names match the manifest JSON.
#[derive(Default, Deserialize)]
#[serde(default)]
struct CoverSpec {
    in_point: Option<String>,
    crop_offset: Option<String>,
    content_crop: Option<String>,
    #[serde(rename = "cropPath")]
    crop_path: Option<Vec<CoverKeyframe>>,
    #[serde(rename = "cropWindow")]
    crop_window: Option<CoverWindow>,
}

/// 9:16 as a width/height ratio. HAND MIRROR of core.ts `TARGET_AR`.
const COVER_TARGET_AR: f64 = 9.0 / 16.0;

/// Round down to the nearest even integer (H.264-style even dimensions; the
/// cover keeps the rule so it matches the rendered clip pixel-for-pixel).
/// HAND MIRROR of core.ts `even` (n - (n % 2), which also handles fractions).
fn even_f(n: f64) -> i64 {
    (n - (n % 2.0)) as i64
}

/// Parse `HH:MM:SS`, `MM:SS`, or plain seconds into float seconds.
/// HAND MIRROR of core.ts `parseTimestamp`.
fn parse_timestamp(value: &str) -> Result<f64, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("empty timestamp".into());
    }
    if value.contains(':') {
        let parts: Vec<&str> = value.split(':').collect();
        if parts.len() > 3 {
            return Err(format!("bad timestamp: {value:?}"));
        }
        let mut secs = 0.0;
        for part in parts {
            let n: f64 = part
                .trim()
                .parse()
                .map_err(|_| format!("bad timestamp: {value:?}"))?;
            secs = secs * 60.0 + n;
        }
        return Ok(secs);
    }
    value
        .parse::<f64>()
        .map_err(|_| format!("bad timestamp: {value:?}"))
}

/// Parse a `"W:H:X:Y"` content region (strip letterbox bars), or None.
/// HAND MIRROR of core.ts `parseContentCrop`.
fn parse_content_crop(value: Option<&str>) -> Result<Option<[i64; 4]>, String> {
    let value = value.unwrap_or("").trim();
    if value.is_empty() {
        return Ok(None);
    }
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 4 {
        return Err(format!("content_crop must be W:H:X:Y, got {value:?}"));
    }
    let mut nums = [0i64; 4];
    for (i, p) in parts.iter().enumerate() {
        nums[i] = p
            .trim()
            .parse::<i64>()
            .map_err(|_| format!("content_crop must be W:H:X:Y integers, got {value:?}"))?;
    }
    if nums[0] <= 0 || nums[1] <= 0 || nums[2] < 0 || nums[3] < 0 {
        return Err(format!(
            "content_crop needs positive W:H and non-negative X:Y, got {value:?}"
        ));
    }
    Ok(Some(nums))
}

/// Parse crop_offset into `[clipRelativeSeconds, offset]` segments, sorted by
/// time. HAND MIRROR of core.ts `parseCropSchedule`.
fn parse_crop_schedule(value: Option<&str>) -> Result<Vec<(f64, String)>, String> {
    let raw = value.unwrap_or("");
    let v = if raw.is_empty() { "center" } else { raw }.trim().to_string();
    if !v.contains('=') {
        return Ok(vec![(0.0, v)]);
    }
    let mut segments: Vec<(f64, String)> = Vec::new();
    for part in v.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let idx = part
            .find('=')
            .ok_or_else(|| format!("bad crop schedule segment: {part:?}"))?;
        let t = parse_timestamp(&part[..idx])?;
        segments.push((t, part[idx + 1..].trim().to_string()));
    }
    if segments.is_empty() {
        return Err(format!("empty crop schedule: {v:?}"));
    }
    // Stable sort by time (Vec::sort_by is stable, like JS Array.sort here).
    segments.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(segments)
}

/// The ACTIVE offset of a parsed schedule at clip-relative time `t`: the last
/// segment whose time is ≤ t; the first applies from the clip start regardless.
/// HAND MIRROR of core.ts `scheduleOffsetAt`.
fn schedule_offset_at(segments: &[(f64, String)], t: f64) -> Result<&str, String> {
    let first = segments
        .first()
        .ok_or_else(|| "scheduleOffsetAt: at least one segment required".to_string())?;
    let mut active = first.1.as_str();
    for (time, offset) in segments {
        if *time <= t {
            active = offset.as_str();
        } else {
            break;
        }
    }
    Ok(active)
}

/// Compute (cw, ch, x, y) extracting a 9:16 region from iw×ih, with the
/// horizontal framing chosen by `crop_offset` (left/center/right/integer).
/// HAND MIRROR of core.ts `computeCrop`.
fn compute_crop(iw: f64, ih: f64, crop_offset: &str) -> Result<(i64, i64, i64, i64), String> {
    let offset = crop_offset.trim().to_lowercase();

    let (cw, ch, x, y): (i64, i64, f64, f64);
    if iw / ih >= COVER_TARGET_AR {
        // Landscape / wider than 9:16 — full height, crop width.
        cw = even_f((ih * COVER_TARGET_AR).round());
        ch = even_f(ih);
        y = 0.0;
        let max_x = iw - cw as f64;
        x = match offset.as_str() {
            "left" => 0.0,
            "center" | "centre" | "" => (max_x / 2.0).floor(),
            "right" => max_x,
            _ => {
                let f: f64 = offset.parse().map_err(|_| {
                    format!(
                        "crop_offset must be left/center/right or an integer, got {crop_offset:?}"
                    )
                })?;
                f.round().min(max_x).max(0.0) // clamp into frame
            }
        };
    } else {
        // Taller than 9:16 — crop height, full width.
        cw = even_f(iw);
        ch = even_f((iw / COVER_TARGET_AR).round());
        x = 0.0;
        y = ((ih - ch as f64) / 2.0).floor();
    }

    Ok((cw, ch, even_f(x), even_f(y)))
}

/// Evaluate an eased crop path's x at clip-relative time `t` (smoothstep:
/// p clamped to [0,1], s = p*p*(3-2p); endpoints held outside the range).
/// HAND MIRROR of core.ts `easedCropXAt`.
fn eased_crop_x_at(keyframes: &[CoverKeyframe], t: f64) -> f64 {
    if keyframes.is_empty() {
        return 0.0;
    }
    let mut kfs: Vec<&CoverKeyframe> = keyframes.iter().collect();
    kfs.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    if kfs.len() == 1 {
        return kfs[0].x;
    }
    if t <= kfs[0].t {
        return kfs[0].x;
    }
    let last = kfs[kfs.len() - 1];
    if t >= last.t {
        return last.x;
    }
    for i in 0..kfs.len() - 1 {
        let a = kfs[i];
        let b = kfs[i + 1];
        if t >= a.t && t <= b.t {
            let dt = b.t - a.t;
            if dt <= 0.0 {
                return b.x;
            }
            let p = ((t - a.t) / dt).clamp(0.0, 1.0);
            let s = p * p * (3.0 - 2.0 * p);
            return a.x + (b.x - a.x) * s;
        }
    }
    last.x
}

/// Even-round and clamp a punch-in window into the working region.
/// HAND MIRROR of core.ts `clampCropWindow`.
fn clamp_crop_window(
    win: &CoverWindow,
    work_w: f64,
    work_h: f64,
) -> Result<(i64, i64, i64, i64), String> {
    let cw = even_f(win.w);
    let ch = even_f(win.h);
    if cw <= 0 || ch <= 0 {
        return Err(format!("cropWindow must have positive w/h, got {cw}x{ch}"));
    }
    if cw as f64 > work_w || ch as f64 > work_h {
        return Err(format!(
            "cropWindow {cw}x{ch} exceeds working region {work_w}x{work_h}"
        ));
    }
    let x = even_f(win.x.min(work_w - cw as f64).max(0.0));
    let y = even_f(win.y.min(work_h - ch as f64).max(0.0));
    Ok((cw, ch, x, y))
}

/// Build the ffmpeg argv exporting ONE frame at source time `t` through the
/// spec's ACTIVE framing as a 1080×1920 PNG written to `out`. Precedence is the
/// render's: cropPath > cropWindow > crop_offset, with schedule/path times
/// evaluated at the CLIP-RELATIVE max(0, t - in_point). HAND MIRROR of core.ts
/// `coverFrameArgs` (whose tests in test/cover.test.ts pin these argv shapes) —
/// the only divergence is the file target, like extract_frame's.
fn cover_frame_args(
    source: &str,
    t: f64,
    spec: &CoverSpec,
    dims: (f64, f64),
    out: &str,
) -> Result<Vec<String>, String> {
    let (iw, ih) = dims;
    let content = parse_content_crop(spec.content_crop.as_deref())?;
    let (work_w, work_h) = match &content {
        Some(c) => (c[0] as f64, c[1] as f64),
        None => (iw, ih),
    };

    let seek = if t.is_finite() { t } else { 0.0 };
    let in_point = parse_timestamp(spec.in_point.as_deref().unwrap_or("0"))?;
    let rel = (seek - in_point).max(0.0);

    let crop_filter = if let Some(path) = spec.crop_path.as_ref().filter(|p| !p.is_empty()) {
        // Eased path beats everything; "center" base sizing as in the render.
        let (cw, ch, _x, y) = compute_crop(work_w, work_h, "center")?;
        let max_x = (work_w - cw as f64).max(0.0);
        let x = eased_crop_x_at(path, rel).max(0.0).min(max_x).round() as i64;
        format!("crop={cw}:{ch}:{x}:{y}")
    } else if let Some(win) = &spec.crop_window {
        let (cw, ch, x, y) = clamp_crop_window(win, work_w, work_h)?;
        format!("crop={cw}:{ch}:{x}:{y}")
    } else {
        let schedule = parse_crop_schedule(spec.crop_offset.as_deref())?;
        let offset = schedule_offset_at(&schedule, rel)?;
        let (cw, ch, x, y) = compute_crop(work_w, work_h, offset)?;
        format!("crop={cw}:{ch}:{x}:{y}")
    };

    let mut filters: Vec<String> = Vec::new();
    if let Some(c) = &content {
        filters.push(format!("crop={}:{}:{}:{}", c[0], c[1], c[2], c[3]));
    }
    filters.push(crop_filter);
    filters.push("scale=1080:1920:flags=lanczos".into());

    Ok(vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        seek.to_string(),
        "-i".into(),
        source.into(),
        "-vf".into(),
        filters.join(","),
        "-frames:v".into(),
        "1".into(),
        "-f".into(),
        "image2".into(),
        "-c:v".into(),
        "png".into(),
        out.into(),
    ])
}

/// Export the frame at source time `t` through the clip's active framing as a
/// 1080×1920 PNG cover image at `out_path` (the user's Save-dialog choice; see
/// `exportCover` in app/src/platform/tauri.ts). Probes the source with ffprobe,
/// then runs the hand-mirrored `cover_frame_args` ffmpeg command. Succeeds only
/// when ffmpeg exits 0 AND wrote a non-empty file (mirroring extract_frame).
#[tauri::command]
async fn export_cover(
    source: String,
    t: f64,
    spec: CoverSpec,
    out_path: String,
) -> Result<(), String> {
    let probe_out = Command::new("ffprobe")
        .args(ffprobe_stream_args(&source))
        .output()
        .map_err(|e| format!("failed to spawn ffprobe: {e}"))?;
    if !probe_out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&probe_out.stderr)
        ));
    }
    let (width, height, _) = parse_probe(&probe_out.stdout)?;

    let args = cover_frame_args(&source, t, &spec, (width as f64, height as f64), &out_path)?;
    let out = Command::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
    let wrote = std::fs::metadata(&out_path).map(|m| m.len() > 0).unwrap_or(false);
    if !out.status.success() || !wrote {
        return Err(format!(
            "cover export failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[derive(Serialize)]
struct LoudnessResult {
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
            let tok = line[idx + 2..].trim_start().split_whitespace().next().unwrap_or("");
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

/// Reinterpret raw little-endian f32 PCM bytes as samples (a trailing partial
/// sample is dropped).
fn pcm_f32le_samples(bytes: &[u8]) -> Vec<f32> {
    let sn = bytes.len() / 4;
    (0..sn)
        .map(|i| {
            let b = &bytes[i * 4..i * 4 + 4];
            f32::from_le_bytes([b[0], b[1], b[2], b[3]])
        })
        .collect()
}

/// Bucket raw mono PCM into `buckets` per-window RMS values, then normalize the
/// whole array to 0..1 by its max (all-silence stays zeros). HAND MIRROR of
/// core.ts `bucketLoudness`.
fn bucket_loudness(samples: &[f32], buckets: usize) -> Vec<f64> {
    let sn = samples.len();
    let mut detect = vec![0.0f64; buckets];
    if sn > 0 {
        for (b, slot) in detect.iter_mut().enumerate() {
            let start = (b * sn) / buckets;
            let end = ((b + 1) * sn) / buckets;
            let count = end - start;
            let mut sum_sq = 0.0f64;
            for s in &samples[start..end] {
                let v = *s as f64;
                sum_sq += v * v;
            }
            *slot = if count > 0 { (sum_sq / count as f64).sqrt() } else { 0.0 };
        }
        let max = detect.iter().cloned().fold(0.0f64, f64::max);
        if max > 0.0 {
            for v in detect.iter_mut() {
                *v /= max;
            }
        }
    }
    detect
}

/// Fine per-frame RMS envelope at `ONSET_FRAME_SEC` resolution, max-normalized
/// to 0..1 (all-silence stays zeros) with a trailing partial frame dropped and
/// values rounded to 4 decimals (compact JSON; identical pinned fixtures across
/// the TS/Rust mirrors). Feeds the frontend's `detectOnsets` — the 160-bucket
/// envelopes are far too coarse for beats. HAND MIRROR of core.ts
/// `onsetEnvelope` — keep in sync.
fn onset_envelope(samples: &[f32], sample_rate: f64) -> Vec<f64> {
    let frame_len = ((sample_rate * ONSET_FRAME_SEC).round() as usize).max(1);
    let frames = samples.len() / frame_len;
    let mut out = vec![0.0f64; frames];
    for (f, slot) in out.iter_mut().enumerate() {
        let mut sum_sq = 0.0f64;
        for s in &samples[f * frame_len..(f + 1) * frame_len] {
            let v = *s as f64;
            sum_sq += v * v;
        }
        *slot = (sum_sq / frame_len as f64).sqrt();
    }
    let max = out.iter().cloned().fold(0.0f64, f64::max);
    if max > 0.0 {
        for v in out.iter_mut() {
            *v = ((*v / max) * 1e4).round() / 1e4;
        }
    }
    out
}

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
async fn loudness(source: String) -> Result<LoudnessResult, String> {
    let out = Command::new("ffmpeg")
        .args(loudness_combined_args(&source))
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    // --- display: per-frame momentary `M:` LUFS from stderr (mirrors bucketLufs).
    let log = String::from_utf8_lossy(&out.stderr);
    let momentary = parse_ebur128_momentary(&log);

    if !out.status.success() && momentary.is_empty() && out.stdout.is_empty() {
        return Err(format!("loudness failed: {log}"));
    }

    let display = bucket_lufs(&momentary, LOUDNESS_BUCKETS);

    // --- detect + onset envelope: from the mono 8 kHz f32le PCM on stdout
    // (mirrors bucketLoudness / onsetEnvelope).
    let samples = pcm_f32le_samples(&out.stdout);
    let detect = bucket_loudness(&samples, LOUDNESS_BUCKETS);
    let onset_env = onset_envelope(&samples, 8000.0);

    Ok(LoudnessResult { display, detect, onset_envelope: onset_env })
}

/// Locate a subject across sample times (AI subject tracking, SPEC §6.9). Writes
/// the request to a temp `.json`, shells the footlight CLI's `track` command,
/// and parses its stdout (a `TrackSample[]` JSON) back to the frontend. The CLI
/// prints ONLY the samples on stdout; `mock:true` in the request runs offline.
#[tauri::command]
async fn track(app: AppHandle, req: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut req_path = std::env::temp_dir();
    req_path.push(format!("footlight_track_{}.json", std::process::id()));
    let body = serde_json::to_string(&req).map_err(|e| format!("serialize track request: {e}"))?;
    std::fs::write(&req_path, body).map_err(|e| format!("write temp track request: {e}"))?;

    let cli = locate_cli(&app);
    let output = Command::new("node")
        .arg(&cli)
        .arg("track")
        .arg(&req_path)
        .output()
        .map_err(|e| format!("failed to spawn node CLI: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "track failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("track returned unparseable output: {e}"))
}

/// Build the footlight CLI `render` argv (everything after `node <cli>`):
/// manifest path, the Settings-derived flags, then `--outdir` LAST so the log's
/// trailing `--outdir <dir>` parses cleanly on the client. Flag names mirror
/// src/cli.ts; empty strings and false/None toggles emit nothing.
fn render_cli_args(
    manifest_path: &str,
    out_dir: &str,
    crf: Option<i64>,
    preset: Option<String>,
    audio_bitrate: Option<String>,
    dry_run: Option<bool>,
    burn_captions: Option<bool>,
    caption_font: Option<String>,
    caption_color: Option<String>,
    caption_outline_color: Option<String>,
    caption_bold: Option<bool>,
    caption_italic: Option<bool>,
    caption_underline: Option<bool>,
    caption_shadow: Option<bool>,
    caption_box: Option<bool>,
    caption_box_color: Option<String>,
    caption_angle: Option<f64>,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["render".into(), manifest_path.into()];
    if let Some(c) = crf {
        args.push("--crf".into());
        args.push(c.to_string());
    }
    if let Some(p) = preset {
        if !p.is_empty() {
            args.push("--preset".into());
            args.push(p);
        }
    }
    if let Some(a) = audio_bitrate {
        if !a.is_empty() {
            args.push("--audio-bitrate".into());
            args.push(a);
        }
    }
    if dry_run.unwrap_or(false) {
        args.push("--dry-run".into());
    }
    if burn_captions == Some(true) {
        args.push("--burn-captions".into());
    }
    if let Some(f) = caption_font {
        args.push("--caption-font".into());
        args.push(f);
    }
    if let Some(c) = caption_color {
        if !c.is_empty() {
            args.push("--caption-color".into());
            args.push(c);
        }
    }
    if let Some(c) = caption_outline_color {
        if !c.is_empty() {
            args.push("--caption-outline-color".into());
            args.push(c);
        }
    }
    if caption_bold == Some(true) {
        args.push("--caption-bold".into());
    }
    if caption_italic == Some(true) {
        args.push("--caption-italic".into());
    }
    if caption_underline == Some(true) {
        args.push("--caption-underline".into());
    }
    if caption_shadow == Some(true) {
        args.push("--caption-shadow".into());
    }
    if caption_box == Some(true) {
        args.push("--caption-box".into());
    }
    if let Some(c) = caption_box_color {
        if !c.is_empty() {
            args.push("--caption-box-color".into());
            args.push(c);
        }
    }
    if let Some(a) = caption_angle {
        args.push("--caption-angle".into());
        args.push(a.to_string());
    }
    args.push("--outdir".into());
    args.push(out_dir.into());
    args
}

/// Render a JSON manifest: write it to a temp `.json` file and invoke the
/// footlight CLI. The CLI auto-detects the JSON path by the `.json` extension,
/// which lets clips carry an eased `cropPath` the CSV path can't express. The
/// CLI is resolved relative to the bundled resources; in dev it sits at the
/// repo's `bin/footlight.js`.
#[tauri::command]
async fn render(
    app: AppHandle,
    manifest_json: String,
    outdir: Option<String>,
    crf: Option<i64>,
    preset: Option<String>,
    audio_bitrate: Option<String>,
    dry_run: Option<bool>,
    burn_captions: Option<bool>,
    caption_font: Option<String>,
    caption_color: Option<String>,
    caption_outline_color: Option<String>,
    caption_bold: Option<bool>,
    caption_italic: Option<bool>,
    caption_underline: Option<bool>,
    caption_shadow: Option<bool>,
    caption_box: Option<bool>,
    caption_box_color: Option<String>,
    caption_angle: Option<f64>,
) -> Result<RenderResult, String> {
    let mut manifest_path = std::env::temp_dir();
    manifest_path.push(format!("footlight_manifest_{}.json", std::process::id()));
    std::fs::write(&manifest_path, manifest_json)
        .map_err(|e| format!("write temp manifest: {e}"))?;

    let cli = locate_cli(&app);
    let out_dir = resolve_outdir(&cli, outdir);

    // Render flags from Settings -> CLI (see render_cli_args for the shape).
    let args = render_cli_args(
        &manifest_path.to_string_lossy(),
        &out_dir,
        crf,
        preset,
        audio_bitrate,
        dry_run,
        burn_captions,
        caption_font,
        caption_color,
        caption_outline_color,
        caption_bold,
        caption_italic,
        caption_underline,
        caption_shadow,
        caption_box,
        caption_box_color,
        caption_angle,
    );

    let output = Command::new("node")
        .arg(&cli)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to spawn node CLI: {e}"))?;

    let log = format!(
        "$ node {} {}\n\n{}{}",
        cli,
        args.join(" "),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    Ok(RenderResult {
        ok: output.status.success(),
        log,
    })
}

/// Path to the persisted render-history file inside the app config dir, creating
/// the config dir if it does not yet exist.
fn history_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app config dir: {e}"))?;
    Ok(dir.join("history.json"))
}

/// Load the persisted render history. A missing file yields an empty list; the
/// frontend owns capping/ordering. Entries are opaque JSON (the TS HistoryEntry
/// shape) so Rust does not mirror the type.
#[tauri::command]
async fn load_history(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let path = history_path(&app)?;
    let body = match std::fs::read_to_string(&path) {
        Ok(b) => b,
        Err(_) => return Ok(vec![]),
    };
    serde_json::from_str(&body).map_err(|e| format!("parse history: {e}"))
}

/// Persist the full render-history array to the app config dir.
#[tauri::command]
async fn save_history(app: AppHandle, entries: Vec<serde_json::Value>) -> Result<(), String> {
    let path = history_path(&app)?;
    let body = serde_json::to_string(&entries).map_err(|e| format!("serialize history: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write history: {e}"))?;
    Ok(())
}

/// Path to the persisted working-session file inside the app config dir, creating
/// the config dir if it does not yet exist.
fn session_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app config dir: {e}"))?;
    Ok(dir.join("session.json"))
}

/// Load the persisted working session. A missing file yields `None`; the session
/// is opaque JSON (the TS SessionData shape) so Rust does not mirror the type.
#[tauri::command]
async fn load_session(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = session_path(&app)?;
    let body = match std::fs::read_to_string(&path) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    let value = serde_json::from_str(&body).map_err(|e| format!("parse session: {e}"))?;
    Ok(Some(value))
}

/// Persist the working session to the app config dir.
#[tauri::command]
async fn save_session(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = session_path(&app)?;
    let body = serde_json::to_string(&data).map_err(|e| format!("serialize session: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write session: {e}"))?;
    Ok(())
}

/// One installed font family for the caption picker. Family-only is enough —
/// CoreText / fontconfig resolve a `Fontname` by name at render time — so `path`
/// is always `None` here (the web/dev backend fills it from fontconfig).
#[derive(Serialize)]
struct FontInfoDto {
    family: String,
    path: Option<String>,
}

/// Enumerate system font families via font-kit (CoreText on macOS, DirectWrite
/// on Windows, fontconfig on Linux), deduped and sorted case-insensitively.
/// Best-effort: any enumeration error yields an empty list so the picker falls
/// back to the free-text font field rather than failing.
#[tauri::command]
async fn list_fonts() -> Result<Vec<FontInfoDto>, String> {
    let mut families = match font_kit::source::SystemSource::new().all_families() {
        Ok(f) => f,
        Err(_) => return Ok(vec![]),
    };
    families.sort_by_key(|f| f.to_lowercase());
    families.dedup();
    Ok(families
        .into_iter()
        .map(|family| FontInfoDto { family, path: None })
        .collect())
}

/// Recursively collect font-file paths (`.ttf`/`.otf`/`.ttc`) under `dir`,
/// bounded by depth/count so a pathological tree can't wedge the walk.
/// Best-effort: unreadable sub-directories are skipped silently.
fn collect_font_files(dir: &std::path::Path, depth: usize, acc: &mut Vec<std::path::PathBuf>) {
    const MAX_DEPTH: usize = 8;
    const MAX_FILES: usize = 5000;
    if depth > MAX_DEPTH || acc.len() >= MAX_FILES {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // unreadable directory — skip.
    };
    for entry in entries.flatten() {
        if acc.len() >= MAX_FILES {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_font_files(&path, depth + 1, acc);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_lowercase().as_str(), "ttf" | "otf" | "ttc"))
            .unwrap_or(false)
        {
            acc.push(path);
        }
    }
}

/// Scan a user fonts folder for `.ttf`/`.otf`/`.ttc`, loading each file with
/// font-kit to read its real family name, returning a deduped (by `family+path`)
/// list sorted case-insensitively by family. Unlike `list_fonts`, `path` is
/// populated here so the caller can reference the exact file. An empty or
/// unreadable directory yields an empty list rather than an error.
#[tauri::command]
async fn list_fonts_in_dir(dir: String) -> Result<Vec<FontInfoDto>, String> {
    if dir.is_empty() {
        return Ok(vec![]);
    }
    let mut files = Vec::new();
    collect_font_files(std::path::Path::new(&dir), 0, &mut files);

    let mut seen = std::collections::HashSet::new();
    let mut fonts: Vec<FontInfoDto> = Vec::new();
    for file in files {
        let family = match font_kit::handle::Handle::from_path(file.clone(), 0).load() {
            Ok(font) => font.family_name(),
            Err(_) => continue, // unreadable/unsupported font file — skip.
        };
        if family.is_empty() {
            continue;
        }
        let path = file.to_string_lossy().to_string();
        if !seen.insert(format!("{family} {path}")) {
            continue;
        }
        fonts.push(FontInfoDto {
            family,
            path: Some(path),
        });
    }
    fonts.sort_by(|a, b| a.family.to_lowercase().cmp(&b.family.to_lowercase()));
    Ok(fonts)
}

/// Build a keyring entry for `key` under this app's service. The platform
/// secretStore seam (app/src/platform/tauri.ts) maps `getSecret`/`setSecret`/
/// `deleteSecret` to the three commands below.
fn secret_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, key).map_err(|e| format!("keyring entry: {e}"))
}

/// Read a secret. For the Gemini BYOK key, an environment variable
/// (`GEMINI_API_KEY` / `FOOTLIGHT_GEMINI_API_KEY`) takes precedence and is
/// returned WITHOUT touching the OS keychain — so launching from a shell with
/// the var set both overrides a stored key and avoids the keychain prompt.
/// Otherwise read from the keychain; a missing entry is `None`, not an error.
#[tauri::command]
async fn get_secret(key: String) -> Result<Option<String>, String> {
    if key == "footlight.apiKey.gemini" {
        for var in ["GEMINI_API_KEY", "FOOTLIGHT_GEMINI_API_KEY"] {
            if let Ok(v) = std::env::var(var) {
                if !v.trim().is_empty() {
                    return Ok(Some(v));
                }
            }
        }
    }
    let entry = secret_entry(&key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("read secret: {e}")),
    }
}

/// Store (or overwrite) a secret in the OS keychain.
#[tauri::command]
async fn set_secret(key: String, value: String) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    entry
        .set_password(&value)
        .map_err(|e| format!("write secret: {e}"))
}

/// Delete a secret from the OS keychain. A missing entry is treated as success
/// so callers can delete idempotently.
#[tauri::command]
async fn delete_secret(key: String) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete secret: {e}")),
    }
}

/// Build the separate Activity window. Its own close button HIDES it (rather than
/// destroying it) and emits `activity-hidden` so the main window keeps the toggle
/// state in sync — and reopening is instant.
fn build_activity_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let win = WebviewWindowBuilder::new(app, "activity", WebviewUrl::App("activity.html".into()))
        .title("Footlight — Activity")
        .inner_size(700.0, 420.0)
        .min_inner_size(320.0, 180.0)
        .build()
        .map_err(|e| e.to_string())?;
    let w = win.clone();
    let app2 = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = w.hide();
            let _ = app2.emit("activity-hidden", ());
        }
    });
    Ok(win)
}

/// Toggle the Activity window: hide it if shown, show (or create) it if not.
/// Returns whether it is now visible so the main window can sync its toggle.
/// Synchronous so window creation runs on the main thread.
#[tauri::command]
fn toggle_activity_window(app: AppHandle) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window("activity") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return Ok(false);
        }
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(true);
    }
    let win = build_activity_window(&app)?;
    let _ = win.set_focus();
    Ok(true)
}

/// Reveal the Activity window (create if needed) — used to surface failures.
#[tauri::command]
fn show_activity_window(app: AppHandle) -> Result<(), String> {
    let win = match app.get_webview_window("activity") {
        Some(w) => w,
        None => build_activity_window(&app)?,
    };
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// Resolve a render outdir. An absolute path is used verbatim; a relative one
/// (the default `clips`) is resolved against the REPO ROOT — the directory two
/// levels up from the located CLI (`<root>/bin/footlight.js`) — so GUI renders
/// land in the project-root `clips/` next to the CLI's own output, NOT in the
/// Tauri process cwd (which under `cargo tauri dev` is `app/src-tauri/`, where
/// clips would silently pile up out of sight). Mirrors the dev server's
/// REPO_ROOT handling in app/dev-server/server.mjs — keep the two in sync.
///
/// NOTE: in a packaged `.app` the CLI sits at `<resources>/engine/bin/...`, so a
/// relative outdir would resolve under the read-only bundle; packaged builds
/// should pass an absolute outdir.
fn resolve_outdir(cli: &str, outdir: Option<String>) -> String {
    let raw = outdir.unwrap_or_else(|| "clips".into());
    if std::path::Path::new(&raw).is_absolute() {
        return raw;
    }
    if let Some(root) = std::path::Path::new(cli)
        .parent() // <root>/bin
        .and_then(|bin| bin.parent())
    {
        return root.join(&raw).to_string_lossy().to_string();
    }
    raw
}

/// The default render output folder for a fresh install: a `footlight` folder in
/// `~/Movies` (the macOS video folder, the natural home for rendered clips),
/// resolved via Tauri's path API. Falls back to the repo-relative `clips` if that
/// dir can't be determined. Used only to seed an empty Outdir field; a path the
/// user set always wins (issue #58).
#[tauri::command]
fn default_outdir(app: AppHandle) -> String {
    app.path()
        .video_dir()
        .map(|d| d.join("footlight").to_string_lossy().into_owned())
        .unwrap_or_else(|_| "clips".into())
}

/// A short, user-facing reason for a filesystem error (no raw errno/OS string).
fn friendly_fs_error(err: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::PermissionDenied => "permission denied".into(),
        ErrorKind::NotFound => "the parent folder does not exist".into(),
        _ => "it could not be created".into(),
    }
}

/// Validate the render output folder before rendering: resolve it exactly like
/// `render` does, create it if missing, and confirm it is writable (a write probe,
/// since creating an already-existing read-only dir succeeds). Returns the resolved
/// absolute path plus a friendly reason on failure, so the GUI can warn up front
/// instead of surfacing a raw EACCES mid-render (issue #58).
#[tauri::command]
fn check_outdir(app: AppHandle, outdir: Option<String>) -> OutdirCheck {
    let cli = locate_cli(&app);
    let resolved = resolve_outdir(&cli, outdir);
    if let Err(e) = std::fs::create_dir_all(&resolved) {
        return OutdirCheck {
            ok: false,
            resolved,
            error: Some(friendly_fs_error(&e)),
        };
    }
    let probe = std::path::Path::new(&resolved).join(".footlight_write_test");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            OutdirCheck {
                ok: true,
                resolved,
                error: None,
            }
        }
        Err(e) => OutdirCheck {
            ok: false,
            resolved,
            error: Some(friendly_fs_error(&e)),
        },
    }
}

/// Write `content` to `path` (a user-chosen file from the Save dialog) — used by
/// the queue → manifest export. The path is the user's explicit choice, so this
/// just writes UTF-8 text and surfaces a friendly error on failure.
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))
}

/// Find the footlight CLI. Resolution order:
///   1. `FOOTLIGHT_CLI` env override.
///   2. The bundled resource at `<resourceDir>/engine/bin/footlight.js` (works
///      in a double-clicked `.app`, where cwd is `/`). The companion engine
///      `dist/` is bundled alongside it at `engine/dist`, so `footlight.js`'s
///      relative `../dist/cli.js` import still resolves.
///   3. Walk up from the current dir looking for `bin/footlight.js` (dev mode,
///      `tauri dev`, where the repo tree is intact).
fn locate_cli(app: &AppHandle) -> String {
    if let Ok(p) = std::env::var("FOOTLIGHT_CLI") {
        return p;
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled = res_dir.join("engine").join("bin").join("footlight.js");
        if bundled.exists() {
            return bundled.to_string_lossy().to_string();
        }
    }
    let mut dir = std::env::current_dir().unwrap_or_default();
    for _ in 0..6 {
        let candidate = dir.join("bin").join("footlight.js");
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
        if !dir.pop() {
            break;
        }
    }
    "footlight.js".into()
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            extract_frame,
            export_cover,
            probe,
            scenes,
            loudness,
            track,
            render,
            default_outdir,
            check_outdir,
            write_text_file,
            load_history,
            save_history,
            load_session,
            save_session,
            get_secret,
            set_secret,
            delete_secret,
            list_fonts,
            list_fonts_in_dir,
            toggle_activity_window,
            show_activity_window
        ])
        .setup(|app| {
            // Setting ANY custom menu replaces the entire default menu bar, so we
            // must rebuild the standard macOS menus by hand — otherwise Quit
            // (Cmd-Q), copy/paste, and window controls all disappear. We use the
            // SubmenuBuilder convenience methods (predefined OS items) for those
            // and append our custom Help submenu mirroring the in-app dropdown.

            // App menu (macOS shows it titled with the app name). Holds Quit/Cmd-Q
            // and the standard Settings… (Cmd-,) item, which opens the in-app modal.
            let settings = MenuItemBuilder::with_id("app_settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            // The single About item, in the standard macOS location (the app menu).
            // It opens the in-app Settings → About panel (the one source of truth)
            // rather than the generic system panel.
            let about = MenuItemBuilder::with_id("help_about", "About Footlight").build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Footlight")
                .item(&about)
                .separator()
                .item(&settings)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let file_menu = SubmenuBuilder::new(app, "File").close_window().build()?;

            // Edit menu — needed for cut/copy/paste in the source-path field.
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .close_window()
                .build()?;

            // Custom Help menu (About lives in the app menu, macOS-style — not here).
            let guide = MenuItemBuilder::with_id("help_guide", "User Guide").build(app)?;
            let bug = MenuItemBuilder::with_id("help_bug", "Report a Bug").build(app)?;
            let gh = MenuItemBuilder::with_id("help_github", "View on GitHub").build(app)?;
            let help = SubmenuBuilder::new(app, "Help")
                .item(&guide)
                .item(&bug)
                .item(&gh)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .item(&help)
                .build()?;
            app.set_menu(menu)?;

            app.on_menu_event(move |app, event| match event.id().as_ref() {
                "app_settings" => {
                    let _ = app.emit("show-settings", ());
                }
                "help_guide" => {
                    let _ = app.emit("show-guide", ());
                }
                "help_about" => {
                    // Ask the frontend to open Settings → About (single source of truth).
                    let _ = app.emit("show-about", ());
                }
                "help_bug" => {
                    let _ = app.opener().open_url(ISSUES_NEW_URL, None::<&str>);
                }
                "help_github" => {
                    let _ = app.opener().open_url(REPO_URL, None::<&str>);
                }
                _ => {}
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Footlight");
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
        assert_eq!(last_crop_suggestion(stderr).as_deref(), Some("1080:1920:420:0"));
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
        assert!(a.contains(&"-y"), "must overwrite the reused temp path");
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
        let lufs = [f64::NEG_INFINITY, LUFS_CEIL, f64::NEG_INFINITY, f64::NEG_INFINITY];
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

    #[test]
    fn pcm_f32le_samples_decodes_and_drops_partial_sample() {
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(&1.0f32.to_le_bytes());
        bytes.extend_from_slice(&(-0.5f32).to_le_bytes());
        bytes.extend_from_slice(&[0x00, 0x01]); // trailing partial sample
        assert_eq!(pcm_f32le_samples(&bytes), vec![1.0, -0.5]);
    }

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

    // --- onset envelope (In/Out beat snap, issue #164) ----------------------

    /// Mirrors test/onsets.test.ts "pinned: per-frame RMS, normalized and
    /// rounded to 4 decimals (rate 200)" — sample rate 200 → 4 samples/frame,
    /// so [1,1,0,0] → RMS √0.5 and [1,1,1,1] → RMS 1; normalized + rounded →
    /// [0.7071, 1].
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

    // --- render -----------------------------------------------------------

    /// No flags set: just `render <manifest> --outdir <dir>`, with --outdir
    /// LAST (the client parses the log's trailing `--outdir <dir>`).
    #[test]
    fn render_cli_args_minimal_appends_outdir_last() {
        let a = render_cli_args(
            "/tmp/m.json",
            "/out",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(a, vec!["render", "/tmp/m.json", "--outdir", "/out"]);
    }

    /// Every Settings flag set: names/order match src/cli.ts's render flags.
    #[test]
    fn render_cli_args_full_flag_set() {
        let a = render_cli_args(
            "/tmp/m.json",
            "/out",
            Some(19),
            Some("medium".into()),
            Some("256k".into()),
            Some(true),
            Some(true),
            Some("Avenir".into()),
            Some("#ffffff".into()),
            Some("#000000".into()),
            Some(true),
            Some(true),
            Some(true),
            Some(true),
            Some(true),
            Some("#00000080".into()),
            Some(-4.0),
        );
        assert_eq!(
            a,
            vec![
                "render",
                "/tmp/m.json",
                "--crf",
                "19",
                "--preset",
                "medium",
                "--audio-bitrate",
                "256k",
                "--dry-run",
                "--burn-captions",
                "--caption-font",
                "Avenir",
                "--caption-color",
                "#ffffff",
                "--caption-outline-color",
                "#000000",
                "--caption-bold",
                "--caption-italic",
                "--caption-underline",
                "--caption-shadow",
                "--caption-box",
                "--caption-box-color",
                "#00000080",
                "--caption-angle",
                "-4",
                "--outdir",
                "/out",
            ]
        );
    }

    /// Empty strings and explicit-false toggles emit no flags at all.
    #[test]
    fn render_cli_args_skips_empty_and_false_options() {
        let a = render_cli_args(
            "/tmp/m.json",
            "/out",
            None,
            Some(String::new()),
            Some(String::new()),
            Some(false),
            Some(false),
            None,
            Some(String::new()),
            Some(String::new()),
            Some(false),
            Some(false),
            Some(false),
            Some(false),
            Some(false),
            Some(String::new()),
            None,
        );
        assert_eq!(a, vec!["render", "/tmp/m.json", "--outdir", "/out"]);
    }

    // --- path helpers -----------------------------------------------------

    #[test]
    fn resolve_outdir_keeps_absolute_paths_verbatim() {
        assert_eq!(
            resolve_outdir("/repo/bin/footlight.js", Some("/abs/clips".into())),
            "/abs/clips"
        );
    }

    /// A relative outdir resolves against the repo root (two levels up from the
    /// located `<root>/bin/footlight.js`), defaulting to `clips`.
    #[test]
    fn resolve_outdir_resolves_relative_against_repo_root() {
        assert_eq!(resolve_outdir("/repo/bin/footlight.js", None), "/repo/clips");
        assert_eq!(
            resolve_outdir("/repo/bin/footlight.js", Some("out".into())),
            "/repo/out"
        );
    }

    /// A bare CLI path (no repo root to walk up to) falls back to the raw value.
    #[test]
    fn resolve_outdir_bare_cli_falls_back_to_raw() {
        assert_eq!(resolve_outdir("footlight.js", None), "clips");
    }

    #[test]
    fn friendly_fs_error_maps_kinds_to_friendly_reasons() {
        use std::io::{Error, ErrorKind};
        assert_eq!(
            friendly_fs_error(&Error::from(ErrorKind::PermissionDenied)),
            "permission denied"
        );
        assert_eq!(
            friendly_fs_error(&Error::from(ErrorKind::NotFound)),
            "the parent folder does not exist"
        );
        assert_eq!(
            friendly_fs_error(&Error::from(ErrorKind::TimedOut)),
            "it could not be created"
        );
    }

    // --- fonts ------------------------------------------------------------

    /// collect_font_files keeps only .ttf/.otf/.ttc (case-insensitively),
    /// recursing into subdirectories.
    #[test]
    fn collect_font_files_filters_extensions_recursively() {
        let dir = std::env::temp_dir().join(format!("footlight_fonts_test_{}", std::process::id()));
        let sub = dir.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("a.ttf"), b"x").unwrap();
        std::fs::write(dir.join("b.OTF"), b"x").unwrap(); // extension case-insensitive
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::write(sub.join("c.ttc"), b"x").unwrap();

        let mut found = Vec::new();
        collect_font_files(&dir, 0, &mut found);
        let mut names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.ttf", "b.OTF", "c.ttc"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    // --- cover export (issue #166) -----------------------------------------

    fn cover_vf(args: &[String]) -> String {
        let i = args.iter().position(|a| a == "-vf").unwrap();
        args[i + 1].clone()
    }

    fn cover_spec(in_point: Option<&str>, crop_offset: Option<&str>) -> CoverSpec {
        CoverSpec {
            in_point: in_point.map(|s| s.into()),
            crop_offset: crop_offset.map(|s| s.into()),
            content_crop: None,
            crop_path: None,
            crop_window: None,
        }
    }

    /// Mirrors test/cover.test.ts "scheduleOffsetAt" — active segment at t,
    /// exact-boundary switch, and the first segment applying from the start.
    #[test]
    fn schedule_offset_at_picks_active_segment() {
        let seg = parse_crop_schedule(Some("0=left; 4=right; 8=640")).unwrap();
        assert_eq!(schedule_offset_at(&seg, 1.0).unwrap(), "left");
        assert_eq!(schedule_offset_at(&seg, 5.0).unwrap(), "right");
        assert_eq!(schedule_offset_at(&seg, 10.0).unwrap(), "640");
        assert_eq!(schedule_offset_at(&seg, 4.0).unwrap(), "right");
        let late = parse_crop_schedule(Some("2=300; 5=right")).unwrap();
        assert_eq!(schedule_offset_at(&late, 0.0).unwrap(), "300");
    }

    /// Mirrors test/cover.test.ts "easedCropXAt" — smoothstep midpoint, held
    /// endpoints, single-keyframe constant, empty → 0.
    #[test]
    fn eased_crop_x_at_smoothstep() {
        let path = vec![
            CoverKeyframe { t: 0.0, x: 0.0 },
            CoverKeyframe { t: 3.0, x: 1312.0 },
        ];
        assert!((eased_crop_x_at(&path, 1.5) - 656.0).abs() < 1e-9);
        assert_eq!(eased_crop_x_at(&path, -1.0), 0.0);
        assert_eq!(eased_crop_x_at(&path, 99.0), 1312.0);
        assert_eq!(eased_crop_x_at(&[CoverKeyframe { t: 2.0, x: 444.0 }], 0.0), 444.0);
        assert_eq!(eased_crop_x_at(&[], 5.0), 0.0);
    }

    /// Mirrors test/cover.test.ts "center on 1920×1080 → the render's 608×1080
    /// crop at x=656" (the TS test pins this by name).
    #[test]
    fn cover_frame_args_fixed_center() {
        let spec = cover_spec(None, Some("center"));
        let a = cover_frame_args("in.mp4", 5.0, &spec, (1920.0, 1080.0), "/tmp/c.png").unwrap();
        assert_eq!(cover_vf(&a), "crop=608:1080:656:0,scale=1080:1920:flags=lanczos");
        let ss = a.iter().position(|s| s == "-ss").unwrap();
        assert_eq!(a[ss + 1], "5");
        assert!(ss < a.iter().position(|s| s == "-i").unwrap());
        assert_eq!(
            &a[a.iter().position(|s| s == "-frames:v").unwrap()..],
            &["-frames:v", "1", "-f", "image2", "-c:v", "png", "/tmp/c.png"]
        );
    }

    /// Mirrors test/cover.test.ts "evaluates the schedule at the CLIP-RELATIVE
    /// time" (in 10s, t 15 → rel 5 → right) — the named Rust pin.
    #[test]
    fn cover_frame_args_schedule_at_t() {
        let spec = cover_spec(Some("10"), Some("0=left; 4=right; 8=640"));
        let a = cover_frame_args("in.mp4", 15.0, &spec, (1920.0, 1080.0), "-").unwrap();
        assert_eq!(cover_vf(&a), "crop=608:1080:1312:0,scale=1080:1920:flags=lanczos");
        // t before the In point clamps the relative time to 0 → first segment.
        let b = cover_frame_args("in.mp4", 3.0, &spec, (1920.0, 1080.0), "-").unwrap();
        assert!(cover_vf(&b).starts_with("crop=608:1080:0:0"));
    }

    /// Mirrors test/cover.test.ts "evaluates the smoothstep at the clip-relative
    /// time (precedence over crop_offset)" — the named Rust pin.
    #[test]
    fn cover_frame_args_eased_midpoint() {
        let mut spec = cover_spec(Some("10"), Some("left"));
        spec.crop_path = Some(vec![
            CoverKeyframe { t: 0.0, x: 0.0 },
            CoverKeyframe { t: 3.0, x: 1312.0 },
        ]);
        let a = cover_frame_args("in.mp4", 11.5, &spec, (1920.0, 1080.0), "-").unwrap();
        assert_eq!(cover_vf(&a), "crop=608:1080:656:0,scale=1080:1920:flags=lanczos");
    }

    /// Mirrors test/cover.test.ts "uses the even-rounded, clamped fixed window"
    /// — the named Rust pin, plus the clamp and region-exceeded cases.
    #[test]
    fn cover_frame_args_punch_in_window() {
        let mut spec = cover_spec(None, None);
        spec.crop_window = Some(CoverWindow { x: 800.0, y: 120.0, w: 405.0, h: 720.0 });
        let a = cover_frame_args("in.mp4", 2.0, &spec, (1920.0, 1080.0), "-").unwrap();
        assert_eq!(cover_vf(&a), "crop=404:720:800:120,scale=1080:1920:flags=lanczos");

        spec.crop_window = Some(CoverWindow { x: 9999.0, y: -50.0, w: 405.0, h: 720.0 });
        let b = cover_frame_args("in.mp4", 2.0, &spec, (1920.0, 1080.0), "-").unwrap();
        assert!(cover_vf(&b).starts_with("crop=404:720:1516:0"));

        spec.crop_window = Some(CoverWindow { x: 0.0, y: 0.0, w: 405.0, h: 2000.0 });
        assert!(cover_frame_args("in.mp4", 0.0, &spec, (1920.0, 1080.0), "-")
            .unwrap_err()
            .contains("exceeds working region"));
    }

    /// Mirrors test/cover.test.ts "pre-crops to the content region and resolves
    /// the offset inside it" — the named Rust pin (1440-wide region → x=416).
    #[test]
    fn cover_frame_args_content_crop() {
        let mut spec = cover_spec(None, Some("center"));
        spec.content_crop = Some("1440:1080:240:0".into());
        let a = cover_frame_args("in.mp4", 0.0, &spec, (1920.0, 1080.0), "-").unwrap();
        assert_eq!(
            cover_vf(&a),
            "crop=1440:1080:240:0,crop=608:1080:416:0,scale=1080:1920:flags=lanczos"
        );
    }

    /// Mirrors test/cover.test.ts "clamps a non-finite t to 0".
    #[test]
    fn cover_frame_args_non_finite_t_clamps_to_zero() {
        let spec = cover_spec(None, Some("center"));
        let a = cover_frame_args("in.mp4", f64::NAN, &spec, (1920.0, 1080.0), "-").unwrap();
        let ss = a.iter().position(|s| s == "-ss").unwrap();
        assert_eq!(a[ss + 1], "0");
    }
}
