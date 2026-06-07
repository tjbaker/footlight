// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Locale selection. `messages` resolves to the best match for the browser/OS
 * language and falls back to English. To add a locale, drop another `Messages`
 * object into `locales`, keyed by its primary subtag (the part before any `-`).
 */

import { en } from "./en.js";
import { es } from "./es.js";
import { ptBR } from "./pt-br.js";
import type { Messages } from "./types.js";

export const locales: Record<string, Messages> = { en, es, pt: ptBR };

function pickLocale(): Messages {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  const lang = (nav || "en").toLowerCase().split("-")[0] ?? "en";
  return locales[lang] ?? en;
}

/** The active message catalog. */
export const messages: Messages = pickLocale();

export type { Messages } from "./types.js";
