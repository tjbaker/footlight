// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
/**
 * DOM tests for the in-app Help menu (`createHelpMenu`). Renders the menu into a
 * jsdom document and exercises what menu.ts actually wires: the trigger label,
 * the four dropdown items (from the i18n catalog), the show/hide toggle, and the
 * external-link clicks routing through `platform.openExternal` with the right
 * URLs. `help`, `settings`, and the platform backend are mocked so the test
 * stays focused on the menu and avoids the heavy settings.ts import graph.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { messages } from "../src/i18n/index.js";
import { REPO_URL, ISSUES_NEW_URL } from "../src/version.js";

const openExternal = vi.fn();
vi.mock("../src/platform/index.js", () => ({
  platform: { openExternal },
  platformName: "web",
  supportsFilePicker: false,
}));

const openGuide = vi.fn();
vi.mock("../src/help.js", () => ({ openGuide }));

const openSettings = vi.fn();
vi.mock("../src/settings.js", () => ({ openSettings }));

// Import after the mocks are registered so menu.ts binds to the mocked modules.
const { createHelpMenu } = await import("../src/menu.js");

/** All dropdown item buttons (the trigger is the first <button> in `.menu`). */
function dropdownItems(menu: HTMLElement): HTMLButtonElement[] {
  const dropdown = menu.querySelector(".menu-dropdown") as HTMLElement;
  return Array.from(dropdown.querySelectorAll("button"));
}

describe("createHelpMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("returns an HTMLElement with the menu class", () => {
    const menu = createHelpMenu();
    expect(menu).toBeInstanceOf(HTMLElement);
    expect(menu.className).toBe("menu");
  });

  it("renders the trigger button with the localized label", () => {
    const menu = createHelpMenu();
    const trigger = menu.querySelector("button") as HTMLButtonElement;
    expect(trigger.textContent).toContain(messages.help.menuTrigger);
    expect(trigger.getAttribute("aria-haspopup")).toBe("true");
  });

  it("renders the four catalog items in order: guide, about, bug, github", () => {
    const menu = createHelpMenu();
    const labels = dropdownItems(menu).map((b) => b.textContent);
    expect(labels).toEqual([
      messages.help.menuLabel,
      messages.help.about,
      messages.help.reportBug,
      messages.help.viewOnGithub,
    ]);
  });

  it("starts with the dropdown hidden and toggles it open/closed on trigger click", () => {
    const menu = createHelpMenu();
    document.body.append(menu);
    const trigger = menu.querySelector("button") as HTMLButtonElement;
    const dropdown = menu.querySelector(".menu-dropdown") as HTMLElement;

    expect(dropdown.hidden).toBe(true);

    trigger.click();
    expect(dropdown.hidden).toBe(false);

    trigger.click();
    expect(dropdown.hidden).toBe(true);
  });

  it("closes the dropdown when clicking elsewhere in the document", () => {
    const menu = createHelpMenu();
    document.body.append(menu);
    const trigger = menu.querySelector("button") as HTMLButtonElement;
    const dropdown = menu.querySelector(".menu-dropdown") as HTMLElement;

    trigger.click();
    expect(dropdown.hidden).toBe(false);

    document.body.click();
    expect(dropdown.hidden).toBe(true);
  });

  it("opens the user guide and closes the dropdown when the guide item is clicked", () => {
    const menu = createHelpMenu();
    document.body.append(menu);
    const trigger = menu.querySelector("button") as HTMLButtonElement;
    const dropdown = menu.querySelector(".menu-dropdown") as HTMLElement;
    const [guideBtn] = dropdownItems(menu);

    trigger.click();
    guideBtn!.click();

    expect(openGuide).toHaveBeenCalledOnce();
    expect(dropdown.hidden).toBe(true);
  });

  it("opens Settings → About when the About item is clicked", () => {
    const menu = createHelpMenu();
    const aboutBtn = dropdownItems(menu)[1]!;

    aboutBtn.click();

    expect(openSettings).toHaveBeenCalledWith("about");
  });

  it("opens the new-issue URL via platform.openExternal for Report a Bug", () => {
    const menu = createHelpMenu();
    const bugBtn = dropdownItems(menu)[2]!;

    bugBtn.click();

    expect(openExternal).toHaveBeenCalledWith(ISSUES_NEW_URL);
  });

  it("opens the repo URL via platform.openExternal for View on GitHub", () => {
    const menu = createHelpMenu();
    const ghBtn = dropdownItems(menu)[3]!;

    ghBtn.click();

    expect(openExternal).toHaveBeenCalledWith(REPO_URL);
  });
});
