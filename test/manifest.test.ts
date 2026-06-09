// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  cropBoxToOffset,
  cropBoxToWindow,
  isFullHeightWindow,
  contentCropFromBox,
  scheduleToString,
  serializeManifestCSV,
  serializeManifestJSON,
  type Box,
  type Dims,
  type ClipRow,
  type ClipSpec,
} from "../src/manifest.js";
import { computeCrop } from "../src/engine.js";
import { parseCsv } from "../src/csv.js";

const box = (x: number, y = 0, w = 0, h = 0): Box => ({ x, y, w, h });

describe("cropBoxToOffset", () => {
  const fhd: Dims = { width: 1920, height: 1080 };
  // crop width = even(round(1080*9/16)) = 608, maxX = 1312, center = 656.

  it("snaps to named offsets on a 1920x1080 region", () => {
    expect(cropBoxToOffset(box(656), fhd)).toBe("center");
    expect(cropBoxToOffset(box(0), fhd)).toBe("left");
    expect(cropBoxToOffset(box(1312), fhd)).toBe("right");
  });

  it("returns a numeric offset between presets", () => {
    expect(cropBoxToOffset(box(720), fhd)).toBe("720");
  });

  it("snaps within the +-2px tolerance", () => {
    expect(cropBoxToOffset(box(655), fhd)).toBe("center"); // even-rounds to 654, |654-656|=2
    expect(cropBoxToOffset(box(2), fhd)).toBe("left");
    expect(cropBoxToOffset(box(1311), fhd)).toBe("right"); // even-rounds to 1310, |1310-1312|=2
  });

  it("clamps out-of-frame boxes back into the named edges", () => {
    expect(cropBoxToOffset(box(-50), fhd)).toBe("left");
    expect(cropBoxToOffset(box(99999), fhd)).toBe("right");
  });

  it("handles a letterboxed content region 1800x1010", () => {
    const region: Dims = { width: 1800, height: 1010 };
    // crop width = even(round(1010*9/16)) = 568, maxX = 1232, center = 616.
    expect(cropBoxToOffset(box(616), region)).toBe("center");
    expect(cropBoxToOffset(box(440), region)).toBe("440");
  });

  it("round-trips: box -> offset -> computeCrop recovers the same x", () => {
    const cases: Array<[Dims, number]> = [
      [fhd, 656],
      [fhd, 720],
      [fhd, 0],
      [fhd, 1312],
      [{ width: 1800, height: 1010 }, 616],
      [{ width: 1800, height: 1010 }, 440],
    ];
    for (const [region, x] of cases) {
      const offset = cropBoxToOffset(box(x), region);
      const crop = computeCrop(region.width, region.height, offset);
      expect(crop.x).toBe(x);
    }
  });
});

describe("contentCropFromBox", () => {
  it("emits W:H:X:Y with even-rounded ints", () => {
    expect(contentCropFromBox({ x: 60, y: 34, w: 1800, h: 1010 })).toBe("1800:1010:60:34");
  });

  it("rounds odd values down to even", () => {
    expect(contentCropFromBox({ x: 61, y: 35, w: 1801, h: 1011 })).toBe("1800:1010:60:34");
  });
});

describe("scheduleToString", () => {
  it("formats a multi-keyframe schedule, trimming trailing zeros", () => {
    expect(
      scheduleToString([
        { t: 0, offset: "center" },
        { t: 14.5, offset: "440" },
      ]),
    ).toBe("0=center; 14.5=440");
  });

  it("sorts keyframes by time", () => {
    expect(
      scheduleToString([
        { t: 21, offset: "440" },
        { t: 0, offset: "center" },
      ]),
    ).toBe("0=center; 21=440");
  });

  it("collapses a single t=0 keyframe to its bare offset", () => {
    expect(scheduleToString([{ t: 0, offset: "center" }])).toBe("center");
  });

  it("keeps a single non-zero keyframe as a t=offset pair", () => {
    expect(scheduleToString([{ t: 5, offset: "720" }])).toBe("5=720");
  });
});

