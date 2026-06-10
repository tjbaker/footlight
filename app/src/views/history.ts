// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The render-history modal — the first extracted editor VIEW (#125 Phase 4).
 * A view is a `buildX(deps)` factory: it builds its own DOM, owns its own
 * behavior, and reaches the rest of the editor only through an explicit `deps`
 * interface (here: the platform, plus `openSpec`/`setThumb` callbacks). It
 * imports the shared primitives (ui.ts, icons.ts) and pure helpers directly
 * rather than from the editor closure.
 *
 * The modal (HANDOFF §5.5) lists past renders grouped by day — each row shows
 * the clip name + framing-mode pill, source, an In→Out / dur / kf / output
 * readout, and render time — with filter, per-row open/remove, and clear-all.
 * Opening a row rehydrates the editor via `openSpec` WITHOUT touching the
 * session queue.
 */

import { parseTimestamp } from "@core";
import { messages } from "../i18n/index.js";
import { el, button, input } from "../ui.js";
import { ICON_X, ICON_SEARCH, ICON_TRASH } from "../icons.js";
import { shorten, baseName, safeParse, kfCount, escapeHtml, fmtTC } from "../editor-util.js";
import { offsetMode, fmtClockTime, dayLabel } from "../editor-format.js";
import type { FootlightPlatform, HistoryEntry } from "../platform/types.js";

/** What the history modal needs from the editor (everything else it imports). */
export interface HistoryViewDeps {
  platform: FootlightPlatform;
  /** Rehydrate a stored spec into the editor (dismisses the modal first). */
  openSpec: (spec: HistoryEntry["spec"], outdir: string) => void;
  /** Paint a frame thumbnail of `source` at time `t` into `elm`. */
  setThumb: (elm: HTMLElement, source: string, t: number) => void;
}

