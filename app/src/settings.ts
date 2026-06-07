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
import { BASE_PROMPT } from "./assistant/base-prompt.js";
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
const FONTS_DIR_KEY = "footlight.fontsDir"; // plain string: a folder of user .ttf/.otf fonts
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
  /**
   * Burn captions into the exported video (off by default — a clean export is
   * the default). The caption content/position comes from the clip; this is the
   * global opt-in to render them at all.
   */
  burnCaptions: boolean;
  /**
   * Bring-your-own caption font: a `.ttf`/`.otf` path or an installed font
   * family name. Empty means the system default — fonts are NEVER bundled.
   */
  captionFont: string;
  /** Caption fill (text) color, `#RRGGBB`. Default white. */
  captionColor: string;
  /** Caption outline color, `#RRGGBB`. Default black. */
  captionOutlineColor: string;
  /** Caption text styling — bold / italic / underline (word-processor style). */
  captionBold: boolean;
  captionItalic: boolean;
  captionUnderline: boolean;
  /** Caption drop shadow (offset shadow behind the text). */
  captionShadow: boolean;
  /** Caption background box behind the text. */
  captionBox: boolean;
  /** Caption box color, `#RRGGBB`. Default black. */
  captionBoxColor: string;
  /** Caption rotation in degrees (e.g. −30…30). Default 0. */
  captionAngle: number;
}

const DEFAULT_RENDER: RenderPrefs = {
  crf: 19,
  preset: "medium",
  audio: "copy",
  bitrate: "256k",
  dryRun: false,
  burnCaptions: false,
  captionFont: "",
  captionColor: "#FFFFFF",
  captionOutlineColor: "#000000",
  captionBold: false,
  captionItalic: false,
  captionUnderline: false,
  captionShadow: false,
  captionBox: false,
  captionBoxColor: "#000000",
  captionAngle: 0,
};

interface AiPrefs {
  provider: string; // "gemini" | "claude" | "openai"
  model: string;
  /**
   * Append-only "framing preferences" overlay composed ON TOP of the read-only
   * base prompt (never replaces it). Optional; whitespace-only is treated as
   * absent. Capped at OVERLAY_MAX_CHARS.
   */
  overlay?: string;
}

const DEFAULT_AI: AiPrefs = { provider: "gemini", model: "gemini-3.5-flash" };

/**
 * Hard cap on the overlay length. Not a security boundary (the overlay is the
 * user's own input on their own machine + key) — it just keeps a runaway paste
 * from bloating every turn's tokens. The real safety boundary is structural: the
 * base prompt is read-only, the operational/safety preamble is always composed
 * LAST, and nothing the model proposes mutates state without a human Accept.
 */
const OVERLAY_MAX_CHARS = 2000;

/** The editor's saved framing-preferences overlay (trimmed; "" when unset). */
export function loadAssistantOverlay(): string {
  const prefs = readJson<AiPrefs>(AI_KEY, DEFAULT_AI);
  return (prefs.overlay ?? "").trim();
}

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

/**
 * Validate a Gemini BYOK key by making the SAME fetch-only `generateContent`
 * call the assistant uses (header auth, no key in the URL), with a 1-token reply
 * so it's the cheapest request that still exercises auth + the chosen model.
 * Returns `ok` plus a short detail for the failure case. Runs entirely in the
 * renderer — the generativelanguage endpoint is CORS-enabled for API-key use,
 * which is also why `GeminiAssistant` can call it directly.
 */
