// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-call argument validators shared by the assistant's deterministic tool
 * interpreter (`tools.ts`) and the orchestrator's vision tools
 * (`orchestrator.ts`). Model-proposed args are untrusted JSON, so each reader
 * either returns a well-typed value or throws a message naming the bad arg.
 * Pure and browser-safe.
 */

/** A required finite number arg, else throw. */
export function numArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`tool arg "${key}" must be a finite number (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** A required non-empty string arg, else throw. */
export function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`tool arg "${key}" must be a non-empty string`);
  }
  return v;
}

/** An optional string arg: the value when it is a non-empty string, else `undefined`. */
export function optStrArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
