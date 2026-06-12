// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DIRECT unit tests for views/assistant.ts (#125 Phase 5) — the dock is built
 * via `buildAssistantView(deps)` with a REAL EditorStore and recording dep
 * stubs, NOT through mountEditor (editor-assistant.test.ts keeps the wired
 * propose→accept integration path). The MODEL is mocked at the module seam
 * (`createAssistant().turn` resolves canned `AssistantReply`s) and the chat
 * stills budget is 0, so no turn ever touches the network, a key, or
 * `extractFrame`. Covered:
 *
 *  - open/close/toggle: display, `onOpenChange` reflection, the one-time
 *    greeting, ghost clearing on close, the header ✕;
 *  - the composer: send-button enable sync, suggestion chips, Enter sends /
 *    Shift+Enter doesn't;
 *  - `sendTurn` outcomes: the no-source and no-key refusals, the happy path
 *    (user bubble → thinking → reply bubble + warn + grounding chips + usage
 *    row + proposal card + ghosts), the turn failure, and multi-turn history
 *    threading (the just-sent user line is excluded from `history`);
 *  - the proposal card: Accept all (incl. the skip row + staged note
 *    variants), Step-through (cursor, per-step ghosts, the final note),
 *    Discard, and Accept-the-rest after a Step.
 *
 * NOT covered under jsdom (documented, not silently skipped):
 *  - `sendTurn`'s `if (!message) return` guard: the send button is disabled
 *    whenever the trimmed value is empty and the Enter handler checks the same
 *    flag, so no DOM event can reach the guard — it is defensive only.
 *  - the real still strip / vision path: budgeted to 0 above; the sampling
 *    plan is editor-chat-context.test.ts's subject.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

const turnMock = vi.fn();
vi.mock("../src/assistant/index.js", () => ({
  createAssistant: () => ({ turn: turnMock }),
}));

import { messages } from "../src/i18n/index.js";
import { createEditorStore } from "../src/editor-store.js";
import type { AssistantReply, ProposedAction } from "@assistant-types";
import { installDomShims, resetHarness, flush, buttonByText } from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { buildAssistantView } = await import("../src/views/assistant.js");

const m = messages.editor;

/** Build the dock on a real store with recording dep stubs (the editor's wiring). */
function makeView(opts: { source?: boolean; apiKey?: string } = {}) {
  const store = createEditorStore();
  if (opts.source !== false) {
    store.set({
      source: "/abs/clip.mp4",
      dims: { width: 1920, height: 1080 },
      duration: 30,
      inPoint: 2,
      outPoint: 10,
    });
  }
  const deps = {
    store,
    currentRegion: () => ({ width: 1920, height: 1080 }),
    ensureApiKey: vi.fn(async () => undefined),
    getApiKey: vi.fn(() => opts.apiKey ?? "fake-gemini-key"),
    applyCommit: vi.fn(() => ({ applied: true, staged: false })),
    setGhosts: vi.fn(),
    onOpenChange: vi.fn(),
  };
  const view = buildAssistantView(deps);
  document.body.append(view.element);
  return { store, deps, view };
}

// ---- DOM lookups (the dock has no ids; structure is the public surface) ----

const log = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>(".fl-assist-body")!;
const bubbles = (root: HTMLElement): HTMLElement[] =>
  Array.from(log(root).querySelectorAll<HTMLElement>(".fl-msg"));
const lastBubble = (root: HTMLElement): HTMLElement => bubbles(root).at(-1)!;
const composerTextarea = (root: HTMLElement): HTMLTextAreaElement =>
  root.querySelector<HTMLTextAreaElement>(".fl-composer textarea")!;
const sendBtn = (root: HTMLElement): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>("button.fl-send")!;
const proposalCard = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>(".fl-prop");
const actionRows = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(".fl-act"));

/** Type a message (firing the enable sync) and send it with Enter; settle. */
async function send(root: HTMLElement, message: string): Promise<void> {
  const ta = composerTextarea(root);
  ta.value = message;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
}

/** A canned happy-path reply: two visual proposals with distinct ghosts. */
function cannedReply(): AssistantReply {
  const actions: ProposedAction[] = [
    {
      display: { fn: "setInOut", detail: "0:02.000 -> 0:08.000" },
      ghost: { region: { inSec: 2, outSec: 8 } },
      commit: { kind: "setInOut", inSec: 2, outSec: 8 },
    },
    {
      display: { fn: "addCropKeyframe", detail: "t=1 x=440" },
      ghost: { keyframe: { t: 1, x: 440 } },
      commit: { kind: "addCropKeyframe", t: 1, x: 440 },
    },
  ];
  return {
    text: "Here is the cut.",
    warn: "inferring the chorus",
    grounding: [
      { kind: "swell", t: 68, detail: "loudness swell @ 01:08" },
      { kind: "scene-cut", t: 4.5 },
    ],
    usage: { promptTokens: 1000, outputTokens: 234, totalTokens: 1234 },
    costUsd: 0.0123,
    actions,
  };
}

