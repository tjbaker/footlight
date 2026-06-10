// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Cover-frame export (issue #166): `coverFrameArgs` builds the single-PNG
 * ffmpeg command whose crop matches the clip's ACTIVE framing at time t —
 * fixed offset, time-keyed schedule (`scheduleOffsetAt`), eased cropPath
 * (`easedCropXAt`), or punch-in cropWindow — through the same filter math as
 * `buildFfmpegArgs`.
 *
 * NOTE: the fixture values here are PINNED by the Rust hand mirror in
 * app/src-tauri/src/main.rs (`cover_frame_args` & friends) — its #[cfg(test)]
 * cases reuse these exact inputs and expected strings, so keep them in sync.
 */

import { describe, it, expect } from "vitest";

import {
  coverFrameArgs,
  coverOutName,
  easedCropXAt,
  parseCropSchedule,
  scheduleOffsetAt,
  type ClipRow,
  type CoverFrameOptions,
} from "../src/engine.js";

const ROW: ClipRow = { source_file: "in.mp4", in_point: "0", out_point: "10" };

function vfOf(args: string[]): string {
  const i = args.indexOf("-vf");
  return args[i + 1]!;
}

function build(row: Partial<ClipRow>, t: number, opts: Partial<CoverFrameOptions> = {}): string[] {
  return coverFrameArgs({ ...ROW, ...row }, t, { dims: [1920, 1080], ...opts });
}

describe("scheduleOffsetAt", () => {
  // Same schedule fixture as the Rust mirror's schedule tests.
  const schedule = parseCropSchedule("0=left; 4=right; 8=640");

  it("picks the segment active at t (last segment time ≤ t)", () => {
    expect(scheduleOffsetAt(schedule, 1)).toBe("left");
    expect(scheduleOffsetAt(schedule, 5)).toBe("right");
    expect(scheduleOffsetAt(schedule, 10)).toBe("640");
  });

  it("switches exactly AT the segment boundary", () => {
    expect(scheduleOffsetAt(schedule, 4)).toBe("right");
    expect(scheduleOffsetAt(schedule, 8)).toBe("640");
  });

  it("applies the first segment from the clip start regardless of its time", () => {
    const late = parseCropSchedule("2=300; 6=right");
    expect(scheduleOffsetAt(late, 0)).toBe("300");
    expect(scheduleOffsetAt(late, 1.9)).toBe("300");
    expect(scheduleOffsetAt(late, 6)).toBe("right");
  });

  it("a plain (non-schedule) value is a single segment from t=0", () => {
    expect(scheduleOffsetAt(parseCropSchedule("center"), 99)).toBe("center");
  });

  it("throws on an empty segment list", () => {
    expect(() => scheduleOffsetAt([], 0)).toThrow(/at least one segment/);
  });
});

describe("easedCropXAt", () => {
  // Same two-keyframe path as the buildEasedCropX tests + the Rust mirror.
  const path = [
    { t: 0, x: 0 },
    { t: 3, x: 1312 },
  ];

  it("evaluates the smoothstep midpoint (p=0.5 → s=0.5)", () => {
    expect(easedCropXAt(path, 1.5)).toBeCloseTo(656, 10);
  });

  it("holds the first/last x outside the path's time range", () => {
    expect(easedCropXAt(path, -1)).toBe(0);
    expect(easedCropXAt(path, 99)).toBe(1312);
  });

  it("eases monotonically between keyframes", () => {
    expect(easedCropXAt(path, 0.5)).toBeGreaterThan(0);
    expect(easedCropXAt(path, 0.5)).toBeLessThan(easedCropXAt(path, 1.5));
    expect(easedCropXAt(path, 2.5)).toBeLessThan(1312);
  });

  it("a single keyframe is constant; empty input is 0", () => {
    expect(easedCropXAt([{ t: 2, x: 444 }], 0)).toBe(444);
    expect(easedCropXAt([], 5)).toBe(0);
  });

  it("sorts keyframes and steps across coincident ones", () => {
    expect(easedCropXAt([...path].reverse(), 1.5)).toBeCloseTo(656, 10);
    const step = [
      { t: 1, x: 100 },
      { t: 1, x: 500 },
    ];
    expect(easedCropXAt(step, 1)).toBe(100); // at the first keyframe's t
  });
});

