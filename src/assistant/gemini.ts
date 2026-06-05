// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Gemini assistant model adapter (SPEC §6.7) — the network `AssistantModel`.
 *
 * Parallels `providers/gemini.ts` (the vision `GeminiTracker`): it talks to the
 * Gemini `generateContent` REST API with `fetch` only — no `node:` builtins — so
 * it works in Node 26+ and in the browser/Tauri frontend. It declares the
 * assistant `TOOLS` as `functionDeclarations`, sends the user's message plus a
 * compact grounded-context preamble, and parses the model's reply into a
 * `ModelTurn` (prose + tool-call PROPOSALS). It NEVER executes a tool — the
 * orchestrator materializes each proposal into a preview-only `ProposedAction`.
 *
 * BYOK & opt-in (SPEC §6.7): the key comes from `req.context.apiKey`; this class
 * CANNOT run without one and is never invoked in tests. The static
 * `parseModelTurn` is PURE (no network, mirrors `GeminiTracker.boxFromGemini`)
 * so the response → ModelTurn mapping is unit-testable offline.
 *
 * Grounding discipline: the chat turn sends project STATE as text only (In/Out,
 * scene cuts, loudness swells) — NOT the frames, and NEVER audio. To look at
 * pixels the model must call a vision tool (`suggestCropForFrame` / `trackSubject`),
 * which the orchestrator routes to the injected `VisionRunner`. The system
 * preamble says exactly this, so a located moment is grounded in real signals and
 * the model never implies it saw a frame it didn't request or heard sound. (A
 * future change may attach a sparse still strip to the turn — see the tracking
 * issue; until then this turn is text-grounded.)
 */

import type { ToolSpec, JsonSchema } from "./tools.js";
import type {
  AssistantModel,
  ModelTurn,
  ToolCall,
  AssistantContext,
  ConversationMessage,
} from "./orchestrator.js";
import type { ToolName } from "./types.js";

/** Configurable model/endpoint — defaults target a current Gemini text model. */
export interface GeminiAssistantOpts {
  /** Model id; configurable. */
  model?: string;
  /** API base; configurable (e.g. a proxy for the future managed-key tier). */
  apiBase?: string;
}

export class GeminiAssistant implements AssistantModel {
  readonly name = "gemini";
  private readonly model: string;
  private readonly apiBase: string;

  constructor(opts: GeminiAssistantOpts = {}) {
    this.model = opts.model ?? "gemini-2.5-flash";
    this.apiBase =
      opts.apiBase ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  async turn(req: {
    message: string;
    tools: readonly ToolSpec[];
    context: AssistantContext;
    history?: ConversationMessage[];
    signal?: AbortSignal;
  }): Promise<ModelTurn> {
    const apiKey = req.context.apiKey;
    if (!apiKey) {
      throw new Error("GeminiAssistant: apiKey is required (BYOK; opt-in).");
    }

    const url = `${this.apiBase}/models/${encodeURIComponent(
      this.model,
    )}:generateContent`;

    // Prior turns first (multi-turn context), then the current user message.
    const contents: unknown[] = [];
    for (const h of req.history ?? []) {
      contents.push({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.text }],
      });
    }
    contents.push({ role: "user", parts: [{ text: req.message }] });

    const body = {
      // Framing brain (base.md) + editor overlay + grounded operational preamble.
      systemInstruction: { parts: [{ text: composeSystemPrompt(req.context) }] },
      contents,
      // Declare the assistant tools as Gemini function declarations.
      tools: [{ functionDeclarations: req.tools.map(toFunctionDeclaration) }],
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Header auth keeps the key out of the URL / server logs.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(
        `GeminiAssistant: HTTP ${res.status} ${res.statusText}${
          detail ? ` — ${detail}` : ""
        }`,
      );
    }

    const json: unknown = await res.json();
    return GeminiAssistant.parseModelTurn(json);
  }

  /**
   * Pull the text part(s) + functionCall parts out of a Gemini
   * `generateContent` response into a `ModelTurn`. PURE and side-effect free
   * (mirrors `GeminiTracker.boxFromGemini`) so it's unit-testable with no
   * network. Defensive against missing candidates / malformed parts: an empty or
   * junk response yields an empty turn rather than throwing. `grounding` / `warn`
   * are left undefined here — the orchestrator fills grounding from real project
   * state (swells / scene cuts / stills) rather than trusting the model to invent
   * it.
   */
  static parseModelTurn(geminiResponse: unknown): ModelTurn {
    const parts = candidateParts(geminiResponse);
    const texts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;

      const text = p["text"];
      if (typeof text === "string" && text.length > 0) {
        texts.push(text);
        continue;
      }

      const fc = p["functionCall"];
      if (fc && typeof fc === "object") {
        const call = functionCallToToolCall(fc as Record<string, unknown>);
        if (call) toolCalls.push(call);
      }
    }

    return { text: texts.join("\n").trim(), toolCalls };
  }
}

/** Names the assistant tool surface declares (kept in sync with `ToolName`). */
const KNOWN_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  "setInOut",
  "addCropKeyframe",
  "setContentCrop",
  "detectScenes",
  "suggestCropForFrame",
  "trackSubject",
  "trim",
  "render",
]);