beforeEach(() => {
  resetHarness();
  turnMock.mockReset();
  turnMock.mockResolvedValue(cannedReply());
  // Budget 0 → sampleChatStills() samples no frames: the turn never touches
  // jsdom's data-URL `fetch` (unsupported) or the platform's `extractFrame`.
  localStorage.setItem(
    "footlight.ai",
    JSON.stringify({ provider: "gemini", model: "gemini-3.5-flash", chatStills: 0 }),
  );
});

describe("open / close / toggle", () => {
  it("open shows the rail, reflects through onOpenChange, greets once, and focuses", () => {
    const { deps, view } = makeView();
    expect(view.element.style.display).toBe("none");
    expect(view.isOpen()).toBe(false);

    view.open();
    expect(view.element.style.display).toBe("");
    expect(view.isOpen()).toBe(true);
    expect(deps.onOpenChange).toHaveBeenCalledWith(true);
    expect(document.activeElement).toBe(composerTextarea(view.element));
    expect(bubbles(view.element)).toHaveLength(1);
    expect(lastBubble(view.element).querySelector(".fl-bubble")!.textContent).toBe(
      m.assistant.greeting,
    );

    // Re-opening never re-greets: the greeting is seeded only into an empty log.
    view.close();
    view.open();
    expect(bubbles(view.element)).toHaveLength(1);
  });

  it("close hides the rail, reflects false, and clears any ghost previews", () => {
    const { deps, view } = makeView();
    view.open();
    view.close();
    expect(view.element.style.display).toBe("none");
    expect(view.isOpen()).toBe(false);
    expect(deps.onOpenChange).toHaveBeenLastCalledWith(false);
    expect(deps.setGhosts).toHaveBeenLastCalledWith([]);
  });

  it("toggle flips between the two; the header ✕ closes", () => {
    const { view } = makeView();
    view.toggle();
    expect(view.isOpen()).toBe(true);
    view.toggle();
    expect(view.isOpen()).toBe(false);

    view.open();
    const closeBtn = view.element.querySelector<HTMLButtonElement>(".fl-assist-h button")!;
    closeBtn.click();
    expect(view.isOpen()).toBe(false);
  });
});

