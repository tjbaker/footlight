// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's DOM construction primitives, shared by editor.ts and its view
 * modules (#125 Phase 4). Tiny, dependency-free element factories — moved out
 * of the editor closure so `views/*` build their DOM the same way the editor
 * does, without importing the whole editor.
 */

/** `<tag class="cls">` — the workhorse element factory. */
export function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

/** A typed `<input>` with a placeholder. */
export function input(type: string, placeholder: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = type;
  i.placeholder = placeholder;
  return i;
}

/** A single-row textarea that grows with its content (Enter = line break). */
export function textarea(placeholder: string): HTMLTextAreaElement {
  const t = document.createElement("textarea");
  t.placeholder = placeholder;
  t.rows = 1;
  return t;
}

/** Fit an auto-growing textarea's height to its content. */
export function autosize(t: HTMLTextAreaElement): void {
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight}px`;
}

/** A `<button>` with optional class and click handler. */
export function button(label: string, cls?: string, onClick?: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

/** An inspector section header (`<div class="fl-sect-h"><span class="fl-label">…`). */
export function sectionHeader(text: string): HTMLElement {
  const h = el("div", "fl-sect-h");
  const label = el("span", "fl-label");
  label.textContent = text;
  h.append(label);
  return h;
}
