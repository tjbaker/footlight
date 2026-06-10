// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Activity / Output VIEW (#125 Phase 4). `buildActivityPanel(deps)` owns the
 * toggleable floating "Activity / Output" window that surfaces render,
 * scene-detect and auto-track output on demand. Like the other editor views it
 * builds its own DOM, owns its own behavior, and reaches the editor only through
 * the minimal `deps` interface — importing the shared primitives (ui.ts) directly.
 *
 * Native (Tauri) vs web branch is preserved exactly: on the native app the
 * Activity log lives in a SEPARATE OS window (created in Rust), so this view
 * drives it via `emit`/`invoke`/`listen` and never mounts a panel; on the web
 * build it's the in-page floating panel (drag-to-move, bounds-clamped) that the
 * editor appends to the body. `lastOutput` is the shared data model, replayed to
 * the native window when it opens.
 *
 * The top-bar Activity TOGGLE BUTTON stays in the editor; this view reflects its
 * open / has-output state back through the `onToggleState` callback, and the
 * editor wires the button's click to `toggleNative()` (Tauri) or
 * `setOpen()`/`isOpen()` (web). `setOutput` / `setOutDir` are exposed so the many
 * editor call sites keep working unchanged.
 */

import { messages } from "../i18n/index.js";
import { el, button } from "../ui.js";
import { clamp } from "../editor-util.js";

/** The kind of an output message (drives the log's accent styling). */
export type OutputKind = "" | "ok" | "err";

/** How the view reflects the top-bar toggle button's state back to the editor. */
export interface ActivityToggleState {
  /** Whether the panel / native window is currently open. */
  on: boolean;
  /** Whether there is unseen output to surface (the "has-output" hint dot). */
  hasOutput: boolean;
}

/** What the activity panel needs from the editor (everything else it imports). */
export interface ActivityViewDeps {
  /** True on the native (Tauri) build — output goes to a separate OS window. */
  isTauri: boolean;
  /**
   * Reflect the panel's open / has-output state onto the top-bar toggle button.
   * Called on every state change so the editor doesn't track it separately.
   */
  onToggleState: (state: ActivityToggleState) => void;
}

/** The activity view: its panel element (web only) plus the editor's handles. */
export interface ActivityView {
  /** The floating panel element — append it to the body on the web build only. */
  element: HTMLElement;
  /** Write to the shared Output panel (render / scene-detect / auto-track). */
  setOutput: (text: string, kind?: OutputKind) => void;
  /** Attach the resolved output directory ("Clips written to …") to the log. */
  setOutDir: (dir: string) => void;
  /** Open or close the web floating panel. */
  setOpen: (open: boolean) => void;
  /** Whether the web floating panel is currently open. */
  isOpen: () => boolean;
  /** Toggle the native Activity OS window (Tauri only); syncs the button state. */
  toggleNative: () => Promise<void>;
  /** Push the current theme to the native Activity window so it matches. */
  pushTheme: () => Promise<void>;
}