describe("coverFrameArgs — command shape", () => {
  it("INPUT-seeks to t, emits one PNG frame, and defaults to stdout", () => {
    const a = build({ crop_offset: "center" }, 12.5);
    const ss = a.indexOf("-ss");
    expect(ss).toBeGreaterThanOrEqual(0);
    expect(ss).toBeLessThan(a.indexOf("-i"));
    expect(a[ss + 1]).toBe("12.5");
    expect(a.slice(a.indexOf("-frames:v"))).toEqual([
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "png",
      "-",
    ]);
  });

  it("targets a .png file path when opts.out is set (Rust mirror's form)", () => {
    const a = build({ crop_offset: "center" }, 1, { out: "/tmp/cover.png" });
    expect(a[a.length - 1]).toBe("/tmp/cover.png");
    expect(a).toContain("-y"); // file target must be overwritable
  });

  it("clamps a non-finite t to 0", () => {
    const a = build({ crop_offset: "center" }, Number.NaN);
    expect(a[a.indexOf("-ss") + 1]).toBe("0");
  });
});

describe("coverFrameArgs — fixed crop_offset", () => {
  it("center on 1920×1080 → the render's 608×1080 crop at x=656", () => {
    // Pinned by the Rust mirror: cover_frame_args_fixed_center.
    expect(vfOf(build({ crop_offset: "center" }, 5))).toBe(
      "crop=608:1080:656:0,scale=1080:1920:flags=lanczos",
    );
  });

  it("left / right / integer offsets resolve like computeCrop", () => {
    expect(vfOf(build({ crop_offset: "left" }, 0))).toContain("crop=608:1080:0:0");
    expect(vfOf(build({ crop_offset: "right" }, 0))).toContain("crop=608:1080:1312:0");
    expect(vfOf(build({ crop_offset: "200" }, 0))).toContain("crop=608:1080:200:0");
    // Out-of-frame integer clamps to maxX (1920-608=1312).
    expect(vfOf(build({ crop_offset: "5000" }, 0))).toContain("crop=608:1080:1312:0");
  });
});

describe("coverFrameArgs — offset-at-t across a schedule", () => {
  // Clip starts at source 10s; schedule times are clip-relative.
  const row: Partial<ClipRow> = { in_point: "10", crop_offset: "0=left; 4=right; 8=640" };

  it("evaluates the schedule at the CLIP-RELATIVE time (t - in_point)", () => {
    expect(vfOf(build(row, 11))).toContain("crop=608:1080:0:0"); // rel 1 → left
    // Pinned by the Rust mirror: cover_frame_args_schedule_at_t (rel 5 → right).
    expect(vfOf(build(row, 15))).toBe("crop=608:1080:1312:0,scale=1080:1920:flags=lanczos");
    expect(vfOf(build(row, 20))).toContain("crop=608:1080:640:0"); // rel 10 → 640
  });

  it("switches exactly at a boundary and clamps t before the In point", () => {
    expect(vfOf(build(row, 14))).toContain("crop=608:1080:1312:0"); // rel 4 → right
    expect(vfOf(build(row, 3))).toContain("crop=608:1080:0:0"); // rel clamps to 0 → left
  });
});