describe("serializeManifestCSV", () => {
  it("writes the canonical header and round-trips through parseCsv", () => {
    const rows: ClipRow[] = [
      {
        source_file: "downloads/live-set.mp4",
        in_point: "0",
        out_point: "30",
        crop_offset: "center",
      },
      {
        source_file: "downloads/edited-mv.mp4",
        in_point: "0:05",
        out_point: "0:35",
        crop_offset: "0=center; 14.5=440",
        content_crop: "1800:1010:60:34",
        out_name: "edited_clip.mp4",
        notes: "cuts to piano, then back",
      },
    ];

    const csv = serializeManifestCSV(rows);
    expect(csv.split("\n")[0]).toBe(
      "source_file,in_point,out_point,crop_offset,content_crop,out_name,hook,title,text_position,notes",
    );

    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(2);

    // First row: empty optional fields are empty cells.
    expect(parsed[0]).toEqual({
      source_file: "downloads/live-set.mp4",
      in_point: "0",
      out_point: "30",
      crop_offset: "center",
      content_crop: "",
      out_name: "",
      hook: "",
      title: "",
      text_position: "",
      notes: "",
    });

    // Second row: content_crop, schedule, and a comma-bearing notes field.
    expect(parsed[1]!.content_crop).toBe("1800:1010:60:34");
    expect(parsed[1]!.crop_offset).toBe("0=center; 14.5=440");
    expect(parsed[1]!.notes).toBe("cuts to piano, then back");
  });

  it("round-trips caption columns (hook / title / text_position)", () => {
    const rows: ClipRow[] = [
      {
        source_file: "a.mp4",
        in_point: "0",
        out_point: "10",
        crop_offset: "center",
        hook: "Watch this\nright now",
        title: "the solo",
        text_position: "top",
      },
    ];
    const parsed = parseCsv(serializeManifestCSV(rows));
    expect(parsed[0]!.hook).toBe("Watch this\nright now");
    expect(parsed[0]!.title).toBe("the solo");
    expect(parsed[0]!.text_position).toBe("top");
  });

  it("quotes fields containing quotes and newlines", () => {
    const rows: ClipRow[] = [
      {
        source_file: "a.mp4",
        in_point: "0",
        out_point: "10",
        crop_offset: "center",
        notes: 'say "hi"\nline2',
      },
    ];
    const parsed = parseCsv(serializeManifestCSV(rows));
    expect(parsed[0]!.notes).toBe('say "hi"\nline2');
  });
});

describe("cropBoxToWindow", () => {
  const region: Dims = { width: 1920, height: 1080 };

  it("locks the window to 9:16 by deriving width from height", () => {
    // A loosely-drawn box; width is re-derived as even(h*9/16), not taken as-is.
    const win = cropBoxToWindow({ x: 800, y: 100, w: 999, h: 720 }, region);
    expect(win).toEqual({ x: 800, y: 100, w: 404, h: 720 });
    // 9:16 within even-rounding tolerance.
    expect(Math.abs(win.w / win.h - 9 / 16)).toBeLessThan(0.01);
  });

  it("clamps the window into the region", () => {
    const win = cropBoxToWindow({ x: 5000, y: -20, w: 0, h: 720 }, region);
    expect(win.w).toBe(404);
    expect(win.h).toBe(720);
    expect(win.x).toBe(1516); // 1920 - 404
    expect(win.y).toBe(0);
  });

  it("caps height so the derived width fits a narrow region", () => {
    const narrow: Dims = { width: 360, height: 1080 };
    const win = cropBoxToWindow({ x: 0, y: 0, w: 0, h: 1080 }, narrow);
    expect(win.w).toBe(360);
    expect(win.h).toBe(640); // even(360 / (9/16))
  });
});

describe("isFullHeightWindow", () => {
  const region: Dims = { width: 1920, height: 1080 };
  it("is true at (near) full height, false when zoomed in", () => {
    expect(isFullHeightWindow({ x: 0, y: 0, w: 608, h: 1080 }, region)).toBe(true);
    expect(isFullHeightWindow({ x: 0, y: 0, w: 608, h: 1079 }, region)).toBe(true);
    expect(isFullHeightWindow({ x: 0, y: 0, w: 405, h: 720 }, region)).toBe(false);
  });
});

describe("serializeManifestJSON", () => {
  it("round-trips an array of clip specs incl. cropPath and cropWindow", () => {
    const clips: ClipSpec[] = [
      {
        source_file: "downloads/live-set.mp4",
        in_point: "0",
        out_point: "30",
        crop_offset: "center",
      },
      {
        source_file: "downloads/edited-mv.mp4",
        in_point: "0:05",
        out_point: "0:35",
        content_crop: "1800:1010:60:34",
        out_name: "edited_clip.mp4",
        notes: "tracked pan to the piano",
        cropPath: [
          { t: 0, x: 616 },
          { t: 14.5, x: 440 },
          { t: 30, x: 900 },
        ],
      },
      {
        source_file: "downloads/session.mp4",
        in_point: "20",
        out_point: "50",
        crop_offset: "center",
        cropWindow: { x: 800, y: 120, w: 404, h: 720 },
      },
    ];
    expect(JSON.parse(serializeManifestJSON(clips))).toEqual(clips);
  });

  it("round-trips per-clip caption styling on a clip spec", () => {
    const clips: ClipSpec[] = [
      {
        source_file: "downloads/live-set.mp4",
        in_point: "0",
        out_point: "30",
        crop_offset: "center",
        hook: "BIG HOOK",
        title: "the title line",
        text_position: "top-left",
        caption: {
          font: "/Users/me/fonts/Impact.ttf",
          color: "#FFCC00",
          outlineColor: "#000000",
          bold: true,
          italic: false,
          underline: true,
          shadow: true,
          box: true,
          boxColor: "#202020",
          angle: 12,
        },
      },
    ];
    expect(JSON.parse(serializeManifestJSON(clips))).toEqual(clips);
  });
});
