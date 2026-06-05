// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The read-only "framing brain" base system prompt, bundled from the repo's
 * `prompts/base.md` at build time via Vite's `?raw` loader (the dev server's
 * `fs.allow` is widened to the repo root, so the import resolves in dev too).
 *
 * This is the canonical domain expertise (pillarbox traps, cut-aligned
 * schedules, verify-the-pixels) that the assistant turn prepends to every system
 * prompt — see `composeSystemPrompt` in src/assistant/gemini.ts. The editor's
 * append-only overlay (Settings → AI) composes ON TOP of this; this layer itself
 * is never user-editable.
 */
import raw from "../../../prompts/base.md?raw";

export const BASE_PROMPT: string = raw;
