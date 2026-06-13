// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DIRECT unit tests for views/inspector.ts (#125 Phase 5) — the view is built
 * via `buildInspector(store, deps)` with a REAL EditorStore and recording dep
 * stubs, NOT through mountEditor (the editor-*.test.ts integration suites keep
 * the wired paths). Covered:
 *
 *  - the Frame/Track tab switch and the Ask entry into the assistant (the
 *    inspector's one entry point; the top-bar spark lives in the editor);
 *  - the Source/Destination seams: load wiring (Enter + button vs the
 *    file-picker Browse variant), probe readouts (probing / result /
 *    cropdetect / error / drop hint), the recents datalist, and the
 *    platform-default outdir seeding (fill-when-empty, never clobber);
 *  - Set In/Out through `snapT`, the In/Out readout grid, the framing-mode
 *    precedence in the offset cell (push > track > punch-in > schedule >
 *    offset), and `refreshIO`'s fan-out to the transport/timeline deps;
 *  - per-clip fades (store patches + the re-encode hint) and the loop-seam
 *    panel (frame pair via `loopSeamTimes`, closed → no fetches);
 *  - the push capture buttons (boxToRegionWindow round-trip, readout, clear);
 *  - crop/content readouts (punch-in zoom text vs plain offset; content on/off);
 *  - keyframes: the needs-In guard, add (clip-relative `round3` + offset),
 *    sorted list render, per-row delete, Clear, and the schedule readout;
 *  - captions: hook/title/text-position store patches + `syncFromState`;
 *  - auto-track: every guard, settings persistence, the happy path (the full
 *    `TrackRequest` handed to `platform.track`, the `samplesToCropPath` store
 *    write, status + Output), the in-flight working counter (fake timers), the
 *    no-boxes and failure paths, and Clear track;
 *  - the small imperative seams (focus/reveal/flashError/setTrackStatusCount).
 *
 * NOT covered under jsdom (documented, not silently skipped):
 *  - real frame pixels in the loop-seam <img>s — jsdom never loads images, so
 *    the assertions stop at the `src` URLs the view assigns;
 *  - the content readout's TEXT: its node is deliberately unmounted (the
 *    content-crop UI is omitted), so only the branch execution is pinned.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { messages } from "../src/i18n/index.js";
import { createEditorStore } from "../src/editor-store.js";
import { boxToRegionWindow } from "../src/editor-push.js";
import { samplesToCropPath, planSampleTimes } from "@track";
import type { TrackRequest, TrackSample } from "../src/platform/types.js";
import type { InspectorViewDeps } from "../src/views/inspector.js";
import { platformMocks, mockPlatform } from "./helpers/platform-mock.js";
import {
  installDomShims,
  resetHarness,
  seedLoadedStore,
  flush,
  buttonByText,
  setValue,
} from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { buildInspector } = await import("../src/views/inspector.js");

const m = messages.editor;
const REGION = { width: 1920, height: 1080 };

/** Recording dep stubs wired the way the editor wires them. The framing
 *  wrappers are vi.fns too so a test can re-aim them mid-flight
 *  (`mockReturnValue`) without rebuilding the view. */
function makeDeps(overrides: Partial<InspectorViewDeps> = {}): InspectorViewDeps {
  return {
    platform: mockPlatform,
    snapT: vi.fn((t: number) => t),
    extractFrame: vi.fn(async (_s: string, t: number) => `blob:frame-${t}`),
    currentRegion: vi.fn(() => REGION),
    contentOrigin: vi.fn(() => null),
    cropWindowSpec: vi.fn(() => null),
    currentOffset: vi.fn(() => "center"),
    setWindowDur: vi.fn(),
    renderRegion: vi.fn(),
    renderKf: vi.fn(),
    onLoad: vi.fn(),
    onBrowse: vi.fn(),
    onBrowseOutdir: vi.fn(),
    onOutdirChange: vi.fn(),
    onAddClip: vi.fn(),
    onAsk: vi.fn(),
    ensureApiKey: vi.fn(async () => undefined),
    getApiKey: vi.fn(() => "fake-gemini-key"),
    setOutput: vi.fn(),
    ...overrides,
  };
}

