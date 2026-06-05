// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The separate Activity window (Tauri only). Renders render / scene-detect /
 * auto-track output pushed from the main window via the `activity-log` event,
 * so the main UI stays clean. On load it emits `activity-ready` so the main
 * window replays the latest output into the freshly-opened window.
 */

import "./style.css";

interface ActivityPayload {
  text: string;
  kind: "" | "ok" | "err";
  outDir: string;
}

/** Match the main window's theme so the colors/tokens line up. */
function applyTheme(t: string): void {
  document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
}
// Best-effort initial theme (localStorage may be shared per-origin); the main
// window also pushes the authoritative theme over the `theme` event below.
try {
  applyTheme(localStorage.getItem("footlight.theme") || "light");
} catch {
  applyTheme("light");
}

const root = document.getElementById("activity-root");
if (!root) throw new Error("missing #activity-root");
root.className = "activity-window";

const head = document.createElement("div");
head.className = "activity-head";
const title = document.createElement("div");
title.className = "activity-title";
title.textContent = "Activity";
const outDir = document.createElement("div");
outDir.className = "hint";
const copyBtn = document.createElement("button");
copyBtn.className = "iconbtn";
copyBtn.textContent = "⧉ Copy";
copyBtn.title = "Copy the output to the clipboard";
head.append(title, outDir, copyBtn);

const pre = document.createElement("pre");
pre.className = "log";
pre.textContent = "(output appears here)";

root.append(head, pre);

copyBtn.addEventListener("click", () => {
  const text = pre.textContent ?? "";
  if (!text.trim() || text === "(output appears here)") return;
  void navigator.clipboard.writeText(text).then(
    () => flash("✓ Copied"),
    () => flash("Copy failed"),
  );
});

function flash(msg: string): void {
  copyBtn.textContent = msg;
  window.setTimeout(() => (copyBtn.textContent = "⧉ Copy"), 1200);
}

function render(p: ActivityPayload): void {
  pre.className = p.kind ? `log ${p.kind}` : "log";
  pre.textContent = p.text;
  outDir.textContent = "";
  if (p.outDir) {
    outDir.append(document.createTextNode("Clips written to "));
    const s = document.createElement("span");
    s.className = "stat";
    s.textContent = p.outDir;
    outDir.append(s);
  }
}

void (async () => {
  const { listen, emit } = await import("@tauri-apps/api/event");
  await listen<ActivityPayload>("activity-log", (e) => render(e.payload));
  await listen<string>("theme", (e) => applyTheme(e.payload));
  // Tell the main window we're ready so it replays the latest output + theme.
  await emit("activity-ready");
})();