export function buildActivityPanel(deps: ActivityViewDeps): ActivityView {
  const { isTauri, onToggleState } = deps;
  const m = messages.editor;

  // Activity / Output — a toggleable floating window so render, scene-detect and
  // auto-track output is available on demand without taking permanent space in
  // the main UI. Hidden by default; auto-opens on errors.
  const activityPanel = el("div", "activity");
  activityPanel.hidden = true;
  const activityHead = el("div", "activity-head");
  const activityTitle = el("div", "activity-title");
  activityTitle.textContent = m.activity.title;
  const outDirLine = el("div", "hint");
  const copyLogBtn = button(m.activity.copy, "iconbtn", () => void copyLog());
  copyLogBtn.title = m.activity.copyTitle;
  const closeActivityBtn = button("✕", "iconbtn", () => setOpen(false));
  closeActivityBtn.title = m.activity.closeTitle;
  activityHead.append(activityTitle, outDirLine, copyLogBtn, closeActivityBtn);
  const logPre = document.createElement("pre");
  logPre.className = "log";
  logPre.textContent = m.activity.placeholder;
  activityPanel.append(activityHead, logPre);

  // lastOutput is the shared data model, replayed to the native window when it
  // opens.
  let lastOutput: { text: string; kind: OutputKind; outDir: string } = {
    text: m.activity.placeholder,
    kind: "",
    outDir: "",
  };

  function setOpen(open: boolean): void {
    activityPanel.hidden = !open;
    onToggleState({ on: open, hasOutput: false });
  }

  /** Toggle the native Activity window open/closed; sync the button to its state. */
  async function toggleNative(): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const visible = await invoke<boolean>("toggle_activity_window");
      onToggleState({ on: visible, hasOutput: false });
      if (visible) await pushActivity();
    } catch {
      /* ignore */
    }
  }

  /** Reveal the native Activity window (used to surface failures). */
  async function showNativeActivity(): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("show_activity_window");
      onToggleState({ on: true, hasOutput: false });
      await pushActivity();
    } catch {
      /* ignore */
    }
  }

  /** Emit the current output to the native Activity window (Tauri only). */
  async function pushActivity(): Promise<void> {
    if (!isTauri) return;
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("activity-log", lastOutput);
    } catch {
      /* ignore */
    }
  }

  /** Push the current theme to the native Activity window so it matches. */
  async function pushTheme(): Promise<void> {
    if (!isTauri) return;
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("theme", document.documentElement.getAttribute("data-theme") || "light");
    } catch {
      /* ignore */
    }
  }

  // Native window events: when the Activity window signals ready, replay the
  // latest output AND the current theme; clear the toggle's "on" state when the
  // user closes the window from its own control.
  if (isTauri) {
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        await listen("activity-ready", () => {
          void pushActivity();
          void pushTheme();
        });
        await listen("activity-hidden", () => onToggleState({ on: false, hasOutput: false }));
      } catch {
        /* ignore */
      }
    })();
  }

  // Drag the activity window by its header (resize is native via CSS `resize`).
  {
    let dragging = false;
    let offX = 0;
    let offY = 0;
    activityHead.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return; // let header buttons work
      const rect = activityPanel.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      // Switch from bottom/right anchoring to absolute left/top so it follows.
      activityPanel.style.left = `${rect.left}px`;
      activityPanel.style.top = `${rect.top}px`;
      activityPanel.style.right = "auto";
      activityPanel.style.bottom = "auto";
      dragging = true;
      activityHead.setPointerCapture(e.pointerId);
    });
    activityHead.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      activityPanel.style.left = `${clamp(e.clientX - offX, 0, window.innerWidth - 80)}px`;
      activityPanel.style.top = `${clamp(e.clientY - offY, 0, window.innerHeight - 40)}px`;
    });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      activityHead.releasePointerCapture(e.pointerId);
    };
    activityHead.addEventListener("pointerup", endDrag);
    activityHead.addEventListener("pointercancel", endDrag);
  }

  /** Write to the shared Output panel (render / scene-detect / auto-track). */
  function setOutput(text: string, kind: OutputKind = ""): void {
    lastOutput = { text, kind, outDir: "" };
    if (isTauri) {
      void pushActivity();
      if (kind === "err") void showNativeActivity(); // surface failures
      return;
    }
    // Web build: the in-app floating panel.
    outDirLine.textContent = "";
    logPre.className = kind ? `log ${kind}` : "log";
    logPre.textContent = text;
    if (kind === "err") setOpen(true);
    else if (activityPanel.hidden) onToggleState({ on: false, hasOutput: true });
  }

  /** Attach the resolved output directory ("Clips written to …") to the log. */
  function setOutDir(dir: string): void {
    lastOutput = { ...lastOutput, outDir: dir };
    if (isTauri) {
      void pushActivity();
      return;
    }
    outDirLine.textContent = "";
    if (dir) {
      outDirLine.append(document.createTextNode(m.activity.clipsWrittenTo));
      const s = el("span", "stat");
      s.textContent = dir;
      outDirLine.append(s);
    }
  }

  /** Copy the Output panel log. */
  function copyLog(): void {
    const text = logPre.textContent ?? "";
    if (text === m.activity.placeholder) return;
    void copyToClipboard(text, copyLogBtn);
  }

  async function copyToClipboard(text: string, btn: HTMLButtonElement): Promise<void> {
    if (!text.trim()) return;
    const idle = btn.textContent || m.activity.copyIdle;
    const done = (ok: boolean) => {
      btn.textContent = ok ? m.activity.copied : m.activity.copyFailed;
      window.setTimeout(() => {
        btn.textContent = idle;
      }, 1200);
    };
    try {
      await navigator.clipboard.writeText(text);
      done(true);
    } catch {
      // Fallback for webviews without async-clipboard access.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        done(ok);
      } catch {
        done(false);
      }
    }
  }

  return {
    element: activityPanel,
    setOutput,
    setOutDir,
    setOpen,
    isOpen: () => !activityPanel.hidden,
    toggleNative,
    pushTheme,
  };
}