/** Narrow a dep back to the vi.fn makeDeps built it as (for mock methods). */
const asMock = (fn: unknown): ReturnType<typeof vi.fn> => fn as ReturnType<typeof vi.fn>;

/** Build the view on a real store; `loaded` seeds a 1920×1080 / 30 s source. */
async function makeView(opts: { loaded?: boolean; deps?: Partial<InspectorViewDeps> } = {}) {
  const store = createEditorStore();
  if (opts.loaded !== false) seedLoadedStore(store);
  const deps = makeDeps(opts.deps);
  const view = buildInspector(store, deps);
  document.body.append(view.element);
  await flush(); // settle defaultOutdir seeding + the caption-style font build
  return { store, deps, view };
}

// ---- DOM lookups (the view has no ids; structure is the public surface) ----

const byTitle = <T extends HTMLElement>(root: HTMLElement, title: string): T => {
  const elx = root.querySelector<T>(`[title="${title}"]`);
  expect(elx, `element titled "${title}"`).toBeTruthy();
  return elx!;
};
const srcInput = (root: HTMLElement): HTMLInputElement =>
  root.querySelector<HTMLInputElement>(`input[placeholder="${m.source.sourcePlaceholder}"]`)!;
/** The destination field: the SECOND `.fl-field.path` input (its placeholder is
 *  rewritten by the `defaultOutdir` seeding, so it can't be matched on). */
const outdirInput = (root: HTMLElement): HTMLInputElement =>
  root.querySelectorAll<HTMLInputElement>(".fl-field.path input")[1]!;
const hints = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(".fl-stack .hint"));
/** The In/Out readout grid (the probe readout is a `.fl-readgrid` too). */
const ioCells = (root: HTMLElement): HTMLElement[] => {
  const grid = Array.from(root.querySelectorAll<HTMLElement>(".fl-readgrid")).find((g) =>
    g.querySelector(".idot.in"),
  )!;
  return Array.from(grid.querySelectorAll<HTMLElement>(".v"));
};
const cropReadout = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>(".fl-readout")!; // first: the Framing section's
const scheduleReadout = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>(".fl-kf-list")!.parentElement!.querySelector(".fl-readout")!;
const trackStatus = (root: HTMLElement): HTMLElement =>
  buttonByText(root, m.track.autoTrack).closest(".fl-sect")!.querySelector(".fl-readout")!;
const clipErr = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>(".err-text")!;

beforeEach(() => {
  resetHarness();
});

describe("tabs + the Ask entry point", () => {
  it("starts on Frame; the segment buttons swap the panes", async () => {
    const { view } = await makeView();
    const frameTab = buttonByText(view.element, m.tabs.frame);
    const trackTab = buttonByText(view.element, m.tabs.track);
    const framePane = frameTab.parentElement!.nextElementSibling as HTMLElement;
    const trackPane = framePane.nextElementSibling as HTMLElement;
    expect(frameTab.classList.contains("on")).toBe(true);
    expect(framePane.style.display).toBe("");
    expect(trackPane.style.display).toBe("none");

    trackTab.click();
    expect(trackTab.classList.contains("on")).toBe(true);
    expect(frameTab.classList.contains("on")).toBe(false);
    expect(framePane.style.display).toBe("none");
    expect(trackPane.style.display).toBe("");

    frameTab.click();
    expect(framePane.style.display).toBe("");
  });

  it("the Ask button at the inspector base opens the assistant", async () => {
    const { deps, view } = await makeView();
    buttonByText(view.element, m.ask.button).click();
    expect(deps.onAsk).toHaveBeenCalledTimes(1);
  });
});

