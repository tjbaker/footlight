// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Help → User Guide modal. Renders the structured, localizable guide content
 * (messages.help) into a scrollable dialog with a table-of-contents sidebar.
 * Plain DOM so it works identically in the browser dev build and under Tauri.
 */

import { messages } from "./i18n/index.js";
import type { GuideBlock, GuideSection } from "./i18n/types.js";

/** Show the User Guide modal. */
export function openGuide(): void {
  const g = messages.help;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal guide";

  const h3 = document.createElement("h3");
  h3.textContent = g.title;
  const subtitle = document.createElement("div");
  subtitle.className = "ver";
  subtitle.textContent = g.subtitle;

  const body = document.createElement("div");
  body.className = "guide-body";

  const toc = document.createElement("nav");
  toc.className = "guide-toc";
  const tocLabel = document.createElement("div");
  tocLabel.className = "guide-toc-label";
  tocLabel.textContent = g.tocLabel;
  toc.append(tocLabel);

  const sectionEls = new Map<string, HTMLElement>();
  for (const section of g.sections) {
    const secEl = renderSection(section);
    sectionEls.set(section.id, secEl);
    body.append(secEl);

    const link = document.createElement("a");
    link.textContent = section.title;
    link.addEventListener("click", () =>
      sectionEls.get(section.id)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
    toc.append(link);
  }

  const cols = document.createElement("div");
  cols.className = "guide-cols";
  cols.append(toc, body);

  const close = document.createElement("button");
  close.className = "close";
  close.textContent = g.close;

  modal.append(h3, subtitle, cols, close);
  backdrop.append(modal);
  document.body.append(backdrop);

  const dismiss = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") dismiss();
  }
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) dismiss();
  });
  document.addEventListener("keydown", onKey);
}

function renderSection(section: GuideSection): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "guide-section";
  const h = document.createElement("h4");
  h.textContent = section.title;
  wrap.append(h);
  for (const block of section.blocks) wrap.append(renderBlock(block));
  return wrap;
}

function renderBlock(block: GuideBlock): HTMLElement {
  switch (block.kind) {
    case "p": {
      const p = document.createElement("p");
      p.textContent = block.text;
      return p;
    }
    case "steps":
    case "list": {
      const listEl = document.createElement(block.kind === "steps" ? "ol" : "ul");
      for (const item of block.items) {
        const li = document.createElement("li");
        li.textContent = item;
        listEl.append(li);
      }
      return listEl;
    }
    case "tip": {
      const div = document.createElement("div");
      div.className = "guide-tip";
      div.textContent = block.text;
      return div;
    }
  }
}
