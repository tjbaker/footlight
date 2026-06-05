#!/usr/bin/env node
// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** CLI entry point for footlight. Delegates to the compiled engine/CLI. */
import { main } from "../dist/cli.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