describe("source + destination seams", () => {
  it("on the web platform Enter and the Load button both fire onLoad", async () => {
    const { deps, view } = await makeView();
    srcInput(view.element).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(deps.onLoad).toHaveBeenCalledTimes(1);
    // Exactly once per click — the duplicate listener was issue #200.
    buttonByText(view.element, m.source.load).click();
    expect(deps.onLoad).toHaveBeenCalledTimes(2);
  });

  it("a file-picker platform swaps in Browse buttons for source and destination", async () => {
    const { deps, view } = await makeView({
      deps: { platform: { ...mockPlatform, supportsFilePicker: true } },
    });
    const browses = Array.from(view.element.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) => b.textContent?.trim() === m.source.browse,
    );
    expect(browses).toHaveLength(2);
    // The Load button is built but never appended on a picker platform.
    const loads = Array.from(view.element.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) => b.textContent?.trim() === m.source.load,
    );
    expect(loads).toHaveLength(0);
    browses[0]!.click();
    browses[1]!.click();
    expect(deps.onBrowse).toHaveBeenCalledTimes(1);
    expect(deps.onBrowseOutdir).toHaveBeenCalledTimes(1);
  });

  it("getSource trims; setSource/focusSource/revealSource drive the field", async () => {
    const { view } = await makeView();
    view.setSource("  /a/b.mp4  ");
    expect(view.getSource()).toBe("/a/b.mp4");
    view.focusSource();
    expect(document.activeElement).toBe(srcInput(view.element));
    (document.activeElement as HTMLElement).blur();
    view.revealSource();
    expect(document.activeElement).toBe(srcInput(view.element));
  });

  it("probing → result → error → drop hint rewrite the dims/cropdetect lines", async () => {
    const { view } = await makeView();
    const [dimsLine, cropdetectLine] = hints(view.element);

    view.setProbing();
    expect(dimsLine!.textContent).toBe(m.source.probing);
    expect(cropdetectLine!.textContent).toBe("");

    view.setProbeResult({
      width: 1920,
      height: 1080,
      duration: 30.5,
      cropdetect: "1920:800:0:140",
    });
    expect(dimsLine!.textContent).toContain("1920×1080");
    expect(dimsLine!.textContent).toContain("30.50s");
    expect(dimsLine!.textContent).toContain("1.778");
    expect(cropdetectLine!.textContent).toBe(`${m.source.cropdetectPrefix}1920:800:0:140`);

    view.setProbeResult({ width: 1920, height: 1080, duration: 30.5, cropdetect: null });
    expect(cropdetectLine!.textContent).toBe(m.source.cropdetectNone);

    view.setSourceError("no such file");
    expect(dimsLine!.querySelector(".err-text")!.textContent).toBe("no such file");

    view.setDropHint();
    expect(dimsLine!.textContent).toBe(m.source.dropHint);
  });

  it("refreshRecents rebuilds the datalist from the stored recents", async () => {
    const { view } = await makeView();
    localStorage.setItem("footlight.recents", JSON.stringify(["/one.mp4", "/two.mp4"]));
    view.refreshRecents();
    const options = Array.from(view.element.querySelectorAll("datalist option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(["/one.mp4", "/two.mp4"]);
  });

  it("seeds the platform default outdir into an empty field (placeholder + value)", async () => {
    const { view } = await makeView();
    expect(outdirInput(view.element).placeholder).toBe("/tmp/out");
    expect(view.getOutdir()).toBe("/tmp/out");
  });

  it("never clobbers a persisted outdir; change events reach onOutdirChange", async () => {
    localStorage.setItem("footlight.outdir", "/keep/me");
    const { deps, view } = await makeView();
    expect(view.getOutdir()).toBe("/keep/me");
    expect(outdirInput(view.element).placeholder).toBe("/tmp/out");

    setValue(outdirInput(view.element), "/new/dir", "change");
    expect(deps.onOutdirChange).toHaveBeenCalledWith("/new/dir");
    view.setOutdir("/set/explicitly");
    expect(view.getOutdir()).toBe("/set/explicitly");
    view.focusOutdir();
    expect(document.activeElement).toBe(outdirInput(view.element));
  });
});

