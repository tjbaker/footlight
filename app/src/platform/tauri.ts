// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * tauriPlatform — the native backend. Each capability is a Tauri `invoke` of a
 * Rust `#[tauri::command]` (see app/src-tauri/src/main.rs) that shells out to
 * ffmpeg/ffprobe and the footlight CLI directly, with no localhost HTTP hop.
 *
 * The `@tauri-apps/*` imports are dynamic so that this module is safe to load
 * in a plain browser (where `__TAURI__` is absent and these packages may not be
 * resolvable at runtime) — they are only pulled in when actually invoked under
 * Tauri.
 */

import type {
  FootlightPlatform,
  ProbeResult,
  LoudnessResult,
  TrackRequest,
  TrackSample,
  HistoryEntry,
  SessionData,
  RenderOptions,
} from "./types.js";

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const tauriPlatform: FootlightPlatform = {
  async extractFrame(source: string, tSeconds: number): Promise<string> {
    // The Rust side writes a temp jpg and returns a path we can wrap with the
    // Tauri asset protocol so an <img> can display it.
    const path = await invoke<string>("extract_frame", { source, t: tSeconds });
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    // extract_frame reuses the same temp filename, so the asset URL is otherwise
    // stable — append a cache-buster keyed on BOTH the source and the timestamp
    // so the webview reloads whenever either changes. (Keying on time alone meant
    // switching clips while staying at the same t produced an identical URL and
    // kept showing the previous clip's cached frame.) The asset protocol resolves
    // by path and ignores the query string.
    const bust = `v=${encodeURIComponent(String(tSeconds))}&s=${encodeURIComponent(source)}`;
    return `${convertFileSrc(path)}?${bust}`;
  },

  async probe(source: string): Promise<ProbeResult> {
    return invoke<ProbeResult>("probe", { source });
  },

  async scenes(source: string): Promise<number[]> {
    return invoke<number[]>("scenes", { source });
  },

  async loudness(source: string): Promise<LoudnessResult> {
    return invoke<LoudnessResult>("loudness", { source });
  },

  async track(req: TrackRequest): Promise<TrackSample[]> {
    return invoke<TrackSample[]>("track", { req });
  },

  async render(
    manifestJson: string,
    opts?: RenderOptions,
  ): Promise<{ ok: boolean; log: string }> {
    return invoke<{ ok: boolean; log: string }>("render", {
      manifestJson,
      outdir: opts?.outdir ?? null,
      crf: opts?.crf ?? null,
      preset: opts?.preset ?? null,
      audioBitrate: opts?.audioBitrate ?? null,
      dryRun: opts?.dryRun ?? false,
    });
  },

  async openExternal(url: string): Promise<void> {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  },

  supportsFilePicker: true,
  async pickSourceFile(): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Choose a source video",
      filters: [
        {
          name: "Video",
          extensions: ["mp4", "mov", "mkv", "webm", "m4v", "avi"],
        },
      ],
    });
    // `open` returns a path string, or null when cancelled (never an array here
    // since multiple:false).
    return typeof selected === "string" ? selected : null;
  },

  async pickDirectory(): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: true,
      title: "Choose an output folder for clips",
    });
    return typeof selected === "string" ? selected : null;
  },

  async videoSrc(source: string): Promise<string> {
    // The asset protocol serves the local file (with audio) and supports range
    // requests, so the <video> element can play and seek it directly.
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return convertFileSrc(source);
  },

  async loadHistory(): Promise<HistoryEntry[]> {
    return invoke<HistoryEntry[]>("load_history", {});
  },

  async saveHistory(entries: HistoryEntry[]): Promise<void> {
    await invoke<void>("save_history", { entries });
  },

  async loadSession(): Promise<SessionData | null> {
    return invoke<SessionData | null>("load_session", {});
  },

  async saveSession(data: SessionData): Promise<void> {
    await invoke<void>("save_session", { data });
  },

  // Secret storage backed by the OS keychain via the Rust `keyring` crate (see
  // get_secret / set_secret / delete_secret in app/src-tauri/src/main.rs). The
  // bundle identifier is the keyring service; `key` is the account name.
  async getSecret(key: string): Promise<string | null> {
    return invoke<string | null>("get_secret", { key });
  },

  async setSecret(key: string, value: string): Promise<void> {
    await invoke<void>("set_secret", { key, value });
  },

  async deleteSecret(key: string): Promise<void> {
    await invoke<void>("delete_secret", { key });
  },
};
