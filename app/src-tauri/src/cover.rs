// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Cover-frame export and the crop mirrors it is built on.

use serde::Deserialize;
use tokio::process::Command;

use crate::media::{ffprobe_stream_args, parse_probe};
use crate::subprocess::{run_output, Kind};

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
pub(crate) struct CoverSpec {
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

/// One `:`-separated timestamp part: unsigned decimal digits with an optional
/// `.fraction` (`^\d+(\.\d+)?$`). HAND MIRROR of core.ts `TIMESTAMP_PART`.
fn is_timestamp_part(part: &str) -> bool {
    let (int, frac) = match part.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (part, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(int) && frac.map_or(true, digits)
}

/// Parse `HH:MM:SS`, `MM:SS`, or plain seconds into float seconds. Each part
/// must be unsigned decimal (no empty parts, signs, hex, exponents, inf/NaN) and
/// the result finite and ≥ 0. HAND MIRROR of core.ts `parseTimestamp`; both are
/// pinned to test/fixtures/timestamps.json.
fn parse_timestamp(value: &str) -> Result<f64, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("empty timestamp".into());
    }
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() > 3 {
        return Err(format!("bad timestamp: {value:?}"));
    }
    let mut secs = 0.0;
    for part in parts {
        let part = part.trim();
        if !is_timestamp_part(part) {
            return Err(format!("bad timestamp: {value:?}"));
        }
        let n: f64 = part
            .parse()
            .map_err(|_| format!("bad timestamp: {value:?}"))?;
        secs = secs * 60.0 + n;
    }
    if !secs.is_finite() {
        return Err(format!("bad timestamp: {value:?}"));
    }
    Ok(secs)
}

/// Largest integer an f64 (a JS number) holds exactly: `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Parse a whitespace-trimmed plain decimal integer with an optional sign
/// (`^[+-]?\d+$`) that is a JS safe integer, or None — no hex, exponent,
/// fraction or inf/NaN. HAND MIRROR of core.ts `parseDecimalInt`.
fn parse_decimal_int(value: &str) -> Option<i64> {
    let s = value.trim();
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>()
        .ok()
        .filter(|n| n.unsigned_abs() <= MAX_SAFE_INTEGER)
}

