// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * i18n catalog invariants. TypeScript guarantees every locale has the full key
 * set (`en: Messages`), but it can't catch empty values, blank strings, or
 * malformed structured data (shortcut groups, guide sections). These tests guard
 * the catalog so a migration into it — e.g. the editor/shortcuts namespaces —
 * can't silently ship an empty or half-filled string.
 */

import { describe, it, expect } from "vitest";
import { en } from "../src/i18n/en.js";
import { messages, locales } from "../src/i18n/index.js";

/** Walk every string leaf in the catalog, yielding `[dottedPath, value]`. */
function* leaves(node: unknown, path = ""): Generator<[string, string]> {
  if (typeof node === "string") {
    yield [path, node];
  } else if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* leaves(node[i], `${path}[${i}]`);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) yield* leaves(v, path ? `${path}.${k}` : k);
  }
}

describe("i18n catalog (en)", () => {
  it("exposes the expected top-level namespaces", () => {
    expect(Object.keys(en).sort()).toEqual(["editor", "help", "settings", "shortcuts"]);
  });

  it("resolves `messages` to the English catalog (node fallback)", () => {
    // No `navigator` in node, so index.ts falls back to `en`.
    expect(messages).toBe(en);
  });

  it("has no empty or whitespace-only string values", () => {
    const blanks: string[] = [];
    for (const [path, value] of leaves(en)) {
      if (value.trim() === "") blanks.push(path);
    }
    expect(blanks).toEqual([]);
  });

  it("has a populated catalog (sanity: many strings, none undefined)", () => {
    const all = [...leaves(en)];
    expect(all.length).toBeGreaterThan(200); // editor migration alone is ~200+
    expect(all.every(([, v]) => typeof v === "string")).toBe(true);
  });
});

describe("shortcuts catalog (single source for the overlay + Settings panel)", () => {
  it("every group has a title and at least one binding", () => {
    expect(en.shortcuts.groups.length).toBeGreaterThan(0);
    for (const g of en.shortcuts.groups) {
      expect(g.title.trim()).not.toBe("");
      expect(g.items.length).toBeGreaterThan(0);
    }
  });

  it("every binding has at least one key and a description", () => {
    for (const g of en.shortcuts.groups) {
      for (const b of g.items) {
        expect(b.keys.length).toBeGreaterThan(0);
        expect(b.keys.every((k) => k.trim() !== "")).toBe(true);
        expect(b.desc.trim()).not.toBe("");
      }
    }
  });
});

describe("help guide catalog", () => {
  it("every guide section has an id, title, and at least one block", () => {
    expect(en.help.sections.length).toBeGreaterThan(0);
    for (const s of en.help.sections) {
      expect(s.id.trim()).not.toBe("");
      expect(s.title.trim()).not.toBe("");
      expect(s.blocks.length).toBeGreaterThan(0);
    }
  });
});

describe("locale parity (every locale matches the en key set)", () => {
  /** The canonical set of leaf key-paths in the reference catalog. */
  const enPaths = [...leaves(en)].map(([p]) => p).sort();

  for (const [code, catalog] of Object.entries(locales)) {
    describe(`locale: ${code}`, () => {
      const paths = [...leaves(catalog)].map(([p]) => p).sort();

      it("has the exact same leaf key-paths as en (no missing/extra keys)", () => {
        expect(paths).toEqual(enPaths);
      });

      it("has no empty or whitespace-only string values", () => {
        const blanks: string[] = [];
        for (const [path, value] of leaves(catalog)) {
          if (value.trim() === "") blanks.push(path);
        }
        expect(blanks).toEqual([]);
      });
    });
  }
});
