// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Fixed-layout rect stubbing for suites that exercise time↔pixel math. jsdom
 * has no layout engine, so every `getBoundingClientRect()` is all-zero and
 * handlers that divide by `rect.width` early-return; pinning an element to a
 * fixed rect at the origin makes the px↔value mapping deterministic.
 * (editor-timeline-drag.test.ts predates this helper and carries its own
 * private copy it may not rewrite history for; new suites use this one.)
 */

/** A `width`×`height` DOMRect at the origin. */
export function fixedRect(width: number, height: number): DOMRect {
  return {
    left: 0,
    top: 0,
    width,
    height,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

/** Override an element's `getBoundingClientRect` with a fixed origin rect. */
export function stubRect(el: Element, width: number, height: number): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => fixedRect(width, height),
    configurable: true,
  });
}
