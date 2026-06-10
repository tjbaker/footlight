// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  parseTimestamp,
  parseContentCrop,
  parseCropSchedule,
  parseFadeSeconds,
  even,
  roundEven,
  computeCrop,
  safeName,
  buildFfmpegArgs,
  FADE_AUDIO_BITRATE,
  type ClipRow,
  type BuildOptions,
} from "../src/engine.js";

const DEFAULTS = { crf: 19, preset: "medium", audioBitrate: "copy", outdir: "clips" };

function build(row: ClipRow, dims: [number, number], overrides: Partial<BuildOptions> = {}) {
  return buildFfmpegArgs(row, { ...DEFAULTS, dims, ...overrides });
}

/** Pull the value following `-vf` out of an ffmpeg arg array. */
function vfOf(args: string[]): string {
  const i = args.indexOf("-vf");
  return args[i + 1]!;
}

/** Pull the audio codec args (`-c:a ...`) out of an ffmpeg arg array. */
function audioOf(args: string[]): string[] {
  const i = args.indexOf("-c:a");
  // copy => 2 tokens; aac + bitrate => 4 tokens
  return args[i + 1] === "copy" ? args.slice(i, i + 2) : args.slice(i, i + 4);
}

describe("parseTimestamp", () => {
  it("parses HH:MM:SS, MM:SS, and seconds", () => {
    expect(parseTimestamp("1:08")).toBe(68);
    expect(parseTimestamp("2:59")).toBe(179);
    expect(parseTimestamp("01:02:03")).toBe(3723);
    expect(parseTimestamp("90")).toBe(90);
    expect(parseTimestamp("14.5")).toBe(14.5);
  });
  it("throws on empty / malformed", () => {
    expect(() => parseTimestamp("")).toThrow();
    expect(() => parseTimestamp("1:2:3:4")).toThrow();
    expect(() => parseTimestamp("abc")).toThrow();
  });
});

describe("parseContentCrop", () => {
  it("parses W:H:X:Y and empty->null", () => {
    expect(parseContentCrop("1800:1010:60:34")).toEqual([1800, 1010, 60, 34]);
    expect(parseContentCrop("")).toBeNull();
    expect(parseContentCrop(undefined)).toBeNull();
  });
  it("throws on wrong arity", () => {
    expect(() => parseContentCrop("1:2:3")).toThrow();
  });
  it("throws on negative offsets and non-positive dimensions", () => {
    expect(() => parseContentCrop("1800:1010:-10:34")).toThrow(/non-negative/);
    expect(() => parseContentCrop("1800:1010:60:-1")).toThrow(/non-negative/);
    expect(() => parseContentCrop("0:1010:60:34")).toThrow(/positive/);
    expect(() => parseContentCrop("-1800:1010:60:34")).toThrow(/positive/);
    expect(() => parseContentCrop("1800:0:60:34")).toThrow(/positive/);
  });
});

describe("even / roundEven", () => {
  it("even truncates down to even", () => {
    expect(even(608)).toBe(608);
    expect(even(607)).toBe(606);
  });
  it("roundEven rounds to nearest, then down to even", () => {
    expect(roundEven(608)).toBe(608);
    expect(roundEven(607.9)).toBe(608);
    expect(roundEven(607.4)).toBe(606);
    expect(roundEven(607)).toBe(606);
  });
});

describe("parseCropSchedule", () => {
  it("treats a plain value as a single t=0 segment", () => {
    expect(parseCropSchedule("center")).toEqual([[0, "center"]]);
    expect(parseCropSchedule("720")).toEqual([[0, "720"]]);
    expect(parseCropSchedule("")).toEqual([[0, "center"]]);
    expect(parseCropSchedule(undefined)).toEqual([[0, "center"]]);
  });
  it("parses and sorts a schedule", () => {
    expect(parseCropSchedule("0=center; 14.5=440")).toEqual([
      [0, "center"],
      [14.5, "440"],
    ]);
    expect(parseCropSchedule("21=440; 0=center")).toEqual([
      [0, "center"],
      [21, "440"],
    ]);
  });
});