async function testGeminiKey(
  key: string,
  model: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal,
    });
    if (res.ok) return { ok: true, detail: "" };
    // Surface the API's own message (e.g. "API key not valid") when present.
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string; status?: string } };
      if (j.error?.message) detail = j.error.message;
      else if (j.error?.status) detail = j.error.status;
    } catch {
      /* non-JSON body — keep the HTTP status. */
    }
    return { ok: false, detail };
  } catch (err) {
    // Network / CORS / abort — report the message so it isn't a silent no-op.
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
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

  // Captions — global opt-in (off by default) + bring-your-own font
  const capBlock = block(s.captions);

  const capToggle = el("div", "fl-adv-toggle");
  capToggle.style.cursor = "default";
  const capBody = el("div");
  capBody.style.flex = "1";
  const capTitle = el("div", "fl-adv-title");
  capTitle.textContent = s.burnCaptions;
  const capSub = el("div", "fl-adv-sub");
  capSub.textContent = s.burnCaptionsHint;
  capBody.append(capTitle, capSub);
  capToggle.append(
    capBody,
    toggleSwitch(prefs.burnCaptions, (v) => {
      prefs.burnCaptions = v;
      save();
    }),
  );

  // --- Caption style: a familiar word-processor text toolbar — fill/outline
  // color (native <input type=color>) + a B/I/U toggle row. Always shown (not
  // gated behind the burn toggle) with a subtle "applies when on" hint; binds
  // to the captionColor / captionOutlineColor / captionBold/Italic/Underline
  // RenderPrefs keys and persists via save().
  const styleGroupHead = el("div", "fl-set-blockh");
  styleGroupHead.style.marginTop = "14px";
  const styleGroupLab = el("span", "fl-label");
  styleGroupLab.textContent = s.captionStyle;
  styleGroupHead.append(styleGroupLab);

  // A labeled native color input bound to a RenderPrefs string key.
  const colorRow = (label: string, value: string, onPick: (v: string) => void): HTMLElement => {
    const field = el("div", "fl-field");
    field.style.cssText = "flex:1; gap:9px; align-items:center; cursor:pointer;";
    const input = document.createElement("input");
    input.type = "color";
    input.value = value;
    input.style.cssText =
      "width:30px; height:24px; padding:0; border:none; background:none; cursor:pointer; flex:none;";
    const hex = el("span", "mono");
    hex.style.cssText = "font-size:12px; color:var(--faint);";
    hex.textContent = value.toUpperCase();
    input.addEventListener("input", () => {
      const v = input.value.toUpperCase();
      hex.textContent = v;
      onPick(v);
    });
    field.append(input, hex);
    return labeledRow(label, field);
  };

  const fillRow = colorRow(s.captionColor, prefs.captionColor, (v) => {
    prefs.captionColor = v;
    save();
  });
  const outlineRow = colorRow(s.captionOutlineColor, prefs.captionOutlineColor, (v) => {
    prefs.captionOutlineColor = v;
    save();
  });

  // B / I / U — a small segmented row of toggle buttons (each glyph rendered in
  // its own face). Each toggles its boolean key independently.
  const biuSeg = el("div", "fl-seg");
  const biuButton = (
    label: string,
    css: string,
    aria: string,
    initial: boolean,
    onToggle: (v: boolean) => void,
  ): HTMLButtonElement => {
    const b = button(label, initial ? "on" : undefined);
    b.type = "button";
    b.style.cssText = css;
    b.setAttribute("aria-pressed", String(initial));
    b.addEventListener("click", () => {
      const next = !b.classList.contains("on");
      b.classList.toggle("on", next);
      b.setAttribute("aria-pressed", String(next));
      onToggle(next);
    });
    b.setAttribute("aria-label", aria);
    return b;
  };
  biuSeg.append(
    biuButton(s.captionBoldGlyph, "font-weight:700;", s.captionBold, prefs.captionBold, (v) => {
      prefs.captionBold = v;
      save();
    }),
    biuButton(s.captionItalicGlyph, "font-style:italic;", s.captionItalic, prefs.captionItalic, (v) => {
      prefs.captionItalic = v;
      save();
    }),
    biuButton(
      s.captionUnderlineGlyph,
      "text-decoration:underline;",
      s.captionUnderline,
      prefs.captionUnderline,
      (v) => {
        prefs.captionUnderline = v;
        save();
      },
    ),
  );
  const biuRow = labeledRow(s.captionEmphasis, biuSeg);

  // --- Effects: drop shadow + background box (with its own color) — a second
  // segmented toggle row, same biuButton helper as B/I/U. The box-color input
  // sits beside the row and dims to a disabled look when the box is off.
  const fxSeg = el("div", "fl-seg");
  let boxOn = prefs.captionBox;
  // The box color sits in its own labeled row; reflect the box on/off state by
  // disabling + dimming the input (kept visible so the layout doesn't jump).
  const boxColorInput = document.createElement("input");
  boxColorInput.type = "color";
  boxColorInput.value = prefs.captionBoxColor;
  boxColorInput.style.cssText =
    "width:30px; height:24px; padding:0; border:none; background:none; cursor:pointer; flex:none;";
  const boxColorHex = el("span", "mono");
  boxColorHex.style.cssText = "font-size:12px; color:var(--faint);";
  boxColorHex.textContent = prefs.captionBoxColor.toUpperCase();
  const reflectBoxColorState = () => {
    boxColorInput.disabled = !boxOn;
    boxColorRow.style.opacity = boxOn ? "" : "0.45";
    boxColorRow.style.pointerEvents = boxOn ? "" : "none";
  };
  boxColorInput.addEventListener("input", () => {
    const v = boxColorInput.value.toUpperCase();
    boxColorHex.textContent = v;
    prefs.captionBoxColor = v;
    save();
  });
  const boxColorField = el("div", "fl-field");
  boxColorField.style.cssText = "flex:1; gap:9px; align-items:center; cursor:pointer;";
  boxColorField.append(boxColorInput, boxColorHex);
  const boxColorRow = labeledRow(s.captionBoxColor, boxColorField);

  fxSeg.append(
    biuButton("", "", s.captionShadow, prefs.captionShadow, (v) => {
      prefs.captionShadow = v;
      save();
    }),
    biuButton("", "", s.captionBox, prefs.captionBox, (v) => {
      prefs.captionBox = v;
      boxOn = v;
      reflectBoxColorState();
      save();
    }),
  );
  // The biuButton helper sets textContent from its label; give these word
  // labels (not glyphs) since they're toggles for named effects.
  (fxSeg.children[0] as HTMLElement).textContent = s.captionShadow;
  (fxSeg.children[1] as HTMLElement).textContent = s.captionBox;
  const fxRow = labeledRow(s.captionEffects, fxSeg);
  reflectBoxColorState();

  // --- Rotation: a range slider (−30…30°) with the live degree value shown.
  const angleField = el("div", "fl-field");
  angleField.style.cssText = "flex:1; gap:9px; align-items:center;";
  const angleInput = document.createElement("input");
  angleInput.type = "range";
  angleInput.min = "-30";
  angleInput.max = "30";
  angleInput.step = "1";
  angleInput.value = String(prefs.captionAngle);
  angleInput.style.cssText = "flex:1; cursor:pointer;";
  const angleVal = el("span", "mono");
  angleVal.style.cssText = "font-size:12px; color:var(--faint); min-width:34px; text-align:right;";
  angleVal.textContent = `${prefs.captionAngle}°`;
  angleInput.addEventListener("input", () => {
    const v = Number(angleInput.value);
    angleVal.textContent = `${v}°`;
    prefs.captionAngle = v;
    save();
  });
  angleField.append(angleInput, angleVal);
  const angleRow = labeledRow(s.captionRotation, angleField);

  const styleAppliesHint = el("div", "fl-set-secsub");
  styleAppliesHint.style.marginTop = "8px";
  styleAppliesHint.textContent = s.captionStyleAppliesHint;

  // --- Caption font: a custom dropdown (per-row live preview) over the free-
  // text field. The picker SETS prefs.captionFont (a family name); "Custom
  // path…" reveals the free-text field for a .ttf/.otf path. If font
  // enumeration is unavailable we show only the free-text field (today's UX).

  // The free-text path field (always built; hidden behind "Custom path…" once
  // the dropdown is in play, shown on its own as the no-enumeration fallback).
  const fontField = el("div", "fl-field path");
  fontField.style.flex = "1";
  const fontInput = document.createElement("input");
  fontInput.type = "text";
  fontInput.className = "mono";
  fontInput.placeholder = s.captionFontPlaceholder;
  fontInput.value = prefs.captionFont;
  fontInput.addEventListener("change", () => {
    prefs.captionFont = fontInput.value.trim();
    save();
  });
  fontField.append(fontInput);
  const fontRow = labeledRow(s.captionFont, fontField);

  // Sentinels for the two non-family rows (leading space keeps them out of any
  // real family namespace).
  const SENTINEL_DEFAULT = " default";
  const SENTINEL_CUSTOM = " custom";

  // The dropdown trigger (a .fl-field-styled button) + its popup. Built up
  // front but only inserted once listFonts() yields families.
  const pickerField = el("div", "fl-field");
  pickerField.style.cssText = "flex:1; position:relative; cursor:pointer; gap:0;";
  const trigger = button("", undefined);
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.style.cssText =
    "flex:1; min-width:0; display:flex; align-items:center; justify-content:space-between; gap:9px; background:none; border:none; outline:none; color:var(--text); font:inherit; font-size:13px; padding:0; text-align:left; cursor:pointer;";
  const triggerLabel = el("span");
  triggerLabel.style.cssText = "min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
  const caret = el("span");
  caret.textContent = "▾"; // ▾
  caret.style.cssText = "flex:none; color:var(--faint); font-size:11px;";
  trigger.append(triggerLabel, caret);
  pickerField.append(trigger);

  const popup = el("ul");
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", s.captionFont);
  popup.style.cssText =
    "position:absolute; top:calc(100% + 6px); left:0; right:0; z-index:40; margin:0; padding:5px; list-style:none; max-height:260px; overflow-y:auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:var(--shadow); display:none;";
  pickerField.append(popup);
  const pickerRow = labeledRow(s.captionFont, pickerField);

  const closePopup = () => {
    popup.style.display = "none";
    trigger.setAttribute("aria-expanded", "false");
  };
  const openPopup = () => {
    popup.style.display = "block";
    trigger.setAttribute("aria-expanded", "true");
    popup.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popup.style.display === "block") closePopup();
    else openPopup();
  });
  // Click-away + Esc anywhere close the popup.
  const onDocClick = (e: MouseEvent) => {
    if (!pickerField.contains(e.target as Node)) closePopup();
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closePopup();
  };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKey);

  // Reflect a selection onto the trigger label (in its own face) + free-text
  // visibility. Single-quotes are stripped so the inline family value can't
  // break out of its quoting. `display` overrides the shown text/face for a
  // family whose stored value is a file path (folder fonts) — show the family,
  // never the raw path.
  const syncPickerUi = (value: string, display?: { label: string; face: string }) => {
    const custom = value === SENTINEL_CUSTOM;
    fontRow.style.display = custom ? "" : "none";
    if (custom) {
      triggerLabel.textContent = s.captionFontCustom;
      triggerLabel.style.fontFamily = "";
    } else if (value === SENTINEL_DEFAULT || value === "") {
      triggerLabel.textContent = s.captionFontSystemDefault;
      triggerLabel.style.fontFamily = "";
    } else if (display) {
      triggerLabel.textContent = display.label;
      triggerLabel.style.fontFamily = `'${display.face.replace(/'/g, "")}'`;
    } else {
      triggerLabel.textContent = value;
      triggerLabel.style.fontFamily = `'${value.replace(/'/g, "")}'`;
    }
  };

  const fontHint = el("div", "fl-set-secsub");
  fontHint.style.marginTop = "8px";
  fontHint.textContent = s.captionFontHint;

  const styleNote = el("div", "fl-set-secsub");
  styleNote.style.marginTop = "8px";
  styleNote.textContent = s.captionStyleNote;

  // --- Fonts folder: a typed path (web) / Browse… (Tauri) bound to its own
  // plain-string key (footlight.fontsDir). When set, the picker scans it via
  // listUserFonts() and lists the results in a top "Your fonts" group. The
  // free-text field above is unrelated (a single .ttf path / family name); this
  // is a *folder* you drop fonts into.
  const fontsDirField = el("div", "fl-field path");
  fontsDirField.style.flex = "1";
  fontsDirField.innerHTML = `<span class="ic">${ICON_FOLDER}</span>`;
  const fontsDirInput = document.createElement("input");
  fontsDirInput.type = "text";
  fontsDirInput.className = "mono";
  fontsDirInput.placeholder = s.fontsDirPlaceholder;
  fontsDirInput.value = readStr(FONTS_DIR_KEY, "");
  fontsDirField.append(fontsDirInput);
  const fontsDirBrowse = button(s.fontsDirBrowse, "fl-btn sm", () => {
    void platform.pickDirectory().then((dir) => {
      if (dir) {
        fontsDirInput.value = dir;
        writeStr(FONTS_DIR_KEY, dir);
        rebuildPicker();
      }
    });
  });
  if (!platform.supportsFilePicker) fontsDirBrowse.disabled = true;
  const fontsDirRow = labeledRow(s.fontsDir, fontsDirField, fontsDirBrowse);
  fontsDirInput.addEventListener("change", () => {
    writeStr(FONTS_DIR_KEY, fontsDirInput.value.trim());
    rebuildPicker();
  });
  const fontsDirHint = el("div", "fl-rowhint");
  fontsDirHint.style.cssText = "font-family:inherit; width:100%; color:var(--faint); margin-top:2px;";
  fontsDirHint.textContent = s.fontsDirHint;

  // Default layout = free-text only (the fallback). Async: if families come
  // back, swap in the dropdown and put the free-text field behind "Custom path…".
  capBlock.body.append(
    capToggle,
    styleGroupHead,
    fillRow,
    outlineRow,
    biuRow,
    fxRow,
    boxColorRow,
    angleRow,
    styleAppliesHint,
    fontRow,
    fontHint,
    fontsDirRow,
    fontsDirHint,
    styleNote,
  );
  root.append(capBlock.root);

  // An option in the picker. A folder font carries `path` (selection sets
  // captionFont = path so the engine resolves family + fontsdir); a system font
  // has no path (selection sets captionFont = family, as today). `face` is the
  // CSS family for the per-row live preview (best-effort).
  type Opt = { value: string; label: string; face?: string; path?: string };

  let selected = SENTINEL_DEFAULT; // updated by (re)build; the live selection
  const markSelected = (value: string) => {
    for (const li of Array.from(popup.children) as HTMLElement[]) {
      if (li.dataset.value === undefined) continue; // group headers aren't options
      const on = li.dataset.value === value;
      li.setAttribute("aria-selected", String(on));
      li.style.background = on ? "var(--panel-3)" : "";
    }
  };

  const groupHeader = (text: string): HTMLElement => {
    const li = el("li");
    li.setAttribute("role", "presentation");
    li.textContent = text;
    li.style.cssText =
      "padding:8px 10px 4px; font-size:10.5px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; color:var(--faint); cursor:default;";
    return li;
  };

  const optionRow = (opt: Opt): HTMLElement => {
    const li = el("li");
    li.dataset.value = opt.value;
    li.setAttribute("role", "option");
    li.textContent = opt.label;
    li.style.cssText =
      "padding:7px 10px; border-radius:7px; cursor:pointer; font-size:13px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
    // Each family row renders in its own face (system fonts resolve by name;
    // folder fonts not installed system-wide fall back to the default face —
    // that's fine, the burn uses the file).
    if (opt.face) li.style.fontFamily = `'${opt.face.replace(/'/g, "")}'`;
    li.addEventListener("mouseenter", () => {
      if (li.getAttribute("aria-selected") !== "true") li.style.background = "var(--panel-2)";
    });
    li.addEventListener("mouseleave", () => {
      if (li.getAttribute("aria-selected") !== "true") li.style.background = "";
    });
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      selected = opt.value;
      markSelected(selected);
      if (opt.value === SENTINEL_DEFAULT) {
        prefs.captionFont = "";
        fontInput.value = "";
        save();
      } else if (opt.value === SENTINEL_CUSTOM) {
        // Reveal the free-text field; keep whatever path is already there.
        prefs.captionFont = fontInput.value.trim();
        save();
      } else {
        // A folder font sets captionFont = its file path (engine resolves the
        // family + fontsdir); a system font sets captionFont = the family.
        prefs.captionFont = opt.path ?? opt.value;
        save();
      }
      const realFont =
        opt.value !== SENTINEL_DEFAULT && opt.value !== SENTINEL_CUSTOM;
      syncPickerUi(
        opt.value === SENTINEL_CUSTOM ? SENTINEL_CUSTOM : prefs.captionFont || SENTINEL_DEFAULT,
        realFont && opt.path ? { label: opt.label, face: opt.face ?? opt.label } : undefined,
      );
      closePopup();
      if (opt.value === SENTINEL_CUSTOM) fontInput.focus();
    });
    return li;
  };

  // (Re)build the dropdown: scan the fonts folder (if set) into a "Your fonts"
  // group at the top, then list system fonts. Called once on mount and again
  // whenever the fonts-folder field changes. Each rebuild supersedes the last
  // (a stale async result is ignored via the token).
  let buildToken = 0;
  const rebuildPicker = (): void => {
    const token = ++buildToken;
    void (async () => {
      let sysFonts: { family: string; path?: string }[] = [];
      try {
        sysFonts = await platform.listFonts();
      } catch {
        sysFonts = [];
      }

      const dir = readStr(FONTS_DIR_KEY, "").trim();
      let userFonts: { family: string; path?: string }[] = [];
      if (dir) {
        try {
          userFonts = await platform.listUserFonts(dir);
        } catch {
          userFonts = []; // unreadable/throwing → just no "Your fonts" group
        }
      }
      if (token !== buildToken) return; // a newer rebuild started — drop this one

      // System families: de-dupe + sort (case-insensitive).
      const sysFamilies = Array.from(new Set(sysFonts.map((f) => f.family).filter((f) => f.trim())));
      sysFamilies.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      // Folder fonts: keep only those with a real family + path; de-dupe by
      // family. A folder font that also appears system-wide wins (it's removed
      // from the System group below) so the file-backed entry is offered.
      const userByFamily = new Map<string, { family: string; path: string }>();
      for (const f of userFonts) {
        const fam = f.family.trim();
        if (!fam || !f.path) continue;
        const key = fam.toLowerCase();
        if (!userByFamily.has(key)) userByFamily.set(key, { family: fam, path: f.path });
      }
      const userList = Array.from(userByFamily.values());
      userList.sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: "base" }));
      const userKeys = new Set(userList.map((f) => f.family.toLowerCase()));

      // Nothing to offer at all → keep the free-text-only fallback.
      if (sysFamilies.length === 0 && userList.length === 0) {
        if (pickerRow.parentElement) pickerRow.remove();
        return;
      }

      const userOpts: Opt[] = userList.map((f) => ({
        value: f.path,
        label: f.family,
        face: f.family,
        path: f.path,
      }));
      const sysOpts: Opt[] = sysFamilies
        .filter((f) => !userKeys.has(f.toLowerCase()))
        .map((f) => ({ value: f, label: f, face: f }));

      // The persisted pref decides the initial selection: "" → default; a value
      // matching a folder font's path or a system family → that entry; anything
      // else (a stray path or an unlisted name) → Custom path… (free-text shows it).
      const cur = prefs.captionFont.trim();
      if (cur === "") selected = SENTINEL_DEFAULT;
      else if (userOpts.some((o) => o.value === cur)) selected = cur;
      else if (sysOpts.some((o) => o.value === cur)) selected = cur;
      else selected = SENTINEL_CUSTOM;

      popup.replaceChildren();
      popup.append(optionRow({ value: SENTINEL_DEFAULT, label: s.captionFontSystemDefault }));
      if (userOpts.length > 0) {
        popup.append(groupHeader(s.captionFontGroupYours));
        for (const o of userOpts) popup.append(optionRow(o));
      }
      if (sysOpts.length > 0) {
        popup.append(groupHeader(s.captionFontGroupSystem));
        for (const o of sysOpts) popup.append(optionRow(o));
      }
      popup.append(optionRow({ value: SENTINEL_CUSTOM, label: s.captionFontCustom }));

      markSelected(selected);
      // A folder font's stored value is a path — show its family on the trigger.
      const selUserOpt = userOpts.find((o) => o.value === selected);
      syncPickerUi(
        selected === SENTINEL_CUSTOM ? SENTINEL_CUSTOM : prefs.captionFont || SENTINEL_DEFAULT,
        selUserOpt ? { label: selUserOpt.label, face: selUserOpt.face ?? selUserOpt.label } : undefined,
      );

      // Swap the free-text-only layout for the dropdown (free-text now behind it).
      if (!pickerRow.parentElement) capBlock.body.insertBefore(pickerRow, fontRow);
    })();
  };

  rebuildPicker();

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
  void platform
    .getSecret(GEMINI_API_KEY_SECRET)
    .then((v) => {
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
  testBtn.addEventListener("click", () => {
    const key = keyInput.value.trim();
    if (!key) return;
    testBtn.disabled = true;
    testStatus.className = "fl-set-test";
    testStatus.textContent = s.apiKeyTesting;
    const model = IMPLEMENTED_PROVIDERS.has(prefs.provider) ? prefs.model : DEFAULT_AI.model;
    void testGeminiKey(key, model).then((r) => {
      if (r.ok) {
        testStatus.className = "fl-set-test ok";
        testStatus.textContent = s.apiKeyValid;
      } else {
        testStatus.className = "fl-set-test err";
        testStatus.textContent = `${s.apiKeyInvalid} — ${r.detail}`;
      }
      syncTestEnabled();
    });
  });
  keyInput.addEventListener("input", () => {
    void saveApiKey(keyInput.value.trim());
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
