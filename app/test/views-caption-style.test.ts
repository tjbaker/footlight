// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DIRECT unit tests for views/caption-style.ts (#125 Phase 5) — the view is
 * built via `buildCaptionStyle(store, platform)` with a REAL EditorStore and
 * the mocked platform module (the same object the inspector passes in
 * production), NOT through mountEditor. Covered:
 *
 *  - every style control's STORE PATCH: the colour swatches (fill / outline /
 *    box colour), the B/I/U + Shadow/Box toggles, and the rotation slider all
 *    write a FRESH `caption` object through `store.set` (the editor-captions
 *    integration suite pins the classes/readouts; here the seam under test is
 *    the patch itself);
 *  - the custom font dropdown: open/close/click-away/Escape, the group
 *    structure built from `platform.listUserFonts` (the localStorage fonts
 *    dir) + `platform.listFonts` — family de-dupe, sorting, folder-beats-
 *    system — and each row kind's selection semantics (default → "", system →
 *    family, folder → file path shown as its family, Custom path… → the
 *    free-text field), including keyboard (Enter/Space) choice and the hover
 *    highlight;
 *  - the enumeration failure modes (either platform list rejecting);
 *  - `sync()` — the clip-restore seam — reflecting a restored `state.caption`
 *    onto every control (font row resolution incl. path→family, swatches,
 *    toggles, box-row visibility, angle).
 *
 * NOT covered under jsdom (documented, not silently skipped):
 *  - `loadFolderFontFace` past its web early-return: the FontFace preview load
 *    is Tauri-only (`platformName === "tauri"` + `@tauri-apps/api/core`'s
 *    convertFileSrc + the FontFace API, none of which exist here). The burn
 *    always uses the file path, so the preview is purely cosmetic.
 *  - the rebuild-token race (`token !== fontBuildToken`): `rebuildFontPicker`
 *    runs once per build and the token is module-internal — no public seam can
 *    start two overlapping rebuilds.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { messages } from "../src/i18n/index.js";
import { createEditorStore } from "../src/editor-store.js";
import type { CaptionStyleState } from "../src/editor-util.js";
import type { FootlightPlatform } from "../src/platform/types.js";
import { platformMocks, platformModule } from "./helpers/platform-mock.js";
import {
  installDomShims,
  resetHarness,
  flush,
  buttonByText,
  setValue,
} from "./helpers/editor-harness.js";

installDomShims();
// Import AFTER the mocks/shims above are installed.
const { buildCaptionStyle } = await import("../src/views/caption-style.js");

const m = messages.editor;
const FONTS_DIR_KEY = "footlight.fontsDir";

/** Build the view on a real store, wired exactly like the inspector wires it. */
async function makeView(caption: Partial<CaptionStyleState> = {}) {
  const store = createEditorStore();
  if (Object.keys(caption).length) {
    store.set({ caption: { ...store.state.caption, ...caption } });
  }
  const view = buildCaptionStyle(store, platformModule.platform as unknown as FootlightPlatform);
  document.body.append(view.element);
  await flush(); // settle the async font-picker build
  return { store, view };
}

// ---- DOM lookups (the view has no ids; structure is the public surface) ----

const trigger = (root: HTMLElement): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
const triggerLabel = (root: HTMLElement): HTMLElement =>
  trigger(root).querySelector<HTMLElement>("span")!;
const popup = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('ul[role="listbox"]')!;
const optionRows = (root: HTMLElement): HTMLElement[] =>
  Array.from(popup(root).querySelectorAll<HTMLElement>('li[role="option"]'));
const rowByLabel = (root: HTMLElement, label: string): HTMLElement => {
  const row = optionRows(root).find((r) => r.textContent === label);
  expect(row, `font option "${label}"`).toBeTruthy();
  return row!;
};
const groupHeaders = (root: HTMLElement): string[] =>
  Array.from(popup(root).querySelectorAll<HTMLElement>('li[role="presentation"]')).map(
    (h) => h.textContent ?? "",
  );
