// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Keyboard operation in jsdom. jsdom dispatches key events but has no native
 * activation behavior: Enter/Space on a `<button>` never synthesizes the click
 * a browser would. `pressOn` focuses the control, dispatches the keydown, and,
 * if nothing called `preventDefault`, performs the browser's native button
 * activation (a click) for Enter/Space, so a test drives a control exactly the
 * way a keyboard user would.
 */

/** Focus `target`, press `key` on it, and apply native button activation. */
export function pressOn(target: HTMLElement, key: string): KeyboardEvent {
  target.focus();
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  const activates = key === "Enter" || key === " ";
  if (activates && !e.defaultPrevented && target instanceof HTMLButtonElement && !target.disabled) {
    target.click();
  }
  return e;
}
