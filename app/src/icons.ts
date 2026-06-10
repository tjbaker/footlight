// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Inline SVG icon markup shared by the editor and its view modules (#125 Phase
 * 4). All `currentColor`, 1.8 stroke unless noted — set via the consuming
 * element's CSS. Moved out of editor.ts so `views/*` can import them without
 * reaching into the editor closure.
 */

// The brand mark — "row of footlights" (three half-disc lamps, beams up).
// currentColor → --accent via `.fl-lamp`; the same motif as the app icon.
export const ICON_BRAND =
  '<svg class="fl-lamp" viewBox="14 12 72 68" fill="currentColor" aria-hidden="true"><g class="beam"><polygon points="27,66 37,66 44,20 20,20"/><polygon points="45,66 55,66 62,20 38,20"/><polygon points="63,66 73,66 80,20 56,20"/></g><rect x="20" y="69" width="60" height="5.5" rx="2.75"/><path d="M24.5,69 A7.5 7.5 0 0 1 39.5,69 Z"/><path d="M42.5,69 A7.5 7.5 0 0 1 57.5,69 Z"/><path d="M60.5,69 A7.5 7.5 0 0 1 75.5,69 Z"/></svg>';

// Inline stroke/fill icons (1.8 stroke, matching the design's set).
export const ICON_GEAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2.5l1.3 2.4 2.7-.3 .6 2.6 2.4 1.3-1 2.5 1 2.5-2.4 1.3-.6 2.6-2.7-.3L12 21.5l-1.3-2.4-2.7.3-.6-2.6L5 15.5l1-2.5-1-2.5 2.4-1.3.6-2.6 2.7.3z" stroke-linejoin="round"/></svg>';
export const ICON_ACTIVITY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h5M7 13h9" stroke-linecap="round"/></svg>';
export const ICON_SUN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round"/></svg>';
export const ICON_MOON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 13.5A8 8 0 1110.5 4a6.5 6.5 0 009.5 9.5z" stroke-linejoin="round"/></svg>';
export const ICON_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';
export const ICON_DOWN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const ICON_PLUS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>';
export const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>';
export const ICON_HISTORY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/></svg>';
export const ICON_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>';
export const ICON_PHONE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="3" width="10" height="18" rx="2.2"/><path d="M11 18h2" stroke-linecap="round"/></svg>';
export const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3" stroke-linecap="round"/></svg>';
export const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const ICON_PREV_CUT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M18 6l-8 6 8 6z" fill="currentColor"/><path d="M6 5.5v13"/></svg>';
export const ICON_NEXT_CUT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M6 6l8 6-8 6z" fill="currentColor"/><path d="M18 5.5v13"/></svg>';
export const PLAY_GLYPH =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z"/></svg>';
export const PAUSE_GLYPH =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
// Spark (assistant), send (composer), check (proposal tick).
export const ICON_SPARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>';
export const ICON_SEND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M12 5l7 7-7 7"/></svg>';
export const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-9"/></svg>';