const pathInput = (root: HTMLElement): HTMLInputElement =>
  root.querySelector<HTMLInputElement>(`input[placeholder="${m.captions.fontPathPlaceholder}"]`)!;
const pathField = (root: HTMLElement): HTMLElement => pathInput(root).parentElement!;

/** A colour row (`.fl-rowg` with an `input[type=color]`) found by its label. */
function colorRow(root: HTMLElement, label: string) {
  const row = Array.from(root.querySelectorAll<HTMLElement>(".fl-rowg")).find(
    (r) => r.querySelector(".fl-label")?.textContent === label,
  );
  expect(row, `colour row "${label}"`).toBeTruthy();
  return {
    row: row!,
    swatch: row!.querySelector<HTMLInputElement>('input[type="color"]')!,
    hex: row!.querySelector<HTMLElement>(".mono")!,
  };
}

beforeEach(() => {
  resetHarness();
});

describe("style controls write through store.set", () => {
  it("a colour swatch patches its field with a FRESH caption object", async () => {
    const { store, view } = await makeView();
    const before = store.state.caption;
    const changed: string[] = [];
    store.onChange((c) => changed.push(...c));

    const fill = colorRow(view.element, m.captions.fill);
    setValue(fill.swatch, "#ff0000");
    expect(store.state.caption.color).toBe("#ff0000");
    expect(store.state.caption).not.toBe(before); // fresh object, not an in-place write
    expect(changed).toContain("caption");
    expect(fill.hex.textContent).toBe("#FF0000");

    const outline = colorRow(view.element, m.captions.outline);
    setValue(outline.swatch, "#112233");
    expect(store.state.caption.outlineColor).toBe("#112233");
    expect(store.state.caption.color).toBe("#ff0000"); // earlier patch preserved
  });

  it("B / I / U toggles flip their booleans on and off through the store", async () => {
    const { store, view } = await makeView();
    const cases: Array<[string, keyof CaptionStyleState]> = [
      ["B", "bold"],
      ["I", "italic"],
      ["U", "underline"],
    ];
    for (const [text, key] of cases) {
      const btn = buttonByText(view.element, text);
      btn.click();
      expect(store.state.caption[key], key).toBe(true);
      btn.click();
      expect(store.state.caption[key], key).toBe(false);
    }
  });

  it("Shadow toggles; Box toggles AND gates the box-colour patch", async () => {
    const { store, view } = await makeView();
    buttonByText(view.element, m.captions.shadow).click();
    expect(store.state.caption.shadow).toBe(true);

    const boxColor = colorRow(view.element, m.captions.boxColor);
    expect(boxColor.row.style.display).toBe("none"); // hidden while box is off
    buttonByText(view.element, m.captions.box).click();
    expect(store.state.caption.box).toBe(true);
    expect(boxColor.row.style.display).toBe("");
    setValue(boxColor.swatch, "#445566");
    expect(store.state.caption.boxColor).toBe("#445566");
    buttonByText(view.element, m.captions.box).click();
    expect(store.state.caption.box).toBe(false);
    expect(boxColor.row.style.display).toBe("none");
  });

  it("the rotation slider patches angle and updates its degree readout", async () => {
    const { store, view } = await makeView();
    const slider = view.element.querySelector<HTMLInputElement>('input[type="range"]')!;
    const readout = slider.parentElement!.querySelector<HTMLElement>(".mono")!;
    expect(readout.textContent).toBe("0°");
    setValue(slider, "12");
    expect(store.state.caption.angle).toBe(12);
    expect(readout.textContent).toBe("12°");
    setValue(slider, "-30");
    expect(store.state.caption.angle).toBe(-30);
    expect(readout.textContent).toBe("-30°");
  });
});

