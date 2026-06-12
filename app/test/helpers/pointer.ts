// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pointer-event synthesis shared by the view drag suites (views-viewer,
 * views-activity). jsdom's PointerEvent honours clientX/clientY through its
 * init dict but leaves offsetX/offsetY at 0 AND read-only, so handlers that
 * read offsets (the viewer overlay derives source px as `offsetX /
 * displayScale`) need them redefined on the instance. One dispatcher covers
 * both coordinate kinds so each suite doesn't carry a private copy.
 */

/** PointerEvent init plus the offset coords jsdom can't set natively. */
export interface FirePointerOpts extends PointerEventInit {
  offsetX?: number;
  offsetY?: number;
}

/** Dispatch a bubbling pointer event carrying the given coords on `target`. */
export function firePointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  opts: FirePointerOpts = {},
): void {
  const { offsetX, offsetY, ...init } = opts;
  const ev = new PointerEvent(type, { bubbles: true, pointerId: 1, ...init });
  if (offsetX !== undefined) Object.defineProperty(ev, "offsetX", { value: offsetX });
  if (offsetY !== undefined) Object.defineProperty(ev, "offsetY", { value: offsetY });
  target.dispatchEvent(ev);
}
