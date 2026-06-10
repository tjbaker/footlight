// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the editor's persisted preferences (editor-prefs.ts): the
 * assistant-model selection, the render-options assembly from Settings, and the
 * outdir / preview / recents / theme round-trips. Two properties matter most and
 * are pinned here: every read falls back to a sane default on missing keys,
 * garbage JSON, or a THROWING localStorage (private mode), and every write is
 * non-fatal. localStorage is a Map-backed shim (no jsdom needed).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  assistantSelection,
  renderOptions,
  loadOutdir,
  saveOutdir,
  loadPreviewPref,
  savePreviewPref,
  loadSnapPref,
  saveSnapPref,
  loadRecents,
  pushRecent,
  saveTheme,
} from "../src/editor-prefs.js";

// --- localStorage: Map-backed shim (same pattern as the jsdom editor tests) ---
const store = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string): void => {
    store.set(k, String(v));
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
  clear: (): void => {
    store.clear();
  },
  key: (i: number): string | null => [...store.keys()][i] ?? null,
  get length(): number {
    return store.size;
  },
};
(globalThis as unknown as { localStorage: typeof localStorageMock }).localStorage =
  localStorageMock;

/** Run `fn` with a localStorage whose every method throws (private mode etc.). */
function withBrokenStorage(fn: () => void): void {
  const broken = new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error("storage unavailable");
        };
      },
    },
  );
  const g = globalThis as unknown as { localStorage: unknown };
  const prev = g.localStorage;
  g.localStorage = broken;
  try {
    fn();
  } finally {
    g.localStorage = prev;
  }
}

beforeEach(() => {
  store.clear();
});

describe("assistantSelection (footlight.ai)", () => {
  it("defaults to Gemini 3.5 Flash when nothing is stored", () => {
    expect(assistantSelection()).toEqual({
      assistantModel: { provider: "gemini", model: "gemini-3.5-flash" },
    });
  });

  it("returns the persisted provider/model pair", () => {
    store.set("footlight.ai", JSON.stringify({ provider: "openai", model: "gpt-x" }));
    expect(assistantSelection().assistantModel).toEqual({ provider: "openai", model: "gpt-x" });
  });

  it("falls back on garbage JSON or wrong field types", () => {
    store.set("footlight.ai", "{nope");
    expect(assistantSelection().assistantModel.provider).toBe("gemini");
    store.set("footlight.ai", JSON.stringify({ provider: 7, model: "x" }));
    expect(assistantSelection().assistantModel.model).toBe("gemini-3.5-flash");
  });

  it("survives an unavailable localStorage", () => {
    withBrokenStorage(() => {
      expect(assistantSelection().assistantModel.provider).toBe("gemini");
    });
  });
});

describe("renderOptions (footlight.render → RenderOptions)", () => {
  it("nothing stored → just the outdir (engine defaults apply downstream)", () => {
    expect(renderOptions("/tmp/out")).toEqual({ outdir: "/tmp/out" });
  });

  it("maps a full Settings blob", () => {
    store.set(
      "footlight.render",
      JSON.stringify({
        crf: 19,
        preset: "slow",
        audio: "reencode",
        bitrate: "256k",
        dryRun: true,
        burnCaptions: true,
      }),
    );
    expect(renderOptions("clips")).toEqual({
      outdir: "clips",
      crf: 19,
      preset: "slow",
      audioBitrate: "256k",
      dryRun: true,
      burnCaptions: true,
    });
  });

  it('only re-encodes audio when audio === "reencode" AND a bitrate string is set', () => {
    store.set("footlight.render", JSON.stringify({ audio: "copy", bitrate: "256k" }));
    expect(renderOptions("o").audioBitrate).toBeUndefined();
    store.set("footlight.render", JSON.stringify({ audio: "reencode" }));
    expect(renderOptions("o").audioBitrate).toBeUndefined();
  });

  it("ignores wrongly-typed fields and non-true booleans", () => {
    store.set(
      "footlight.render",
      JSON.stringify({ crf: "19", preset: 4, dryRun: "yes", burnCaptions: false }),
    );
    expect(renderOptions("o")).toEqual({ outdir: "o" });
  });

  it("garbage JSON → engine defaults", () => {
    store.set("footlight.render", "{nope");
    expect(renderOptions("o")).toEqual({ outdir: "o" });
  });
});