/// Parse a `"W:H:X:Y"` content region (strip letterbox bars), or None. Each
/// part must be a plain decimal integer (`parse_decimal_int`). HAND MIRROR of
/// core.ts `parseContentCrop`; both are pinned to test/fixtures/crop.json.
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
        nums[i] = parse_decimal_int(p)
            .ok_or_else(|| format!("content_crop must be W:H:X:Y integers, got {value:?}"))?;
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
    let v = if raw.is_empty() { "center" } else { raw }
        .trim()
        .to_string();
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
/// An integer offset must be a plain decimal integer (`parse_decimal_int`).
/// HAND MIRROR of core.ts `computeCrop`; both are pinned to
/// test/fixtures/crop.json.
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
                let n = parse_decimal_int(&offset).ok_or_else(|| {
                    format!(
                        "crop_offset must be left/center/right or an integer, got {crop_offset:?}"
                    )
                })?;
                (n as f64).min(max_x).max(0.0) // clamp into frame
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
/// HAND MIRROR of core.ts `clampCropWindow`; both are pinned to
/// test/fixtures/crop.json.
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
pub(crate) async fn export_cover(
    source: String,
    t: f64,
    spec: CoverSpec,
    out_path: String,
) -> Result<(), String> {
    let mut cmd = Command::new("ffprobe");
    cmd.args(ffprobe_stream_args(&source));
    let probe_out = run_output(cmd, "ffprobe", Kind::Analysis).await?;
    if !probe_out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&probe_out.stderr)
        ));
    }
    let (width, height, _) = parse_probe(&probe_out.stdout)?;

    let args = cover_frame_args(&source, t, &spec, (width as f64, height as f64), &out_path)?;
    let mut cmd = Command::new("ffmpeg");
    cmd.args(&args);
    let out = run_output(cmd, "ffmpeg", Kind::Analysis).await?;
    let wrote = std::fs::metadata(&out_path)
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    if !out.status.success() || !wrote {
        return Err(format!(
            "cover export failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_timestamp (issue #256) --------------------------------------

    /// The SAME accept/reject fixtures test/engine.test.ts runs against
    /// core.ts `parseTimestamp` — read from the shared JSON so drift fails here.
    fn timestamp_fixtures() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../test/fixtures/timestamps.json")).unwrap()
    }

    #[test]
    fn parse_timestamp_accepts_shared_fixtures() {
        let fx = timestamp_fixtures();
        let accept = fx["accept"].as_array().unwrap();
        assert!(!accept.is_empty());
        for case in accept {
            let input = case[0].as_str().unwrap();
            let want = case[1].as_f64().unwrap();
            assert_eq!(parse_timestamp(input), Ok(want), "input {input:?}");
        }
    }

    #[test]
    fn parse_timestamp_rejects_shared_fixtures() {
        let fx = timestamp_fixtures();
        let reject = fx["reject"].as_array().unwrap();
        assert!(!reject.is_empty());
        for case in reject {
            let input = case.as_str().unwrap();
            let err = parse_timestamp(input).expect_err(input);
            assert!(err.contains("timestamp"), "input {input:?} -> {err}");
        }
    }

    /// Mirrors test/engine.test.ts "names the offending value in the error".
    #[test]
    fn parse_timestamp_names_offending_value() {
        assert_eq!(
            parse_timestamp("1::30"),
            Err("bad timestamp: \"1::30\"".to_string())
        );
    }

    // --- compute_crop / parse_content_crop / clamp_crop_window (issue #261) --

    /// The SAME fixtures test/engine.test.ts runs against core.ts `computeCrop`,
    /// `parseContentCrop` and `clampCropWindow` — read from the shared JSON so
    /// drift fails here.
    fn crop_fixtures() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../test/fixtures/crop.json")).unwrap()
    }

    /// A fixture `[cw, ch, x, y]` / `[W, H, X, Y]` array as a tuple.
    fn quad(v: &serde_json::Value) -> (i64, i64, i64, i64) {
        let n = |i: usize| v[i].as_i64().unwrap();
        (n(0), n(1), n(2), n(3))
    }

    fn cases<'a>(fx: &'a serde_json::Value, func: &str, kind: &str) -> &'a [serde_json::Value] {
        let list = fx[func][kind].as_array().unwrap();
        assert!(!list.is_empty(), "{func}.{kind} is empty");
        list
    }

    #[test]
    fn compute_crop_accepts_shared_fixtures() {
        let fx = crop_fixtures();
        for case in cases(&fx, "computeCrop", "accept") {
            let (iw, ih) = (case[0].as_f64().unwrap(), case[1].as_f64().unwrap());
            let offset = case[2].as_str().unwrap();
            assert_eq!(
                compute_crop(iw, ih, offset),
                Ok(quad(&case[3])),
                "{iw}x{ih} {offset:?}"
            );
        }
    }

    #[test]
    fn compute_crop_rejects_shared_fixtures() {
        let fx = crop_fixtures();
        for case in cases(&fx, "computeCrop", "reject") {
            let (iw, ih) = (case[0].as_f64().unwrap(), case[1].as_f64().unwrap());
            let offset = case[2].as_str().unwrap();
            let err = compute_crop(iw, ih, offset).expect_err(offset);
            assert!(err.contains("crop_offset must be"), "{offset:?} -> {err}");
        }
    }

    #[test]
    fn parse_content_crop_accepts_shared_fixtures() {
        let fx = crop_fixtures();
        for case in cases(&fx, "parseContentCrop", "accept") {
            let input = case[0].as_str();
            let want = (!case[1].is_null()).then(|| {
                let (w, h, x, y) = quad(&case[1]);
                [w, h, x, y]
            });
            assert_eq!(parse_content_crop(input), Ok(want), "input {input:?}");
        }
    }

    #[test]
    fn parse_content_crop_rejects_shared_fixtures() {
        let fx = crop_fixtures();
        for case in cases(&fx, "parseContentCrop", "reject") {
            let input = case[0].as_str().unwrap();
            let msg = case[1].as_str().unwrap();
            let err = parse_content_crop(Some(input)).expect_err(input);
            assert!(err.contains(msg), "input {input:?} -> {err} (want {msg:?})");
        }
    }

    fn fixture_window(v: &serde_json::Value) -> CoverWindow {
        let n = |k: &str| v[k].as_f64().unwrap();
        CoverWindow {
            x: n("x"),
            y: n("y"),
            w: n("w"),
            h: n("h"),
        }
    }

    #[test]
    fn clamp_crop_window_accepts_shared_fixtures() {
        let fx = crop_fixtures();
        for case in cases(&fx, "clampCropWindow", "accept") {
            let win = fixture_window(&case[0]);
            let (work_w, work_h) = (case[1].as_f64().unwrap(), case[2].as_f64().unwrap());
            assert_eq!(
                clamp_crop_window(&win, work_w, work_h),
                Ok(quad(&case[3])),
                "{} in {work_w}x{work_h}",
                case[0]
            );
        }
    }

    #[test]
    fn clamp_crop_window_rejects_shared_fixtures() {
        let fx = crop_fixtures();
        for case in cases(&fx, "clampCropWindow", "reject") {
            let win = fixture_window(&case[0]);
            let (work_w, work_h) = (case[1].as_f64().unwrap(), case[2].as_f64().unwrap());
            let err = clamp_crop_window(&win, work_w, work_h).expect_err("reject");
            assert!(err.contains("cropWindow"), "{} -> {err}", case[0]);
        }
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
        assert_eq!(
            eased_crop_x_at(&[CoverKeyframe { t: 2.0, x: 444.0 }], 0.0),
            444.0
        );
        assert_eq!(eased_crop_x_at(&[], 5.0), 0.0);
    }

    /// Mirrors test/cover.test.ts "center on 1920×1080 → the render's 608×1080
    /// crop at x=656" (the TS test pins this by name).
    #[test]
    fn cover_frame_args_fixed_center() {
        let spec = cover_spec(None, Some("center"));
        let a = cover_frame_args("in.mp4", 5.0, &spec, (1920.0, 1080.0), "/tmp/c.png").unwrap();
        assert_eq!(
            cover_vf(&a),
            "crop=608:1080:656:0,scale=1080:1920:flags=lanczos"
        );
        let ss = a.iter().position(|s| s == "-ss").unwrap();
        assert_eq!(a[ss + 1], "5");
        assert!(ss < a.iter().position(|s| s == "-i").unwrap());
        assert_eq!(
            &a[a.iter().position(|s| s == "-frames:v").unwrap()..],
            &[
                "-frames:v",
                "1",
                "-f",
                "image2",
                "-c:v",
                "png",
                "/tmp/c.png"
            ]
        );
    }

    /// Mirrors test/cover.test.ts "evaluates the schedule at the CLIP-RELATIVE
    /// time" (in 10s, t 15 → rel 5 → right) — the named Rust pin.
    #[test]
    fn cover_frame_args_schedule_at_t() {
        let spec = cover_spec(Some("10"), Some("0=left; 4=right; 8=640"));
        let a = cover_frame_args("in.mp4", 15.0, &spec, (1920.0, 1080.0), "-").unwrap();
        assert_eq!(
            cover_vf(&a),
            "crop=608:1080:1312:0,scale=1080:1920:flags=lanczos"
        );
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
        assert_eq!(
            cover_vf(&a),
            "crop=608:1080:656:0,scale=1080:1920:flags=lanczos"
        );
    }

    /// Mirrors test/cover.test.ts "uses the even-rounded, clamped fixed window"
    /// — the named Rust pin, plus the clamp and region-exceeded cases.
    #[test]
    fn cover_frame_args_punch_in_window() {
        let mut spec = cover_spec(None, None);
        spec.crop_window = Some(CoverWindow {
            x: 800.0,
            y: 120.0,
            w: 405.0,
            h: 720.0,
        });
        let a = cover_frame_args("in.mp4", 2.0, &spec, (1920.0, 1080.0), "-").unwrap();
        assert_eq!(
            cover_vf(&a),
            "crop=404:720:800:120,scale=1080:1920:flags=lanczos"
        );

        spec.crop_window = Some(CoverWindow {
            x: 9999.0,
            y: -50.0,
            w: 405.0,
            h: 720.0,
        });
        let b = cover_frame_args("in.mp4", 2.0, &spec, (1920.0, 1080.0), "-").unwrap();
        assert!(cover_vf(&b).starts_with("crop=404:720:1516:0"));

        spec.crop_window = Some(CoverWindow {
            x: 0.0,
            y: 0.0,
            w: 405.0,
            h: 2000.0,
        });
        assert!(
            cover_frame_args("in.mp4", 0.0, &spec, (1920.0, 1080.0), "-")
                .unwrap_err()
                .contains("exceeds working region")
        );
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
