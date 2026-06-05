// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />

// Allow `import pkg from "../package.json"` (Vite resolves JSON natively).
declare module "*.json" {
  const value: unknown;
  export default value;
}
