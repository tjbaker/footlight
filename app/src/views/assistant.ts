// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The AI assistant dock VIEW (#125 Phase 4, SPEC §6.7) — the conversational
 * "framing brain" that slides over the inspector. `buildAssistantView(deps)`
 * owns the rail DOM (header + scrolling message log + composer), the multi-turn
 * conversation, the per-turn context assembly, and the proposal cards. The
 * assistant PROPOSES; nothing mutates editor state until the human Accepts —
 * commits flow back through the editor's `applyCommit` (passed in), and the
 * canvas/timeline "ghost" previews are pushed via `setGhosts` (the viewer owns
 * the drawing). The top-bar spark button + the inspector "Ask" button + the
 * `a`/Esc hotkeys stay in the editor and drive this view's open/close/toggle;
 * the view reflects its open state back through `onOpenChange` (which hides the
 * inspector and toggles the spark button).
 *
 * Pure helpers it leans on are imported directly (assembleAssistantContext /
 * sampleChatStills, resolveModels, the cost/format helpers) — DRY, no
 * re-derivation. The conversation engine is `createAssistant`.
 */

import { messages } from "../i18n/index.js";
import { el, button } from "../ui.js";
import { ICON_SPARK, ICON_X, ICON_SEND, ICON_CHECK } from "../icons.js";
import { platform } from "../platform/index.js";
import { createAssistant, type ConversationMessage } from "../assistant/index.js";
import { BASE_PROMPT } from "../assistant/base-prompt.js";
import { resolveModels } from "@model";
import { assembleAssistantContext, sampleChatStills } from "../editor-chat-context.js";
import { assistantSelection } from "../editor-prefs.js";
import { loadAssistantOverlay, loadChatStillsBudget } from "../settings.js";
import { fmtUsd, ghostsFrom } from "../editor-format.js";
import { fmtClock, errMsg } from "../editor-util.js";
import type { EditorStore } from "../editor-store.js";
import type { Dims } from "@manifest";
import type {
  AssistantReply,
  ProposedAction,
  GhostPreview,
  CommitOp,
  Grounding,
  Usage,
} from "@assistant-types";

/** What the assistant dock needs from the editor (everything else it imports). */
export interface AssistantViewDeps {
  store: EditorStore;
  /** The working region (post content-crop) for the per-turn context. */
  currentRegion: () => Dims;
  /** Lazily load the BYOK key into the keychain-backed cache (first AI use). */
  ensureApiKey: () => Promise<void>;
  /** Read the current (possibly empty) BYOK key. */
  getApiKey: () => string;
  /** Apply one accepted commit through the editor's mutations + effects. */
  applyCommit: (commit: CommitOp) => { applied: boolean; staged: boolean };
  /** Push the pending proposal "ghost" previews to the viewer/timeline. */
  setGhosts: (ghosts: GhostPreview[]) => void;
  /** Reflect open/closed in the editor: hide the inspector, toggle the spark. */
  onOpenChange: (open: boolean) => void;
}

/** The assistant dock view: its rail element + the editor's open/close handles. */
export interface AssistantView {
  element: HTMLElement;
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
}