describe("In/Out + the readout grid", () => {
  it("Set In / Set Out mark the playhead through snapT", async () => {
    const { store, view } = await makeView({ deps: { snapT: vi.fn((t: number) => t + 0.25) } });
    store.set({ t: 4 });
    buttonByText(view.element, m.clip.setIn).click();
    expect(store.state.inPoint).toBe(4.25);
    store.set({ t: 9 });
    buttonByText(view.element, m.clip.setOut).click();
    expect(store.state.outPoint).toBe(9.25);
  });

  it("renders in/out/dur and fans refreshIO out to the transport + timeline deps", async () => {
    const { store, deps, view } = await makeView();
    // Placeholders until the first refreshIO (a store change or an explicit call).
    expect(ioCells(view.element).map((v) => v.textContent)).toEqual(["—", "—", "—", "—"]);

    store.set({ inPoint: 2, outPoint: 10.5 });
    const [inV, outV, durV, offsetV] = ioCells(view.element);
    expect(inV!.textContent).toBe("2.000s");
    expect(outV!.textContent).toBe("10.500s");
    expect(durV!.textContent).toBe("8.500s");
    expect(offsetV!.textContent).toBe("center");
    expect(deps.setWindowDur).toHaveBeenLastCalledWith("8.500s");
    expect(deps.renderRegion).toHaveBeenCalled();
    expect(deps.renderKf).toHaveBeenCalled();
  });

  it("the offset cell climbs the full framing-mode precedence ladder", async () => {
    const { store, deps, view } = await makeView();
    const offsetCell = () => ioCells(view.element)[3]!.textContent;

    store.set({ inPoint: 0 });
    expect(offsetCell()).toBe("center"); // plain crop_offset

    store.set({ keyframes: [{ t: 0, offset: "center" }] });
    expect(offsetCell()).toBe(m.framing.modeSchedule);

    asMock(deps.cropWindowSpec).mockReturnValue({ x: 100, y: 100, w: 304, h: 540 });
    view.refreshIO(); // re-aimed dep, no store change — refresh explicitly
    expect(offsetCell()).toBe(m.framing.modePunchIn); // punch-in beats schedule

    store.set({ cropPath: [{ t: 0, x: 0 }] });
    expect(offsetCell()).toBe(m.framing.modeTrack); // track beats punch-in

    store.set({
      push: { start: { x: 0, y: 0, w: 304, h: 540 }, end: { x: 50, y: 0, w: 304, h: 540 } },
    });
    expect(offsetCell()).toBe(m.framing.modePush); // push beats everything
  });
});

describe("fades + the loop seam", () => {
  it("fade inputs patch the store and gate the re-encode hint", async () => {
    const { store, view } = await makeView();
    const fadeIn = byTitle<HTMLInputElement>(view.element, m.clip.fadeInTitle);
    const fadeOut = byTitle<HTMLInputElement>(view.element, m.clip.fadeOutTitle);
    const hint = Array.from(view.element.querySelectorAll<HTMLElement>(".hint")).find(
      (h) => h.textContent === m.clip.fadeAudioHint,
    )!;
    expect(hint.style.display).toBe("none");

    setValue(fadeIn, "0.5");
    expect(store.state.fadeIn).toBe(0.5);
    expect(hint.style.display).toBe("");
    setValue(fadeIn, "0");
    expect(hint.style.display).toBe("none");
    setValue(fadeOut, "-3"); // negative clamps to 0 via parseFadeField
    expect(store.state.fadeOut).toBe(0);
    setValue(fadeOut, "1.2");
    expect(store.state.fadeOut).toBe(1.2);
    expect(hint.style.display).toBe("");
  });

  it("the seam panel fetches the Out/In frame pair one frame apart", async () => {
    const { store, deps, view } = await makeView();
    store.set({ inPoint: 2, outPoint: 10, fps: 25 });
    asMock(deps.extractFrame).mockClear();

    const seamBtn = buttonByText(view.element, m.clip.loopSeam);
    seamBtn.click();
    await flush();
    expect(seamBtn.classList.contains("primary")).toBe(true);
    // outT backs off one frame (1/25 s) from Out; inT is In itself.
    expect(deps.extractFrame).toHaveBeenCalledWith("/abs/clip.mp4", 10 - 1 / 25);
    expect(deps.extractFrame).toHaveBeenCalledWith("/abs/clip.mp4", 2);
    const imgs = Array.from(view.element.querySelectorAll<HTMLImageElement>(".fl-loopseam img"));
    expect(imgs.map((i) => i.src)).toEqual([`blob:frame-${10 - 1 / 25}`, "blob:frame-2"]);

    seamBtn.click(); // toggle off hides the panel
    expect(view.element.querySelector<HTMLElement>(".fl-loopseam")!.style.display).toBe("none");
  });

  it("a closed panel (or missing In/Out) never fetches frames", async () => {
    const { store, deps, view } = await makeView();
    store.set({ inPoint: 2, outPoint: 10 });
    asMock(deps.extractFrame).mockClear();
    view.refreshIO(); // seam closed → refreshLoopSeam early-returns
    await flush();
    expect(deps.extractFrame).not.toHaveBeenCalled();

    store.set({ outPoint: null });
    buttonByText(view.element, m.clip.loopSeam).click();
    await flush();
    expect(deps.extractFrame).not.toHaveBeenCalled();
  });
});