/**
 * Convert a `ToolSpec` into a Gemini function declaration. The `paramSchema` is
 * already a JSON-schema object fragment (`type/properties/required`), which is
 * exactly the shape Gemini's `parameters` field wants; we drop
 * `additionalProperties` (Gemini's schema dialect ignores it) and keep the rest.
 */
function toFunctionDeclaration(tool: ToolSpec): {
  name: string;
  description: string;
  parameters: { type: string; properties: JsonSchema["properties"]; required: string[] };
} {
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: tool.paramSchema.properties,
      required: tool.paramSchema.required,
    },
  };
}

/**
 * Compose the full system instruction sent on every turn, in three layers:
 *
 *   1. `ctx.basePrompt` — the read-only "framing brain" (`prompts/base.md`): the
 *      domain expertise (pillarbox traps, cut-aligned schedules, verify-the-pixels).
 *   2. `ctx.userOverlay` — the editor's append-only framing preferences, clearly
 *      framed as refining (NOT overriding) the safety guidance above it.
 *   3. `systemPreamble(ctx)` — the runtime grounding + operational discipline
 *      (no frames in-conversation, never audio, the live In/Out / cuts / swells).
 *
 * Layers 1 and 2 are optional; the operational preamble is always present and
 * comes LAST so its discipline can't be silently buried by a long overlay. PURE
 * and exported so the composition is unit-testable offline.
 */
export function composeSystemPrompt(ctx: AssistantContext): string {
  const sections: string[] = [];
  const base = ctx.basePrompt?.trim();
  if (base) sections.push(base);
  const overlay = ctx.userOverlay?.trim();
  if (overlay) {
    sections.push(
      "## Editor's framing preferences (overlay)\n" +
        "The editor added the preferences below. They REFINE the guidance above " +
        "for this editor's taste, but they do NOT override the safety rules " +
        "(pillarbox warnings, verify-the-pixels, human-in-the-loop, clean export, " +
        "lossless audio). If a preference conflicts with a safety rule, follow the " +
        "safety rule and say so.\n\n" +
        overlay,
    );
  }
  sections.push(systemPreamble(ctx));
  return sections.join("\n\n---\n\n");
}

/**
 * A compact grounded-context preamble: the operational discipline (the model
 * sees no frames in-conversation and NEVER audio) plus the live clip state —
 * In/Out, duration, scene cuts, loudness swells — to ground time-locating
 * proposals. This is the always-present last layer of `composeSystemPrompt`.
 */
function systemPreamble(ctx: AssistantContext): string {
  const lines: string[] = [
    "You are Footlight's framing assistant. You PROPOSE actions via tool calls;",
    "the human accepts, steps, or discards them — you never apply or render.",
    "You work from project STATE only (In/Out, duration, scene cuts, loudness",
    "swells — all below). You do NOT see the video frames in this conversation:",
    "to look at a frame, call suggestCropForFrame or trackSubject — those tools",
    "read the pixels and frame/track the subject for you. NEVER claim you saw a",
    "frame you didn't request, and NEVER imply you heard the audio — cite scene",
    "cuts / loudness swells as grounding. You cannot see colored/blurred",
    "pillarbox, so say so when framing is a guess.",
  ];
  if (ctx.inSec !== undefined || ctx.outSec !== undefined) {
    lines.push(`Clip In/Out: ${fmt(ctx.inSec)}s → ${fmt(ctx.outSec)}s.`);
  }
  if (ctx.duration !== undefined) {
    lines.push(`Source duration: ${fmt(ctx.duration)}s.`);
  }
  lines.push(`Working region: ${ctx.region.width}×${ctx.region.height}px.`);
  if (ctx.sceneCuts && ctx.sceneCuts.length > 0) {
    lines.push(`Scene cuts (s): ${ctx.sceneCuts.map(fmt).join(", ")}.`);
  }
  if (ctx.swells && ctx.swells.length > 0) {
    lines.push(
      `Loudness swells: ${ctx.swells
        .map((s) => (s.label ? `${fmt(s.t)}s (${s.label})` : `${fmt(s.t)}s`))
        .join(", ")}.`,
    );
  }
  return lines.join("\n");
}

function fmt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "?";
  return String(Math.round(n * 1000) / 1000);
}

/** Pull the first candidate's content parts out of a `generateContent` response. */
function candidateParts(json: unknown): unknown[] {
  const j = json as {
    candidates?: Array<{ content?: { parts?: unknown[] } }>;
  };
  const parts = j?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts : [];
}

/**
 * Map a Gemini `functionCall` part into a `ToolCall`. Drops calls whose name
 * isn't a known assistant tool (the orchestrator would reject them anyway), and
 * normalizes a missing/invalid `args` to `{}`.
 */
function functionCallToToolCall(fc: Record<string, unknown>): ToolCall | null {
  const name = fc["name"];
  if (typeof name !== "string" || !KNOWN_TOOLS.has(name)) return null;
  const rawArgs = fc["args"];
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  return { name: name as ToolName, args };
}

/** Read a response body as text without throwing. */
async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
