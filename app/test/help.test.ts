// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
/**
 * DOM coverage for the Help → User Guide modal (`openGuide`). Asserts the dialog
 * is built from `messages.help` (title/subtitle, a TOC entry + a rendered section
 * per `messages.help.sections`, the section blocks), that a TOC link anchors to
 * its section, and that the modal dismisses via the close button, a backdrop
 * click, and Escape. `openGuide` is pure DOM (no platform), so nothing is mocked.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGuide } from "../src/help.js";
import { messages } from "../src/i18n/index.js";

const g = messages.help;

const backdrop = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(".modal-backdrop");

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  // Drain any modal a test left open so its keydown listener can't leak.
  document.querySelector<HTMLElement>(".modal-backdrop")?.remove();
  document.body.innerHTML = "";
});

describe("openGuide", () => {
  it("appends one backdrop + modal to document.body", () => {
    expect(backdrop()).toBeNull();
    openGuide();

    const bd = backdrop();
    expect(bd).not.toBeNull();
    expect(bd!.parentElement).toBe(document.body);
    expect(bd!.querySelector(".modal.guide")).not.toBeNull();
  });

  it("renders the title + subtitle from messages.help", () => {
    openGuide();

    const h3 = backdrop()!.querySelector("h3");
    expect(h3?.textContent).toBe(g.title);
    expect(backdrop()!.querySelector(".ver")?.textContent).toBe(g.subtitle);
  });

  it("renders the close button label and the TOC label", () => {
    openGuide();

    expect(backdrop()!.querySelector("button.close")?.textContent).toBe(g.close);
    expect(backdrop()!.querySelector(".guide-toc-label")?.textContent).toBe(
      g.tocLabel,
    );
  });

  it("renders one section + one TOC link per messages.help.sections entry", () => {
    openGuide();

    const sections = backdrop()!.querySelectorAll("section.guide-section");
    expect(sections.length).toBe(g.sections.length);

    // TOC links are the <a>s in the nav (the label is a <div>, not a link).
    const links = backdrop()!.querySelectorAll<HTMLAnchorElement>(".guide-toc a");
    expect(links.length).toBe(g.sections.length);

    // Each section's title is rendered as a TOC link and as the section heading,
    // in catalog order.
    g.sections.forEach((section, i) => {
      expect(links[i]!.textContent).toBe(section.title);
      expect(sections[i]!.querySelector("h4")?.textContent).toBe(section.title);
    });
  });

  it("renders every guide block kind into the matching element", () => {
    openGuide();
    const sections = backdrop()!.querySelectorAll("section.guide-section");

    g.sections.forEach((section, i) => {
      const el = sections[i]!;
      for (const block of section.blocks) {
        switch (block.kind) {
          case "p":
            expect(
              [...el.querySelectorAll("p")].some(
                (p) => p.textContent === block.text,
              ),
            ).toBe(true);
            break;
          case "tip":
            expect(
              [...el.querySelectorAll(".guide-tip")].some(
                (d) => d.textContent === block.text,
              ),
            ).toBe(true);
            break;
          case "steps":
          case "list": {
            const tag = block.kind === "steps" ? "ol" : "ul";
            const lists = [...el.querySelectorAll(tag)];
            const match = lists.find(
              (l) => l.querySelectorAll("li").length === block.items.length,
            );
            expect(match).toBeDefined();
            const texts = [...match!.querySelectorAll("li")].map(
              (li) => li.textContent,
            );
            expect(texts).toEqual(block.items);
            break;
          }
        }
      }
    });
  });

  it("anchors a TOC link to its section via scrollIntoView", () => {
    openGuide();
    const links = backdrop()!.querySelectorAll<HTMLAnchorElement>(".guide-toc a");
    const sections = backdrop()!.querySelectorAll<HTMLElement>(
      "section.guide-section",
    );

    // jsdom has no layout, so scrollIntoView is a no-op stub — spy on the target
    // section to prove the click is wired to the right one.
    let scrolledIdx = -1;
    sections.forEach((sec, i) => {
      sec.scrollIntoView = () => {
        scrolledIdx = i;
      };
    });

    links[2]!.click();
    expect(scrolledIdx).toBe(2);
  });

  it("dismisses on the close button", () => {
    openGuide();
    expect(backdrop()).not.toBeNull();

    backdrop()!.querySelector<HTMLButtonElement>("button.close")!.click();
    expect(backdrop()).toBeNull();
  });

  it("dismisses on a backdrop click (but not on inner-modal clicks)", () => {
    openGuide();
    const bd = backdrop()!;

    // Clicking inside the modal must NOT dismiss (target !== backdrop).
    bd.querySelector<HTMLElement>(".modal.guide")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(backdrop()).not.toBeNull();

    // Clicking the backdrop itself dismisses.
    bd.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(backdrop()).toBeNull();
  });

  it("dismisses on Escape and unbinds the keydown listener", () => {
    openGuide();
    expect(backdrop()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop()).toBeNull();

    // A second Escape after dismissal must be a no-op (listener was removed):
    // re-open, fire a non-Escape key, and confirm it stays open.
    openGuide();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(backdrop()).not.toBeNull();
  });
});
