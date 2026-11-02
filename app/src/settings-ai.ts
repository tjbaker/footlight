// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings → AI & models (#270): provider, BYOK key, model, cost, chat stills, framing overlay.
 */

import { messages } from "./i18n/index.js";
import {
  GEMINI_API_KEY_SECRET,
  loadAutoTrackSettings,
  saveAutoTrackSettings,
} from "./autotrack.js";
import { platform } from "./platform/index.js";
import { BASE_PROMPT } from "./assistant/base-prompt.js";
import { priceForModel } from "@assistant-cost";
import { perFrameUsd, perRequestUsd } from "./settings-util.js";
import { el, button, ensureId } from "./ui.js";
import { createGeneration } from "./generation.js";
import {
  ICON_KEY,
  ICON_SPARK,
  block,
  panelHeader,
  segmented,
  toggleSwitch,
} from "./settings-controls.js";
import {
  type AiPrefs,
  AI_KEY,
  DEFAULT_AI,
  OVERLAY_MAX_CHARS,
  loadChatStillsBudget,
  readJson,
  writeJson,
} from "./settings-store.js";
import {
  IMPLEMENTED_PROVIDERS,
  defaultModelFor,
  fmtUsd,
  modelsFor,
} from "./settings-ai-catalog.js";
import {
  KEY_TEST_TIMEOUT_MS,
  apiKeySaves,
  queueApiKeySave,
  testGeminiKey,
} from "./settings-ai-key.js";

