// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { renderCliArgs, type RenderCliOptions } from "../src/render-args.js";

// The SAME cases the Rust mirror (`render_cli_args` in app/src-tauri/src/main.rs)
// reads via include_str!, so the two argv builders cannot drift apart.
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/render-cli-args.json", import.meta.url), "utf8"),
) as { name: string; opts: RenderCliOptions; argv: string[] }[];

describe("renderCliArgs (shared fixtures)", () => {
  it("has fixture cases", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("$name", ({ opts, argv }) => {
    expect(renderCliArgs(opts)).toEqual(argv);
  });
});
