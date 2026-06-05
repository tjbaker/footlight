// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure, browser-safe migration helper for moving a BYOK API key out of the
 * legacy `footlight.autotrack` localStorage blob and into the OS keychain
 * (the `secretStore` platform capability).
 *
 * Historically the Gemini API key lived inline in the JSON blob persisted by
 * `app/src/autotrack.ts` under `localStorage["footlight.autotrack"]`. That is
 * fine for the dev/web build but a packaged app must keep the key in the OS
 * keychain, never in a project/config file (SPEC follow-up). This helper does
 * the one-time extraction so a caller can: read the legacy blob → `migrateApiKey`
 * → write `apiKey` to `secretStore` → persist the cleaned `remainder` back.
 *
 * It lives in the engine (root vitest) precisely BECAUSE it is pure: no `node:`
 * imports, no fs, no DOM — just a defensive JSON parse — so it is testable and
 * importable from either the frontend or Node. Keep it that way.
 */

/** The result of pulling a key out of a legacy auto-track blob. */
export interface ApiKeyMigration {
  /** The non-empty API key found in the blob, or null if absent/blank/invalid. */
  apiKey: string | null;
  /**
   * Every OTHER field from the blob, so the caller can persist a cleaned copy
   * (the key removed). Always an object — `{}` when the input is unusable.
   */
  remainder: Record<string, unknown>;
}

/**
 * Parse a legacy `footlight.autotrack` JSON string, pull out a non-empty
 * `apiKey`, and return the remaining fields untouched so the caller can re-store
 * the cleaned blob.
 *
 * Defensive by design: anything that is not a JSON object (bad JSON, a JSON
 * array, a bare string/number, `null`) yields `{ apiKey: null, remainder: {} }`
 * rather than throwing — a corrupt blob must never break startup. A present but
 * non-string or whitespace-only `apiKey` is treated as "no key" (apiKey: null)
 * and is still stripped from `remainder`.
 */
export function migrateApiKey(raw: string): ApiKeyMigration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { apiKey: null, remainder: {} };
  }

  // Must be a plain object (reject null, arrays, and primitives).
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { apiKey: null, remainder: {} };
  }

  // Copy every field except apiKey into the remainder; keep the key out of it
  // regardless of whether it turns out to be usable.
  const remainder: Record<string, unknown> = {};
  let apiKey: string | null = null;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === "apiKey") {
      if (typeof value === "string" && value.trim() !== "") {
        apiKey = value.trim();
      }
      continue;
    }
    remainder[key] = value;
  }

  return { apiKey, remainder };
}