export function buildAiPanel(): HTMLElement {
  const s = messages.settings.ai;
  const prefs = readJson<AiPrefs>(AI_KEY, DEFAULT_AI);
  const save = () => writeJson(AI_KEY, prefs);

  const root = el("div");
  root.append(panelHeader(s.title, s.subtitle));

  // Provider chips
  const providerBlock = block(s.provider);
  const provRow = el("div", "fl-prov-row");
  const providers = [
    { id: "gemini", name: s.providerGemini, connected: true },
    { id: "claude", name: s.providerClaude, connected: false },
    { id: "openai", name: s.providerOpenai, connected: false },
  ];
  for (const p of providers) {
    const implemented = IMPLEMENTED_PROVIDERS.has(p.id);
    // A real button (Tab + Enter/Space); `aria-pressed` carries the selection.
    const chip = button("", p.id === prefs.provider ? "fl-prov on" : "fl-prov");
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(p.id === prefs.provider));
    if (!p.connected) chip.classList.add("add");
    if (!implemented) {
      chip.classList.add("soon");
      chip.title = s.notImplementedBody;
    }
    const dot = el("span", "pdot");
    const name = el("span", "pname");
    name.textContent = p.name;
    const stat = el("span", "pstat");
    stat.textContent = !implemented
      ? s.notImplemented
      : p.connected
        ? s.providerConnected
        : s.providerAddKey;
    chip.append(dot, name, stat);
    chip.setAttribute("aria-labelledby", ensureId(name, "prov-name"));
    chip.setAttribute("aria-describedby", ensureId(stat, "prov-stat"));
    chip.addEventListener("click", () => {
      for (const c of Array.from(provRow.children)) {
        c.classList.remove("on");
        c.setAttribute("aria-pressed", "false");
      }
      chip.classList.add("on");
      chip.setAttribute("aria-pressed", "true");
      prefs.provider = p.id;
      // The selected model must belong to the new provider — reset to its default
      // if not, then re-render the model list and recompute the cost.
      if (!modelsFor(p.id).some((m) => m.id === prefs.model)) {
        prefs.model = defaultModelFor(p.id);
      }
      save();
      renderModels();
      paintCost();
      syncTestEnabled(); // Test is only meaningful for an implemented provider
    });
    provRow.append(chip);
  }
  providerBlock.body.append(provRow);
  root.append(providerBlock.root);

  // API key (OS keychain) — password field + Show/Hide + Test
  const keyBlock = block(s.apiKey);
  const keyRow = el("div", "fl-set-key");
  const keyField = el("div", "fl-field");
  keyField.style.flex = "1";
  keyField.innerHTML = `<span class="ic">${ICON_KEY}</span>`;
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.className = "mono";
  keyInput.placeholder = s.apiKeyPlaceholder;
  // Hydrate AFTER any in-flight save (e.g. one committed as the modal closed),
  // so a reopened panel reads the key just written, not the one before it. A
  // field the user has already typed into is left alone.
  let keyEdited = false;
  void apiKeySaves
    .then(() => platform.getSecret(GEMINI_API_KEY_SECRET))
    .then((v) => {
      if (keyEdited) return;
      keyInput.value = v ?? "";
      syncTestEnabled(); // a key hydrated from the keychain enables Test
    })
    .catch(() => undefined);
  const showBtn = button(s.apiKeyShow, "fl-btn sm", () => {
    const showing = keyInput.type === "text";
    keyInput.type = showing ? "password" : "text";
    showBtn.textContent = showing ? s.apiKeyShow : s.apiKeyHide;
  });
  // Live key test: a 1-token generateContent against the selected model. Only
  // meaningful for an implemented provider with a key present.
  const testStatus = el("span", "fl-set-test");
  testStatus.setAttribute("aria-live", "polite");
  const testBtn = button(s.apiKeyTest, "fl-btn sm");
  testBtn.title = s.apiKeyTest;
  const syncTestEnabled = (): void => {
    testBtn.disabled =
      !IMPLEMENTED_PROVIDERS.has(prefs.provider) || keyInput.value.trim().length === 0;
  };
  // Only the LATEST test may report, and only for the key still in the field:
  // a result for an edited-away key (or a superseded click) is dropped (#264).
  const keyTestGen = createGeneration();
  testBtn.addEventListener("click", () => {
    const key = keyInput.value.trim();
    if (!key) return;
    const isCurrent = keyTestGen.begin();
    testBtn.disabled = true;
    testStatus.className = "fl-set-test";
    testStatus.textContent = s.apiKeyTesting;
    const model = IMPLEMENTED_PROVIDERS.has(prefs.provider) ? prefs.model : DEFAULT_AI.model;
    // A hung request must not leave Test disabled forever: abort it after a
    // bound; testGeminiKey reports the abort as a failure like any other.
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), KEY_TEST_TIMEOUT_MS);
    void testGeminiKey(key, model, ctrl.signal)
      .then((r) => {
        if (!isCurrent() || keyInput.value.trim() !== key) return;
        if (r.ok) {
          testStatus.className = "fl-set-test ok";
          testStatus.textContent = s.apiKeyValid;
        } else {
          testStatus.className = "fl-set-test err";
          testStatus.textContent = `${s.apiKeyInvalid} — ${r.detail}`;
        }
      })
      .finally(() => {
        window.clearTimeout(timer);
        // The latest test always re-enables Test; a superseded one leaves the
        // button to the test (or edit) that replaced it.
        if (isCurrent()) syncTestEnabled();
      });
  });
  // Persist the key on COMMIT (change = blur/Enter), like the other text fields
  // here — not per keystroke, whose racing writes could land out of order and
  // store a truncated key (#278). Commits join the module-wide save chain.
  keyInput.addEventListener("change", () => queueApiKeySave(keyInput.value.trim()));
  keyInput.addEventListener("input", () => {
    keyEdited = true;
    testStatus.textContent = ""; // a new key invalidates the prior result
    testStatus.className = "fl-set-test";
    syncTestEnabled();
  });
  keyField.append(keyInput);
  syncTestEnabled();
  keyRow.append(keyField, showBtn, testBtn, testStatus);
  const keyHint = el("div", "fl-keyhint");
  keyHint.innerHTML = ICON_KEY;
  const keyHintText = document.createElement("span");
  keyHintText.textContent = s.apiKeyHint;
  keyHint.append(keyHintText);
  keyBlock.body.append(keyRow, keyHint);
  root.append(keyBlock.root);

  // Model picker (radio cards): a radiogroup with one Tab stop (the checked
  // card, roving tabindex); arrows move the selection, Space/Enter pick.
  const modelBlock = block(s.model);
  const optList = el("div");
  optList.style.cssText = "display:flex; flex-direction:column; gap:9px;";
  optList.setAttribute("aria-label", s.model);
  const modelCards = (): HTMLElement[] =>
    Array.from(optList.querySelectorAll<HTMLElement>('[role="radio"]'));
  function selectModel(card: HTMLElement): void {
    for (const c of modelCards()) {
      const on = c === card;
      c.classList.toggle("sel", on);
      c.setAttribute("aria-checked", String(on));
      c.tabIndex = on ? 0 : -1;
    }
    prefs.model = card.dataset.model!;
    save();
    paintCost();
  }
  optList.addEventListener("keydown", (e) => {
    const cards = modelCards();
    const at = cards.indexOf(e.target as HTMLElement);
    if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return; // leave OS/browser combos alone
    const last = cards.length - 1;
    const to: Record<string, number> = {
      ArrowDown: at === last ? 0 : at + 1,
      ArrowRight: at === last ? 0 : at + 1,
      ArrowUp: at === 0 ? last : at - 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
      " ": at,
      Enter: at,
    };
    const next = cards[to[e.key] ?? -1];
    if (!next) return;
    e.preventDefault();
    selectModel(next);
    next.focus();
  });
  function renderModels(): void {
    optList.replaceChildren();
    if (!IMPLEMENTED_PROVIDERS.has(prefs.provider)) {
      optList.removeAttribute("role");
      const notice = el("div", "fl-set-secsub");
      notice.style.cssText = "padding:10px 2px; line-height:1.5;";
      notice.textContent = s.notImplementedBody;
      optList.append(notice);
      return;
    }
    optList.setAttribute("role", "radiogroup");
    for (const m of modelsFor(prefs.provider)) {
      const card = el("div", m.id === prefs.model ? "fl-opt sel" : "fl-opt");
      card.dataset.model = m.id;
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(m.id === prefs.model));
      card.tabIndex = m.id === prefs.model ? 0 : -1;
      const radio = el("span", "radio");
      const body = el("div", "fl-opt-body");
      const top = el("div", "fl-opt-top");
      const name = el("span", "fl-opt-name");
      name.textContent = m.name;
      top.append(name);
      if (m.recommended) {
        const badge = el("span", "fl-pill on");
        badge.textContent = s.recommended;
        top.append(badge);
      }
      const cap = el("div", "fl-opt-cap");
      cap.textContent = m.cap;
      const meta = el("div", "fl-opt-meta");
      const speed = el("span", "fl-tag-speed");
      speed.textContent = m.speed;
      const cost = el("span", "fl-tag-cost");
      // Only show a cost tag for a model we have a published rate for — never a
      // misleading $0.0000 for an unpriced model.
      if (priceForModel(m.id)) {
        cost.innerHTML = `${fmtUsd(perFrameUsd(m.id))}${s.perFrame} <span class="tier">· ~${fmtUsd(perRequestUsd(m.id))}${s.perRequest}</span>`;
      }
      meta.append(speed, cost);
      body.append(top, cap, meta);
      card.append(radio, body);
      card.setAttribute("aria-labelledby", ensureId(name, "model-name"));
      card.setAttribute("aria-describedby", ensureId(cap, "model-cap"));
      card.addEventListener("click", () => selectModel(card));
      optList.append(card);
    }
    // No card checked (a stale saved model): the first one is the Tab stop.
    const cards = modelCards();
    if (cards.length && !cards.some((c) => c.tabIndex === 0)) cards[0]!.tabIndex = 0;
  }
  renderModels();
  modelBlock.body.append(optList);

  // Cost callout with a live interval recompute
  const note = el("div", "fl-costnote");
  note.innerHTML = ICON_SPARK;
  const ct = el("div", "ct");
  const noteText = el("span");
  const intervalCtl = segmented<string>(
    [
      { value: "0.5", label: "0.50s" },
      { value: "0.75", label: "0.75s" },
      { value: "1", label: "1.00s" },
      { value: "1.5", label: "1.50s" },
    ],
    String(loadAutoTrackSettings().intervalSec),
    (v) => {
      saveAutoTrackSettings({ ...loadAutoTrackSettings(), intervalSec: Number(v) });
      paintCost();
    },
  );
  intervalCtl.style.marginTop = "9px";
  const ctlLabel = el("div");
  ctlLabel.style.cssText = "margin-top:9px; font-size:11.5px; color:var(--muted);";
  ctlLabel.textContent = s.costInterval;
  ct.append(noteText, ctlLabel, intervalCtl);
  note.append(ct);

  function paintCost(): void {
    const models = modelsFor(prefs.provider);
    if (models.length === 0) {
      note.style.display = "none"; // no cost line for a not-yet-implemented provider
      return;
    }
    note.style.display = "";
    const interval = loadAutoTrackSettings().intervalSec || 0.75;
    const frames = Math.max(1, Math.round(20 / interval));
    const model =
      models.find((m) => m.id === prefs.model) ?? models.find((m) => m.recommended) ?? models[0]!;
    const trackCost = frames * perFrameUsd(model.id);
    noteText.innerHTML = `${s.costNote} ${interval.toFixed(2)}s ≈ <b>${frames} frames</b> ≈ <b>${fmtUsd(trackCost)}</b> with ${model.name}. The assistant adds about ~<b>${fmtUsd(perRequestUsd(model.id))}</b> per request.`;
  }
  paintCost();
  modelBlock.body.append(note);
  root.append(modelBlock.root);

  // Chat stills (#40): how many frames the assistant samples + sees per message.
  // Cost is per frame, so it lives next to the model/cost block; 0 = state-only.
  const stillsBlock = block(s.chatStills);
  const stillsCtl = segmented<string>(
    [
      { value: "0", label: s.chatStillsOff },
      { value: "2", label: "2" },
      { value: "4", label: "4" },
      { value: "6", label: "6" },
      { value: "8", label: "8" },
    ],
    String(loadChatStillsBudget()),
    (v) => {
      prefs.chatStills = Number(v);
      save();
    },
  );
  const stillsHint = el("div", "fl-set-secsub");
  stillsHint.style.marginTop = "8px";
  stillsHint.textContent = s.chatStillsHint;
  stillsBlock.body.append(stillsCtl, stillsHint);
  root.append(stillsBlock.root);

  // Framing preferences — an append-only overlay composed ON TOP of the
  // read-only base prompt (it refines, never replaces it; see composeSystemPrompt).
  const overlayBlock = block(s.overlayTitle);
  const overlaySub = el("div", "fl-set-secsub");
  overlaySub.style.cssText = "margin-bottom:9px; line-height:1.5;";
  overlaySub.textContent = s.overlaySub;
  const overlayArea = document.createElement("textarea");
  overlayArea.className = "fl-set-overlay mono";
  overlayArea.rows = 4;
  overlayArea.maxLength = OVERLAY_MAX_CHARS;
  overlayArea.placeholder = s.overlayPlaceholder;
  overlayArea.value = prefs.overlay ?? "";
  const overlayCount = el("div", "fl-set-overlay-count");
  const paintCount = (): void => {
    overlayCount.textContent = `${overlayArea.value.length}/${OVERLAY_MAX_CHARS}`;
  };
  paintCount();
  overlayArea.addEventListener("input", () => {
    prefs.overlay = overlayArea.value;
    save();
    paintCount();
  });
  overlayBlock.body.append(overlaySub, overlayArea, overlayCount);

  // Read-only base prompt (transparency): show exactly what the overlay sits on.
  const baseSub = el("div", "fl-set-secsub");
  baseSub.style.cssText = "margin:14px 0 7px; line-height:1.5;";
  baseSub.textContent = s.baseViewSub;
  const basePre = document.createElement("pre");
  basePre.className = "fl-set-baseview mono";
  basePre.textContent = BASE_PROMPT;
  basePre.style.display = "none";
  const baseBtn = button(s.baseViewShow, "fl-btn sm", () => {
    const showing = basePre.style.display !== "none";
    basePre.style.display = showing ? "none" : "block";
    baseBtn.textContent = showing ? s.baseViewShow : s.baseViewHide;
  });
  const baseHead = el("div", "fl-set-baseview-head");
  const baseLabel = el("span");
  baseLabel.textContent = s.baseView;
  baseHead.append(baseLabel, baseBtn);
  overlayBlock.body.append(baseSub, baseHead, basePre);
  root.append(overlayBlock.root);

  // Advanced: separate vision/tracking model (off by default)
  const advBlock = block("Advanced");
  const advToggle = el("div", "fl-adv-toggle");
  const advBody = el("div");
  advBody.style.flex = "1";
  const advTitle = el("div", "fl-adv-title");
  advTitle.textContent = s.advanced;
  const advSub = el("div", "fl-adv-sub");
  advSub.textContent = s.advancedSub;
  advBody.append(advTitle, advSub);
  const advArea = el("div", "fl-adv-body");
  advArea.style.display = "none";
  advArea.textContent = ""; // populated only when split is on (power-user path)
  const advNote = el("div", "fl-set-secsub");
  advNote.textContent = `${s.assistantModel} · ${s.visionModel}`;
  advArea.append(advNote);
  advToggle.append(
    advBody,
    toggleSwitch(
      false,
      (on) => {
        advArea.style.display = on ? "block" : "none";
      },
      advTitle,
      advSub,
    ),
  );
  advBlock.body.append(advToggle, advArea);
  root.append(advBlock.root);

  return root;
}
