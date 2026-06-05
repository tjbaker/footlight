// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** App entry: mount the Studio editor (which builds its own top bar). */

import "./style.css";
import { openAbout } from "./menu.js";
import { openGuide } from "./help.js";
import { openSettings } from "./settings.js";
import { mountEditor } from "./editor.js";
import { platformName } from "./platform/index.js";

const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

mountEditor(app);

// Under Tauri, native menu items emit events; open the same in-app modals so the
// native menu and the in-app controls share one source of truth.
if (platformName === "tauri") {
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen("show-about", () => openAbout());
      await listen("show-guide", () => openGuide());
      await listen("show-settings", () => openSettings());
    } catch {
      // Not fatal: Settings is reachable from the top-bar gear.
    }
  })();
}
