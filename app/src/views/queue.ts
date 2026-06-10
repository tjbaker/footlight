// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The filmstrip queue VIEW (#125 Phase 4). `buildQueueStrip(store, deps)`
 * builds the bottom filmstrip — the queue label, the clip cards, the add card,
 * and the export (JSON / cover) buttons — and renders the cards REACTIVELY by
 * subscribing to the store's `clips` changes. Cards are click-to-edit,
 * drag-to-reorder, with duplicate / remove; the queue mutations (dup, delete,
 * reorder) go straight through `store.set`. The editor supplies what the view
 * can't build itself via `deps`: the thumbnail painter, the open-spec
 * rehydrator, the current outdir, and the add / export handlers.
 *
 * The render button (top bar) and the session autosave also react to `clips`,
 * but they live in the editor — they stay as the editor's own store
 * subscription rather than being driven from here.
 */

import type { ClipSpec } from "@manifest";
import { messages } from "../i18n/index.js";
import { el, button } from "../ui.js";
import { ICON_DOWN, ICON_COPY } from "../icons.js";
import { shorten, escapeHtml, fmtClock, safeParse } from "../editor-util.js";
import { clipDur } from "../editor-format.js";
import type { EditorStore } from "../editor-store.js";

/** What the queue strip needs from the editor (everything else it imports). */
export interface QueueViewDeps {
  /** Paint a frame thumbnail of `source` at time `t` into `elm`. */
  setThumb: (elm: HTMLElement, source: string, t: number) => void;
  /** Re-open a clip spec into the editor for editing (with its outdir). */
  openSpec: (spec: ClipSpec, outdir?: string) => void;
  /** The outdir to attach when click-to-edit re-opens a clip. */
  getOutdir: () => string;
  /** Stage the current In/Out + framing as a new queue card. */
  onAdd: () => void;
  /** Export the queue as a JSON manifest. */
  onExportJson: () => void;
  /** Export the playhead frame through the active framing as a cover PNG. */
  onExportCover: () => void;
}

/** The queue strip view: its root element (append it into the editor shell). */
export interface QueueView {
  element: HTMLElement;
}

export function buildQueueStrip(store: EditorStore, deps: QueueViewDeps): QueueView {
  const state = store.state;
  const m = messages.editor;

  const filmstrip = el("div", "fl-filmstrip");
  const queueLabel = el("span", "fl-label");
  queueLabel.style.alignSelf = "center";
  queueLabel.innerHTML = `${escapeHtml(m.queue.queueLabel)} <span class="n">0</span>`;
  const clipList = el("div");
  clipList.style.display = "contents";
  const addCard = el("div", "fl-strip-card add");
  addCard.textContent = m.queue.addClip;
  addCard.addEventListener("click", () => deps.onAdd());
  const fsSpacer = el("span", "fl-spacer");

  // Export the playhead frame, through the ACTIVE framing, as the clip's
  // 1080×1920 PNG cover image (#166).
  const coverBtn = button("", "fl-btn sm ghost", () => deps.onExportCover());
  coverBtn.innerHTML = `${ICON_DOWN}${escapeHtml(m.queue.exportCover)}`;
  coverBtn.style.alignSelf = "center";
  coverBtn.title = m.queue.exportCoverTitle;
  // Export the queue as a JSON manifest (re-imports via `footlight render`) —
  // the single queue-out action and the safety net for Clear.
  const exportBtn = button("", "fl-btn sm ghost", () => deps.onExportJson());
  exportBtn.innerHTML = `${ICON_DOWN}${escapeHtml(m.queue.exportJson)}`;
  exportBtn.style.alignSelf = "center";
  exportBtn.title = m.queue.exportJsonTitle;
  filmstrip.append(queueLabel, clipList, addCard, fsSpacer, coverBtn, exportBtn);

  // Drag-to-reorder source index (the card list's own concern).
  let dragFrom: number | null = null;

  function clipCard(spec: ClipSpec, i: number): HTMLDivElement {
    // Click-to-edit (re-opens the clip), drag-to-reorder, with duplicate +
    // remove. The ✕/⧉ buttons stop propagation so they don't trigger the edit.
    const card = el("div", "fl-strip-card edit") as HTMLDivElement;
    card.draggable = true;
    card.title = m.queue.cardEditTitle;
    const thumb = el("div", "fl-thumb");
    deps.setThumb(thumb, spec.source_file, safeParse(spec.in_point));
    const meta = el("div", "fl-clip-meta");
    const name = el("div", "fl-clip-name");
    name.textContent = spec.out_name || shorten(spec.source_file);
    const sub = el("div", "fl-clip-sub");
    const d = clipDur(spec);
    const dur = d > 0 ? `${d.toFixed(1)}s` : `${spec.in_point}→${spec.out_point}`;
    const framing = spec.cropPath?.length
      ? m.framing.modeTrack
      : spec.cropWindow
        ? m.framing.modePunchIn
        : (spec.crop_offset ?? m.framing.defaultOffset);
    sub.innerHTML = `${dur} · <span style="color:var(--accent-2)">${escapeHtml(framing)}</span>`;
    meta.append(name, sub);

    const dup = el("button", "fl-clip-x") as HTMLButtonElement;
    dup.innerHTML = ICON_COPY;
    dup.title = m.queue.duplicateTitle;
    dup.addEventListener("click", (ev) => {
      ev.stopPropagation();
      store.set({
        clips: [...state.clips.slice(0, i + 1), structuredClone(spec), ...state.clips.slice(i + 1)],
      });
    });
    const del = el("button", "fl-clip-x") as HTMLButtonElement;
    del.textContent = "✕";
    del.title = m.queue.removeTitle;
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      store.set({ clips: state.clips.filter((_, idx) => idx !== i) });
    });

    card.addEventListener("click", () => deps.openSpec(spec, deps.getOutdir() || undefined));
    // HTML5 drag-to-reorder.
    card.addEventListener("dragstart", () => {
      dragFrom = i;
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      dragFrom = null;
      card.classList.remove("dragging");
    });
    card.addEventListener("dragover", (ev) => ev.preventDefault());
    card.addEventListener("drop", (ev) => {
      ev.preventDefault();
      if (dragFrom == null || dragFrom === i) return;
      const moved = state.clips[dragFrom];
      if (moved) {
        const without = state.clips.filter((_, idx) => idx !== dragFrom);
        store.set({ clips: [...without.slice(0, i), moved, ...without.slice(i)] });
      }
    });

    card.append(thumb, meta, dup, del);
    return card;
  }

  function render(): void {
    clipList.innerHTML = "";
    state.clips.forEach((spec, i) => clipList.append(clipCard(spec, i)));
    const total = state.clips.reduce((s, c) => s + clipDur(c), 0);
    queueLabel.innerHTML = state.clips.length
      ? `${escapeHtml(m.queue.queueLabel)} <span class="n">${state.clips.length}</span> · <span class="n">${fmtClock(total, false)}</span>`
      : `${escapeHtml(m.queue.queueLabel)} <span class="n">0</span>`;
  }

  store.onChange((changed) => {
    if (changed.has("clips")) render();
  });
  render();

  return { element: filmstrip };
}