describe("outdir round-trip (footlight.outdir)", () => {
  it('returns "" when never chosen (caller seeds the platform default — issue #58)', () => {
    expect(loadOutdir()).toBe("");
  });

  it("saves a trimmed value and loads it back", () => {
    saveOutdir("  /Users/t/Movies/clips  ");
    expect(store.get("footlight.outdir")).toBe("/Users/t/Movies/clips");
    expect(loadOutdir()).toBe("/Users/t/Movies/clips");
  });

  it("does not persist a blank value", () => {
    saveOutdir("   ");
    expect(store.has("footlight.outdir")).toBe(false);
  });

  it("is fail-soft when storage is unavailable", () => {
    withBrokenStorage(() => {
      expect(loadOutdir()).toBe("");
      expect(() => saveOutdir("x")).not.toThrow();
    });
  });
});

describe("preview pref round-trip (footlight.preview)", () => {
  it("defaults ON; only an explicit \"off\" disables it", () => {
    expect(loadPreviewPref()).toBe(true);
    store.set("footlight.preview", "off");
    expect(loadPreviewPref()).toBe(false);
    store.set("footlight.preview", "anything-else");
    expect(loadPreviewPref()).toBe(true);
  });

  it("round-trips through save", () => {
    savePreviewPref(false);
    expect(loadPreviewPref()).toBe(false);
    savePreviewPref(true);
    expect(loadPreviewPref()).toBe(true);
  });

  it("defaults ON when storage is unavailable", () => {
    withBrokenStorage(() => {
      expect(loadPreviewPref()).toBe(true);
      expect(() => savePreviewPref(false)).not.toThrow();
    });
  });
});

describe("onset-snap pref round-trip (footlight.snap)", () => {
  it("defaults OFF (snapping is opt-in); only an explicit \"on\" enables it", () => {
    expect(loadSnapPref()).toBe(false);
    store.set("footlight.snap", "on");
    expect(loadSnapPref()).toBe(true);
    store.set("footlight.snap", "anything-else");
    expect(loadSnapPref()).toBe(false);
  });

  it("round-trips through save", () => {
    saveSnapPref(true);
    expect(loadSnapPref()).toBe(true);
    saveSnapPref(false);
    expect(loadSnapPref()).toBe(false);
  });

  it("defaults OFF when storage is unavailable", () => {
    withBrokenStorage(() => {
      expect(loadSnapPref()).toBe(false);
      expect(() => saveSnapPref(true)).not.toThrow();
    });
  });
});

describe("recents (footlight.recents, most-recent-first, cap 10)", () => {
  it("defaults to [] and filters non-string entries", () => {
    expect(loadRecents()).toEqual([]);
    store.set("footlight.recents", JSON.stringify(["a.mp4", 7, null, "b.mp4"]));
    expect(loadRecents()).toEqual(["a.mp4", "b.mp4"]);
    store.set("footlight.recents", JSON.stringify({ not: "an array" }));
    expect(loadRecents()).toEqual([]);
  });

  it("pushRecent puts the path first and dedupes an existing entry", () => {
    pushRecent("a.mp4");
    pushRecent("b.mp4");
    pushRecent("a.mp4");
    expect(loadRecents()).toEqual(["a.mp4", "b.mp4"]);
  });

  it("ignores blank paths and trims real ones", () => {
    pushRecent("   ");
    expect(loadRecents()).toEqual([]);
    pushRecent("  c.mp4  ");
    expect(loadRecents()).toEqual(["c.mp4"]);
  });

  it("caps the list at 10", () => {
    for (let i = 0; i < 15; i++) pushRecent(`clip-${i}.mp4`);
    const recents = loadRecents();
    expect(recents).toHaveLength(10);
    expect(recents[0]).toBe("clip-14.mp4");
    expect(recents[9]).toBe("clip-5.mp4");
  });
});

describe("saveTheme (footlight.theme)", () => {
  it("persists the quick light/dark override", () => {
    saveTheme("dark");
    expect(store.get("footlight.theme")).toBe("dark");
    saveTheme("light");
    expect(store.get("footlight.theme")).toBe("light");
  });

  it("is non-fatal when storage is unavailable", () => {
    withBrokenStorage(() => {
      expect(() => saveTheme("dark")).not.toThrow();
    });
  });
});