describe("coverFrameArgs — eased cropPath at t", () => {
  const cropPath = [
    { t: 0, x: 0 },
    { t: 3, x: 1312 },
  ];

  it("evaluates the smoothstep at the clip-relative time (precedence over crop_offset)", () => {
    // Pinned by the Rust mirror: cover_frame_args_eased_midpoint.
    expect(vfOf(build({ in_point: "10", crop_offset: "left" }, 11.5, { cropPath }))).toBe(
      "crop=608:1080:656:0,scale=1080:1920:flags=lanczos",
    );
  });

  it("holds the endpoints outside the path and rounds/clamps into the frame", () => {
    expect(vfOf(build({}, 0, { cropPath }))).toContain("crop=608:1080:0:0");
    expect(vfOf(build({}, 99, { cropPath }))).toContain("crop=608:1080:1312:0");
    // A path x beyond maxX clamps (1920-608=1312).
    expect(vfOf(build({}, 0, { cropPath: [{ t: 0, x: 9999 }] }))).toContain("crop=608:1080:1312:0");
    // Fractional eased x rounds to the nearest integer pixel.
    const frac = vfOf(build({}, 1, { cropPath }));
    const m = /crop=608:1080:(\d+):0/.exec(frac);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(Math.round(easedCropXAt(cropPath, 1)));
  });
});

describe("coverFrameArgs — punch-in cropWindow", () => {
  it("uses the even-rounded, clamped fixed window (same fixture as buildFfmpegArgs)", () => {
    // Pinned by the Rust mirror: cover_frame_args_punch_in_window.
    expect(vfOf(build({}, 2, { cropWindow: { x: 800, y: 120, w: 405, h: 720 } }))).toBe(
      "crop=404:720:800:120,scale=1080:1920:flags=lanczos",
    );
    // Clamping mirrors the render: x → 1920-404=1516, y → 0.
    expect(vfOf(build({}, 2, { cropWindow: { x: 9999, y: -50, w: 405, h: 720 } }))).toContain(
      "crop=404:720:1516:0",
    );
  });

  it("cropPath takes precedence over cropWindow (render parity)", () => {
    const a = build({}, 0, {
      cropWindow: { x: 0, y: 0, w: 405, h: 720 },
      cropPath: [{ t: 0, x: 100 }],
    });
    expect(vfOf(a)).toContain("crop=608:1080:100:0");
  });

  it("throws when the window exceeds the working region", () => {
    expect(() => build({}, 0, { cropWindow: { x: 0, y: 0, w: 405, h: 2000 } })).toThrow(
      /exceeds working region/,
    );
  });
});

describe("coverFrameArgs — content_crop working region", () => {
  it("pre-crops to the content region and resolves the offset inside it", () => {
    // Pinned by the Rust mirror: cover_frame_args_content_crop. 1440-wide region:
    // cw=608, maxX=832, center → even(floor(832/2))=416.
    expect(vfOf(build({ content_crop: "1440:1080:240:0", crop_offset: "center" }, 0))).toBe(
      "crop=1440:1080:240:0,crop=608:1080:416:0,scale=1080:1920:flags=lanczos",
    );
  });

  it("a punch-in window is clamped against the content region, not the frame", () => {
    const a = build({ content_crop: "1280:720:320:180" }, 0, {
      cropWindow: { x: 100, y: 0, w: 270, h: 480 },
    });
    expect(vfOf(a)).toBe("crop=1280:720:320:180,crop=270:480:100:0,scale=1080:1920:flags=lanczos");
  });
});

describe("coverOutName", () => {
  it("derives from out_name when set, stripping .mp4", () => {
    expect(coverOutName({ ...ROW, out_name: "chorus_closeup.mp4" })).toBe(
      "chorus_closeup_cover.png",
    );
    expect(coverOutName({ ...ROW, out_name: "chorus_closeup" })).toBe("chorus_closeup_cover.png");
  });

  it("falls back to the render's <stem>_<in>-<out> derivation", () => {
    expect(
      coverOutName({ source_file: "/media/My Show.mp4", in_point: "0:14.5", out_point: "0:29" }),
    ).toBe("My_Show_0_14.5-0_29_cover.png");
  });
});
