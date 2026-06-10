// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * webPlatform — the dev/browser backend. Every capability is a `fetch` to the
 * Node dev server (see app/dev-server/server.mjs) running on localhost:8787,
 * which shells out to ffmpeg/ffprobe and the footlight CLI. This is the path
 * that is fully runnable and verifiable in a plain browser without any native
 * toolchain.
 */

import type { ClipSpec } from "@manifest";
import type {
  FootlightPlatform,
  FontInfo,
  ProbeResult,
  LoudnessResult,
  TrackRequest,
  TrackSample,
  HistoryEntry,
  SessionData,
  RenderOptions,
  OutdirCheck,
} from "./types.js";

const BASE = "http://localhost:8787";

// localStorage key prefix for the DEV-ONLY secret shim (see getSecret below).
const SECRET_PREFIX = "footlight.secret.";

export const webPlatform: FootlightPlatform = {
  async extractFrame(source: string, tSeconds: number): Promise<string> {
    const url = `${BASE}/frame?source=${encodeURIComponent(source)}&t=${encodeURIComponent(
      String(tSeconds),
    )}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`frame failed (${res.status}): ${await res.text()}`);
    }
    const blob = await res.blob();
    // Return an object URL the caller is responsible for revoking.
    return URL.createObjectURL(blob);
  },

  async probe(source: string): Promise<ProbeResult> {
    const res = await fetch(`${BASE}/probe?source=${encodeURIComponent(source)}`);
    if (!res.ok) {
      throw new Error(`probe failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as ProbeResult;
  },

  async scenes(source: string): Promise<number[]> {
    const res = await fetch(`${BASE}/scenes?source=${encodeURIComponent(source)}`);
    if (!res.ok) {
      throw new Error(`scenes failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as number[];
  },

  async loudness(source: string): Promise<LoudnessResult> {
    const res = await fetch(`${BASE}/loudness?source=${encodeURIComponent(source)}`);
    if (!res.ok) {
      throw new Error(`loudness failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as LoudnessResult;
  },

  async track(req: TrackRequest): Promise<TrackSample[]> {
    const res = await fetch(`${BASE}/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`track failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as TrackSample[];
  },

  async render(manifestJson: string, opts?: RenderOptions): Promise<{ ok: boolean; log: string }> {
    const q = new URLSearchParams();
    if (opts?.outdir) q.set("outdir", opts.outdir);
    if (opts?.crf != null) q.set("crf", String(opts.crf));
    if (opts?.preset) q.set("preset", opts.preset);
    if (opts?.audioBitrate) q.set("audioBitrate", opts.audioBitrate);
    if (opts?.dryRun) q.set("dryRun", "1");
    if (opts?.burnCaptions) q.set("burnCaptions", "1");
    if (opts?.captionFont) q.set("captionFont", opts.captionFont);
    if (opts?.captionColor) q.set("captionColor", opts.captionColor);
    if (opts?.captionOutlineColor) q.set("captionOutlineColor", opts.captionOutlineColor);
    if (opts?.captionBold) q.set("captionBold", "1");
    if (opts?.captionItalic) q.set("captionItalic", "1");
    if (opts?.captionUnderline) q.set("captionUnderline", "1");
    if (opts?.captionShadow) q.set("captionShadow", "1");
    if (opts?.captionBox) q.set("captionBox", "1");
    if (opts?.captionBoxColor) q.set("captionBoxColor", opts.captionBoxColor);
    if (opts?.captionAngle != null) q.set("captionAngle", String(opts.captionAngle));
    const qs = q.toString();
    const url = qs ? `${BASE}/render?${qs}` : `${BASE}/render`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: manifestJson,
    });
    const data = (await res.json()) as { ok: boolean; log: string };
    return data;
  },

  // The web/dev build writes into the repo-relative `clips` folder (the dev
  // server resolves it against the project root); no home-dir resolution.
  async defaultOutdir(): Promise<string> {
    return "clips";
  },

  async checkOutdir(dir: string): Promise<OutdirCheck> {
    const url = `${BASE}/check-outdir?outdir=${encodeURIComponent(dir || "")}`;
    try {
      const res = await fetch(url);
      return (await res.json()) as OutdirCheck;
    } catch {
      return { ok: false, resolved: dir, error: "the dev backend is not reachable" };
    }
  },

  // Browser download: there's no native Save dialog, so stream the content into a
  // blob URL and click a synthetic <a download>. Always "succeeds" (the browser
  // owns where it lands), so resolve true.
  async exportTextFile(suggestedName: string, content: string): Promise<boolean> {
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },

  // Cover-frame export (issue #166): the dev server probes the source, runs the
  // engine's `coverFrameArgs` at t with the spec's active framing, and streams
  // the 1080×1920 PNG back; we download it like exportTextFile does (the browser
  // owns where it lands, so a successful response resolves true).
  async exportCover(
    source: string,
    t: number,
    spec: ClipSpec,
    suggestedName: string,
  ): Promise<boolean> {
    const url = `${BASE}/cover?source=${encodeURIComponent(source)}&t=${encodeURIComponent(
      String(t),
    )}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    });
    if (!res.ok) {
      throw new Error(`cover failed (${res.status}): ${await res.text()}`);
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    return true;
  },

  async openExternal(url: string): Promise<void> {
    window.open(url, "_blank", "noopener,noreferrer");
  },

  // A browser page cannot obtain a real filesystem path from a file input, so
  // there is no native picker here — the UI keeps the typed-path field instead.
  supportsFilePicker: false,
  async pickSourceFile(): Promise<string | null> {
    return null;
  },

  // No native folder dialog in a browser; the UI keeps the typed Outdir field.
  async pickDirectory(): Promise<string | null> {
    return null;
  },

  async videoSrc(source: string): Promise<string> {
    // The dev server streams the file with HTTP Range support so <video> seeks.
    return `${BASE}/video?source=${encodeURIComponent(source)}`;
  },

  async loadHistory(): Promise<HistoryEntry[]> {
    const res = await fetch(`${BASE}/history`);
    if (!res.ok) {
      throw new Error(`loadHistory failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as HistoryEntry[];
  },

  async saveHistory(entries: HistoryEntry[]): Promise<void> {
    const res = await fetch(`${BASE}/history`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    if (!res.ok) {
      throw new Error(`saveHistory failed (${res.status}): ${await res.text()}`);
    }
  },

  async loadSession(): Promise<SessionData | null> {
    const res = await fetch(`${BASE}/session`);
    if (!res.ok) {
      throw new Error(`loadSession failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as SessionData | null;
  },

  async saveSession(data: SessionData): Promise<void> {
    const res = await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (!res.ok) {
      throw new Error(`saveSession failed (${res.status}): ${await res.text()}`);
    }
  },

  // --- Secret storage (DEV-ONLY boundary) -----------------------------------
  // A localhost dev server CANNOT reach the OS keychain — that's an inherently
  // native capability. So on the web/dev build we keep secrets in the browser's
  // own `localStorage` (prefixed to avoid colliding with the auto-track blob and
  // other app keys). This is acceptable ONLY for local dev: the packaged Tauri
  // build (`tauriPlatform`) is the one that actually puts the key in the OS
  // keychain. Do not ship the web build as a product surface for real keys.
  async getSecret(key: string): Promise<string | null> {
    // Env override (dev): if the dev server's shell has a GEMINI_API_KEY, use it
    // so `make gui` works without pasting a key. Only for the Gemini secret; the
    // pasted localStorage value is the fallback when no env var is set.
    if (key.includes("gemini")) {
      try {
        const res = await fetch(`${BASE}/env-key`);
        if (res.ok) {
          const v = (await res.text()).trim();
          if (v) return v;
        }
      } catch {
        /* dev server unreachable — fall through to the localStorage shim. */
      }
    }
    try {
      return localStorage.getItem(`${SECRET_PREFIX}${key}`);
    } catch {
      // localStorage unavailable (private mode etc.) — treat as "no secret".
      return null;
    }
  },

  async setSecret(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(`${SECRET_PREFIX}${key}`, value);
    } catch {
      /* localStorage unavailable — non-fatal in the dev build. */
    }
  },

  async deleteSecret(key: string): Promise<void> {
    try {
      localStorage.removeItem(`${SECRET_PREFIX}${key}`);
    } catch {
      /* localStorage unavailable — non-fatal in the dev build. */
    }
  },

  // Ask the dev server for the system fonts it enumerated via fontconfig
  // (`fc-list`). Best-effort: any failure (server down, parse error) yields `[]`
  // so the picker falls back to the free-text font field.
  async listFonts(): Promise<FontInfo[]> {
    try {
      const res = await fetch(`${BASE}/fonts`);
      if (!res.ok) return [];
      return (await res.json()) as FontInfo[];
    } catch {
      return [];
    }
  },

  // Ask the dev server to scan a user fonts folder (`/fonts?dir=`), resolving
  // each file's family via `fc-scan`. Best-effort like `listFonts`: an empty
  // `dir` or any failure yields `[]` so the picker falls back to free-text.
  async listUserFonts(dir: string): Promise<FontInfo[]> {
    if (!dir) return [];
    try {
      const res = await fetch(`${BASE}/fonts?dir=${encodeURIComponent(dir)}`);
      if (!res.ok) return [];
      return (await res.json()) as FontInfo[];
    } catch {
      return [];
    }
  },
};
