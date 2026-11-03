// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The BYOK key's persistence (OS keychain via `secretStore`) and its live
 * test (#270). The save chain is module-scoped: ONE chain for the whole app,
 * whichever AI panel instance queued the write (#278).
 */

import { GEMINI_API_KEY_SECRET } from "./autotrack.js";
import { platform } from "./platform/index.js";

// ---- key persistence (OS keychain via secretStore) ----

/** How long a key test may run before it is aborted (and Test re-enabled). */
export const KEY_TEST_TIMEOUT_MS = 15_000;

async function saveApiKey(key: string): Promise<void> {
  try {
    if (key) await platform.setSecret(GEMINI_API_KEY_SECRET, key);
    else await platform.deleteSecret(GEMINI_API_KEY_SECRET);
  } catch {
    /* keychain unavailable (locked, denied, etc.) — non-fatal for the modal. */
  }
}

/**
 * Every key write, chained in commit order. Module-scoped (not per panel
 * build) so saves from a closed or rebuilt AI panel and the next panel's
 * hydration all queue on ONE chain (#278). `saveApiKey` never rejects.
 */
export let apiKeySaves: Promise<void> = Promise.resolve();
export function queueApiKeySave(key: string): void {
  apiKeySaves = apiKeySaves.then(() => saveApiKey(key));
}

/**
 * Validate a Gemini BYOK key by making the SAME fetch-only `generateContent`
 * call the assistant uses (header auth, no key in the URL), with a 1-token reply
 * so it's the cheapest request that still exercises auth + the chosen model.
 * Returns `ok` plus a short detail for the failure case. Runs entirely in the
 * renderer — the generativelanguage endpoint is CORS-enabled for API-key use,
 * which is also why `GeminiAssistant` can call it directly.
 */
export async function testGeminiKey(
  key: string,
  model: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal,
    });
    if (res.ok) return { ok: true, detail: "" };
    // Surface the API's own message (e.g. "API key not valid") when present.
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string; status?: string } };
      if (j.error?.message) detail = j.error.message;
      else if (j.error?.status) detail = j.error.status;
    } catch {
      /* non-JSON body — keep the HTTP status. */
    }
    return { ok: false, detail };
  } catch (err) {
    // Network / CORS / abort — report the message so it isn't a silent no-op.
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