describe("even", () => {
  it("rounds down to nearest even", () => {
    expect(even(1080)).toBe(1080);
    expect(even(1081)).toBe(1080);
    expect(even(7)).toBe(6);
    expect(even(0)).toBe(0);
  });
});

describe("computeCrop", () => {
  it("landscape 1920x1080 center", () => {
    expect(computeCrop(1920, 1080, "center")).toEqual({ cw: 608, ch: 1080, x: 656, y: 0 });
  });
  it("landscape 1920x1080 left/right/numeric", () => {
    expect(computeCrop(1920, 1080, "left").x).toBe(0);
    expect(computeCrop(1920, 1080, "right").x).toBe(1312); // 1920-608
    expect(computeCrop(1920, 1080, "720").x).toBe(720);
  });
  it("clamps numeric x into frame", () => {
    expect(computeCrop(1920, 1080, "5000").x).toBe(1312);
    expect(computeCrop(1920, 1080, "-50").x).toBe(0);
  });
  it("content region 1800x1010 center", () => {
    const c = computeCrop(1800, 1010, "center");
    expect(c.cw).toBe(568);
    expect(c.ch).toBe(1010);
    expect(c.x).toBe(616);
    expect(c.y).toBe(0);
  });
  it("taller-than-9:16 source crops height, full width", () => {
    const c = computeCrop(1080, 1920, "center");
    expect(c).toEqual({ cw: 1080, ch: 1920, x: 0, y: 0 });
  });
});

describe("safeName", () => {
  it("replaces runs and strips edges", () => {
    expect(safeName("My Clip!! v2")).toBe("My_Clip_v2");
    expect(safeName("__a..b__")).toBe("a..b");
  });
});

