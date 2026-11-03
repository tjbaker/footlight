// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Keyboard operation of the Settings controls (#265). Each control must be a
 * Tab stop inside the dialog (`tabStops`: the same set the modal's Tab trap
 * cycles), carry an accessible name and state, and be operable from the
 * keyboard: Enter/Space on the nav items, switches and provider chips (native
 * buttons), and arrows / Home / End / Space on the model radiogroup.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { messages } from "../src/i18n/index.js";
import { installDomShims, resetHarness } from "./helpers/editor-harness.js";
import { pressOn } from "./helpers/keyboard.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { openSettings } = await import("../src/settings.js");
const { tabStops } = await import("../src/ui.js");

const s = messages.settings;
const dialog = (): HTMLElement => document.querySelector<HTMLElement>(".fl-modal.settings")!;
const main = (): HTMLElement => document.querySelector<HTMLElement>(".fl-set-main")!;
const heading = (): string => main().querySelector(".fl-set-secth")?.textContent ?? "";
const navItem = (label: string): HTMLElement =>
  Array.from(document.querySelectorAll<HTMLElement>(".fl-set-navitem")).find(
    (n) => n.textContent === label,
  )!;
/** The element(s) an `aria-labelledby` points at, as text. */
const nameOf = (e: HTMLElement): string =>
  (e.getAttribute("aria-labelledby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
const switchNamed = (label: string): HTMLElement =>
  Array.from(main().querySelectorAll<HTMLElement>('[role="switch"]')).find(
    (sw) => nameOf(sw) === label,
  )!;
const isTabStop = (e: HTMLElement): boolean => tabStops(dialog()).includes(e);
const radios = (): HTMLElement[] =>
  Array.from(main().querySelectorAll<HTMLElement>('[role="radiogroup"] [role="radio"]'));
const checkedRadio = (): HTMLElement | undefined =>
  radios().find((r) => r.getAttribute("aria-checked") === "true");
const aiBlob = (): { provider: string; model: string } =>
  JSON.parse(localStorage.getItem("footlight.ai")!) as { provider: string; model: string };

beforeEach(() => {
  resetHarness();
});

describe("Settings nav (keyboard)", () => {
  it("every nav item is a Tab stop; Enter and Space switch the panel and move aria-current", () => {
    openSettings();
    const labels = Object.values(s.nav);
    for (const label of labels) {
      const item = navItem(label);
      expect(item.tagName).toBe("BUTTON");
      expect(isTabStop(item)).toBe(true);
    }
    expect(navItem(s.nav.general).getAttribute("aria-current")).toBe("page");

    pressOn(navItem(s.nav.rendering), "Enter");
    expect(heading()).toBe(s.rendering.title);
    expect(navItem(s.nav.rendering).getAttribute("aria-current")).toBe("page");
    expect(navItem(s.nav.general).hasAttribute("aria-current")).toBe(false);

    pressOn(navItem(s.nav.about), " ");
    expect(heading()).toBe(s.about.title);
    expect(document.querySelectorAll('.fl-set-navitem[aria-current="page"]')).toHaveLength(1);
  });

  it("the nav has its own name, distinct from the dialog's (#350)", () => {
    openSettings();
    const nav = document.querySelector<HTMLElement>("nav.fl-set-nav")!;
    expect(nav.getAttribute("aria-label")).toBe(s.navLabel);
    expect(nav.getAttribute("aria-label")).not.toBe(nameOf(dialog()));
  });
});

describe("Settings switches (keyboard)", () => {
  it("each switch is a named Tab stop button; Space and Enter flip it and persist", () => {
    openSettings("rendering");
    const dry = switchNamed(s.rendering.dryRun);
    expect(dry.tagName).toBe("BUTTON");
    expect(isTabStop(dry)).toBe(true);
    expect(dry.getAttribute("aria-describedby")).toBeTruthy();
    expect(dry.getAttribute("aria-checked")).toBe("false");

    pressOn(dry, " ");
    expect(dry.getAttribute("aria-checked")).toBe("true");
    expect(
      (JSON.parse(localStorage.getItem("footlight.render")!) as { dryRun: boolean }).dryRun,
    ).toBe(true);
    pressOn(dry, "Enter");
    expect(dry.getAttribute("aria-checked")).toBe("false");

    const burn = switchNamed(s.rendering.burnCaptions);
    expect(isTabStop(burn)).toBe(true);
    pressOn(burn, " ");
    expect(burn.getAttribute("aria-checked")).toBe("true");
  });

  it("the General autosave and the AI advanced switches are named Tab stops too", () => {
    openSettings();
    const autosave = switchNamed(s.general.autosave);
    expect(isTabStop(autosave)).toBe(true);
    expect(autosave.getAttribute("aria-checked")).toBe("true");
    pressOn(autosave, " ");
    expect(autosave.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("footlight.autosave")).toBe("off");

    pressOn(navItem(s.nav.ai), "Enter");
    const adv = switchNamed(s.ai.advanced);
    expect(isTabStop(adv)).toBe(true);
    pressOn(adv, "Enter");
    expect(adv.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Settings provider chips (keyboard)", () => {
  it("chips are named Tab stop buttons; Enter/Space select one and move aria-pressed", () => {
    openSettings("ai");
    const chips = Array.from(main().querySelectorAll<HTMLElement>(".fl-prov"));
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(chip.tagName).toBe("BUTTON");
      expect(isTabStop(chip)).toBe(true);
    }
    const chip = (name: string): HTMLElement => chips.find((c) => nameOf(c) === name)!;
    expect(chip(s.ai.providerGemini).getAttribute("aria-pressed")).toBe("true");
    expect(chip(s.ai.providerClaude).getAttribute("aria-pressed")).toBe("false");

    pressOn(chip(s.ai.providerClaude), "Enter");
    expect(chip(s.ai.providerClaude).getAttribute("aria-pressed")).toBe("true");
    expect(chip(s.ai.providerGemini).getAttribute("aria-pressed")).toBe("false");
    expect(aiBlob().provider).toBe("claude");
    // Not implemented yet: the model list is a notice, not a radiogroup.
    expect(main().querySelector('[role="radiogroup"]')).toBeNull();

    pressOn(chip(s.ai.providerGemini), " ");
    expect(aiBlob().provider).toBe("gemini");
    expect(radios().length).toBeGreaterThan(1);
  });
});

describe("Settings model radiogroup (keyboard)", () => {
  it("is a labelled radiogroup with one Tab stop: the checked card", () => {
    openSettings("ai");
    const group = main().querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe(s.ai.model);
    const all = radios();
    expect(all.length).toBeGreaterThan(1);
    const checked = checkedRadio()!;
    expect(nameOf(checked)).toBe("Gemini 3.5 Flash");
    expect(all.filter(isTabStop)).toEqual([checked]);
  });

  it("arrows move the selection and focus (wrapping), Home/End jump, Space selects", () => {
    openSettings("ai");
    const [first, second] = radios() as [HTMLElement, HTMLElement];
    expect(checkedRadio()).toBe(first);

    expect(pressOn(first, "ArrowDown").defaultPrevented).toBe(true);
    expect(checkedRadio()).toBe(second);
    expect(document.activeElement).toBe(second);
    expect(second.classList.contains("sel")).toBe(true);
    expect(first.classList.contains("sel")).toBe(false);
    expect(radios().filter(isTabStop)).toEqual([second]);
    expect(aiBlob().model).toBe(second.dataset.model);

    pressOn(second, "ArrowDown"); // wraps to the first
    expect(checkedRadio()).toBe(first);
    pressOn(first, "ArrowUp"); // wraps to the last
    expect(checkedRadio()).toBe(radios().at(-1));
    pressOn(document.activeElement as HTMLElement, "Home");
    expect(checkedRadio()).toBe(first);
    pressOn(first, "End");
    expect(checkedRadio()).toBe(radios().at(-1));

    // Space on a focused, unchecked card checks it.
    first.focus();
    pressOn(first, " ");
    expect(checkedRadio()).toBe(first);
    expect(aiBlob().model).toBe(first.dataset.model);
  });

  it("a key the group doesn't use is left alone", () => {
    openSettings("ai");
    const [first] = radios() as [HTMLElement];
    expect(pressOn(first, "a").defaultPrevented).toBe(false);
    expect(checkedRadio()).toBe(first);
    // Modified arrows are OS/browser combos, not radio navigation.
    const alt = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    first.dispatchEvent(alt);
    expect(alt.defaultPrevented).toBe(false);
    expect(checkedRadio()).toBe(first);
  });
});

describe("Settings accessible names and pressed state (#265)", () => {
  /** Every `role=group` in the panel, keyed by its accessible name. */
  const groupsByName = (): Map<string, HTMLElement> =>
    new Map(
      Array.from(main().querySelectorAll<HTMLElement>('[role="group"]')).map((g) => [nameOf(g), g]),
    );
  const pressed = (g: HTMLElement): string[] =>
    Array.from(g.querySelectorAll<HTMLElement>('button[aria-pressed="true"]')).map(
      (b) => b.textContent ?? "",
    );
  const buttonIn = (g: HTMLElement, text: string): HTMLElement =>
    Array.from(g.querySelectorAll<HTMLElement>("button")).find((b) => b.textContent === text)!;

  it("segmented controls are named groups whose buttons carry aria-pressed", () => {
    openSettings();
    const groups = groupsByName();
    const theme = groups.get(s.general.theme)!;
    expect(theme).toBeTruthy();
    expect(groups.get(s.general.timecode)).toBeTruthy();
    expect(groups.get(s.general.trackingInterval)).toBeTruthy();
    for (const b of Array.from(theme.querySelectorAll("button"))) {
      expect(b.hasAttribute("aria-pressed")).toBe(true);
    }
    expect(pressed(theme)).toEqual([s.general.themeLight]);

    const dark = buttonIn(theme, s.general.themeDark);
    pressOn(dark, "Enter");
    expect(pressed(theme)).toEqual([s.general.themeDark]);
    expect(dark.classList.contains("on")).toBe(true);
  });

  it("Rendering: the CRF slider and every group are named; preset chips carry aria-pressed", () => {
    openSettings("rendering");
    const range = main().querySelector<HTMLElement>("input.fl-range")!;
    expect(nameOf(range)).toBe(s.rendering.quality);
    expect(range.getAttribute("aria-valuetext")).toMatch(/^CRF 19 · /);

    const groups = groupsByName();
    expect(groups.get(s.rendering.audio)).toBeTruthy();
    expect(groups.get(s.rendering.bitrate)).toBeTruthy();
    const presets = groups.get(s.rendering.preset)!;
    expect(presets.classList.contains("fl-preset-row")).toBe(true);
    expect(pressed(presets)).toEqual(["medium"]);
    pressOn(buttonIn(presets, "slow"), " ");
    expect(pressed(presets)).toEqual(["slow"]);
    const blob = JSON.parse(localStorage.getItem("footlight.render")!) as { preset: string };
    expect(blob.preset).toBe("slow");
  });

  it("AI: the interval and chat-stills groups are named", () => {
    openSettings("ai");
    const groups = groupsByName();
    expect(groups.get(s.ai.costInterval)).toBeTruthy();
    expect(groups.get(s.ai.chatStills)).toBeTruthy();
  });

  it("model cards describe every visible detail (badge, capability, speed, cost)", () => {
    openSettings("ai");
    const card = checkedRadio()!;
    const described = (card.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described).toContain(s.ai.recommended);
    expect(described).toContain(card.querySelector(".fl-opt-cap")!.textContent);
    expect(described).toContain(card.querySelector(".fl-tag-speed")!.textContent);
    expect(described).toContain(card.querySelector(".fl-tag-cost")!.textContent);
  });

  it("the model list drops its name with the radiogroup role for an unimplemented provider", () => {
    openSettings("ai");
    const list = main().querySelector<HTMLElement>('[role="radiogroup"]')!;
    const chip = (name: string): HTMLElement =>
      Array.from(main().querySelectorAll<HTMLElement>(".fl-prov")).find((c) => nameOf(c) === name)!;
    pressOn(chip(s.ai.providerClaude), "Enter");
    expect(list.hasAttribute("role")).toBe(false);
    expect(list.hasAttribute("aria-label")).toBe(false);
    pressOn(chip(s.ai.providerGemini), "Enter");
    expect(list.getAttribute("role")).toBe("radiogroup");
    expect(list.getAttribute("aria-label")).toBe(s.ai.model);
  });
});
