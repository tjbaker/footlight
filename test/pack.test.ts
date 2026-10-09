// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pins the npm tarball contents (`npm pack --dry-run --json`): only current
 * build output for real `src/` modules, plus bin, NOTICE, LICENSE, README and
 * package.json. No sourcemaps (they point at `src/`, which isn't shipped) and
 * no stale output from removed modules.
 *
 * `--ignore-scripts` skips the `prepack` clean+build so the test reads the
 * `dist/` that `npm run build` already produced (CI and `npm run verify` build
 * before testing). A stale local `dist/` fails here on purpose — `prepack`
 * would clean it, but the fix locally is `rm -rf dist && npm run build`.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** src module paths relative to src/, without the `.ts` extension. */
const srcModules = readdirSync(new URL("../src", import.meta.url), {
  recursive: true,
  encoding: "utf8",
})
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => f.replaceAll("\\", "/").slice(0, -".ts".length));

let files: string[] = [];

beforeAll(() => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const [pkg] = JSON.parse(out) as { files: { path: string }[] }[];
  files = pkg!.files.map((f) => f.path).sort();
});

describe("npm tarball", () => {
  it("ships the CLI entry point, bin shim, and license notices", () => {
    for (const f of [
      "bin/footlight.js",
      "dist/cli.js",
      "dist/engine.js",
      "LICENSE",
      "NOTICE",
      "README.md",
      "package.json",
    ]) {
      expect(files).toContain(f);
    }
  });

  it("ships no sourcemaps and no studio output", () => {
    expect(files.filter((f) => f.endsWith(".map"))).toEqual([]);
    expect(files.filter((f) => f.includes("studio"))).toEqual([]);
  });

  it("ships exactly the .js + .d.ts of each current src module", () => {
    const expected = srcModules.flatMap((m) => [`dist/${m}.d.ts`, `dist/${m}.js`]).sort();
    expect(files.filter((f) => f.startsWith("dist/"))).toEqual(expected);
  });

  it("ships nothing outside dist/ beyond the known top-level files", () => {
    expect(files.filter((f) => !f.startsWith("dist/"))).toEqual(
      ["LICENSE", "NOTICE", "README.md", "bin/footlight.js", "package.json"].sort(),
    );
  });
});
