// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Settings panels' shared DOM builders (panel header, titled block,
 * segmented control, switch, labeled row). Their icons live in icons.ts. Shared
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

/** A titled block (`.fl-set-block` + `.fl-set-blockh` label; `label` can name a control). */
export function block(title: string): { root: HTMLElement; body: HTMLElement; label: HTMLElement } {
  const root = el("div", "fl-set-block");
  const head = el("div", "fl-set-blockh");
  const lab = el("span", "fl-label");
  lab.textContent = title;
  head.append(lab);
  const body = el("div");
  root.append(head, body);
  return { root, body, label: lab };
}

/** Name `control` by the visible `label` element (`aria-labelledby`). */
export function labelBy(control: HTMLElement, label: HTMLElement): void {
  control.setAttribute("aria-labelledby", ensureId(label, "label"));
}

/**
 * Mark `chosen` as the one pressed button among `group`'s children: the `on`
 * class for the look, `aria-pressed` for assistive tech. Shared by every
 * pick-one button row (segmented controls, the encoder preset chips).
 */
export function pressOnly(group: HTMLElement, chosen: HTMLElement): void {
  for (const child of Array.from(group.children)) {
    child.classList.toggle("on", child === chosen);
    child.setAttribute("aria-pressed", String(child === chosen));
  }
}

/**
 * A segmented control (`.fl-seg`, a `role=group` of pressed/unpressed
 * buttons). `value` is the initially-selected option; `onPick` fires with the
 * chosen value. Name the group with `labelBy` (`labeledRow` does it for you).
 */
export function segmented<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  onPick: (v: T) => void,
): HTMLElement {
  const seg = el("div", "fl-seg");
  seg.setAttribute("role", "group");
  for (const opt of options) {
    const b = button(opt.label, opt.value === value ? "on" : undefined, () => {
      pressOnly(seg, b);
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

/**
 * A labeled General-panel row (`.fl-row2` + `.fl-rowlab`). The row label names
 * any `role=group` control in it (a segmented control).
 */
export function labeledRow(label: string, ...controls: HTMLElement[]): HTMLElement {
  const row = el("div", "fl-row2");
  const lab = el("span", "fl-rowlab");
  lab.textContent = label;
  for (const c of controls) if (c.getAttribute("role") === "group") labelBy(c, lab);
  row.append(lab, ...controls);
  return row;
}