describe("font picker: popup mechanics", () => {
  it("builds default + custom rows only when both enumerations are empty", async () => {
    const { view } = await makeView();
    expect(optionRows(view.element).map((r) => r.textContent)).toEqual([
      m.captions.fontSystemDefault,
      m.captions.fontCustomPath,
    ]);
    expect(groupHeaders(view.element)).toEqual([]);
    expect(triggerLabel(view.element).textContent).toBe(m.captions.fontSystemDefault);
    expect(pathField(view.element).style.display).toBe("none");
    // The default row is the live selection.
    expect(
      rowByLabel(view.element, m.captions.fontSystemDefault).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("the trigger opens/closes the popup and mirrors aria-expanded", async () => {
    const { view } = await makeView();
    const t = trigger(view.element);
    expect(popup(view.element).style.display).toBe("none");
    t.click();
    expect(popup(view.element).style.display).toBe("block");
    expect(t.getAttribute("aria-expanded")).toBe("true");
    t.click();
    expect(popup(view.element).style.display).toBe("none");
    expect(t.getAttribute("aria-expanded")).toBe("false");
  });

  it("a click outside the picker closes it; Escape closes and refocuses", async () => {
    const { view } = await makeView();
    trigger(view.element).click();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popup(view.element).style.display).toBe("none");

    trigger(view.element).click();
    popup(view.element).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(popup(view.element).style.display).toBe("none");
    expect(document.activeElement).toBe(trigger(view.element));
  });
});

describe("font picker: groups from the platform enumerations", () => {
  it("groups folder fonts above system fonts, de-duped and sorted", async () => {
    localStorage.setItem(FONTS_DIR_KEY, "/my/fonts");
    platformMocks.listUserFonts.mockResolvedValue([
      { family: "Zed Display", path: "/my/fonts/Zed.ttf" },
      { family: "Inter", path: "/my/fonts/Inter.ttf" },
      { family: "inter", path: "/my/fonts/Inter-Copy.ttf" }, // dupe family (case-insensitive)
      { family: "  ", path: "/my/fonts/blank.ttf" }, // no real family → dropped
      { family: "NoPath" }, // no file path → dropped
    ]);
    platformMocks.listFonts.mockResolvedValue([
      { family: "Zilla" },
      { family: "Arial" },
      { family: "Arial" }, // exact dupe → one row
      { family: "INTER" }, // folder font wins → dropped here
      { family: " " }, // blank → dropped
    ]);
    const { view } = await makeView();

    expect(platformMocks.listUserFonts).toHaveBeenCalledWith("/my/fonts");
    expect(groupHeaders(view.element)).toEqual([
      m.captions.fontYourFonts,
      m.captions.fontSystemFonts,
    ]);
    // Default, then folder fonts (sorted), then system fonts (sorted), then custom.
    expect(optionRows(view.element).map((r) => r.textContent)).toEqual([
      m.captions.fontSystemDefault,
      "Inter",
      "Zed Display",
      "Arial",
      "Zilla",
      m.captions.fontCustomPath,
    ]);
    // A folder row carries its FILE PATH as the value; a system row its family.
    expect(rowByLabel(view.element, "Inter").dataset.value).toBe("/my/fonts/Inter.ttf");
    expect(rowByLabel(view.element, "Arial").dataset.value).toBe("Arial");
  });

  it("skips the folder scan entirely when no fonts dir is set", async () => {
    await makeView();
    expect(platformMocks.listUserFonts).not.toHaveBeenCalled();
  });

  it("an unreadable folder drops only the Your-fonts group", async () => {
    localStorage.setItem(FONTS_DIR_KEY, "/gone");
    platformMocks.listUserFonts.mockRejectedValue(new Error("ENOENT"));
    platformMocks.listFonts.mockResolvedValue([{ family: "Arial" }]);
    const { view } = await makeView();
    expect(groupHeaders(view.element)).toEqual([m.captions.fontSystemFonts]);
    expect(optionRows(view.element).map((r) => r.textContent)).toEqual([
      m.captions.fontSystemDefault,
      "Arial",
      m.captions.fontCustomPath,
    ]);
  });

  it("a failed system enumeration leaves default + custom path only", async () => {
    platformMocks.listFonts.mockRejectedValue(new Error("unavailable"));
    const { view } = await makeView();
    expect(optionRows(view.element).map((r) => r.textContent)).toEqual([
      m.captions.fontSystemDefault,
      m.captions.fontCustomPath,
    ]);
  });
});

describe("font picker: selection semantics", () => {
  /** A picker with one folder font (Inter) and one system font (Arial). */
  async function makePicker() {
    localStorage.setItem(FONTS_DIR_KEY, "/my/fonts");
    platformMocks.listUserFonts.mockResolvedValue([
      { family: "Inter", path: "/my/fonts/Inter.ttf" },
    ]);
    platformMocks.listFonts.mockResolvedValue([{ family: "Arial" }]);
    return makeView();
  }

  it("a system row sets caption.font to the FAMILY and previews its face", async () => {
    const { store, view } = await makePicker();
    trigger(view.element).click();
    rowByLabel(view.element, "Arial").click();
    expect(store.state.caption.font).toBe("Arial");
    expect(triggerLabel(view.element).textContent).toBe("Arial");
    // The view writes 'Arial' (single quotes); jsdom's CSSOM serializes back with double quotes.
    expect(triggerLabel(view.element).style.fontFamily).toBe('"Arial"');
    expect(popup(view.element).style.display).toBe("none"); // chose → closed
    expect(document.activeElement).toBe(trigger(view.element));
    trigger(view.element).click();
    expect(rowByLabel(view.element, "Arial").getAttribute("aria-selected")).toBe("true");
    expect(
      rowByLabel(view.element, m.captions.fontSystemDefault).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("a folder row sets caption.font to the FILE PATH but shows the family", async () => {
    const { store, view } = await makePicker();
    trigger(view.element).click();
    rowByLabel(view.element, "Inter").click();
    expect(store.state.caption.font).toBe("/my/fonts/Inter.ttf");
    expect(triggerLabel(view.element).textContent).toBe("Inter"); // never the raw path
    expect(triggerLabel(view.element).style.fontFamily).toBe('"Inter"'); // CSSOM-normalized quotes
  });

  it("System default clears the font (and any stale custom path)", async () => {
    const { store, view } = await makePicker();
    trigger(view.element).click();
    rowByLabel(view.element, m.captions.fontCustomPath).click();
    setValue(pathInput(view.element), "/tmp/x.ttf");
    expect(store.state.caption.font).toBe("/tmp/x.ttf");
    trigger(view.element).click();
    rowByLabel(view.element, m.captions.fontSystemDefault).click();
    expect(store.state.caption.font).toBe("");
    expect(pathInput(view.element).value).toBe("");
    expect(triggerLabel(view.element).textContent).toBe(m.captions.fontSystemDefault);
    expect(pathField(view.element).style.display).toBe("none");
  });

  it("rows choose via Enter and Space too", async () => {
    const { store, view } = await makePicker();
    trigger(view.element).click();
    rowByLabel(view.element, "Arial").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(store.state.caption.font).toBe("Arial");
    trigger(view.element).click();
    rowByLabel(view.element, "Inter").dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(store.state.caption.font).toBe("/my/fonts/Inter.ttf");
  });

  it("hover highlights an unselected row and clears on leave; never the selected one", async () => {
    const { view } = await makePicker();
    trigger(view.element).click();
    const arial = rowByLabel(view.element, "Arial");
    arial.dispatchEvent(new MouseEvent("mouseenter"));
    expect(arial.style.background).toBe("var(--panel-2)");
    arial.dispatchEvent(new MouseEvent("mouseleave"));
    expect(arial.style.background).toBe("");
    const selected = rowByLabel(view.element, m.captions.fontSystemDefault);
    selected.dispatchEvent(new MouseEvent("mouseenter"));
    expect(selected.style.background).toBe("var(--panel-3)"); // selection tint, untouched
  });
});

describe("custom font path", () => {
  it("reveals the field, focuses it, and patches the trimmed path on input", async () => {
    const { store, view } = await makeView();
    trigger(view.element).click();
    rowByLabel(view.element, m.captions.fontCustomPath).click();
    expect(pathField(view.element).style.display).toBe("");
    expect(triggerLabel(view.element).textContent).toBe(m.captions.fontCustomPath);
    expect(document.activeElement).toBe(pathInput(view.element));
    expect(store.state.caption.font).toBe(""); // empty field → empty font
    setValue(pathInput(view.element), "  /fonts/Display.otf  ");
    expect(store.state.caption.font).toBe("/fonts/Display.otf");
  });

  it("typing into the (hidden) field outside custom mode patches nothing", async () => {
    const { store, view } = await makeView();
    setValue(pathInput(view.element), "/sneaky/path.ttf");
    expect(store.state.caption.font).toBe("");
  });
});

describe("sync() — the clip-restore seam", () => {
  it("reflects a restored style onto every control", async () => {
    platformMocks.listFonts.mockResolvedValue([{ family: "Arial" }]);
    const { store, view } = await makeView();
    store.set({
      caption: {
        ...store.state.caption,
        font: "Arial",
        color: "#123456",
        outlineColor: "#654321",
        bold: true,
        box: true,
        boxColor: "#0a0b0c",
        angle: -7,
      },
    });
    view.sync();

    expect(triggerLabel(view.element).textContent).toBe("Arial");
    expect(rowByLabel(view.element, "Arial").getAttribute("aria-selected")).toBe("true");
    expect(colorRow(view.element, m.captions.fill).swatch.value).toBe("#123456");
    expect(colorRow(view.element, m.captions.fill).hex.textContent).toBe("#123456");
    expect(colorRow(view.element, m.captions.outline).swatch.value).toBe("#654321");
    expect(buttonByText(view.element, "B").classList.contains("primary")).toBe(true);
    expect(buttonByText(view.element, "I").classList.contains("primary")).toBe(false);
    expect(buttonByText(view.element, m.captions.box).classList.contains("primary")).toBe(true);
    expect(colorRow(view.element, m.captions.boxColor).row.style.display).toBe("");
    expect(colorRow(view.element, m.captions.boxColor).swatch.value).toBe("#0a0b0c");
    const slider = view.element.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.value).toBe("-7");
    expect(slider.parentElement!.querySelector(".mono")!.textContent).toBe("-7°");
  });

  it("resolves a restored folder-font PATH to its family row", async () => {
    localStorage.setItem(FONTS_DIR_KEY, "/my/fonts");
    platformMocks.listUserFonts.mockResolvedValue([
      { family: "Inter", path: "/my/fonts/Inter.ttf" },
    ]);
    const { store, view } = await makeView();
    store.set({ caption: { ...store.state.caption, font: "/my/fonts/Inter.ttf" } });
    view.sync();
    expect(triggerLabel(view.element).textContent).toBe("Inter");
    expect(rowByLabel(view.element, "Inter").getAttribute("aria-selected")).toBe("true");
    expect(pathField(view.element).style.display).toBe("none");
  });

  it("falls an unlisted font value through to Custom path…", async () => {
    const { store, view } = await makeView();
    store.set({ caption: { ...store.state.caption, font: "/elsewhere/Weird.ttc" } });
    view.sync();
    expect(triggerLabel(view.element).textContent).toBe(m.captions.fontCustomPath);
    expect(pathField(view.element).style.display).toBe("");
    expect(pathInput(view.element).value).toBe("/elsewhere/Weird.ttc");
    expect(rowByLabel(view.element, m.captions.fontCustomPath).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("an emptied font restores the System default row", async () => {
    const { store, view } = await makeView({ font: "whatever" });
    store.set({ caption: { ...store.state.caption, font: "" } });
    view.sync();
    expect(triggerLabel(view.element).textContent).toBe(m.captions.fontSystemDefault);
    expect(triggerLabel(view.element).style.fontFamily).toBe("");
  });
});
