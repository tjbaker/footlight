// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Settings panels' shared DOM builders (panel header, titled block,
 * segmented control, switch, labeled row) and their stroke icon set. Shared
 * only between the Settings panels (#270), so they live beside them rather
 * than in ui.ts.
 */

import { el, button, ensureId } from "./ui.js";

/** A `<span class="fl-set-secth">` heading + optional `.fl-set-secsub` sub. */
export function panelHeader(title: string, sub?: string): HTMLElement {
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
export function block(title: string): { root: HTMLElement; body: HTMLElement } {
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
export function segmented<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  onPick: (v: T) => void,
): HTMLElement {
  const seg = el("div", "fl-seg");
  for (const opt of options) {
    const b = button(opt.label, opt.value === value ? "on" : undefined, () => {
      for (const child of Array.from(seg.children)) {
        child.classList.remove("on");
        child.setAttribute("aria-pressed", "false");
      }
      b.classList.add("on");
      b.setAttribute("aria-pressed", "true");
      onPick(opt.value);
    });
    b.type = "button";
    b.setAttribute("aria-pressed", String(opt.value === value));
    seg.append(b);
  }
  return seg;
}

/**
 * A pill-toggle switch (`.fl-switch`): a real `<button role="switch">`, so Tab
 * reaches it and Enter/Space flip it natively. `label` is the visible text that
 * names it (`aria-labelledby`); the optional `hint` describes it.
 */
export function toggleSwitch(
  on: boolean,
  onChange: (v: boolean) => void,
  label: HTMLElement,
  hint?: HTMLElement,
): HTMLButtonElement {
  const sw = button("", on ? "fl-switch on" : "fl-switch");
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", String(on));
  sw.setAttribute("aria-labelledby", ensureId(label, "switch-label"));
  if (hint) sw.setAttribute("aria-describedby", ensureId(hint, "switch-hint"));
  sw.append(el("span", "knob"));
  sw.addEventListener("click", () => {
    const next = !sw.classList.contains("on");
    sw.classList.toggle("on", next);
    sw.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  return sw;
}

/** A labeled General-panel row (`.fl-row2` + `.fl-rowlab`). */
export function labeledRow(label: string, ...controls: HTMLElement[]): HTMLElement {
  const row = el("div", "fl-row2");
  const lab = el("span", "fl-rowlab");
  lab.textContent = label;
  row.append(lab, ...controls);
  return row;
}

// ---- icons (stroke set matching the app) ----

export const ICON_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>';
export const ICON_BRAND =
  '<svg class="fl-lamp" viewBox="14 12 72 68" fill="currentColor" aria-hidden="true"><g class="beam"><polygon points="27,66 37,66 44,20 20,20"/><polygon points="45,66 55,66 62,20 38,20"/><polygon points="63,66 73,66 80,20 56,20"/></g><rect x="20" y="69" width="60" height="5.5" rx="2.75"/><path d="M24.5,69 A7.5 7.5 0 0 1 39.5,69 Z"/><path d="M42.5,69 A7.5 7.5 0 0 1 57.5,69 Z"/><path d="M60.5,69 A7.5 7.5 0 0 1 75.5,69 Z"/></svg>';
export const ICON_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';
export const ICON_KEY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2" stroke-linecap="round"/></svg>';
export const ICON_SPARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>';
export const ICON_GEAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2.5l1.3 2.4 2.7-.3 .6 2.6 2.4 1.3-1 2.5 1 2.5-2.4 1.3-.6 2.6-2.7-.3L12 21.5l-1.3-2.4-2.7.3-.6-2.6L5 15.5l1-2.5-1-2.5 2.4-1.3.6-2.6 2.7.3z" stroke-linejoin="round"/></svg>';
export const ICON_FILM =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4" stroke-linecap="round"/></svg>';
export const ICON_KEYBOARD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" stroke-linecap="round"/></svg>';
export const ICON_INFO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01" stroke-linecap="round"/></svg>';
export const ICON_LINK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1.5-1.5"/></svg>';