/** Open the render-history modal. Async only to await the initial load. */
export async function openHistoryModal(deps: HistoryViewDeps): Promise<void> {
  const { platform, openSpec, setThumb } = deps;
  const m = messages.editor;

  const backdrop = el("div", "fl-modal-backdrop");
  const modal = el("div", "fl-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", m.history.ariaLabel);

  // header: title + N renders · spacer · Clear all · close
  const head = el("div", "fl-modal-h");
  const titleWrap = el("div");
  titleWrap.style.cssText = "display:flex; align-items:center; gap:11px;";
  const title = el("span", "fl-label");
  title.style.fontSize = "13px";
  title.textContent = m.history.title;
  const countPill = el("span", "fl-pill ghost");
  titleWrap.append(title, countPill);
  const clearBtn = button(m.history.clearAll, "fl-btn sm ghost danger", () => {
    entries = [];
    void save();
    draw();
  });
  const closeBtn = button("", "fl-iconbtn");
  closeBtn.innerHTML = ICON_X;
  closeBtn.title = m.common.close;
  head.append(titleWrap, el("span", "fl-spacer"), clearBtn, closeBtn);

  // tools: filter field + "stored · local" chip
  const tools = el("div", "fl-modal-tools");
  const filterField = el("div", "fl-field");
  filterField.style.flex = "1";
  filterField.innerHTML = `<span class="ic">${ICON_SEARCH}</span>`;
  const filterInput = input("text", m.history.filterPlaceholder);
  filterField.append(filterInput);
  const storedChip = el("span", "fl-rdchip");
  storedChip.innerHTML = `<span class="lab">${escapeHtml(m.history.storedLabel)}</span><span class="val">${escapeHtml(m.history.storedValue)}</span>`;
  tools.append(filterField, storedChip);
  filterInput.addEventListener("input", () => draw());

  const body = el("div", "fl-modal-body");
  const empty = el("div", "hint");
  empty.style.padding = "24px 8px";
  empty.textContent = m.history.emptyHint;

  const foot = el("div", "fl-modal-foot");
  foot.innerHTML =
    '<span class="idot in" style="background:var(--accent)"></span>' + m.history.footHtmlBody;

  modal.append(head, tools, body, empty, foot);
  backdrop.append(modal);
  document.body.append(backdrop);

  let entries: HistoryEntry[] = [];
  const save = () => platform.saveHistory(entries).catch(() => undefined);

  function histRow(entry: HistoryEntry): HTMLElement {
    const row = el("div", "fl-hist");
    const meta = el("div", "fl-hist-meta");
    const top = el("div", "fl-hist-top");
    const nm = el("span", "nm");
    nm.textContent = entry.spec.out_name || shorten(entry.spec.source_file);
    const mode = offsetMode(entry.spec);
    const pill = el("span", mode.ghost ? "fl-pill ghost" : "fl-pill");
    pill.textContent = mode.label;
    top.append(nm, pill);
    const src = el("div", "fl-hist-src");
    src.textContent = baseName(entry.spec.source_file);
    const read = el("div", "fl-readout");
    const kf = kfCount(entry.spec);
    let inT = "—";
    let outT = "—";
    let dur = "—";
    try {
      const a = parseTimestamp(entry.spec.in_point);
      const b = parseTimestamp(entry.spec.out_point);
      inT = fmtTC(a);
      outT = fmtTC(b);
      dur = `${(b - a).toFixed(2)}s`;
    } catch {
      /* leave dashes on an unparseable spec */
    }
    read.innerHTML =
      `<span class="idot in"></span><span class="v">${inT}</span><span class="arrow">→</span>` +
      `<span class="idot out"></span><span class="v">${outT}</span>` +
      `<span class="sep">·</span><span class="k">${escapeHtml(m.clip.durKey)}</span><span class="v accent">${dur}</span>` +
      (kf > 0
        ? `<span class="sep">·</span><span class="k">kf</span><span class="v">${kf}</span>`
        : "") +
      `<span class="sep">·</span><span class="path">${escapeHtml(entry.outdir)}</span>`;
    meta.append(top, src, read);

    const side = el("div", "fl-hist-side");
    const time = el("span", "fl-hist-time");
    time.textContent = fmtClockTime(entry.ts);
    const actions = el("div", "fl-hist-actions");
    const openBtn = button(m.history.open, "fl-btn sm primary", () => {
      dismiss();
      openSpec(entry.spec, entry.outdir);
    });
    const rm = button("", "fl-iconbtn sm rm");
    rm.innerHTML = ICON_TRASH;
    rm.title = m.history.removeTitle;
    rm.addEventListener("click", () => {
      entries = entries.filter((e) => e.id !== entry.id);
      void save();
      draw();
    });
    actions.append(openBtn, rm);
    side.append(time, actions);

    const thumb = el("div", "fl-thumb");
    setThumb(thumb, entry.spec.source_file, safeParse(entry.spec.in_point));
    row.append(thumb, meta, side);
    return row;
  }

  function draw(): void {
    const q = filterInput.value.trim().toLowerCase();
    const shown = q
      ? entries.filter(
          (e) =>
            (e.spec.out_name || "").toLowerCase().includes(q) ||
            e.spec.source_file.toLowerCase().includes(q),
        )
      : entries;
    body.innerHTML = "";
    countPill.textContent = `${entries.length} ${entries.length === 1 ? m.history.renderSingular : m.history.renderPlural}`;
    clearBtn.style.display = entries.length ? "" : "none";
    empty.style.display = entries.length ? "none" : "block";
    let lastDay = "";
    for (const entry of shown) {
      const day = dayLabel(entry.ts);
      if (day !== lastDay) {
        lastDay = day;
        const count = shown.filter((e) => dayLabel(e.ts) === day).length;
        const div = el("div", "fl-hist-day");
        div.innerHTML = `<span>${day}</span><span class="line"></span><span class="c">${count}</span>`;
        body.append(div);
      }
      body.append(histRow(entry));
    }
    if (q && shown.length === 0 && entries.length) {
      const none = el("div", "hint");
      none.style.padding = "16px 8px";
      none.textContent = m.history.noMatches;
      body.append(none);
    }
  }

  try {
    entries = await platform.loadHistory();
  } catch {
    entries = [];
  }
  draw();

  const dismiss = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") dismiss();
  }
  closeBtn.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) dismiss();
  });
  document.addEventListener("keydown", onKey);
}
