// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's DOM construction primitives, shared by editor.ts and its view
 * modules (#125 Phase 4). Tiny, dependency-free element factories — moved out
 * of the editor closure so `views/*` build their DOM the same way the editor
 * does, without importing the whole editor. Also home to the one accessible
 * modal helper (`openModal`) every dialog in the app is built on.
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

// ---- modal dialogs (#266) ----

/**
 * Every modal backdrop the app renders: the editor's dialogs (history,
 * settings, clear-confirm) use `.fl-modal-backdrop`; the shortcuts and help
 * dialogs use `.modal-backdrop`.
 */
const MODAL_BACKDROP = ".fl-modal-backdrop, .modal-backdrop:not([hidden])";

/**
 * True while any modal is on screen. Read from the DOM rather than from an
 * open-modal registry so a backdrop torn down by anything (a test, a view
 * rebuild) can never leave the editor's hotkeys stuck off.
 */
export function isModalOpen(): boolean {
  return document.querySelector(MODAL_BACKDROP) !== null;
}

/** Elements that take Tab focus, before the visibility filter. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The dialog's Tab stops, in document order, skipping hidden subtrees. */
function tabStops(dialog: HTMLElement): HTMLElement[] {
  const visible = (e: HTMLElement): boolean => {
    for (let n: HTMLElement | null = e; n && n !== dialog; n = n.parentElement) {
      if (n.hidden || getComputedStyle(n).display === "none") return false;
    }
    return true;
  };
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
}

export interface ModalOptions {
  /** The dialog element, already populated (`.fl-modal` / `.modal`). */
  dialog: HTMLElement;
  /** The backdrop's class (`fl-modal-backdrop` or `modal-backdrop`). */
  backdropClass: string;
  /** The visible title; the dialog is `aria-labelledby` it. */
  labelledBy: HTMLElement;
  /** What takes focus on open (default: the first Tab stop, else the dialog). */
  initialFocus?: HTMLElement;
  /**
   * Runs on EVERY close path (Escape, backdrop click, `close()`) while the
   * dialog is still in the DOM — e.g. Settings commits its focused text field.
   */
  beforeClose?: () => void;
}

export interface ModalHandle {
  backdrop: HTMLElement;
  /** Tear the modal down and restore focus. Idempotent. */
  close: () => void;
}

/** Open modals, oldest first — only the topmost one answers Escape/Tab. */
const openStack: HTMLElement[] = [];
let titleIds = 0;

/**
 * Mount `dialog` in a backdrop as an accessible modal (#266): `role=dialog`,
 * `aria-modal`, `aria-labelledby` the title; focus moves in, Tab/Shift-Tab are
 * trapped inside, Escape and a click on the backdrop itself close it, and
 * focus returns to whatever held it before. The caller wires its own close
 * buttons to the returned `close`.
 */
export function openModal(opts: ModalOptions): ModalHandle {
  const { dialog, labelledBy } = opts;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  if (!labelledBy.id) labelledBy.id = `fl-modal-title-${++titleIds}`;
  dialog.setAttribute("aria-labelledby", labelledBy.id);
  dialog.tabIndex = -1; // the focus fallback when the dialog has no Tab stops

  const backdrop = el("div", opts.backdropClass);
  backdrop.append(dialog);
  document.body.append(backdrop);
  openStack.push(backdrop);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    opts.beforeClose?.();
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    const at = openStack.indexOf(backdrop);
    if (at >= 0) openStack.splice(at, 1);
    if (opener?.isConnected) opener.focus();
  };

  /** Topmost among the modals still mounted (a stale entry never blocks). */
  const isTopmost = (): boolean => openStack.filter((b) => b.isConnected).at(-1) === backdrop;

  function onKey(e: KeyboardEvent): void {
    if (!backdrop.isConnected) {
      // Removed from outside (never through close): just unhook.
      closed = true;
      document.removeEventListener("keydown", onKey);
      const at = openStack.indexOf(backdrop);
      if (at >= 0) openStack.splice(at, 1);
      return;
    }
    if (!isTopmost()) return;
    if (e.key === "Escape") {
      close();
    } else if (e.key === "Tab") {
      const stops = tabStops(dialog);
      const first = stops[0];
      const last = stops.at(-1);
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        dialog.focus();
      } else if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey);
  (opts.initialFocus ?? tabStops(dialog)[0] ?? dialog).focus();

  return { backdrop, close };
}
