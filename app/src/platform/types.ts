// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The platform seam: the single interface that sits between the UI and the
 * outside world (ffmpeg, the filesystem, external links). The UI talks only to
 * a `FootlightPlatform`; concrete backends — the Node dev server (`webPlatform`)
 * and the native Tauri shell (`tauriPlatform`) — implement it. Swapping
 * backends is therefore a one-line selection at startup, and the editor never
 * needs to know which one it is running against.
 */

import type { ClipSpec } from "@studio";

/** One past render, persisted locally so it can be re-opened and tweaked. */
export interface HistoryEntry {
  id: string;     // unique
  ts: number;     // epoch ms when rendered
  spec: ClipSpec; // the rendered clip's spec
  outdir: string; // the output dir used
}

/** A saved working session (project) — restored on next launch. */
export interface SessionData {
  source: string;     // last-loaded source path ("" if none)
  outdir: string;     // output dir
  clips: ClipSpec[];  // the queue
  savedAt: number;    // epoch ms
}

/** Result of probing a source video. */
export interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  /** A `W:H:X:Y` cropdetect suggestion (black bars only), or null. */
  cropdetect: string | null;
}

/**
 * Two normalized (0..1) loudness envelopes for the timeline, from one ffmpeg pass:
 * `display` is perceptual (ebur128 momentary LUFS) for the waveform bars; `detect`
 * is raw-energy RMS, fed to the swell detector because it exposes the musical dips
 * that perceptually-gated LUFS smooths away on compressed live material.
 */
export interface LoudnessResult {
  display: number[];
  detect: number[];
}

/** A located subject at a clip-relative time; `box` is in working-region pixels. */
export interface TrackSample {
  t: number;
  box: { x: number; y: number; w: number; h: number };
}

/**
 * A subject-tracking request, mirroring the CLI's `track <request.json>` shape.
 * `apiKey` is BYOK and only needed for the live provider; `mock:true` runs the
 * deterministic offline MockTracker (no network, no key).
 */
export interface TrackRequest {
  sourcePath: string;
  region: { width: number; height: number };
  sampleTimes: number[];
  subjectHint?: string;
  apiKey?: string;
  mock?: boolean;
  /**
   * Source-seconds offset of the shot's In point. Frames are extracted from
   * `startSec + sampleTime`; the returned path stays clip-relative.
   */
  startSec?: number;
  /** Optional `W:H:X:Y` content crop applied during frame extraction. */
  contentCrop?: string;
}

/** The contract every backend must satisfy. */
export interface FootlightPlatform {
  /** Extract a single frame at `tSeconds`; returns an image URL usable in <img>. */
  extractFrame(source: string, tSeconds: number): Promise<string>;
  /** Probe dimensions, duration, and a cropdetect suggestion. */
  probe(source: string): Promise<ProbeResult>;
  /** Detect scene-cut timestamps (seconds). */
  scenes(source: string): Promise<number[]>;
  /**
   * Compute the timeline's two loudness envelopes (perceptual `display` + RMS
   * `detect`) in one pass. A cheap pass next to `probe`; cache per source. Swell
   * suggestions are derived from `detect` on the frontend via `detectSwells`.
   */
  loudness(source: string): Promise<LoudnessResult>;
  /**
   * Locate a subject across the requested sample times (AI subject tracking,
   * SPEC §6.9). Shells the CLI's `track` command in the backend; the live
   * (Gemini) path needs a real key, `mock:true` runs offline.
   */
  track(req: TrackRequest): Promise<TrackSample[]>;
  /**
   * Render a JSON manifest via the footlight CLI engine. `manifestJson` is the
   * string produced by `serializeManifestJSON` (clips may carry a `cropPath`).
   * The backend writes it to a temp `.json` so the CLI takes the JSON path.
   */
  render(manifestJson: string, opts?: { outdir?: string }): Promise<{ ok: boolean; log: string }>;
  /** Open a URL in the user's default browser. */
  openExternal(url: string): Promise<void>;
  /**
   * Open a native file-picker for a source video and return the chosen absolute
   * path, or null if the user cancelled. Returns null on backends that have no
   * native picker (the browser dev backend, which can't read a real filesystem
   * path) — callers should fall back to the typed path field there. Check
   * `supportsFilePicker` before surfacing a Browse affordance.
   */
  pickSourceFile(): Promise<string | null>;
  /**
   * Open a native folder picker and return the chosen absolute directory path,
   * or null if the user cancelled. Returns null on backends without a native
   * dialog (the browser dev backend) — callers fall back to the typed Outdir
   * field there. Gated by `supportsFilePicker`, like `pickSourceFile`.
   */
  pickDirectory(): Promise<string | null>;
  /** Whether `pickSourceFile`/`pickDirectory` open a real native dialog (false on web). */
  readonly supportsFilePicker: boolean;
  /**
   * A playable URL for the source video (with audio) for the preview player —
   * the native asset protocol under Tauri, or a range-streaming dev-server
   * endpoint on the web build. Supports seeking (HTTP Range).
   */
  videoSrc(source: string): Promise<string>;
  /** Load the persisted render history (as last saved). Empty array if none. */
  loadHistory(): Promise<HistoryEntry[]>;
  /** Persist the full render-history array (the frontend owns capping/ordering). */
  saveHistory(entries: HistoryEntry[]): Promise<void>;
  /** Load the saved session, or null if none. */
  loadSession(): Promise<SessionData | null>;
  /** Persist the working session. */
  saveSession(data: SessionData): Promise<void>;
  /**
   * Secret storage for sensitive values (the BYOK API key, SPEC follow-up). The
   * native backend backs this with the OS keychain (macOS Keychain / Windows
   * Credential Manager / libsecret) keyed on the app's bundle identifier; the
   * web dev backend can't reach an OS keychain, so it falls back to a documented
   * DEV-ONLY localStorage shim. Always go through this seam — never persist a key
   * inline in a session/manifest/config file.
   *
   * `key` is a stable account name (e.g. `"apiKey"`); `getSecret` returns null
   * when the entry is absent. These are async on BOTH backends.
   */
  getSecret(key: string): Promise<string | null>;
  /** Store (or overwrite) the secret value for `key`. */
  setSecret(key: string, value: string): Promise<void>;
  /** Delete the secret for `key`; a no-op if it does not exist. */
  deleteSecret(key: string): Promise<void>;
}