describe("buildFfmpegArgs golden cases", () => {
  it("1. landscape center, default audio", () => {
    const { args } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "10", crop_offset: "center" },
      [1920, 1080],
    );
    expect(vfOf(args)).toBe(
      "crop=608:1080:656:0,scale=1080:1920:flags=lanczos,setsar=1",
    );
    expect(audioOf(args)).toEqual(["-c:a", "copy"]);
  });

  it("2. landscape numeric 720", () => {
    const { args } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "10", crop_offset: "720" },
      [1920, 1080],
    );
    expect(vfOf(args)).toBe(
      "crop=608:1080:720:0,scale=1080:1920:flags=lanczos,setsar=1",
    );
  });

  it("3. letterboxed edit: content_crop + schedule", () => {
    const { args } = build(
      {
        source_file: "edited-mv.mp4",
        in_point: "0",
        out_point: "30",
        crop_offset: "0=center; 14.5=440",
        content_crop: "1800:1010:60:34",
      },
      [1, 1], // dims irrelevant; content_crop overrides working region
    );
    expect(vfOf(args)).toBe(
      "crop=1800:1010:60:34,crop=568:1010:x='if(lt(t,14.500),616,440)':y=0,scale=1080:1920:flags=lanczos,setsar=1",
    );
  });

  it("cropWindow (zoom/punch-in) overrides crop_offset with a fixed crop=w:h:x:y", () => {
    const { args } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "10", crop_offset: "center" },
      [1920, 1080],
      { cropWindow: { x: 800, y: 120, w: 405, h: 720 } },
    );
    expect(vfOf(args)).toBe(
      "crop=404:720:800:120,scale=1080:1920:flags=lanczos,setsar=1",
    );
  });

  it("cropWindow even-rounds and clamps x/y into the working region", () => {
    const { args } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "10" },
      [1920, 1080],
      { cropWindow: { x: 9999, y: -50, w: 405, h: 720 } },
    );
    // w even-rounds 405->404; x clamps to 1920-404=1516; y clamps to 0.
    expect(vfOf(args)).toBe(
      "crop=404:720:1516:0,scale=1080:1920:flags=lanczos,setsar=1",
    );
  });

  it("cropWindow is relative to the content_crop working region", () => {
    const { args } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "10", content_crop: "1280:720:320:180" },
      [1920, 1080],
      { cropWindow: { x: 100, y: 0, w: 270, h: 480 } },
    );
    expect(vfOf(args)).toBe(
      "crop=1280:720:320:180,crop=270:480:100:0,scale=1080:1920:flags=lanczos,setsar=1",
    );
  });

  it("cropWindow exceeding the working region throws", () => {
    expect(() =>
      build(
        { source_file: "in.mp4", in_point: "0", out_point: "10" },
        [1920, 1080],
        { cropWindow: { x: 0, y: 0, w: 405, h: 2000 } },
      ),
    ).toThrow(/exceeds working region/);
  });

  it("cropPath takes precedence over cropWindow", () => {
    const { args } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "10" },
      [1920, 1080],
      { cropWindow: { x: 0, y: 0, w: 405, h: 720 }, cropPath: [{ t: 0, x: 100 }] },
    );
    // Eased x expression (full-height crop), not the fixed window.
    expect(vfOf(args)).toContain("crop=608:1080:x='100':y=0");
  });

  it("audio re-encode when bitrate given", () => {
    const { args } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "10", crop_offset: "center" },
      [1920, 1080],
      { audioBitrate: "256k" },
    );
    expect(audioOf(args)).toEqual(["-c:a", "aac", "-b:a", "256k"]);
  });

  it("auto-generates out_name from stem + timestamps", () => {
    const { outPath } = build(
      { source_file: "downloads/My Show.mkv", in_point: "1:08", out_point: "2:59", crop_offset: "center" },
      [1920, 1080],
    );
    expect(outPath).toBe("clips/My_Show_1_08-2_59.mp4");
  });

  it("respects explicit out_name and appends .mp4", () => {
    const { outPath } = build(
      { source_file: "in.mp4", in_point: "0", out_point: "10", crop_offset: "center", out_name: "my_clip" },
      [1920, 1080],
    );
    expect(outPath).toBe("clips/my_clip.mp4");
  });

  it("emits correct -ss/-t and codec args", () => {
    const { args } = build(
      { source_file: "in.mp4", in_point: "10", out_point: "25.5", crop_offset: "center" },
      [1920, 1080],
    );
    expect(args[args.indexOf("-ss") + 1]).toBe("10.000");
    expect(args[args.indexOf("-t") + 1]).toBe("15.500");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args[args.indexOf("-crf") + 1]).toBe("19");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(args.slice(-3)).toEqual(["-movflags", "+faststart", "clips/in_10-25.5.mp4"]);
  });

  it("throws when out_point not after in_point", () => {
    expect(() =>
      build({ source_file: "in.mp4", in_point: "10", out_point: "10", crop_offset: "center" }, [1920, 1080]),
    ).toThrow();
  });
});

describe("parseFadeSeconds", () => {
  it("empty/absent means no fade", () => {
    expect(parseFadeSeconds(undefined, "fade_in")).toBe(0);
    expect(parseFadeSeconds(null, "fade_in")).toBe(0);
    expect(parseFadeSeconds("", "fade_in")).toBe(0);
    expect(parseFadeSeconds("  ", "fade_in")).toBe(0);
  });
  it("parses plain non-negative seconds", () => {
    expect(parseFadeSeconds("0", "fade_in")).toBe(0);
    expect(parseFadeSeconds("0.5", "fade_in")).toBe(0.5);
    expect(parseFadeSeconds(" 2 ", "fade_out")).toBe(2);
  });
  it("rejects negative, non-numeric, and non-finite values with the field name", () => {
    expect(() => parseFadeSeconds("-1", "fade_in")).toThrow(/fade_in.*non-negative/);
    expect(() => parseFadeSeconds("abc", "fade_out")).toThrow(/fade_out.*non-negative/);
    expect(() => parseFadeSeconds("Infinity", "fade_in")).toThrow(/non-negative/);
  });
});

