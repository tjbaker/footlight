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

import type { ClipSpec } from "@manifest";

/** One past render, persisted locally so it can be re-opened and tweaked. */
export interface HistoryEntry {
  id: string;     // unique
  ts: number;     // epoch ms when rendered
  spec: ClipSpec; // the rendered clip's spec
  outdir: string; // the output dir used
}

/** Render options that map 1:1 to the footlight CLI render flags. */
export interface RenderOptions {
  /** Output directory (`--outdir`). */
  outdir?: string;
  /** H.264 quality (`--crf`); lower = better/larger. */
  crf?: number;
  /** x264 speed/efficiency preset (`--preset`). */
  preset?: string;
  /** `--audio-bitrate`: `"copy"` (lossless passthrough) or a bitrate like `"256k"`. */
  audioBitrate?: string;
  /** Print the ffmpeg commands without running them (`--dry-run`). */
  dryRun?: boolean;
  /** Burn each clip's hook/title into the video (`--burn-captions`); off by default. */
  burnCaptions?: boolean;
  /**
   * Caption font: a `.ttf`/`.otf` file path or a system family name
   * (`--caption-font`). The engine treats a value with a path separator or font
   * extension as a file (libass `fontsdir`), otherwise a fontconfig name.
   */
  captionFont?: string;
  /** Caption fill colour `#RRGGBB` (`--caption-color`); default white. */
  captionColor?: string;
  /** Caption outline colour `#RRGGBB` (`--caption-outline-color`); default black. */
  captionOutlineColor?: string;
  /** Bold / italic / underline the burned caption (`--caption-bold` etc.). */
  captionBold?: boolean;
  captionItalic?: boolean;
  captionUnderline?: boolean;
  /** Drop shadow behind the caption (`--caption-shadow`). */
  captionShadow?: boolean;
  /** Opaque box behind the caption (`--caption-box`) + its `#RRGGBB` colour. */
  captionBox?: boolean;
  captionBoxColor?: string;
  /** Rotate the caption by N degrees (`--caption-angle`). */
  captionAngle?: number;
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
 * Normalized (0..1) audio envelopes for the timeline, from one ffmpeg pass:
 * `display` is perceptual (ebur128 momentary LUFS) for the waveform bars; `detect`
 * is raw-energy RMS, fed to the swell detector because it exposes the musical dips
 * that perceptually-gated LUFS smooths away on compressed live material;
 * `onsetEnvelope` is a FINE fixed-rate RMS envelope (`ONSET_FRAME_SEC` frames over
 * the same 8 kHz mono PCM — the 160-bucket envelopes are far too coarse for
 * beats), fed to `detectOnsets` for the In/Out beat-snap ticks.
 */
export interface LoudnessResult {
  display: number[];
  detect: number[];
  onsetEnvelope: number[];
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

/** Result of validating/creating a render output directory (SPEC §6, issue #58). */
export interface OutdirCheck {
  /** True when the resolved dir exists (or was created) and is writable. */
  ok: boolean;
  /** The absolute path the backend resolved the input to (shown to the user). */
  resolved: string;
  /** A short, user-facing reason when `ok` is false (e.g. "permission denied"). */
  error?: string;
}

/** An installed/available font the caption picker can offer. */
export interface FontInfo {
  /** Family name — the ASS `Fontname` / CSS `font-family` value used for captions. */
  family: string;
  /** Absolute path to a font file when known (for `fontsdir` / preview). */
  path?: string;
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
   * Compute the timeline's audio envelopes (perceptual `display` + RMS `detect`
   * + fine `onsetEnvelope`) in one pass. A cheap pass next to `probe`; cache per
   * source. Swell suggestions and beat-snap onsets are derived on the frontend
   * via `detectSwells(detect)` / `detectOnsets(onsetEnvelope)`.
   */
  loudness(source: string): Promise<LoudnessResult>;
  /**
   * Locate a subject across the requested sample times (AI subject tracking,
   * SPEC §6.9). Shells the CLI's `track` command in the backend; the live
   * (Gemini) path needs a real key, `mock:true` runs offline.
   */
  track(req: TrackRequest): Promise<TrackSample[]>;
  /**
   * List installed/available fonts for the caption font picker. Best-effort:
   * the native backend enumerates system fonts; the web/dev backend asks the dev
   * server (fontconfig). Returns `[]` when enumeration isn't available — the UI
   * then falls back to the free-text font field.
   */
  listFonts(): Promise<FontInfo[]>;
  /**
   * List font files in the user's "fonts folder" (`dir`), recursively, each with
   * its real family name (read via fc-scan / font-kit so libass can match it).
   * Returns `[]` for an empty/unreadable `dir`. Shown as a separate "Your fonts"
   * group above System fonts in the caption picker.
   */
  listUserFonts(dir: string): Promise<FontInfo[]>;
  /**
   * Render a JSON manifest via the footlight CLI engine. `manifestJson` is the
   * string produced by `serializeManifestJSON` (clips may carry a `cropPath`).
   * The backend writes it to a temp `.json` so the CLI takes the JSON path.
   * `opts` map 1:1 to the CLI render flags (from Settings → Rendering).
   */
  render(manifestJson: string, opts?: RenderOptions): Promise<{ ok: boolean; log: string }>;
  /**
   * The DEFAULT output folder for a fresh install (no persisted choice yet): the
   * native app resolves a `footlight` folder in `~/Movies` (the macOS video
   * folder); the web/dev backend uses the repo-relative `clips`. Used only to seed
   * an empty Outdir field — an explicit user choice (typed or persisted) wins.
   */
  defaultOutdir(): Promise<string>;
  /**
   * Validate the render output folder BEFORE rendering: resolve `dir` the same way
   * `render` does, create it if missing, and confirm it is writable. Returns the
   * resolved absolute path plus a friendly reason on failure, so the UI can warn
   * ("Can't write to …") instead of surfacing a raw `EACCES` from the engine
   * mid-render. Both backends implement it (issue #58).
   */
  checkOutdir(dir: string): Promise<OutdirCheck>;
  /**
   * Save `content` to a user-chosen text file (e.g. the queue exported as a JSON
   * manifest, which re-imports via `footlight render`). Web: downloads
   * `suggestedName`. Native: opens a Save dialog seeded with `suggestedName`, then
   * writes the file. Resolves `true` if a file was written, `false` if cancelled.
   */
  exportTextFile(suggestedName: string, content: string): Promise<boolean>;
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
