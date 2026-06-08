// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION test for the editor's AI ASSISTANT DOCK propose → accept path
 * (SPEC §6.7). It mounts the whole editor into jsdom (same harness as
 * editor-load.test.ts), loads a real-ish source so the dock has a working
 * region, opens the assistant rail, types a message, sends a turn, and asserts
 * the conversational UI: an assistant reply bubble, a proposal card carrying the
 * proposed action, and an Accept control. Accepting the proposal commits a
 * `setInOut` through the editor's existing state mutation and the In/Out readout
 * updates to the proposed window. A second case exercises Discard (the proposal
 * clears and editor state is left untouched).
 *
 * The MODEL is mocked end-to-end (no network, no key spent): the assistant
 * module (`../src/assistant/index.js`) is `vi.mock`ed so `createAssistant().turn`
 * resolves a canned `AssistantReply` matching the real `@assistant-types` shape
 * (one `setInOut` proposal). The platform is mocked wholesale (no ffmpeg /
 * dev-server). `getSecret` resolves a non-empty fake key so the dock's
 * `buildAssistantContext` clears its needKey guard; `extractFrame` resolves a
 * data URL for any still sampling.
 *
 * jsdom stubs (kept here, never in src) mirror editor-load.test.ts:
 *   - `globalThis.localStorage` — Map-backed shim. We also seed `footlight.ai`
 *     with `chatStills: 0` so `sampleChatStills()` samples NO frames — this keeps
 *     the turn off jsdom's `fetch` (data-URL fetch is unsupported there) and off
 *     the platform's `extractFrame` entirely. The still-strip plumbing is its own
 *     concern (#40); this test targets the propose/accept conversation path.
 *   - `window.matchMedia` — `initTheme()` calls it on boot; jsdom lacks it.
 *   - `HTMLCanvasElement.getContext` → null — stage/overlay canvases call it; the
 *     editor's draw helpers guard `if (!ctx) return`, so null is a safe no-op.
 *   - `URL.createObjectURL` / `revokeObjectURL` — frame plumbing touches them.
 *
 * What this test does NOT exercise under jsdom (and why):
 *   - The canvas "ghost" preview (`setGhosts`). The canned proposal carries no
 *     `ghost`, and `getContext` is null, so there is nothing to draw; we assert
 *     the committed STATE (the In/Out readout) instead of pixels.
 *   - The still strip / model vision path — deliberately budgeted to 0 (above).
 *     The model itself is mocked, so no real frames or key are ever consumed.
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

// --- URL object-URL helpers: frame plumbing touches them (jsdom lacks) -------
if (typeof URL.createObjectURL !== "function") {
  (URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL =
    () => "blob:stub";
}
if (typeof URL.revokeObjectURL !== "function") {
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL =
    () => undefined;
}

// --- platform: mocked wholesale; key + frame resolve so the dock is enabled ---
const getSecretMock = vi.fn(async () => "fake-gemini-key");
const extractFrameMock = vi.fn(async () => "data:image/png;base64,AAAA");
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
    extractFrame: extractFrameMock,
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
    getSecret: getSecretMock,
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
  };
  return {
    platform,
    platformName: platform.platformName,
    isTauri: () => false,
  };
});

// --- assistant: model mocked end-to-end (no network, no key spent) -----------
// `createAssistant().turn` resolves a canned reply matching the real
// `@assistant-types` `AssistantReply` shape: prose `text`, empty `grounding[]`,
// and one `setInOut` `ProposedAction` (`display.{fn,detail}` + typed `commit`).
const turnMock = vi.fn(async () => ({
  text: "Setting your clip.",
  grounding: [] as never[],
  actions: [
    {
      display: { fn: "setInOut" as const, detail: "2s -> 8s" },
      commit: { kind: "setInOut" as const, inSec: 2, outSec: 8 },
    },
  ],
}));
vi.mock("../src/assistant/index.js", () => ({
  createAssistant: () => ({ turn: turnMock }),
}));

// Import AFTER the mocks/shims above are installed.
const { mountEditor } = await import("../src/editor.js");