export function buildAssistantView(deps: AssistantViewDeps): AssistantView {
  const { store, currentRegion, ensureApiKey, getApiKey, applyCommit, setGhosts, onOpenChange } =
    deps;
  const state = store.state;
  const m = messages.editor;

  /** Whether the assistant rail is showing (inspector hidden when true). */
  let assistantOpen = false;
  /** Multi-turn history threaded into each turn. */
  const assistantHistory: ConversationMessage[] = [];
  /** Pending proposals from the most recent reply (cleared on Discard / new turn). */
  let pendingActions: ProposedAction[] = [];
  /** Step cursor: index of the next single proposal to apply via "Step". */
  let stepIndex = 0;

  /**
   * Build the assistant rail DOM: header (spark + title + close), a scrolling
   * message log, and a footer composer (suggestion chips + textarea + send). The
   * returned object exposes the root plus the imperative pieces the open/turn
   * handlers drive.
   */
  function buildAssistantDock(): {
    el: HTMLElement;
    log: HTMLElement;
    textarea: HTMLTextAreaElement;
    send: HTMLButtonElement;
  } {
    const root = el("div", "fl-assist");
    root.style.display = "none";

    const head = el("div", "fl-assist-h");
    const spark = el("span", "fl-assist-spark");
    spark.innerHTML = ICON_SPARK;
    const headText = el("div");
    const title = el("div", "fl-assist-title");
    title.textContent = m.assistant.title;
    const sub = el("div", "fl-assist-sub");
    sub.textContent = m.assistant.sub;
    headText.append(title, sub);
    const closeBtn = button("", "fl-iconbtn sm", () => close());
    closeBtn.innerHTML = ICON_X;
    closeBtn.title = m.assistant.closeTitle;
    closeBtn.style.marginLeft = "auto";
    head.append(spark, headText, closeBtn);

    const log = el("div", "fl-assist-body");

    const foot = el("div", "fl-assist-foot");
    const chips = el("div", "fl-chips");
    const SUGGESTIONS = m.assistant.suggestions;
    for (const s of SUGGESTIONS) {
      const chip = button(s, "fl-chip", () => {
        textarea.value = s;
        textarea.focus();
        syncSend();
      });
      chips.append(chip);
    }
    const composer = el("div", "fl-composer");
    const textarea = document.createElement("textarea");
    textarea.rows = 1;
    textarea.placeholder = m.assistant.composerPlaceholder;
    const send = button("", "fl-send", () => void sendTurn()) as HTMLButtonElement;
    send.innerHTML = ICON_SEND;
    send.disabled = true;
    send.title = m.assistant.sendTitle;
    composer.append(textarea, send);

    const syncSend = () => {
      send.disabled = textarea.value.trim().length === 0;
    };
    textarea.addEventListener("input", syncSend);
    textarea.addEventListener("keydown", (e) => {
      // Enter sends; Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!send.disabled) void sendTurn();
      }
    });

    foot.append(chips, composer);
    root.append(head, log, foot);
    return { el: root, log, textarea, send };
  }

  const dock = buildAssistantDock();

  /** Show the assistant rail (hides the inspector so the viewer stays full-width). */
  function open(): void {
    assistantOpen = true;
    onOpenChange(true);
    dock.el.style.display = "";
    if (dock.log.childElementCount === 0) greetAssistant();
    dock.textarea.focus();
  }

  /** Hide the assistant rail; restore the inspector. */
  function close(): void {
    assistantOpen = false;
    dock.el.style.display = "none";
    onOpenChange(false);
    setGhosts([]); // don't leave dashed previews floating with the rail hidden
  }

  function toggle(): void {
    if (assistantOpen) close();
    else open();
  }

  /** Seed the log with a one-time greeting (the first time the dock opens). */
  function greetAssistant(): void {
    appendBubble("ai", m.assistant.greeting);
  }

  /** Append a chat bubble (`.fl-msg` + `.fl-bubble`) to the log and scroll to it. */
  function appendBubble(who: "user" | "ai", text: string, warn?: string): HTMLElement {
    const msg = el("div", `fl-msg ${who}`);
    const label = el("div", "who");
    label.textContent = who === "user" ? m.assistant.youLabel : m.assistant.assistantLabel;
    const bubble = el("div", "fl-bubble");
    bubble.textContent = text;
    if (warn) {
      const w = el("span", "warn");
      w.textContent = warn;
      bubble.append(w);
    }
    msg.append(label, bubble);
    dock.log.append(msg);
    dock.log.scrollTop = dock.log.scrollHeight;
    return msg;
  }

  /** A transient "thinking…" bubble; returns a disposer that removes it. */
  function appendThinking(): () => void {
    const msg = el("div", "fl-msg ai");
    const bubble = el("div", "fl-bubble");
    const think = el("div", "fl-think");
    think.innerHTML = "<i></i><i></i><i></i>";
    bubble.append(think);
    msg.append(bubble);
    dock.log.append(msg);
    dock.log.scrollTop = dock.log.scrollHeight;
    return () => msg.remove();
  }

  /**
   * Assemble the per-turn `AssistantContext` from live editor state: the working
   * region (post content-crop), In/Out + duration, detected scene cuts, suggested
   * swells, the resolved models, and the BYOK key (read fresh from the keychain).
   * `source` lets the vision runner extract frames. Returns null with a friendly
   * message when there is no source or no key.
   */
  async function buildAssistantContext(): Promise<
    | { ok: true; ctx: Parameters<ReturnType<typeof createAssistant>["turn"]>[0]["context"] }
    | { ok: false; reason: string }
  > {
    if (!state.source || !state.dims) {
      return { ok: false, reason: m.assistant.needSource };
    }
    // First keychain touch happens here (lazily), not at launch — so a user who
    // never opens the assistant never sees an OS keychain prompt. Reads fresh so
    // a key entered in Settings this session is honored.
    await ensureApiKey();
    if (!getApiKey().trim()) {
      return {
        ok: false,
        reason: m.assistant.needKey,
      };
    }
    const region = currentRegion();
    const models = resolveModels(assistantSelection());
    const overlay = loadAssistantOverlay(); // editor's append-only framing preferences
    // Sparse still strip (#40): sample a few frames so the model SEES the footage.
    // System-chosen, bounded by the user's budget; failures degrade to fewer/no stills.
    const stills = await sampleChatStills({
      source: state.source,
      budget: loadChatStillsBudget(),
      inPoint: state.inPoint,
      outPoint: state.outPoint,
      duration: state.duration,
      sceneCuts: state.sceneCuts,
      extractFrame: (source, t) => platform.extractFrame(source, t),
    });
    const ctx = assembleAssistantContext({
      region: { width: region.width, height: region.height },
      source: state.source,
      models,
      apiKey: getApiKey().trim(),
      basePrompt: BASE_PROMPT, // the read-only framing brain (prompts/base.md)
      overlay,
      inPoint: state.inPoint,
      outPoint: state.outPoint,
      duration: state.duration,
      sceneCuts: state.sceneCuts,
      swells: state.swells,
      stills,
    });
    return { ok: true, ctx };
  }

  /** Run one assistant turn end-to-end: assemble context → call the model → render. */
  async function sendTurn(): Promise<void> {
    const message = dock.textarea.value.trim();
    if (!message) return;
    dock.textarea.value = "";
    dock.send.disabled = true;
    setGhosts([]); // a new turn supersedes any still-previewing proposals
    appendBubble("user", message);
    assistantHistory.push({ role: "user", text: message });

    const built = await buildAssistantContext();
    if (!built.ok) {
      appendBubble("ai", built.reason);
      assistantHistory.push({ role: "assistant", text: built.reason });
      return;
    }

    const dispose = appendThinking();
    try {
      const assistant = createAssistant({
        selection: assistantSelection(),
        platform,
      });
      const reply: AssistantReply = await assistant.turn({
        message,
        context: built.ctx,
        history: assistantHistory.slice(0, -1), // exclude the just-pushed user line
      });
      dispose();
      renderReply(reply);
      assistantHistory.push({ role: "assistant", text: reply.text });
    } catch (err) {
      dispose();
      const failMsg = `${m.assistant.turnFailedPrefix}${errMsg(err)}`;
      appendBubble("ai", failMsg);
      assistantHistory.push({ role: "assistant", text: failMsg });
    }
  }

  /** Render one reply: prose bubble + grounding chips + proposal cards + action bar. */
  function renderReply(reply: AssistantReply): void {
    const msg = appendBubble("ai", reply.text, reply.warn);
    const bubble = msg.querySelector(".fl-bubble");
    if (bubble && reply.grounding.length) bubble.append(groundingRow(reply.grounding));

    if (bubble && reply.usage) bubble.append(usageRow(reply.usage, reply.costUsd));

    pendingActions = reply.actions.slice();
    stepIndex = 0;
    setGhosts(ghostsFrom(pendingActions, 0));
    if (pendingActions.length) dock.log.append(proposalCard(pendingActions));
    dock.log.scrollTop = dock.log.scrollHeight;
  }

  /**
   * The per-turn usage/cost footer under an AI bubble: exact total tokens plus an
   * estimated USD cost (tokens × a maintained rate table — `assistant/cost.ts`).
   * The dollar figure is omitted when the model's price is unknown; the tooltip
   * breaks down in/out tokens and flags that the cost is an estimate.
   */
  function usageRow(usage: Usage, costUsd?: number): HTMLElement {
    const row = el("div", "fl-usage");
    const tok = el("span", "tok");
    tok.textContent = `${usage.totalTokens.toLocaleString()} ${m.assistant.usageTokens}`;
    row.append(tok);
    if (costUsd != null) {
      const cost = el("span", "cost");
      cost.textContent = `~${fmtUsd(costUsd)}`;
      row.append(cost);
    }
    row.title =
      `${usage.promptTokens.toLocaleString()} ${m.assistant.usageInLabel} + ` +
      `${usage.outputTokens.toLocaleString()} ${m.assistant.usageOutLabel} · ` +
      m.assistant.usageEstNote;
    return row;
  }

  /** "grounded in …" chip row citing the real signals (never audio). */
  function groundingRow(grounding: Grounding[]): HTMLElement {
    const row = el("div", "fl-ground");
    const lab = el("span", "gl");
    lab.textContent = m.assistant.grounded;
    row.append(lab);
    for (const g of grounding) {
      const chip = el("span", "gchip");
      chip.textContent = g.detail ?? `${g.kind} @ ${fmtClock(g.t, true)}`;
      row.append(chip);
    }
    return row;
  }

  /**
   * The proposed-action card: a mono list of `→ fn detail` rows plus an
   * Accept all · Step · Discard bar. Accept applies every commit through the
   * editor's existing mutations; Step applies one at a time; Discard clears the
   * proposals (state untouched). Rows mark `.active` / `.done` / `.skip`.
   */
  function proposalCard(actions: ProposedAction[]): HTMLElement {
    const card = el("div", "fl-prop");
    const h = el("div", "fl-prop-h");
    h.append(document.createTextNode(m.assistant.proposed));
    const n = el("span", "n");
    n.textContent = `${actions.length} ${actions.length === 1 ? m.assistant.actionSingular : m.assistant.actionPlural}`;
    h.append(n);

    const list = el("div", "fl-prop-list");
    const rows: HTMLElement[] = actions.map((a) => {
      const row = el("div", "fl-act");
      const arrow = el("span", "arrow");
      arrow.textContent = m.assistant.arrow;
      const fn = el("span", "fn");
      fn.textContent = a.display.fn;
      const detail = el("span", "detail");
      detail.textContent = a.display.detail;
      const tick = el("span", "tick");
      tick.innerHTML = ICON_CHECK;
      row.append(arrow, fn, detail, tick);
      list.append(row);
      return row;
    });

    const bar = el("div", "fl-prop-bar");
    const acceptBtn = button(m.assistant.acceptAll, "fl-btn primary sm");
    const stepLab = el("span", "step");
    const stepBtn = button(m.assistant.step, "fl-btn sm");
    const discardBtn = button(m.assistant.discard, "fl-btn sm ghost");

    const markActiveStep = () => {
      rows.forEach((r, i) =>
        r.classList.toggle("active", i === stepIndex && stepIndex < actions.length),
      );
      stepLab.textContent = `${Math.min(stepIndex, actions.length)}/${actions.length}`;
    };

    const finish = (note: string, kind: "" | "ok" = "ok") => {
      bar.remove();
      const done = el("div", "fl-applied-note");
      if (kind === "ok") done.innerHTML = ICON_CHECK;
      const span = el("span");
      span.textContent = note;
      done.append(span);
      card.append(done);
    };

    acceptBtn.addEventListener("click", () => {
      let staged = false;
      let applied = 0;
      for (let i = stepIndex; i < actions.length; i++) {
        const a = actions[i]!;
        const res = applyCommit(a.commit);
        rows[i]!.classList.remove("active");
        rows[i]!.classList.add(res.applied ? "done" : "skip");
        if (res.applied) applied++;
        if (res.staged) staged = true;
      }
      stepIndex = actions.length;
      pendingActions = [];
      setGhosts([]); // committed — drop the previews
      finish(
        staged
          ? `${m.assistant.appliedStagedPrefix}${applied}${m.assistant.appliedStagedSuffix}`
          : `${m.assistant.appliedPrefix}${applied}${applied === 1 ? m.assistant.appliedSuffixSingular : m.assistant.appliedSuffixPlural}`,
      );
    });

    stepBtn.addEventListener("click", () => {
      if (stepIndex >= actions.length) return;
      const a = actions[stepIndex]!;
      const res = applyCommit(a.commit);
      rows[stepIndex]!.classList.remove("active");
      rows[stepIndex]!.classList.add(res.applied ? "done" : "skip");
      stepIndex++;
      markActiveStep();
      // Drop the ghost for the just-committed action; keep the rest previewing.
      setGhosts(ghostsFrom(actions, stepIndex));
      if (stepIndex >= actions.length) {
        pendingActions = [];
        finish(m.assistant.steppedThrough);
      }
    });

    discardBtn.addEventListener("click", () => {
      rows.forEach((r) => r.classList.add("skip"));
      pendingActions = [];
      stepIndex = actions.length;
      setGhosts([]); // nothing committed, but the previews go away
      finish(m.assistant.discarded, "");
    });

    bar.append(acceptBtn, stepLab, stepBtn, discardBtn);
    markActiveStep();
    card.append(h, list, bar);
    return card;
  }

  return {
    element: dock.el,
    open,
    close,
    toggle,
    isOpen: () => assistantOpen,
  };
}