describe("buildFfmpegArgs fades (issue #165)", () => {
  const ROW: ClipRow = { source_file: "in.mp4", in_point: "0", out_point: "10", crop_offset: "center" };

  /** Pull the value following `-af` out of an ffmpeg arg array (or null). */
  function afOf(args: string[]): string | null {
    const i = args.indexOf("-af");
    return i === -1 ? null : args[i + 1]!;
  }

  it("appends fade in+out video filters LAST and matching afades", () => {
    const { args } = build({ ...ROW, fade_in: "0.5", fade_out: "1" }, [1920, 1080]);
    expect(vfOf(args)).toBe(
      "crop=608:1080:656:0,scale=1080:1920:flags=lanczos,setsar=1," +
        "fade=t=in:st=0:d=0.500,fade=t=out:st=9.000:d=1.000",
    );
    expect(afOf(args)).toBe("afade=t=in:st=0:d=0.500,afade=t=out:st=9.000:d=1.000");
  });

  it("fade-in only / fade-out only emit just their filter", () => {
    const inOnly = build({ ...ROW, fade_in: "0.25" }, [1920, 1080]);
    expect(vfOf(inOnly.args)).toContain("fade=t=in:st=0:d=0.250");
    expect(vfOf(inOnly.args)).not.toContain("fade=t=out");
    expect(afOf(inOnly.args)).toBe("afade=t=in:st=0:d=0.250");

    const outOnly = build({ ...ROW, fade_out: "2" }, [1920, 1080]);
    expect(vfOf(outOnly.args)).toContain("fade=t=out:st=8.000:d=2.000");
    expect(vfOf(outOnly.args)).not.toContain("fade=t=in");
    expect(afOf(outOnly.args)).toBe("afade=t=out:st=8.000:d=2.000");
  });

  it("THE AUDIO RULE: a fade + audioBitrate 'copy' forces an AAC re-encode and flags it", () => {
    const built = build({ ...ROW, fade_in: "0.5" }, [1920, 1080]); // DEFAULTS has "copy"
    expect(audioOf(built.args)).toEqual(["-c:a", "aac", "-b:a", FADE_AUDIO_BITRATE]);
    expect(built.forcedAudioReencode).toBe(true);
  });

  it("an explicit audio bitrate is respected (no forcing) when fading", () => {
    const built = build({ ...ROW, fade_out: "1" }, [1920, 1080], { audioBitrate: "192k" });
    expect(audioOf(built.args)).toEqual(["-c:a", "aac", "-b:a", "192k"]);
    expect(built.forcedAudioReencode).toBe(false);
  });

  it("no fades: audio stays a lossless copy with no -af, and no forced flag", () => {
    const built = build(ROW, [1920, 1080]);
    expect(audioOf(built.args)).toEqual(["-c:a", "copy"]);
    expect(afOf(built.args)).toBeNull();
    expect(built.forcedAudioReencode).toBe(false);
    expect(vfOf(built.args)).not.toContain("fade");
  });

  it("zero-length fades are no-ops (no filters, no forced re-encode)", () => {
    const built = build({ ...ROW, fade_in: "0", fade_out: "0" }, [1920, 1080]);
    expect(vfOf(built.args)).not.toContain("fade");
    expect(afOf(built.args)).toBeNull();
    expect(audioOf(built.args)).toEqual(["-c:a", "copy"]);
    expect(built.forcedAudioReencode).toBe(false);
  });

  it("fades render AFTER burned captions so the captions fade with the video", () => {
    const { args } = build({ ...ROW, fade_out: "1" }, [1920, 1080], {
      captionAssPath: "/tmp/cap.ass",
    });
    const vf = vfOf(args);
    const subIdx = vf.indexOf("subtitles=");
    const fadeIdx = vf.indexOf("fade=t=out");
    expect(subIdx).toBeGreaterThan(-1);
    expect(fadeIdx).toBeGreaterThan(subIdx);
  });

  it("errors early when the fades are longer than the clip", () => {
    expect(() => build({ ...ROW, fade_in: "6", fade_out: "5" }, [1920, 1080])).toThrow(
      /longer than the clip/,
    );
    expect(() => build({ ...ROW, fade_in: "11" }, [1920, 1080])).toThrow(/longer than the clip/);
  });

  it("errors early on malformed fade values", () => {
    expect(() => build({ ...ROW, fade_in: "-0.5" }, [1920, 1080])).toThrow(/fade_in/);
    expect(() => build({ ...ROW, fade_out: "fast" }, [1920, 1080])).toThrow(/fade_out/);
  });
});