/** Flush microtasks so the editor's async load / turn promises settle. */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("editor assistant dock: propose → accept / discard (jsdom)", () => {
  beforeEach(() => {
    store.clear();
    // Budget 0 → sampleChatStills() samples no frames, keeping the turn off
    // jsdom's data-URL `fetch` (unsupported) and off `extractFrame` entirely.
    store.set("footlight.ai", JSON.stringify({ provider: "gemini", model: "gemini-3.5-flash", chatStills: 0 }));
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
    probeMock.mockClear();
    getSecretMock.mockClear();
    extractFrameMock.mockClear();
    turnMock.mockClear();
  });

  /** Mount the editor and load a real-ish 1920×1080 / 30s source (Enter loads). */
  async function mountAndLoad(): Promise<HTMLElement> {
    const root = document.createElement("div");
    document.body.append(root);
    mountEditor(root);
    await flush();

    const srcInput = root.querySelector<HTMLInputElement>(".fl-field.path input");
    expect(srcInput).not.toBeNull();
    srcInput!.value = "/abs/path/to/clip.mp4";
    srcInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    return root;
  }

  /** The In/Out readout `.v` value cell for an `.idot.{in,out}` dot (matches
   *  editor-load.test.ts: the Set buttons carry an `.idot` too, but no `.v`). */
  function ioValue(root: HTMLElement, cls: "in" | "out"): HTMLElement | null {
    for (const dot of root.querySelectorAll<HTMLElement>(`.idot.${cls}`)) {
      const v = dot.parentElement?.querySelector<HTMLElement>(".v");
      if (v) return v;
    }
    return null;
  }

  /** Open the dock, type `message`, and send the turn (Enter in the textarea). */
  async function openAndSend(root: HTMLElement, message: string): Promise<void> {
    // The top-bar spark (`.fl-iconbtn.assistant`) toggles the dock open; the
    // inspector-base "Ask" button is an alternate entry point we fall back to.
    const opener =
      root.querySelector<HTMLButtonElement>(".fl-iconbtn.assistant") ??
      [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        /ask/i.test(b.textContent ?? ""),
      );
    expect(opener).toBeTruthy();
    opener!.click();
    await flush();

    const dock = root.querySelector<HTMLElement>(".fl-assist");
    expect(dock).not.toBeNull();
    expect(dock!.style.display).not.toBe("none"); // open → inspector hidden, dock shown

    const textarea = dock!.querySelector<HTMLTextAreaElement>(".fl-composer textarea");
    expect(textarea).not.toBeNull();
    textarea!.value = message;
    textarea!.dispatchEvent(new Event("input", { bubbles: true })); // syncSend enables Send

    // Enter (no Shift) sends, mirroring the composer's keydown handler.
    textarea!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flush();
  }

  it("renders the reply bubble + proposal card and Accept commits setInOut", async () => {
    const root = await mountAndLoad();
    await openAndSend(root, "Find the drop and frame it.");

    // The model mock ran exactly once for this turn.
    expect(turnMock).toHaveBeenCalledTimes(1);

    const dock = root.querySelector<HTMLElement>(".fl-assist")!;

    // The user message echoed, then the assistant reply prose bubble rendered.
    const bubbles = [...dock.querySelectorAll(".fl-bubble")];
    const replyBubble = bubbles.find((b) => b.textContent?.includes("Setting your clip."));
    expect(replyBubble).toBeTruthy();

    // A proposal card rendered with the proposed action: fn + detail.
    const card = dock.querySelector(".fl-prop");
    expect(card).not.toBeNull();
    const actRow = card!.querySelector(".fl-act");
    expect(actRow).not.toBeNull();
    expect(actRow!.querySelector(".fn")!.textContent).toBe("setInOut");
    expect(actRow!.querySelector(".detail")!.textContent).toBe("2s -> 8s");

    // An "Accept" control exists in the action bar.
    const acceptBtn = [...card!.querySelectorAll<HTMLButtonElement>(".fl-prop-bar button")].find(
      (b) => /accept/i.test(b.textContent ?? ""),
    );
    expect(acceptBtn).toBeTruthy();

    // Pre-accept: no In/Out marked yet (the load path doesn't set one).
    const inVal = ioValue(root, "in");
    const outVal = ioValue(root, "out");
    expect(inVal).not.toBeNull();
    expect(outVal).not.toBeNull();
    expect(inVal!.textContent).toBe("—");
    expect(outVal!.textContent).toBe("—");

    // Accept → applyCommit({kind:"setInOut", inSec:2, outSec:8}) mutates state.
    acceptBtn!.click();
    await flush();

    // The In/Out readout now reflects the proposed window (duration 30 ⇒ no clamp).
    expect(inVal!.textContent).toBe("2.000s");
    expect(outVal!.textContent).toBe("8.000s");

    // The card's action bar is replaced by an "applied" note (no longer offering Accept).
    expect(card!.querySelector(".fl-prop-bar")).toBeNull();
    expect(card!.querySelector(".fl-applied-note")).not.toBeNull();
  });

  it("Discard clears the proposal and leaves In/Out untouched", async () => {
    const root = await mountAndLoad();
    await openAndSend(root, "Frame the singer.");

    const dock = root.querySelector<HTMLElement>(".fl-assist")!;
    const card = dock.querySelector(".fl-prop");
    expect(card).not.toBeNull();

    // Sanity: no In/Out before we touch anything.
    const inVal = ioValue(root, "in");
    const outVal = ioValue(root, "out");
    expect(inVal!.textContent).toBe("—");
    expect(outVal!.textContent).toBe("—");

    const discardBtn = [...card!.querySelectorAll<HTMLButtonElement>(".fl-prop-bar button")].find(
      (b) => /discard/i.test(b.textContent ?? ""),
    );
    expect(discardBtn).toBeTruthy();

    discardBtn!.click();
    await flush();

    // State untouched — the In/Out readout still shows placeholders.
    expect(inVal!.textContent).toBe("—");
    expect(outVal!.textContent).toBe("—");

    // The proposal is resolved: the action bar is gone and the rows read as skipped.
    expect(card!.querySelector(".fl-prop-bar")).toBeNull();
    const actRow = card!.querySelector(".fl-act");
    expect(actRow).not.toBeNull();
    expect(actRow!.classList.contains("skip")).toBe(true);
    // The applied/finished note is present (Discard calls finish() too).
    expect(card!.querySelector(".fl-applied-note")).not.toBeNull();
  });
});
