// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * App version + repo metadata. The version is read at build time from the
 * repo-root package.json — the single source of truth that release-please bumps
 * — so the About dialog always reflects the released version.
 */

import { version } from "../../package.json";

export const APP_NAME = "Footlight";
export const APP_VERSION: string = version;
export const LICENSE = "Apache-2.0";
export const COPYRIGHT = "Copyright 2026 Trevor Baker";
export const REPO_URL = "https://github.com/tjbaker/footlight";
export const ISSUES_NEW_URL = "https://github.com/tjbaker/footlight/issues/new";