describe("the composer", () => {
  it("send enables only while the trimmed value is non-empty", () => {
    const { view } = makeView();
    const ta = composerTextarea(view.element);
    expect(sendBtn(view.element).disabled).toBe(true);
    ta.value = "   ";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sendBtn(view.element).disabled).toBe(true);
    ta.value = "frame the singer";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sendBtn(view.element).disabled).toBe(false);
  });

  it("a suggestion chip fills the composer, focuses it, and enables send", () => {
    const { view } = makeView();
    const suggestion = m.assistant.suggestions[0]!;
    buttonByText(view.element, suggestion).click();
    expect(composerTextarea(view.element).value).toBe(suggestion);
    expect(document.activeElement).toBe(composerTextarea(view.element));
    expect(sendBtn(view.element).disabled).toBe(false);
  });

  it("Enter sends the turn; Shift+Enter does not", async () => {
    const { view } = makeView();
    const ta = composerTextarea(view.element);
    ta.value = "find the chorus";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    await flush();
    expect(turnMock).not.toHaveBeenCalled();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(turnMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendTurn outcomes", () => {
  it("refuses with needSource when no source is loaded (no model call, no key touch)", async () => {
    const { deps, view } = makeView({ source: false });
    await send(view.element, "anything");
    expect(lastBubble(view.element).querySelector(".fl-bubble")!.textContent).toBe(
      m.assistant.needSource,
    );
    expect(turnMock).not.toHaveBeenCalled();
    expect(deps.ensureApiKey).not.toHaveBeenCalled();
  });

  it("refuses with needKey when the keychain read comes back empty", async () => {
    const { deps, view } = makeView({ apiKey: "  " });
    await send(view.element, "anything");
    expect(deps.ensureApiKey).toHaveBeenCalled();
    expect(lastBubble(view.element).querySelector(".fl-bubble")!.textContent).toBe(
      m.assistant.needKey,
    );
    expect(turnMock).not.toHaveBeenCalled();
  });

  it("renders the full happy path: bubbles, warn, grounding, usage, card, ghosts", async () => {
    const { deps, view } = makeView();
    await send(view.element, "find the chorus");

    // user bubble then ai bubble; the transient thinking bubble is gone.
    const all = bubbles(view.element);
    expect(all).toHaveLength(2);
    expect(all[0]!.className).toContain("user");
    expect(all[0]!.querySelector(".fl-bubble")!.textContent).toBe("find the chorus");
    expect(view.element.querySelector(".fl-think")).toBeNull();

    const ai = all[1]!.querySelector<HTMLElement>(".fl-bubble")!;
    expect(ai.textContent).toContain("Here is the cut.");
    expect(ai.querySelector(".warn")!.textContent).toBe("inferring the chorus");

    // grounding chips: explicit detail, then the `kind @ clock` fallback.
    const chips = Array.from(ai.querySelectorAll<HTMLElement>(".gchip")).map((c) => c.textContent);
    expect(chips).toEqual(["loudness swell @ 01:08", "scene-cut @ 0:04.500"]);

    // usage row: localized token total + the ~$ estimate + the breakdown title.
    const usage = ai.querySelector<HTMLElement>(".fl-usage")!;
    expect(usage.querySelector(".tok")!.textContent).toBe(
      `${(1234).toLocaleString()} ${m.assistant.usageTokens}`,
    );
    expect(usage.querySelector(".cost")!.textContent).toBe("~$0.0123");
    expect(usage.title).toContain(m.assistant.usageEstNote);

    // proposal card: one `→ fn detail` row per action, plural count, step 0/2.
    const card = proposalCard(view.element)!;
    expect(card.querySelector(".n")!.textContent).toBe(`2 ${m.assistant.actionPlural}`);
    const rows = actionRows(card);
    expect(rows.map((r) => r.querySelector(".fn")!.textContent)).toEqual([
      "setInOut",
      "addCropKeyframe",
    ]);
    expect(rows[0]!.className).toContain("active");
    expect(card.querySelector(".step")!.textContent).toBe("0/2");

    // every not-yet-committed ghost is previewing.
    expect(deps.setGhosts).toHaveBeenLastCalledWith([
      { region: { inSec: 2, outSec: 8 } },
      { keyframe: { t: 1, x: 440 } },
    ]);
  });

  it("omits the cost span when costUsd is unknown and the card when there are no actions", async () => {
    turnMock.mockResolvedValue({
      text: "Just an answer.",
      grounding: [],
      actions: [],
      usage: { promptTokens: 10, outputTokens: 5, totalTokens: 15 },
    } satisfies AssistantReply);
    const { deps, view } = makeView();
    await send(view.element, "what do you see?");
    const ai = lastBubble(view.element).querySelector<HTMLElement>(".fl-bubble")!;
    expect(ai.querySelector(".fl-usage .tok")).not.toBeNull();
    expect(ai.querySelector(".fl-usage .cost")).toBeNull();
    expect(ai.querySelector(".fl-ground")).toBeNull();
    expect(proposalCard(view.element)).toBeNull();
    expect(deps.setGhosts).toHaveBeenLastCalledWith([]);
  });

  it("a failed turn removes the thinking bubble and apologizes with the error", async () => {
    turnMock.mockRejectedValue(new Error("quota exceeded"));
    const { view } = makeView();
    await send(view.element, "anything");
    expect(view.element.querySelector(".fl-think")).toBeNull();
    expect(lastBubble(view.element).querySelector(".fl-bubble")!.textContent).toBe(
      `${m.assistant.turnFailedPrefix}quota exceeded`,
    );
  });

  it("threads prior turns as history, excluding the just-sent user line", async () => {
    const { view } = makeView();
    await send(view.element, "first ask");
    await send(view.element, "second ask");
    expect(turnMock).toHaveBeenCalledTimes(2);
    const second = turnMock.mock.calls[1]![0] as {
      message: string;
      history: Array<{ role: string; text: string }>;
    };
    expect(second.message).toBe("second ask");
    expect(second.history).toEqual([
      { role: "user", text: "first ask" },
      { role: "assistant", text: "Here is the cut." },
    ]);
  });

  it("a new turn supersedes still-previewing proposals (ghosts cleared up front)", async () => {
    const { deps, view } = makeView();
    await send(view.element, "first ask");
    deps.setGhosts.mockClear();
    await send(view.element, "second ask");
    expect(deps.setGhosts.mock.calls[0]).toEqual([[]]);
  });
});

describe("the proposal card", () => {
  it("Accept all commits every action, marks rows, clears ghosts, and notes the count", async () => {
    const { deps, view } = makeView();
    await send(view.element, "go");
    const card = proposalCard(view.element)!;
    buttonByText(card, m.assistant.acceptAll).click();

    expect(deps.applyCommit).toHaveBeenCalledTimes(2);
    expect(deps.applyCommit).toHaveBeenNthCalledWith(1, { kind: "setInOut", inSec: 2, outSec: 8 });
    expect(actionRows(card).every((r) => r.classList.contains("done"))).toBe(true);
    expect(deps.setGhosts).toHaveBeenLastCalledWith([]);
    expect(card.querySelector(".fl-prop-bar")).toBeNull(); // bar replaced by the note
    const note = card.querySelector<HTMLElement>(".fl-applied-note")!;
    expect(note.textContent).toBe(
      `${m.assistant.appliedPrefix}2${m.assistant.appliedSuffixPlural}`,
    );
    expect(note.querySelector("svg")).not.toBeNull(); // the ok check mark
  });

  it("a refused commit marks its row skip and is left out of the applied count", async () => {
    const { deps, view } = makeView();
    deps.applyCommit
      .mockReturnValueOnce({ applied: true, staged: false })
      .mockReturnValueOnce({ applied: false, staged: false });
    await send(view.element, "go");
    const card = proposalCard(view.element)!;
    buttonByText(card, m.assistant.acceptAll).click();

    const rows = actionRows(card);
    expect(rows[0]!.classList.contains("done")).toBe(true);
    expect(rows[1]!.classList.contains("skip")).toBe(true);
    expect(card.querySelector(".fl-applied-note")!.textContent).toBe(
      `${m.assistant.appliedPrefix}1${m.assistant.appliedSuffixSingular}`,
    );
  });

  it("a staged commit switches the note to the render-staged wording", async () => {
    const { deps, view } = makeView();
    deps.applyCommit.mockReturnValue({ applied: true, staged: true });
    await send(view.element, "go");
    const card = proposalCard(view.element)!;
    buttonByText(card, m.assistant.acceptAll).click();
    expect(card.querySelector(".fl-applied-note")!.textContent).toBe(
      `${m.assistant.appliedStagedPrefix}2${m.assistant.appliedStagedSuffix}`,
    );
  });

  it("Step commits one action at a time, advancing the cursor and the ghosts", async () => {
    const { deps, view } = makeView();
    await send(view.element, "go");
    const card = proposalCard(view.element)!;
    const step = buttonByText(card, m.assistant.step);

    step.click();
    expect(deps.applyCommit).toHaveBeenCalledTimes(1);
    const rows = actionRows(card);
    expect(rows[0]!.classList.contains("done")).toBe(true);
    expect(rows[1]!.classList.contains("active")).toBe(true);
    expect(card.querySelector(".step")!.textContent).toBe("1/2");
    // The committed action's ghost dropped; the remaining one still previews.
    expect(deps.setGhosts).toHaveBeenLastCalledWith([{ keyframe: { t: 1, x: 440 } }]);

    step.click();
    expect(deps.applyCommit).toHaveBeenCalledTimes(2);
    expect(card.querySelector(".fl-prop-bar")).toBeNull();
    expect(card.querySelector(".fl-applied-note")!.textContent).toBe(m.assistant.steppedThrough);

    step.click(); // past the end: a no-op, not a crash
    expect(deps.applyCommit).toHaveBeenCalledTimes(2);
  });

  it("Accept all after a Step only commits the remaining actions", async () => {
    const { deps, view } = makeView();
    await send(view.element, "go");
    const card = proposalCard(view.element)!;
    buttonByText(card, m.assistant.step).click();
    buttonByText(card, m.assistant.acceptAll).click();
    expect(deps.applyCommit).toHaveBeenCalledTimes(2); // 1 step + 1 remaining, never re-applied
    expect(deps.applyCommit).toHaveBeenNthCalledWith(2, { kind: "addCropKeyframe", t: 1, x: 440 });
  });

  it("Discard skips every row, clears ghosts, and leaves state untouched", async () => {
    const { deps, view } = makeView();
    await send(view.element, "go");
    const card = proposalCard(view.element)!;
    buttonByText(card, m.assistant.discard).click();

    expect(deps.applyCommit).not.toHaveBeenCalled();
    expect(actionRows(card).every((r) => r.classList.contains("skip"))).toBe(true);
    expect(deps.setGhosts).toHaveBeenLastCalledWith([]);
    const note = card.querySelector<HTMLElement>(".fl-applied-note")!;
    expect(note.textContent).toBe(m.assistant.discarded);
    expect(note.querySelector("svg")).toBeNull(); // no check mark — nothing applied
  });
});
