// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The footlight CLI `render` argv, built in ONE place (issue #260).
 *
 * Pure and browser-safe (no `node:` imports). The web dev backend
 * (`app/dev-server/server.mjs`) calls this directly; the native Tauri shell
 * cannot import TS, so `render_cli_args` in `app/src-tauri/src/main.rs` is a
 * documented hand mirror. Both are pinned to the same cases in
 * `test/fixtures/render-cli-args.json`, so a drift on either side fails CI.
 */

/** Everything the GUI's render options can put on the CLI. */
export interface RenderCliOptions {
  /** The manifest file to render (positional, right after `render`). */
  manifestPath: string;
  /** Resolved output directory; `--outdir` is always emitted, LAST. */
  outDir: string;
  /** `--crf`. Every number is forwarded, including 0 (x264 lossless). */
  crf?: number | null;
  preset?: string | null;
  audioBitrate?: string | null;
  dryRun?: boolean | null;
  burnCaptions?: boolean | null;
  captionFont?: string | null;
  captionColor?: string | null;
  captionOutlineColor?: string | null;
  captionBold?: boolean | null;
  captionItalic?: boolean | null;
  captionUnderline?: boolean | null;
  captionShadow?: boolean | null;
  captionBox?: boolean | null;
  captionBoxColor?: string | null;
  /** `--caption-angle`. 0 degrees is a real value and is forwarded. */
  captionAngle?: number | null;
}

/**
 * Build the `render` argv (everything after `node <cli>`): `render`, the
 * manifest path, the flags, then `--outdir <dir>` LAST so the client can parse
 * the log's trailing `--outdir`. Rules: numbers are emitted whenever present
 * (0 included); strings only when non-empty; toggles only when `true`. Flag
 * names and order mirror `src/cli.ts`.
 */
export function renderCliArgs(opts: RenderCliOptions): string[] {
  const args = ["render", opts.manifestPath];
  const num = (flag: string, v: number | null | undefined): void => {
    if (v != null) args.push(flag, String(v));
  };
  const str = (flag: string, v: string | null | undefined): void => {
    if (v) args.push(flag, v);
  };
  const toggle = (flag: string, v: boolean | null | undefined): void => {
    if (v === true) args.push(flag);
  };
  num("--crf", opts.crf);
  str("--preset", opts.preset);
  str("--audio-bitrate", opts.audioBitrate);
  toggle("--dry-run", opts.dryRun);
  toggle("--burn-captions", opts.burnCaptions);
  str("--caption-font", opts.captionFont);
  str("--caption-color", opts.captionColor);
  str("--caption-outline-color", opts.captionOutlineColor);
  toggle("--caption-bold", opts.captionBold);
  toggle("--caption-italic", opts.captionItalic);
  toggle("--caption-underline", opts.captionUnderline);
  toggle("--caption-shadow", opts.captionShadow);
  toggle("--caption-box", opts.captionBox);
  str("--caption-box-color", opts.captionBoxColor);
  num("--caption-angle", opts.captionAngle);
  args.push("--outdir", opts.outDir);
  return args;
}