describe("push capture", () => {
  const BOX = { x: 200, y: 0, w: 304, h: 540 };

  it("Set start / Set end capture the drawn box as region windows; ✕ clears", async () => {
    const { store, view } = await makeView();
    store.set({ cropBox: { ...BOX } });
    const clearBtn = byTitle<HTMLButtonElement>(view.element, m.framing.pushClearTitle);
    expect(clearBtn.style.display).toBe("none"); // nothing captured yet

    buttonByText(view.element, m.framing.pushSetStart).click();
    const expected = boxToRegionWindow(BOX, null, REGION);
    expect(store.state.push.start).toEqual(expected);
    expect(store.state.push.end).toBeNull();
    expect(clearBtn.style.display).toBe("");

    buttonByText(view.element, m.framing.pushSetEnd).click();
    expect(store.state.push.end).toEqual(expected);
    // The readout describes the captured pair.
    expect(view.element.textContent).toContain(
      `${expected.w}×${expected.h} → ${expected.w}×${expected.h}`,
    );

    clearBtn.click();
    expect(store.state.push).toEqual({ start: null, end: null });
    expect(clearBtn.style.display).toBe("none");
  });

  it("capture is a no-op without a drawn box", async () => {
    const { store, view } = await makeView();
    buttonByText(view.element, m.framing.pushSetStart).click();
    expect(store.state.push.start).toBeNull();
  });
});

describe("crop + content readouts", () => {
  it("with no punch-in window the readout falls back to the plain crop_offset", async () => {
    // The full-height-box → null-window mapping itself lives in the editor's
    // cropWindowSpec wrapper (stubbed here); this pins the view's else-branch.
    const { store, view } = await makeView();
    store.set({ cropBox: { x: 200, y: 0, w: 608, h: 1080 } });
    expect(cropReadout(view.element).textContent).toBe(`${m.framing.cropOffsetPrefix}center`);
  });

  it("a punch-in window reads with its zoom factor", async () => {
    const { store, view } = await makeView({
      deps: { cropWindowSpec: () => ({ x: 100, y: 100, w: 304, h: 540 }) },
    });
    store.set({ cropBox: { x: 100, y: 100, w: 304, h: 540 } });
    expect(cropReadout(view.element).textContent).toBe(
      `${m.framing.punchInPrefix}304×540 @ (100,100)${m.framing.zoomMid}2.00${m.framing.resetSuffix}`,
    );
  });

  it("refreshCropReadout without a box leaves the placeholder untouched", async () => {
    const { view } = await makeView();
    view.refreshCropReadout();
    expect(cropReadout(view.element).textContent).toBe(m.framing.loadASource);
  });

  it("the content readout runs both branches (its node is deliberately unmounted)", async () => {
    // content-crop is omitted from the UI: the readout element is created but
    // never appended (inspector.ts keeps the code path compiling). There is
    // nothing to observe in the DOM — this exercises both branches through the
    // store subscription and the exposed handle so a regression still throws.
    const { store, view } = await makeView();
    expect(
      Array.from(view.element.querySelectorAll<HTMLElement>(".hint")).find(
        (h) => h.textContent === m.framing.contentOff,
      ),
    ).toBeUndefined();
    store.set({ contentMode: true, contentBox: { x: 0, y: 140, w: 1920, h: 800 } });
    store.set({ contentMode: false });
    view.refreshContentReadout();
  });
});

