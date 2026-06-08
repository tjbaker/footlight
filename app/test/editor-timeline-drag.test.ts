// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION test for the editor's loudness-timeline pointer interactions — the
 * timeline track (`.fl-tl-track`) is the app's single scrubber AND trimmer, so a
 * pointer drag across it sets the In→Out region, a plain click seeks the playhead,
 * and a drag that starts on an In/Out edge moves that marker. None of that math is
 * pure (it reads `getBoundingClientRect()` + `clientX`), so this mounts the whole
 * editor into jsdom and drives real PointerEvents through the track's handlers.
 *
 * It reuses the mount + source-load harness (and every jsdom stub + the wholesale
 * `platform` vi.mock) from editor-load.test.ts — see that file for why each stub
 * exists. The source loads as a real-ish 1920×1080 / 30s clip so `state.duration`
 * is 30 and the time↔pixel mapping is exercised end to end.
 *
 * Two stubs are specific to *pointer* + *layout* work and live only here:
 *   - The timeline track's `getBoundingClientRect()` is overridden to a fixed
 *     1000×40 rect at the origin. jsdom has no layout engine, so every element's
 *     rect is all-zero by default; `tlTimeAt`/`edgeDist` early-return (`rect.width
 *     <= 0`) without it, making the whole interaction a no-op.
 *   - `Element.prototype.setPointerCapture` / `releasePointerCapture` are stubbed —
 *     the `pointerdown`/`pointerup` handlers call them and jsdom doesn't implement
 *     them (they'd throw). The handlers read `clientX` (not `offsetX`), confirmed in
 *     `tlTimeAt`/`edgeDist`/the pointerdown handler, so the events only need clientX.
 *
 * With width 1000 and duration 30, the time↔x map is t = clientX/1000 * 30, i.e.
 * clientX 200→6s, 600→18s, 500→15s. The region drag must move ≥3px from its down-x
 * to count (the handler's click-vs-drag threshold), which a 200→600 drag clears.
 *
 * What this does NOT exercise under jsdom (documented, not silently skipped):
 *   - The canvas/overlay redraw and the floating hover-thumb frame preview (canvas
 *     `getContext` is null and `img.load` never fires for a data-URL src in jsdom).
 *     We assert the *state-derived readout text*, the interaction's observable output.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- localStorage: Map-backed shim -------------------------------------------
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

// --- window.matchMedia: initTheme() needs it on boot (jsdom lacks it) --------
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// --- HTMLCanvasElement.getContext: jsdom returns undefined; force null --------
HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// --- URL object-URL helpers: setT/frame plumbing touches them (jsdom lacks) --
if (typeof URL.createObjectURL !== "function") {
  (URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL =
    () => "blob:stub";
}
if (typeof URL.revokeObjectURL !== "function") {
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL =
    () => undefined;
}

// --- Pointer capture: the track's pointerdown/up call these; jsdom lacks them -
Element.prototype.setPointerCapture = () => undefined;
Element.prototype.releasePointerCapture = () => undefined;

// --- platform: mocked wholesale; `probe` returns a real-ish source -----------
const probeMock = vi.fn(async () => ({
  width: 1920,
  height: 1080,
  duration: 30,
  cropdetect: null as string | null,
}));
vi.mock("../src/platform/index.js", () => {
  const platform = {
    platformName: "web" as const,
    supportsFilePicker: false, // → the editor renders the "Load" button + Enter loads
    extractFrame: vi.fn(async () => "data:image/png;base64,AAAA"),
    probe: probeMock,
    scenes: vi.fn(async () => [] as number[]),
    loudness: vi.fn(async () => ({ display: [] as number[], detect: [] as number[] })),
    track: vi.fn(async () => []),
    listFonts: vi.fn(async () => []),
    listUserFonts: vi.fn(async () => []),
    render: vi.fn(async () => ({ ok: true, log: "" })),
    defaultOutdir: vi.fn(async () => ""),
    checkOutdir: vi.fn(async () => ({ ok: true, resolved: "" })),
    exportTextFile: vi.fn(async () => false),
    openExternal: vi.fn(async () => undefined),
    pickSourceFile: vi.fn(async () => null),
    pickDirectory: vi.fn(async () => null),
    videoSrc: vi.fn(async () => "blob:x"),
    loadHistory: vi.fn(async () => []),
    saveHistory: vi.fn(async () => undefined),
    loadSession: vi.fn(async () => null),
    saveSession: vi.fn(async () => undefined),
    getSecret: vi.fn(async () => null),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
  };
  return {
    platform,
    platformName: platform.platformName,
    isTauri: () => false,
  };
});

// Import AFTER the mocks/shims above are installed.
const { mountEditor } = await import("../src/editor.js");

/** Flush microtasks so the editor's async load/bootstrap promises settle. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A fixed 1000×40 rect at the origin (jsdom has no layout, so rects are 0×0). */
function fixedRect(width = 1000, height = 40): DOMRect {
  return {
    left: 0,
    top: 0,
    width,
    height,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

/** Dispatch a PointerEvent of `type` at `clientX` on `target` (pointerId 1).
 *  The handlers read `clientX`; we also mirror it onto `offsetX` defensively. */
function pointer(target: Element, type: string, clientX: number): void {
  const ev = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    pointerId: 1,
  });
  Object.defineProperty(ev, "offsetX", { value: clientX, configurable: true });
  target.dispatchEvent(ev);
}

describe("editor loudness-timeline drag (jsdom)", () => {
  beforeEach(() => {
    store.clear();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
    probeMock.mockClear();
  });

  /** Mount, load a 30s source, and hand back the root + the (rect-stubbed) track. */
  async function mountLoadTrack(): Promise<{ root: HTMLElement; track: HTMLElement }> {
    const root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
    await flush();

    const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
    expect(srcInput).not.toBeNull();
    srcInput!.value = "/abs/path/to/clip.mp4";
    srcInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    const track = root.querySelector<HTMLElement>(".fl-tl-track");
    expect(track).not.toBeNull();
    Object.defineProperty(track!, "getBoundingClientRect", {
      value: () => fixedRect(),
      configurable: true,
    });
    return { root, track: track! };
  }

  /** The `.v` value span of the In/Out readout cell carrying an `.idot.{in,out}`. */
  function valForDot(root: HTMLElement, cls: string): HTMLElement | null {
    for (const dot of root.querySelectorAll<HTMLElement>(`.idot.${cls}`)) {
      const v = dot.parentElement?.querySelector<HTMLElement>(".v");
      if (v) return v;
    }
    return null;
  }

  /** Parse a "6.000s" readout cell to a number (NaN if it's the "—" placeholder). */
  function sec(el: HTMLElement | null): number {
    return Number.parseFloat((el?.textContent ?? "").replace("s", ""));
  }

  it("drag across the track sets the In→Out region (clientX 200→600 ⇒ 6s→18s)", async () => {
    const { root, track } = await mountLoadTrack();

    const inVal = valForDot(root, "in");
    const outVal = valForDot(root, "out");
    expect(inVal!.textContent).toBe("—");
    expect(outVal!.textContent).toBe("—");

    // Down at 200 (anchor=6s), move to 600 (>3px ⇒ a real drag, t=18s), up.
    pointer(track, "pointerdown", 200);
    pointer(track, "pointermove", 600);
    pointer(track, "pointerup", 600);
    await flush();

    // inPoint = min(anchor, t) = 6, outPoint = max(anchor, t) = 18 (round3'd).
    expect(sec(inVal)).toBeCloseTo(6, 2);
    expect(sec(outVal)).toBeCloseTo(18, 2);
    expect(sec(outVal)).toBeGreaterThan(sec(inVal));

    // The transport "in→out" chip reflects the window duration (out − in = 12s).
    const ioChipVal = root.querySelector<HTMLElement>(".fl-rdchip .val");
    expect(ioChipVal!.textContent).toBe("12.000s");
  });

  it("a plain click (no drag) seeks the playhead (clientX 500 ⇒ ~15s)", async () => {
    const { root, track } = await mountLoadTrack();

    // No move between down and up ⇒ endTlDrag treats it as a click and seeks the
    // anchor (tlTimeAt(500) = 500/1000*30 = 15s). setT writes the time readout
    // synchronously before the (debounced) frame fetch, so it's observable now.
    pointer(track, "pointerdown", 500);
    pointer(track, "pointerup", 500);
    await flush();

    // The transport timecode (`.fl-time`) and stage tag both mirror state.t.
    const tLabel = root.querySelector<HTMLElement>(".fl-time");
    expect(tLabel).not.toBeNull();
    expect(sec(tLabel)).toBeCloseTo(15, 2);

    // Two `.fl-stage-tag` spans exist: the "SOURCE" badge (`.rec`) and the time
    // tag — `setT` writes "t = …s" into the latter.
    const stageTag = root.querySelector<HTMLElement>(".fl-stage-tag:not(.rec)");
    expect(stageTag!.textContent).toContain("15.000s");

    // A click drops any marker selection ⇒ the In/Out region stays unset.
    expect(valForDot(root, "in")!.textContent).toBe("—");
    expect(valForDot(root, "out")!.textContent).toBe("—");
  });

  it("dragging the In marker moves the In point and leaves Out fixed", async () => {
    const { root, track } = await mountLoadTrack();

    // First establish a region: drag 200→700 (anchor 6s → 21s) ⇒ In=6, Out=21.
    pointer(track, "pointerdown", 200);
    pointer(track, "pointermove", 700);
    pointer(track, "pointerup", 700);
    await flush();

    const inVal = valForDot(root, "in");
    const outVal = valForDot(root, "out");
    expect(sec(inVal)).toBeCloseTo(6, 2);
    expect(sec(outVal)).toBeCloseTo(21, 2);

    // A pointerdown within TL_EDGE_PX (7px) of the In edge (In=6s → x=200px) grabs
    // the In marker; dragging to clientX 400 (=12s) moves only In, Out unchanged.
    pointer(track, "pointerdown", 201);
    pointer(track, "pointermove", 400);
    pointer(track, "pointerup", 400);
    await flush();

    expect(sec(inVal)).toBeCloseTo(12, 2);
    expect(sec(outVal)).toBeCloseTo(21, 2); // Out untouched
    expect(sec(outVal)).toBeGreaterThan(sec(inVal));
  });

  it("dragging the Out marker moves the Out point and leaves In fixed", async () => {
    const { root, track } = await mountLoadTrack();

    // Region: 200→700 ⇒ In=6 (x=200), Out=21 (x=700).
    pointer(track, "pointerdown", 200);
    pointer(track, "pointermove", 700);
    pointer(track, "pointerup", 700);
    await flush();

    const inVal = valForDot(root, "in");
    const outVal = valForDot(root, "out");
    expect(sec(inVal)).toBeCloseTo(6, 2);
    expect(sec(outVal)).toBeCloseTo(21, 2);

    // Grab the Out edge (x≈700) and drag to clientX 900 (=27s); In stays at 6.
    pointer(track, "pointerdown", 699);
    pointer(track, "pointermove", 900);
    pointer(track, "pointerup", 900);
    await flush();

    expect(sec(inVal)).toBeCloseTo(6, 2); // In untouched
    expect(sec(outVal)).toBeCloseTo(27, 2);
  });
});
