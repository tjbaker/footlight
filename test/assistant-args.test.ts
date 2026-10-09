// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { numArg, optStrArg, strArg } from "../src/assistant/args.js";

describe("assistant tool-arg validators", () => {
  it("numArg returns a finite number and rejects anything else", () => {
    expect(numArg({ t: 1.5 }, "t")).toBe(1.5);
    expect(() => numArg({ t: "1" }, "t")).toThrow(/tool arg "t" must be a finite number/);
    expect(() => numArg({ t: Infinity }, "t")).toThrow(/finite number/);
    expect(() => numArg({}, "t")).toThrow(/finite number/);
  });

  it("strArg returns a non-empty string and rejects anything else", () => {
    expect(strArg({ s: "x" }, "s")).toBe("x");
    expect(() => strArg({ s: "" }, "s")).toThrow(/tool arg "s" must be a non-empty string/);
    expect(() => strArg({ s: 3 }, "s")).toThrow(/non-empty string/);
  });

  it("optStrArg returns undefined for a missing, empty, or non-string arg", () => {
    expect(optStrArg({ s: "x" }, "s")).toBe("x");
    expect(optStrArg({ s: "" }, "s")).toBeUndefined();
    expect(optStrArg({ s: 3 }, "s")).toBeUndefined();
    expect(optStrArg({}, "s")).toBeUndefined();
  });
});
