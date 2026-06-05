// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { migrateApiKey } from "../src/secret-migration.js";

describe("migrateApiKey", () => {
  it("pulls a non-empty apiKey out and returns the rest as remainder", () => {
    const raw = JSON.stringify({
      apiKey: "sk-abc123",
      subjectHint: "the guitarist",
      mock: false,
      intervalSec: 0.75,
    });
    const out = migrateApiKey(raw);
    expect(out.apiKey).toBe("sk-abc123");
    expect(out.remainder).toEqual({
      subjectHint: "the guitarist",
      mock: false,
      intervalSec: 0.75,
    });
    // The key must NOT linger in the remainder.
    expect("apiKey" in out.remainder).toBe(false);
  });

  it("trims surrounding whitespace from the extracted key", () => {
    const out = migrateApiKey(JSON.stringify({ apiKey: "  key-with-spaces  " }));
    expect(out.apiKey).toBe("key-with-spaces");
  });

  it("treats a whitespace-only apiKey as no key but still strips it", () => {
    const out = migrateApiKey(JSON.stringify({ apiKey: "   ", subjectHint: "x" }));
    expect(out.apiKey).toBeNull();
    expect("apiKey" in out.remainder).toBe(false);
    expect(out.remainder).toEqual({ subjectHint: "x" });
  });

  it("treats an empty-string apiKey as no key", () => {
    const out = migrateApiKey(JSON.stringify({ apiKey: "", mock: true }));
    expect(out.apiKey).toBeNull();
    expect(out.remainder).toEqual({ mock: true });
  });

  it("treats a missing apiKey as no key and preserves the blob", () => {
    const out = migrateApiKey(JSON.stringify({ subjectHint: "x", intervalSec: 1 }));
    expect(out.apiKey).toBeNull();
    expect(out.remainder).toEqual({ subjectHint: "x", intervalSec: 1 });
  });

  it("treats a non-string apiKey (number) as no key but strips it", () => {
    const out = migrateApiKey(JSON.stringify({ apiKey: 42, mock: true }));
    expect(out.apiKey).toBeNull();
    expect("apiKey" in out.remainder).toBe(false);
    expect(out.remainder).toEqual({ mock: true });
  });

  it("is defensive against bad JSON", () => {
    expect(migrateApiKey("not json at all")).toEqual({ apiKey: null, remainder: {} });
    expect(migrateApiKey("{ broken")).toEqual({ apiKey: null, remainder: {} });
    expect(migrateApiKey("")).toEqual({ apiKey: null, remainder: {} });
  });

  it("is defensive against non-object JSON (array, primitive, null)", () => {
    expect(migrateApiKey("[1,2,3]")).toEqual({ apiKey: null, remainder: {} });
    expect(migrateApiKey('"just a string"')).toEqual({ apiKey: null, remainder: {} });
    expect(migrateApiKey("123")).toEqual({ apiKey: null, remainder: {} });
    expect(migrateApiKey("null")).toEqual({ apiKey: null, remainder: {} });
    expect(migrateApiKey("true")).toEqual({ apiKey: null, remainder: {} });
  });

  it("returns a remainder that is a fresh object (not the parsed input)", () => {
    const out = migrateApiKey(JSON.stringify({ apiKey: "k", a: 1 }));
    // Mutating the remainder must be safe and isolated.
    out.remainder.b = 2;
    expect(out.remainder).toEqual({ a: 1, b: 2 });
  });

  it("preserves unknown/extra fields in the remainder verbatim", () => {
    const out = migrateApiKey(
      JSON.stringify({ apiKey: "k", futureField: { nested: true }, count: 0 }),
    );
    expect(out.apiKey).toBe("k");
    expect(out.remainder).toEqual({ futureField: { nested: true }, count: 0 });
  });
});
