// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Gemini vision tracker (SPEC §6.9 reference provider).
 *
 * Locates the subject at the requested timestamps via the Gemini
 * `generateContent` REST API and maps Gemini's normalized boxes into pixel
 * `Box`es in the working region. Uses `fetch` only — no `node:` builtins — so
 * it works in Node 26+ and in the browser/Tauri frontend.
 *
 * BYOK & opt-in (SPEC §6.7): the key comes from `req.apiKey`; this class CANNOT
 * run without one and is never invoked in tests. The model and endpoint are
 * configurable (constructor opts); the tokens are the USER'S — this code path
 * only runs when the user has opted in and supplied a key.
 *
 * Gemini box convention: Gemini returns 2D bounding boxes as
 *   [ymin, xmin, ymax, xmax]
 * normalized to a 0..1000 scale (NOT 0..1). We convert each pair to pixels in
 * `region` and assemble a top-left-origin {x, y, w, h} Box.
 *
 * SOURCE DELIVERY — per-frame images, not video. Gemini's file_uri only accepts
 * Files-API / HTTPS / YouTube / gs:// URIs (never a local path), and uploading a
 * whole video is wasteful and would misalign clip-relative times. Instead the
 * Node `track` command extracts one frame per sample time (from In→Out, in the
 * working region) and passes them on `req.frames`; this provider sends them as
 * inline images labelled with their timestamps. The provider stays browser-safe
 * (fetch only) — it never reads the filesystem.
 */

import type { Box, Dims } from "../studio.js";
import type { TrackSample, TrackRequest, VisionTracker } from "./types.js";

/** Configurable model/endpoint — defaults target a current vision-capable Gemini. */
export interface GeminiTrackerOpts {
  /** Model id; configurable. */
  model?: string;
  /** API base; configurable (e.g. a proxy for the future managed-key tier). */
  apiBase?: string;
}

const GEMINI_SCALE = 1000; // Gemini normalizes box coords to 0..1000.

export class GeminiTracker implements VisionTracker {
  readonly name = "gemini";
  private readonly model: string;
  private readonly apiBase: string;

  constructor(opts: GeminiTrackerOpts = {}) {
    this.model = opts.model ?? "gemini-2.5-pro";
    this.apiBase =
      opts.apiBase ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  /**
   * Map one Gemini normalized box [ymin, xmin, ymax, xmax] (0..1000) into a
   * pixel `Box` within `region`. Exposed/static so the mapping is unit-testable
   * without any network. Values are clamped to the region and ordered so w/h
   * are non-negative even if the model returns swapped corners.
   */
  static boxFromGemini(
    norm: [number, number, number, number],
    region: Dims,
  ): Box {
    const [ymin, xmin, ymax, xmax] = norm;
    const x0 = (Math.min(xmin, xmax) / GEMINI_SCALE) * region.width;
    const x1 = (Math.max(xmin, xmax) / GEMINI_SCALE) * region.width;
    const y0 = (Math.min(ymin, ymax) / GEMINI_SCALE) * region.height;
    const y1 = (Math.max(ymin, ymax) / GEMINI_SCALE) * region.height;
    const cx0 = Math.max(0, Math.min(region.width, x0));
    const cx1 = Math.max(0, Math.min(region.width, x1));
    const cy0 = Math.max(0, Math.min(region.height, y0));
    const cy1 = Math.max(0, Math.min(region.height, y1));
    return { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
  }

  private prompt(req: TrackRequest): string {
    const subject = req.subjectHint?.trim() || "the main performer";
    return [
      `You are given a sequence of video frames, each preceded by its timestamp`,
      `label "t=<seconds>". For each frame, locate ${JSON.stringify(subject)} and`,
      `report its 2D bounding box.`,
      `It is the SAME subject throughout; hold identity through occlusion and`,
      `brief detection dropouts. If the subject is genuinely not visible in a`,
      `frame, OMIT that entry rather than guessing.`,
      ``,
      `Return ONLY a JSON array, no prose, of objects:`,
      `[{"t": <seconds:number>, "box_2d": [ymin, xmin, ymax, xmax]}]`,
      `where box_2d is normalized to 0..1000 and t matches the frame's label.`,
    ].join("\n");
  }

  async track(req: TrackRequest): Promise<TrackSample[]> {
    if (!req.apiKey) {
      throw new Error("GeminiTracker: apiKey is required (BYOK; opt-in).");
    }
    const frames = req.frames ?? [];
    if (frames.length === 0) {
      throw new Error(
        "GeminiTracker: no frames provided — image-based tracking expects " +
          "pre-extracted frames (the Node `track` command supplies them).",
      );
    }

    const url = `${this.apiBase}/models/${encodeURIComponent(
      this.model,
    )}:generateContent`;

    // Prompt first, then each frame as a timestamp label followed by its image.
    const parts: unknown[] = [{ text: this.prompt(req) }];
    for (const f of frames) {
      parts.push({ text: `t=${Number(f.t.toFixed(3))}` });
      parts.push({ inline_data: { mime_type: f.mimeType, data: f.dataBase64 } });
    }

    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        // Coordinates, not prose — keep it deterministic and JSON.
        temperature: 0,
        responseMimeType: "application/json",
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Header auth keeps the key out of the URL / server logs.
        "x-goog-api-key": req.apiKey,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(
        `GeminiTracker: HTTP ${res.status} ${res.statusText}${
          detail ? ` — ${detail}` : ""
        }`,
      );
    }

    const json: unknown = await res.json();
    const text = extractText(json);
    if (!text) {
      return [];
    }
    return this.parseSamples(text, req.region);
  }

  /** Parse the model's JSON text into samples; defensive against junk/markdown. */
  private parseSamples(text: string, region: Dims): TrackSample[] {
    const arr = parseJsonArray(text);
    if (!arr) {
      return [];
    }
    const out: TrackSample[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const t = Number(rec["t"]);
      const raw = rec["box_2d"];
      if (!Number.isFinite(t) || !Array.isArray(raw) || raw.length !== 4) {
        continue;
      }
      const nums = raw.map((n) => Number(n));
      if (nums.some((n) => !Number.isFinite(n))) continue;
      out.push({
        t,
        box: GeminiTracker.boxFromGemini(
          nums as [number, number, number, number],
          region,
        ),
      });
    }
    return out.sort((a, b) => a.t - b.t);
  }
}

/** Pull the first text part out of a Gemini `generateContent` response. */
function extractText(json: unknown): string | null {
  const j = json as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const parts = j?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (typeof p?.text === "string" && p.text.trim()) return p.text;
  }
  return null;
}

/** Parse a JSON array out of model text, tolerating ```json fences / stray prose. */
function parseJsonArray(text: string): unknown[] | null {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  // Try whole-string first, then the first [...] span.
  for (const candidate of [stripped, sliceBrackets(stripped)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return null;
}

/** Extract the outermost [...] substring, or null. */
function sliceBrackets(s: string): string | null {
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

/** Read a response body as text without throwing. */
async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
