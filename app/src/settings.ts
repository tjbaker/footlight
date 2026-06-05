// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings — a left-nav modal with five panels (General / Rendering / AI &
 * models / Shortcuts / About). It is a *surface* over capability that already
 * lives elsewhere in the app: theme + timecode + default destination +
 * autosave (General), the render flags (Rendering), the BYOK key in the OS
 * keychain + tracking interval (AI), the keyboard bindings (Shortcuts), and the
 * build metadata from `version.ts` (About).
 *
 * Persistence is split by sensitivity, never inline in a config/session file:
 * - the BYOK API key lives in the OS keychain via the platform `secretStore`
 *   under `GEMINI_API_KEY_SECRET` (a DEV-ONLY localStorage shim on the web build);
 * - every other preference is a small `localStorage` blob (see the `*_KEY`s below),
 *   reusing the keys the editor already reads (`footlight.theme`, `footlight.outdir`)
 *   so the two stay in sync.
 *
 * NOTE (out of slice): the Rendering panel maps 1:1 to `--crf/--preset/
 * --audio-bitrate/--dry-run`, but `platform.render` only threads `{ outdir }`
 * today, so these defaults are persisted + surfaced here and *not yet* passed to
 * the render call. Wiring them through `platform.render` + the editor's render
 * path is a follow-up (those files are outside this PR's slice).
 */

import { messages } from "./i18n/index.js";
import { GEMINI_API_KEY_SECRET, loadAutoTrackSettings, saveAutoTrackSettings } from "./autotrack.js";
import { platform } from "./platform/index.js";
import {
  APP_NAME,
  APP_VERSION,
  LICENSE,
  REPO_URL,
  ISSUES_NEW_URL,
} from "./version.js";

// ---- tiny DOM builders (self-contained; mirror editor.ts's el()/button()) ----

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function button(label: string, cls?: string, onClick?: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

/** A `<span class="fl-set-secth">` heading + optional `.fl-set-secsub` sub. */
function panelHeader(title: string, sub?: string): HTMLElement {
  const wrap = el("div");
  const h = el("div", "fl-set-secth");
  h.textContent = title;
  wrap.append(h);
  if (sub) {
    const s = el("div", "fl-set-secsub");
    s.textContent = sub;
    wrap.append(s);
  }
  return wrap;
}

/** A titled block (`.fl-set-block` + `.fl-set-blockh` label). */
function block(title: string): { root: HTMLElement; body: HTMLElement } {
  const root = el("div", "fl-set-block");
  const head = el("div", "fl-set-blockh");
  const lab = el("span", "fl-label");
  lab.textContent = title;
  head.append(lab);
  const body = el("div");
  root.append(head, body);
  return { root, body };
}

/**
 * A segmented control (`.fl-seg`). `value` is the initially-selected option;
 * `onPick` fires with the chosen value. Returns the element.
 */
function segmented<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  onPick: (v: T) => void,
): HTMLElement {
  const seg = el("div", "fl-seg");
  for (const opt of options) {
    const b = button(opt.label, opt.value === value ? "on" : undefined, () => {
      for (const child of Array.from(seg.children)) child.classList.remove("on");
      b.classList.add("on");
      onPick(opt.value);
    });
    seg.append(b);
  }
  return seg;
}

/** A pill-toggle switch (`.fl-switch`). Returns the element + a getter. */
function toggleSwitch(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const sw = el("div", on ? "fl-switch on" : "fl-switch");
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", String(on));
  sw.append(el("div", "knob"));
  sw.addEventListener("click", () => {
    const next = !sw.classList.contains("on");
    sw.classList.toggle("on", next);
    sw.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  return sw;
}

/** A labeled General-panel row (`.fl-row2` + `.fl-rowlab`). */
function labeledRow(label: string, ...controls: HTMLElement[]): HTMLElement {
  const row = el("div", "fl-row2");
  const lab = el("span", "fl-rowlab");
  lab.textContent = label;
  row.append(lab, ...controls);
  return row;
}

// ---- persisted preferences (localStorage; key reuse noted above) ----

type ThemeMode = "light" | "dark" | "system";
type Timecode = "smpte" | "frames";
type AudioMode = "copy" | "reencode";

const THEME_KEY = "footlight.theme"; // shared with the editor's top-bar toggle
const OUTDIR_KEY = "footlight.outdir"; // shared with the editor's destination field
const TIMECODE_KEY = "footlight.timecode";
const AUTOSAVE_KEY = "footlight.autosave";
const RENDER_KEY = "footlight.render"; // { crf, preset, audio, bitrate, dryRun }
const AI_KEY = "footlight.ai"; // { provider, model }

const PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;
type Preset = (typeof PRESETS)[number];

interface RenderPrefs {
  crf: number;
  preset: Preset;
  audio: AudioMode;
  bitrate: string; // "192k" | "256k" | "320k"
  dryRun: boolean;
}

const DEFAULT_RENDER: RenderPrefs = {
  crf: 19,
  preset: "medium",
  audio: "copy",
  bitrate: "256k",
  dryRun: false,
};

interface AiPrefs {
  provider: string; // "gemini" | "claude" | "openai"
  model: string;
}

const DEFAULT_AI: AiPrefs = { provider: "gemini", model: "gemini-3.5-flash" };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage unavailable — non-fatal. */
  }
}

function readStr(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStr(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-fatal */
  }
}

// ---- theme (light / dark / system) ----

let systemThemeMql: MediaQueryList | null = null;
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

function osPrefersDark(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function loadThemeMode(): ThemeMode {
  const v = readStr(THEME_KEY, "light");
  return v === "dark" || v === "system" ? v : "light";
}

/** Resolve a mode to a concrete light|dark, write `data-theme`, and (for System)
 *  install a `prefers-color-scheme` listener so the root follows the OS live. */
function applyThemeMode(mode: ThemeMode): void {
  // Tear down any prior System listener; re-installed below only when needed.
  if (systemThemeMql && systemThemeListener) {
    systemThemeMql.removeEventListener("change", systemThemeListener);
    systemThemeMql = null;
    systemThemeListener = null;
  }
  const resolve = (): "light" | "dark" =>
    mode === "system" ? (osPrefersDark() ? "dark" : "light") : mode;
  document.documentElement.setAttribute("data-theme", resolve());
  if (mode === "system" && typeof window.matchMedia === "function") {
    systemThemeMql = window.matchMedia("(prefers-color-scheme: dark)");
    systemThemeListener = () =>
      document.documentElement.setAttribute("data-theme", resolve());
    systemThemeMql.addEventListener("change", systemThemeListener);
  }
}

/**
 * Apply the persisted theme on startup. Called once from app boot so the
 * System mode's media listener is live even before Settings is opened, and the
 * root carries the resolved `data-theme`.
 */
export function initTheme(): void {
  applyThemeMode(loadThemeMode());
}

function persistThemeMode(mode: ThemeMode): void {
  writeStr(THEME_KEY, mode);
  applyThemeMode(mode);
}

// ---- icons (stroke set matching the app) ----

const ICON_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>';
const ICON_BRAND =
  '<svg class="fl-lamp" viewBox="14 12 72 68" fill="currentColor" aria-hidden="true"><g class="beam"><polygon points="27,66 37,66 44,20 20,20"/><polygon points="45,66 55,66 62,20 38,20"/><polygon points="63,66 73,66 80,20 56,20"/></g><rect x="20" y="69" width="60" height="5.5" rx="2.75"/><path d="M24.5,69 A7.5 7.5 0 0 1 39.5,69 Z"/><path d="M42.5,69 A7.5 7.5 0 0 1 57.5,69 Z"/><path d="M60.5,69 A7.5 7.5 0 0 1 75.5,69 Z"/></svg>';
const ICON_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';
const ICON_KEY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2" stroke-linecap="round"/></svg>';
const ICON_SPARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>';
const ICON_GEAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2.5l1.3 2.4 2.7-.3 .6 2.6 2.4 1.3-1 2.5 1 2.5-2.4 1.3-.6 2.6-2.7-.3L12 21.5l-1.3-2.4-2.7.3-.6-2.6L5 15.5l1-2.5-1-2.5 2.4-1.3.6-2.6 2.7.3z" stroke-linejoin="round"/></svg>';
const ICON_FILM =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4" stroke-linecap="round"/></svg>';
const ICON_KEYBOARD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" stroke-linecap="round"/></svg>';
const ICON_INFO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01" stroke-linecap="round"/></svg>';
const ICON_LINK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1.5-1.5"/></svg>';

// ---- shortcuts data (mirrors shortcuts.ts groups; read-only here) ----

interface ScRow {
  keys: string[];
  desc: string;
}
interface ScGroup {
  title: string;
  rows: ScRow[];
}
const SHORTCUT_GROUPS: ScGroup[] = [
  {
    title: "Playback",
    rows: [
      { keys: ["Space"], desc: "Play / pause" },
      { keys: ["←", "→"], desc: "Step 1 frame back / forward" },
      { keys: ["Shift", "←"], desc: "Nudge time −0.1s" },
      { keys: ["Shift", "→"], desc: "Nudge time +0.1s" },
    ],
  },
  {
    title: "Marking",
    rows: [
      { keys: ["I"], desc: "Set In at the playhead" },
      { keys: ["O"], desc: "Set Out at the playhead" },
      { keys: ["S"], desc: "Add the current clip to the queue" },
    ],
  },
  {
    title: "Navigation",
    rows: [
      { keys: ["["], desc: "Jump to previous scene cut" },
      { keys: ["]"], desc: "Jump to next scene cut" },
    ],
  },
  {
    title: "Framing",
    rows: [
      { keys: ["Alt", "←"], desc: "Nudge the crop left" },
      { keys: ["Alt", "→"], desc: "Nudge the crop right" },
      { keys: ["Alt", "↑"], desc: "Nudge the crop up (punch-in)" },
      { keys: ["Alt", "↓"], desc: "Nudge the crop down (punch-in)" },
      { keys: ["Double-click"], desc: "Reset framing to full-height 9:16" },
    ],
  },
  {
    title: "Help",
    rows: [
      { keys: ["?"], desc: "Show this shortcuts overlay" },
      { keys: ["Esc"], desc: "Close any dialog" },
    ],
  },
];

// ---- AI model catalog (illustrative pricing; wire to real pricing later) ----

interface ModelOpt {
  id: string;
  name: string;
  recommended?: boolean;
  cap: string;
  speed: string;
  /** Illustrative cost in USD per sampled still frame. */
  perFrame: number;
}
/**
 * Model catalog, keyed by provider. Pricing is illustrative. Only Gemini is
 * wired today (the vision/assistant adapters); the Anthropic/OpenAI lists are
 * shown for the provider-agnostic picker and should be confirmed before those
 * providers are implemented.
 */
const MODEL_CATALOG = {
  gemini: [
    { id: "gemini-3.5-pro", name: "Gemini 3.5 Pro", cap: "Highest-quality reasoning + vision.", speed: "slower", perFrame: 0.0015 },
    {
      id: "gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      recommended: true,
      cap: "Fast, capable multimodal — the sweet spot for tracking.",
      speed: "fast",
      perFrame: 0.0004,
    },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", cap: "Cheapest; good for dense sampling.", speed: "fastest", perFrame: 0.00015 },
  ],
  // Anthropic / OpenAI have no adapter yet (see IMPLEMENTED_PROVIDERS) — no models listed.
} satisfies Record<string, ModelOpt[]>;

/** Providers with a working adapter today; others are shown but flagged "not yet implemented". */
const IMPLEMENTED_PROVIDERS = new Set<string>(["gemini"]);

/** Models for a provider; empty for a provider that isn't implemented yet. */
function modelsFor(provider: string): ModelOpt[] {
  return (MODEL_CATALOG as Record<string, ModelOpt[]>)[provider] ?? [];
}
/** A provider's default model id (recommended, else first, else the global default). */
function defaultModelFor(provider: string): string {
  const ms = modelsFor(provider);
  return (ms.find((m) => m.recommended) ?? ms[0])?.id ?? DEFAULT_AI.model;
}

/** Per-request flat cost the assistant adds on top of per-frame vision (illustrative). */
const ASSISTANT_PER_REQUEST = 0.004;

function fmtUsd(n: number): string {
  return "$" + n.toFixed(4);
}

// ---- key persistence (OS keychain via secretStore) ----

async function saveApiKey(key: string): Promise<void> {
  try {
    if (key) await platform.setSecret(GEMINI_API_KEY_SECRET, key);
    else await platform.deleteSecret(GEMINI_API_KEY_SECRET);
  } catch {
    /* keychain unavailable (locked, denied, etc.) — non-fatal for the modal. */
  }
}

// =====================================================================
// Panels
// =====================================================================

function buildGeneralPanel(): HTMLElement {
  const s = messages.settings.general;
  const root = el("div");
  root.append(panelHeader(s.title, s.subtitle));

  // Appearance — theme + timecode
  const appearance = block(s.appearance);
  appearance.body.append(
    labeledRow(
      s.theme,
      segmented<ThemeMode>(
        [
          { value: "light", label: s.themeLight },
          { value: "dark", label: s.themeDark },
          { value: "system", label: s.themeSystem },
        ],
        loadThemeMode(),
        (v) => persistThemeMode(v),
      ),
    ),
    labeledRow(
      s.timecode,
      segmented<Timecode>(
        [
          { value: "smpte", label: "MM:SS.mmm" },
          { value: "frames", label: s.timecodeFrames },
        ],
        readStr(TIMECODE_KEY, "smpte") === "frames" ? "frames" : "smpte",
        (v) => writeStr(TIMECODE_KEY, v),
      ),
    ),
  );
  root.append(appearance.root);

  // Defaults — destination + tracking interval
  const defaults = block(s.defaults);

  const destField = el("div", "fl-field path");
  destField.style.flex = "1";
  destField.innerHTML = `<span class="ic">${ICON_FOLDER}</span>`;
  const destInput = document.createElement("input");
  destInput.type = "text";
  destInput.className = "mono";
  destInput.value = readStr(OUTDIR_KEY, "clips");
  destInput.addEventListener("change", () =>
    writeStr(OUTDIR_KEY, destInput.value.trim() || "clips"),
  );
  destField.append(destInput);
  const browse = button(s.destinationBrowse, "fl-btn sm", () => {
    void platform.pickDirectory().then((dir) => {
      if (dir) {
        destInput.value = dir;
        writeStr(OUTDIR_KEY, dir);
      }
    });
  });
  if (!platform.supportsFilePicker) browse.disabled = true;
  const destRow = labeledRow(s.destination, destField, browse);
  const destHint = el("div", "fl-rowhint");
  destHint.style.cssText = "font-family:inherit; width:100%; color:var(--faint); margin-top:2px;";
  destHint.textContent = s.destinationHint;

  const at = loadAutoTrackSettings();
  const intervalRow = labeledRow(
    s.trackingInterval,
    segmented<string>(
      [
        { value: "0.5", label: "0.50s" },
        { value: "0.75", label: "0.75s" },
        { value: "1", label: "1.00s" },
        { value: "1.5", label: "1.50s" },
      ],
      String(at.intervalSec),
      (v) => saveAutoTrackSettings({ ...loadAutoTrackSettings(), intervalSec: Number(v) }),
    ),
  );
  const intervalHint = el("div", "fl-rowhint");
  intervalHint.style.cssText = "font-family:inherit; width:100%; color:var(--faint); margin-top:2px;";
  intervalHint.textContent = s.trackingIntervalHint;

  defaults.body.append(destRow, destHint, intervalRow, intervalHint);
  root.append(defaults.root);

  // Session — autosave + clear
  const session = block(s.session);
  const autosaveOn = readStr(AUTOSAVE_KEY, "on") !== "off";
  const autosaveRow = el("div", "fl-adv-toggle");
  autosaveRow.style.cursor = "default";
  const sw = toggleSwitch(autosaveOn, (v) => writeStr(AUTOSAVE_KEY, v ? "on" : "off"));
  const autosaveBody = el("div");
  autosaveBody.style.flex = "1";
  const autosaveTitle = el("div", "fl-adv-title");
  autosaveTitle.textContent = s.autosave;
  const autosaveSub = el("div", "fl-adv-sub");
  autosaveSub.textContent = s.autosaveHint;
  autosaveBody.append(autosaveTitle, autosaveSub);
  autosaveRow.append(autosaveBody, sw);

  const clearWrap = el("div");
  clearWrap.style.marginTop = "11px";
  const clearBtn = button(s.clearSession, "fl-btn sm ghost danger", () => {
    void platform
      .saveSession({ source: "", outdir: "", clips: [], savedAt: Date.now() })
      .catch(() => undefined);
    clearBtn.textContent = s.sessionCleared;
    clearBtn.disabled = true;
  });
  clearWrap.append(clearBtn);

  session.body.append(autosaveRow, clearWrap);
  root.append(session.root);

  return root;
}

function buildRenderingPanel(): HTMLElement {
  const s = messages.settings.rendering;
  const prefs = readJson<RenderPrefs>(RENDER_KEY, DEFAULT_RENDER);
  const save = () => writeJson(RENDER_KEY, prefs);

  const root = el("div");
  root.append(panelHeader(s.title, s.subtitle));

  // gap note (the persistence-only follow-up)
  const gap = el("div", "fl-set-secsub");
  gap.style.cssText = "margin-top:8px; color:var(--accent-2);";
  gap.textContent = s.gapNote;
  root.append(gap);

  // Quality (CRF) range
  const qualityBlock = block(s.quality);
  const range = document.createElement("input");
  range.type = "range";
  range.className = "fl-range";
  range.min = "14";
  range.max = "28";
  range.step = "1";
  range.value = String(prefs.crf);
  const ends = el("div", "fl-range-ends");
  const readout = el("span");
  const qualityWord = (crf: number): string =>
    crf <= 17 ? s.qualityNearLossless : crf <= 20 ? s.qualityHigh : crf <= 23 ? s.qualityGood : s.qualitySmaller;
  const paintReadout = () => {
    readout.textContent = `CRF ${prefs.crf} · ${qualityWord(prefs.crf)}`;
  };
  const left = el("span");
  left.textContent = "14 · near-lossless";
  const right = el("span");
  right.textContent = "28 · smaller";
  ends.append(left, readout, right);
  paintReadout();
  range.addEventListener("input", () => {
    prefs.crf = Number(range.value);
    paintReadout();
    save();
  });
  qualityBlock.body.append(range, ends);
  root.append(qualityBlock.root);

  // Encoder preset chips
  const presetBlock = block(s.preset);
  const presetRow = el("div", "fl-preset-row");
  for (const p of PRESETS) {
    const chip = button(p, p === prefs.preset ? "fl-preset on" : "fl-preset", () => {
      for (const c of Array.from(presetRow.children)) c.classList.remove("on");
      chip.classList.add("on");
      prefs.preset = p;
      save();
    });
    presetRow.append(chip);
  }
  const presetHint = el("div", "fl-set-secsub");
  presetHint.style.marginTop = "10px";
  presetHint.textContent = s.presetHint;
  presetBlock.body.append(presetRow, presetHint);
  root.append(presetBlock.root);

  // Audio
  const audioBlock = block(s.audio);
  const audioHint = el("div", "fl-set-secsub");
  audioHint.style.marginTop = "10px";
  const bitrateWrap = el("div", "fl-row2");
  bitrateWrap.style.marginTop = "12px";
  const bitrateLab = el("span", "fl-rowlab");
  bitrateLab.textContent = s.bitrate;
  const bitrateSeg = segmented<string>(
    [
      { value: "192k", label: "192k" },
      { value: "256k", label: "256k" },
      { value: "320k", label: "320k" },
    ],
    prefs.bitrate,
    (v) => {
      prefs.bitrate = v;
      save();
    },
  );
  bitrateWrap.append(bitrateLab, bitrateSeg);
  const syncAudioUi = () => {
    audioHint.textContent = prefs.audio === "copy" ? s.audioCopyHint : s.audioReencodeHint;
    bitrateWrap.style.display = prefs.audio === "reencode" ? "flex" : "none";
  };
  const audioSeg = segmented<AudioMode>(
    [
      { value: "copy", label: s.audioCopy },
      { value: "reencode", label: s.audioReencode },
    ],
    prefs.audio,
    (v) => {
      prefs.audio = v;
      syncAudioUi();
      save();
    },
  );
  syncAudioUi();
  audioBlock.body.append(audioSeg, audioHint, bitrateWrap);
  root.append(audioBlock.root);

  // Dry-run switch
  const dryBlock = block(s.dryRun);
  const dryToggle = el("div", "fl-adv-toggle");
  dryToggle.style.cursor = "default";
  const dryBody = el("div");
  dryBody.style.flex = "1";
  const dryTitle = el("div", "fl-adv-title");
  dryTitle.textContent = s.dryRun;
  const drySub = el("div", "fl-adv-sub");
  drySub.textContent = s.dryRunHint;
  dryBody.append(dryTitle, drySub);
  dryToggle.append(
    dryBody,
    toggleSwitch(prefs.dryRun, (v) => {
      prefs.dryRun = v;
      save();
    }),
  );
  dryBlock.body.append(dryToggle);
  root.append(dryBlock.root);

  return root;
}

function buildAiPanel(): HTMLElement {
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
    const chip = el("div", p.id === prefs.provider ? "fl-prov on" : "fl-prov");
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
    chip.addEventListener("click", () => {
      for (const c of Array.from(provRow.children)) c.classList.remove("on");
      chip.classList.add("on");
      prefs.provider = p.id;
      // The selected model must belong to the new provider — reset to its default
      // if not, then re-render the model list and recompute the cost.
      if (!modelsFor(p.id).some((m) => m.id === prefs.model)) {
        prefs.model = defaultModelFor(p.id);
      }
      save();
      renderModels();
      paintCost();
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
  void platform
    .getSecret(GEMINI_API_KEY_SECRET)
    .then((v) => {
      keyInput.value = v ?? "";
    })
    .catch(() => undefined);
  keyInput.addEventListener("input", () => void saveApiKey(keyInput.value.trim()));
  keyField.append(keyInput);
  const showBtn = button(s.apiKeyShow, "fl-btn sm", () => {
    const showing = keyInput.type === "text";
    keyInput.type = showing ? "password" : "text";
    showBtn.textContent = showing ? s.apiKeyShow : s.apiKeyHide;
  });
  const testBtn = button(s.apiKeyTest, "fl-btn sm");
  testBtn.disabled = true; // live key-test needs backend plumbing (out of slice)
  testBtn.title = s.apiKeyTest;
  keyRow.append(keyField, showBtn, testBtn);
  const keyHint = el("div", "fl-keyhint");
  keyHint.innerHTML = ICON_KEY;
  const keyHintText = document.createElement("span");
  keyHintText.textContent = s.apiKeyHint;
  keyHint.append(keyHintText);
  keyBlock.body.append(keyRow, keyHint);
  root.append(keyBlock.root);

  // Model picker (radio cards)
  const modelBlock = block(s.model);
  const optList = el("div");
  optList.style.cssText = "display:flex; flex-direction:column; gap:9px;";
  function renderModels(): void {
    optList.replaceChildren();
    if (!IMPLEMENTED_PROVIDERS.has(prefs.provider)) {
      const notice = el("div", "fl-set-secsub");
      notice.style.cssText = "padding:10px 2px; line-height:1.5;";
      notice.textContent = s.notImplementedBody;
      optList.append(notice);
      return;
    }
    for (const m of modelsFor(prefs.provider)) {
    const card = el("div", m.id === prefs.model ? "fl-opt sel" : "fl-opt");
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
    cost.innerHTML = `${fmtUsd(m.perFrame)}/frame <span class="tier">· ~${fmtUsd(m.perFrame * 27 + ASSISTANT_PER_REQUEST)}/req</span>`;
    meta.append(speed, cost);
    body.append(top, cap, meta);
    card.append(radio, body);
    card.addEventListener("click", () => {
      for (const c of Array.from(optList.children)) c.classList.remove("sel");
      card.classList.add("sel");
      prefs.model = m.id;
      save();
      paintCost();
    });
    optList.append(card);
    }
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
    const model = models.find((m) => m.id === prefs.model) ?? models.find((m) => m.recommended) ?? models[0]!;
    const trackCost = frames * model.perFrame;
    noteText.innerHTML = `${s.costNote} ${interval.toFixed(2)}s ≈ <b>${frames} frames</b> ≈ <b>${fmtUsd(trackCost)}</b> with ${model.name}. The assistant adds only ~<b>${fmtUsd(ASSISTANT_PER_REQUEST)}</b> per request.`;
  }
  paintCost();
  modelBlock.body.append(note);
  root.append(modelBlock.root);

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
    toggleSwitch(false, (on) => {
      advArea.style.display = on ? "block" : "none";
    }),
  );
  advBlock.body.append(advToggle, advArea);
  root.append(advBlock.root);

  return root;
}

function buildShortcutsPanel(): HTMLElement {
  const s = messages.settings.shortcuts;
  const root = el("div");
  root.append(panelHeader(s.title, s.subtitle));
  for (const group of SHORTCUT_GROUPS) {
    const b = block(group.title);
    const list = el("div", "fl-sc-list");
    for (const r of group.rows) {
      const row = el("div", "fl-sc-row");
      const desc = el("span", "fl-sc-desc");
      desc.textContent = r.desc;
      const keys = el("span", "fl-sc-keys");
      r.keys.forEach((k, i) => {
        if (i > 0) {
          const plus = el("span", "plus");
          plus.textContent = "+";
          keys.append(plus);
        }
        const kbd = el("span", "fl-kbd");
        kbd.textContent = k;
        keys.append(kbd);
      });
      row.append(desc, keys);
      list.append(row);
    }
    b.body.append(list);
    root.append(b.root);
  }
  return root;
}

function buildAboutPanel(): HTMLElement {
  const s = messages.settings.about;
  const root = el("div");
  root.append(panelHeader(s.title, s.subtitle));

  const idBlock = block(s.title);
  const id = el("div", "fl-about-id");
  const mark = el("div");
  mark.innerHTML = ICON_BRAND;
  const idMeta = el("div");
  const idName = el("div");
  idName.style.cssText =
    'font-family:"Bricolage Grotesque",sans-serif; font-weight:700; font-size:20px; letter-spacing:-0.02em;';
  idName.textContent = APP_NAME;
  const idVer = el("div", "fl-rowhint");
  idVer.style.marginTop = "3px";
  idVer.textContent = `v${APP_VERSION} · ${LICENSE} · © 2026 Trevor Baker`;
  idMeta.append(idName, idVer);
  id.append(mark, idMeta);

  const links = el("div", "fl-link-row");
  const repoBtn = button(s.repo, "fl-btn", () => {
    void platform.openExternal(REPO_URL).catch(() => undefined);
  });
  repoBtn.insertAdjacentHTML("afterbegin", ICON_LINK);
  const bugBtn = button(s.reportBug, "fl-btn", () => {
    void platform.openExternal(ISSUES_NEW_URL).catch(() => undefined);
  });
  bugBtn.insertAdjacentHTML("afterbegin", ICON_LINK);
  const licBtn = button(s.licenses, "fl-btn", () => {
    void platform.openExternal(`${REPO_URL}/blob/main/NOTICE`).catch(() => undefined);
  });
  licBtn.insertAdjacentHTML("afterbegin", ICON_LINK);
  links.append(repoBtn, bugBtn, licBtn);
  idBlock.body.append(id, links);
  root.append(idBlock.root);

  // Environment — a static read-out (a live `make doctor` probe needs backend
  // plumbing not present in the platform seam; surfaced read-only here).
  const envBlock = block(s.environment);
  const env = el("div", "fl-env");
  const rows: [string, string][] = [
    ["ffmpeg", "from PATH"],
    ["ffprobe", "from PATH"],
    ["node", "from PATH"],
    ["yt-dlp", "optional"],
  ];
  for (const [k, v] of rows) {
    const row = el("div", "fl-env-row");
    const dot = el("span", "fl-dot");
    const key = el("span", "fl-env-k");
    key.textContent = k;
    const val = el("span", "fl-env-v");
    val.textContent = v;
    row.append(dot, key, val);
    env.append(row);
  }
  const envHint = el("div", "fl-set-secsub");
  envHint.textContent = s.environmentHint;
  envBlock.body.append(env, envHint);
  root.append(envBlock.root);

  return root;
}

// =====================================================================
// Shell
// =====================================================================

type PanelId = "general" | "rendering" | "ai" | "shortcuts" | "about";

const NAV: { id: PanelId; icon: string; label: () => string; build: () => HTMLElement }[] = [
  { id: "general", icon: ICON_GEAR, label: () => messages.settings.nav.general, build: buildGeneralPanel },
  { id: "rendering", icon: ICON_FILM, label: () => messages.settings.nav.rendering, build: buildRenderingPanel },
  { id: "ai", icon: ICON_SPARK, label: () => messages.settings.nav.ai, build: buildAiPanel },
  { id: "shortcuts", icon: ICON_KEYBOARD, label: () => messages.settings.nav.shortcuts, build: buildShortcutsPanel },
  { id: "about", icon: ICON_INFO, label: () => messages.settings.nav.about, build: buildAboutPanel },
];

/** Show the Settings modal, landing on the General panel. */
export function openSettings(): void {
  const s = messages.settings;

  const backdrop = el("div", "fl-modal-backdrop");
  const modal = el("div", "fl-modal settings");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", s.title);

  // header: spark mark + "Settings" + close ✕
  const head = el("div", "fl-modal-h");
  const titleWrap = el("div");
  titleWrap.style.cssText = "display:flex; align-items:center; gap:11px;";
  const spark = el("span", "fl-assist-spark");
  spark.innerHTML = ICON_SPARK;
  const title = el("span", "fl-label");
  title.style.fontSize = "14px";
  title.textContent = s.title;
  titleWrap.append(spark, title);
  const closeBtn = button("", "fl-iconbtn");
  closeBtn.innerHTML = ICON_X;
  closeBtn.title = s.close;
  head.append(titleWrap, el("span", "fl-spacer"), closeBtn);

  // body: nav + main
  const setRoot = el("div", "fl-set fl-grow");
  const nav = el("div", "fl-set-nav");
  const main = el("div", "fl-set-main");

  const navItems = new Map<PanelId, HTMLElement>();
  let current: PanelId = "general";

  const renderPanel = (id: PanelId): void => {
    current = id;
    for (const [pid, item] of navItems) item.classList.toggle("on", pid === id);
    main.replaceChildren(NAV.find((n) => n.id === id)!.build());
    main.scrollTop = 0;
  };

  for (const item of NAV) {
    const navItem = el("div", "fl-set-navitem");
    navItem.innerHTML = item.icon;
    const lab = document.createElement("span");
    lab.textContent = item.label();
    navItem.append(lab);
    navItem.addEventListener("click", () => renderPanel(item.id));
    navItems.set(item.id, navItem);
    nav.append(navItem);
  }
  setRoot.append(nav, main);

  // footer: Cancel / Save (settings persist live, so both just close)
  const foot = el("div", "fl-modal-foot");
  const cancelBtn = button(s.cancel, "fl-btn ghost", () => dismiss());
  const saveBtn = button(s.save, "fl-btn primary", () => dismiss());
  foot.append(el("span", "fl-spacer"), cancelBtn, saveBtn);

  modal.append(head, setRoot, foot);
  backdrop.append(modal);
  document.body.append(backdrop);

  renderPanel(current);

  const dismiss = (): void => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") dismiss();
  }
  closeBtn.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) dismiss();
  });
  document.addEventListener("keydown", onKey);
}
