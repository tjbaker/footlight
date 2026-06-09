// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Per-turn assistant-context assembly, lifted out of editor.ts (#125, Phase 2).
 * `assembleAssistantContext` is the pure object assembly (the conditional
 * spreads deciding which optional fields a turn carries); `sampleChatStills`
 * plans + extracts the sparse still strip (#40) with the frame extractor
 * injected so tests never touch a platform. The keychain read, i18n messaging,
 * and model resolution stay in the editor — only data-in/data-out lives here.
 */

import { planChatStillTimes } from "./editor-chat.js";

/** One sampled still: clip time + inline-image payload for the model. */
export interface ChatStill {
  t: number;
  mimeType: string;
  dataBase64: string;
}

/** The live editor data a turn's context is assembled from. */
export interface AssistantContextInput<M> {
  region: { width: number; height: number };
  source: string;
  models: M;
  /** Already trimmed. */
  apiKey: string;
  basePrompt: string;
  /** The editor's append-only framing preferences, or null when none. */
  overlay: string | null;
  inPoint: number | null;
  outPoint: number | null;
  duration: number;
  sceneCuts: number[];
  swells: Array<{ t: number; label: string }>;
  stills: ChatStill[];
}

/**
 * Assemble the per-turn `AssistantContext`: required fields verbatim, optional
 * fields only when they carry signal (no In/Out → no inSec/outSec, no cuts →
 * no sceneCuts, …) so the prompt never sees empty placeholders.
 */
export function assembleAssistantContext<M>(i: AssistantContextInput<M>): {
  region: { width: number; height: number };
  source: string;
  models: M;
  apiKey: string;
  basePrompt: string;
  userOverlay?: string;
  inSec?: number;
  outSec?: number;
  duration?: number;
  sceneCuts?: number[];
  swells?: Array<{ t: number; label: string }>;
  stills?: ChatStill[];
} {
  return {
    region: { width: i.region.width, height: i.region.height },
    source: i.source,
    models: i.models,
    apiKey: i.apiKey,
    basePrompt: i.basePrompt,
    ...(i.overlay ? { userOverlay: i.overlay } : {}),
    ...(i.inPoint != null ? { inSec: i.inPoint } : {}),
    ...(i.outPoint != null ? { outSec: i.outPoint } : {}),
    ...(i.duration > 0 ? { duration: i.duration } : {}),
    ...(i.sceneCuts.length ? { sceneCuts: i.sceneCuts.slice() } : {}),
    ...(i.swells.length ? { swells: i.swells.map((s) => ({ t: s.t, label: s.label })) } : {}),
    ...(i.stills.length ? { stills: i.stills } : {}),
  };
}

/**
 * Sample the per-turn still strip (#40): cut-aware frames across In→Out (or the
 * whole source when no In/Out is set), trimmed evenly to the user's "Chat stills"
 * budget, each extracted + base64-encoded for the model's inline image parts.
 * Budget 0, no window, or no source → no stills; any per-frame failure is skipped
 * so a turn never fails over a missing frame.
 */
export async function sampleChatStills(opts: {
  source: string;
  budget: number;
  inPoint: number | null;
  outPoint: number | null;
  duration: number;
  sceneCuts: number[];
  /** Extracts one frame and returns its URL (blob or asset). */
  extractFrame: (source: string, t: number) => Promise<string>;
}): Promise<ChatStill[]> {
  if (!opts.source) return [];
  const times = planChatStillTimes({
    budget: opts.budget,
    inPoint: opts.inPoint,
    outPoint: opts.outPoint,
    duration: opts.duration,
    sceneCuts: opts.sceneCuts,
  });
  const out: ChatStill[] = [];
  for (const t of times) {
    try {
      const url = await opts.extractFrame(opts.source, t);
      const enc = await urlToBase64(url);
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      if (enc) out.push({ t, mimeType: enc.mimeType, dataBase64: enc.dataBase64 });
    } catch {
      /* skip a frame that fails to extract/encode — never fail the turn over it */
    }
  }
  return out;
}

/** Fetch an extracted-frame URL (blob or asset) and return its base64 + mime. */
export async function urlToBase64(
  url: string,
): Promise<{ mimeType: string; dataBase64: string } | null> {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const dataUrl: string = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    return { mimeType: blob.type || "image/jpeg", dataBase64: dataUrl.slice(comma + 1) };
  } catch {
    return null;
  }
}
