// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** App version + repo metadata, read from the app's package.json at build time. */

import pkg from "../package.json";

export const APP_NAME = "Footlight";
export const APP_VERSION: string = (pkg as { version: string }).version;
export const LICENSE = "Apache-2.0";
export const COPYRIGHT = "Copyright 2026 Trevor Baker";
export const REPO_URL = "https://github.com/tjbaker/footlight";
export const ISSUES_NEW_URL = "https://github.com/tjbaker/footlight/issues/new";
