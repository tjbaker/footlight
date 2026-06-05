// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { parseCsv } from "../src/csv.js";

describe("parseCsv", () => {
  it("parses a basic manifest", () => {
    const text = [
      "source_file,in_point,out_point,crop_offset",
      "a.mp4,0,10,center",
      "b.mp4,1:08,2:59,720",
    ].join("\n");
    const rows = parseCsv(text);
    expect(rows).toEqual([
      { source_file: "a.mp4", in_point: "0", out_point: "10", crop_offset: "center" },
      { source_file: "b.mp4", in_point: "1:08", out_point: "2:59", crop_offset: "720" },
    ]);
  });

  it("handles quoted fields with commas and a schedule", () => {
    const text =
      'source_file,in_point,out_point,crop_offset,notes\n' +
      'c.mp4,0,30,"0=center; 14.5=440","cuts to piano, then back"\n';
    const rows = parseCsv(text);
    expect(rows[0]!.crop_offset).toBe("0=center; 14.5=440");
    expect(rows[0]!.notes).toBe("cuts to piano, then back");
  });

  it("handles escaped quotes and CRLF", () => {
    const text =
      'source_file,out_name\r\n' +
      'd.mp4,"say ""hi"""\r\n';
    const rows = parseCsv(text);
    expect(rows[0]!.out_name).toBe('say "hi"');
  });

  it("skips blank trailing lines and returns [] for header-only", () => {
    expect(parseCsv("source_file,in_point\n\n")).toEqual([]);
    expect(parseCsv("source_file,in_point")).toEqual([]);
  });

  it("fills missing trailing fields with empty strings", () => {
    const text = "source_file,in_point,out_point,crop_offset\na.mp4,0,10";
    const rows = parseCsv(text);
    expect(rows[0]).toEqual({
      source_file: "a.mp4",
      in_point: "0",
      out_point: "10",
      crop_offset: "",
    });
  });
});