describe("keyframes", () => {
  it("refuses to add before In is set (the times are clip-relative)", async () => {
    const { store, view } = await makeView();
    buttonByText(view.element, m.keyframes.add).click();
    expect(clipErr(view.element).textContent).toBe(m.keyframes.needIn);
    expect(store.state.keyframes).toEqual([]);
  });

  it("adds at the clip-relative playhead with the current offset; renders sorted; deletes", async () => {
    const { store, deps, view } = await makeView();
    store.set({ inPoint: 2, t: 5.5555 });
    buttonByText(view.element, m.keyframes.add).click();
    expect(store.state.keyframes).toEqual([{ t: 3.556, offset: "center" }]); // round3(5.5555-2)

    store.set({ t: 3 });
    buttonByText(view.element, m.keyframes.add).click();
    const items = Array.from(view.element.querySelectorAll(".fl-kf-list li span")).map(
      (s) => s.textContent,
    );
    expect(items).toEqual(["t=1s → center", "t=3.556s → center"]); // sorted by t
    expect(scheduleReadout(view.element).textContent).toBe(
      `${m.keyframes.schedulePrefix}1=center; 3.556=center`,
    );
    expect(deps.renderKf).toHaveBeenCalled();

    view.element.querySelector<HTMLButtonElement>(".fl-kf-list li button")!.click(); // delete t=1
    expect(store.state.keyframes).toEqual([{ t: 3.556, offset: "center" }]);

    buttonByText(view.element, m.keyframes.clear).click();
    expect(store.state.keyframes).toEqual([]);
    expect(scheduleReadout(view.element).textContent).toBe(m.keyframes.scheduleNoKeyframes);
  });
});

describe("captions + syncFromState", () => {
  it("hook/title/text-position controls patch the store", async () => {
    const { store, view } = await makeView();
    const hook = byTitle<HTMLTextAreaElement>(view.element, m.captions.hookTitle);
    const title = byTitle<HTMLTextAreaElement>(view.element, m.captions.titleTitle);
    setValue(hook, "BIG LINE");
    setValue(title, "small line");
    expect(store.state.hook).toBe("BIG LINE");
    expect(store.state.title).toBe("small line");

    const posV = byTitle<HTMLSelectElement>(view.element, m.captions.posVTitle);
    const posH = byTitle<HTMLSelectElement>(view.element, m.captions.posHTitle);
    setValue(posV, "top", "change");
    expect(store.state.textPosition).toBe("top"); // center horizontal stays implicit
    setValue(posH, "right", "change");
    expect(store.state.textPosition).toBe("top-right");
  });

  it("syncFromState reflects a restored clip onto name/captions/fades/position", async () => {
    const { store, view } = await makeView();
    store.set({
      hook: "restored hook",
      title: "restored title",
      textPosition: "center-left",
      fadeIn: 0.5,
      fadeOut: 0,
    });
    view.syncFromState("chorus_closeup");

    expect(view.getName()).toBe("chorus_closeup");
    expect(byTitle<HTMLTextAreaElement>(view.element, m.captions.hookTitle).value).toBe(
      "restored hook",
    );
    expect(byTitle<HTMLTextAreaElement>(view.element, m.captions.titleTitle).value).toBe(
      "restored title",
    );
    expect(byTitle<HTMLSelectElement>(view.element, m.captions.posVTitle).value).toBe("center");
    expect(byTitle<HTMLSelectElement>(view.element, m.captions.posHTitle).value).toBe("left");
    expect(byTitle<HTMLInputElement>(view.element, m.clip.fadeInTitle).value).toBe("0.5");
    expect(byTitle<HTMLInputElement>(view.element, m.clip.fadeOutTitle).value).toBe(""); // 0 → empty

    view.clearName();
    expect(view.getName()).toBe("");
  });

  it("the Add clip button defers to the editor; flashError lands in the error line", async () => {
    const { deps, view } = await makeView();
    buttonByText(view.element, m.add.addClip).click();
    expect(deps.onAddClip).toHaveBeenCalledTimes(1);
    view.flashError("name taken");
    expect(clipErr(view.element).textContent).toBe("name taken");
  });
});

