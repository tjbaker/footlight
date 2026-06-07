// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Locale selection. English is the only catalog today; `messages` resolves to the
 * best match for the browser/OS language and falls back to English. To add a
 * locale, drop another `Messages` object into `locales`.
 */

import { en } from "./en.js";
import { ptBR } from "./pt-br.js";
import type { Messages } from "./types.js";

export const locales: Record<string, Messages> = { en, pt: ptBR };

function pickLocale(): Messages {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  const lang = (nav || "en").toLowerCase().split("-")[0] ?? "en";
  return locales[lang] ?? en;
}

/** The active message catalog. */
export const messages: Messages = pickLocale();

export type { Messages } from "./types.js";