describe("auto-track", () => {
  const SAMPLES: TrackSample[] = [
    { t: 0, box: { x: 0, y: 0, w: 200, h: 1080 } },
    { t: 4, box: { x: 1600, y: 0, w: 200, h: 1080 } },
  ];

  async function runTrack(view: { element: HTMLElement }): Promise<void> {
    buttonByText(view.element, m.track.autoTrack).click();
    await flush();
  }

  it("guards: no source, missing In/Out, inverted window, missing key", async () => {
    const noSource = await makeView({ loaded: false });
    await runTrack(noSource.view);
    expect(trackStatus(noSource.view.element).textContent).toBe(m.track.statusLoadSource);
    expect(platformMocks.track).not.toHaveBeenCalled();

    const noWindow = await makeView();
    await runTrack(noWindow.view);
    expect(trackStatus(noWindow.view.element).textContent).toBe(m.track.statusNeedInOut);

    const inverted = await makeView();
    inverted.store.set({ inPoint: 10, outPoint: 10 });
    await runTrack(inverted.view);
    expect(trackStatus(inverted.view.element).textContent).toBe(m.track.statusOutAfterIn);

    const noKey = await makeView({ deps: { getApiKey: () => "  " } });
    noKey.store.set({ inPoint: 2, outPoint: 10 });
    await runTrack(noKey.view);
    expect(trackStatus(noKey.view.element).textContent).toBe(m.track.statusNeedKey);
    expect(platformMocks.track).not.toHaveBeenCalled();
  });

  it("tracks the shot and stores the smoothed crop path (status + Output report)", async () => {
    platformMocks.track.mockResolvedValue(SAMPLES);
    const { store, deps, view } = await makeView();
    store.set({ inPoint: 2, outPoint: 10, sceneCuts: [1, 5, 20] });
    const hint = view.element.querySelector<HTMLInputElement>(
      `input[placeholder='${m.track.subjectPlaceholder}']`,
    )!;
    setValue(hint, "the guitarist", "change");
    await runTrack(view);

    // The request is clip-relative: cut-anchored samples, startSec = In, the
    // in-range scene cut (5 s) shifted by In.
    const req = platformMocks.track.mock.calls[0]![0] as unknown as TrackRequest;
    expect(req.sourcePath).toBe("/abs/clip.mp4");
    expect(req.region).toEqual(REGION);
    expect(req.startSec).toBe(2);
    expect(req.subjectHint).toBe("the guitarist");
    expect(req.apiKey).toBe("fake-gemini-key"); // BYOK rides the request
    expect(req.contentCrop).toBeUndefined();
    expect(req.sampleTimes).toEqual(
      planSampleTimes({ shotStart: 0, shotEnd: 8, intervalSec: 0.75, sceneCuts: [3] }),
    );

    const expectedPath = samplesToCropPath(SAMPLES, REGION);
    expect(store.state.cropPath).toEqual(expectedPath);
    expect(trackStatus(view.element).textContent).toBe(
      `${m.track.statusOnPrefix}${expectedPath.length}${m.track.statusOnSuffix}`,
    );
    expect(deps.setOutput).toHaveBeenCalledWith(
      `${m.track.resultPrefix}${expectedPath.length}${m.track.resultMid}${SAMPLES.length}${m.track.resultSuffix}`,
      "ok",
    );
    expect(buttonByText(view.element, m.track.autoTrack).disabled).toBe(false);
    // The settings persisted (hint saved, mock forced off, interval kept).
    expect(JSON.parse(localStorage.getItem("footlight.autotrack")!)).toEqual({
      subjectHint: "the guitarist",
      mock: false,
      intervalSec: 0.75,
    });
  });

  it("shows the live working counter and disables the button while the tracker runs", async () => {
    vi.useFakeTimers();
    try {
      let resolveTrack!: (s: TrackSample[]) => void;
      platformMocks.track.mockImplementation(
        () => new Promise<TrackSample[]>((r) => (resolveTrack = r)),
      );
      // (flush() is microtask-only, so fake timers don't stall the harness.)
      const { store, view } = await makeView();
      store.set({ inPoint: 2, outPoint: 10 });
      const status = trackStatus(view.element);
      const btn = buttonByText(view.element, m.track.autoTrack);
      btn.click();
      await flush();

      expect(btn.disabled).toBe(true);
      expect(status.classList.contains("working")).toBe(true);
      expect(status.textContent).toBe(
        `${m.track.statusWorkingPrefix}0${m.track.statusWorkingSuffix}`,
      );
      vi.advanceTimersByTime(2000); // two 1 s ticks of the elapsed counter
      expect(status.textContent).toBe(
        `${m.track.statusWorkingPrefix}2${m.track.statusWorkingSuffix}`,
      );

      resolveTrack([]);
      await flush();
      expect(btn.disabled).toBe(false);
      expect(status.classList.contains("working")).toBe(false);
      vi.advanceTimersByTime(3000); // interval cleared — the counter is dead
      expect(status.textContent).toBe(m.track.statusNoBoxes);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unusable-boxes result falls back to the manual offset", async () => {
    platformMocks.track.mockResolvedValue([]);
    const { store, deps, view } = await makeView();
    store.set({ inPoint: 2, outPoint: 10, cropPath: [{ t: 0, x: 5 }] });
    await runTrack(view);
    expect(store.state.cropPath).toBeNull();
    expect(trackStatus(view.element).textContent).toBe(m.track.statusNoBoxes);
    expect(deps.setOutput).toHaveBeenCalledWith(m.track.noBoxesOutput);
  });

  it("a tracker failure clears the path and reports through Output", async () => {
    platformMocks.track.mockRejectedValue(new Error("vision quota"));
    const { store, deps, view } = await makeView();
    store.set({ inPoint: 2, outPoint: 10, cropPath: [{ t: 0, x: 5 }] });
    await runTrack(view);
    expect(store.state.cropPath).toBeNull();
    expect(trackStatus(view.element).textContent).toBe(m.track.statusFailed);
    expect(deps.setOutput).toHaveBeenCalledWith(`${m.track.failedOutputPrefix}vision quota`, "err");
    expect(buttonByText(view.element, m.track.autoTrack).disabled).toBe(false);
  });

  it("an invalid interval persists as the 0.75 default; Clear track reverts the path", async () => {
    const { store, view } = await makeView();
    const interval = view.element.querySelector<HTMLInputElement>(
      `input[placeholder="${m.track.intervalPlaceholder}"]`,
    )!;
    setValue(interval, "-2", "change");
    expect(JSON.parse(localStorage.getItem("footlight.autotrack")!).intervalSec).toBe(0.75);

    store.set({ cropPath: [{ t: 0, x: 5 }] });
    buttonByText(view.element, m.track.clearTrack).click();
    expect(store.state.cropPath).toBeNull();
    expect(trackStatus(view.element).textContent).toBe(m.track.statusNone);
  });

  it("setTrackStatusCount shows the assistant-committed keyframe count", async () => {
    const { view } = await makeView();
    view.setTrackStatusCount(7);
    expect(trackStatus(view.element).textContent).toBe(
      `${m.assistant.trackFromAssistantPrefix}7${m.assistant.trackFromAssistantSuffix}`,
    );
  });
});
