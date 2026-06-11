// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The per-clip caption STYLE controls (#125 Phase 4; SPEC §6.5) — font picker
 * + colour swatches + B/I/U + shadow/box + rotation, extracted from the
 * inspector as `buildCaptionStyle(store, platform)`. The controls bind to
 * `state.caption` (a populated working copy) and write through `store.set`;
 * `addClip` narrows it to a sparse `spec.caption`. The fonts FOLDER stays in
 * Settings — its dir feeds the "Your fonts" group of the picker here.
 *
 * The caption TEXT (hook/title) and 9-zone position selects stay with the
 * inspector — this module is only the style cluster (it is by far the largest
 * single block of caption UI, so it gets its own file).
 */

import { messages } from "../i18n/index.js";
import { platformName } from "../platform/index.js";
import type { FootlightPlatform } from "../platform/types.js";
import { el, input, button } from "../ui.js";
import type { EditorState, EditorStore } from "../editor-store.js";

/** The caption-style cluster: its root element + the restore re-sync. */
export interface CaptionStyleView {
  element: HTMLElement;
  /** Refresh every control from `state.caption` (used on clip restore). */
  sync: () => void;
}

export function buildCaptionStyle(
  store: EditorStore,
  platform: FootlightPlatform,
): CaptionStyleView {
  const state = store.state;
  const m = messages.editor;

  const FONTS_DIR_KEY = "footlight.fontsDir";
  const styleWrap = el("div", "fl-cap-style");
  styleWrap.style.cssText = "display:flex; flex-direction:column; gap:8px; margin-top:8px;";

  // Font picker: a CUSTOM dropdown (trigger button + absolutely-positioned popup
  // list) grouped into System default / Your fonts / System fonts / Custom path…
  // A native <select> can't preview faces — browsers and the macOS WKWebView
  // popup render <option>s in the OS UI font and ignore per-option font-family.
  // Here each row sets `li.style.fontFamily` to its own family so it renders in
  // its own typeface. Folder fonts store their FILE PATH (engine resolves family
  // + fontsdir); system fonts store the family NAME; custom reveals a text field.
  //
  // Sentinels for the two non-family rows. A leading space keeps them out of any
  // real family / path namespace (a stored font value is never " default").
  const FONT_DEFAULT = " default";
  const FONT_CUSTOM = " custom";

  // The free-text custom-path field (revealed only by the "Custom path…" row).
  const fontField = el("div", "fl-field");
  fontField.style.marginTop = "2px";
  const fontPathInput = input("text", m.captions.fontPathPlaceholder);
  fontPathInput.classList.add("mono");
  fontField.append(fontPathInput);
  fontField.style.display = "none";
  fontPathInput.addEventListener("input", () => {
    if (selected === FONT_CUSTOM) {
      setCaption("font", fontPathInput.value.trim());
    }
  });

  // The trigger (a .fl-field-styled button) + its popup list.
  const fontRow = el("div", "fl-field");
  fontRow.style.cssText = "position:relative; cursor:pointer; gap:0;";
  const fontTrigger = button("", undefined);
  fontTrigger.type = "button";
  fontTrigger.title = m.captions.fontTitle;
  fontTrigger.setAttribute("aria-haspopup", "listbox");
  fontTrigger.setAttribute("aria-expanded", "false");
  fontTrigger.style.cssText =
    "flex:1; min-width:0; display:flex; align-items:center; justify-content:space-between; gap:9px; background:none; border:none; outline:none; color:var(--text); font:inherit; font-size:13px; padding:0; text-align:left; cursor:pointer;";
  const fontTriggerLabel = el("span");
  fontTriggerLabel.style.cssText =
    "min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
  const fontCaret = el("span");
  fontCaret.textContent = "▾";
  fontCaret.style.cssText = "flex:none; color:var(--faint); font-size:11px;";
  fontTrigger.append(fontTriggerLabel, fontCaret);
  fontRow.append(fontTrigger);

  const fontPopup = el("ul");
  fontPopup.setAttribute("role", "listbox");
  fontPopup.setAttribute("aria-label", m.captions.fontTitle);
  fontPopup.style.cssText =
    "position:absolute; top:calc(100% + 6px); left:0; right:0; z-index:40; margin:0; padding:5px; list-style:none; max-height:260px; overflow-y:auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:var(--shadow); display:none;";
  fontRow.append(fontPopup);

  const closeFontPopup = (): void => {
    fontPopup.style.display = "none";
    fontTrigger.setAttribute("aria-expanded", "false");
  };
  const openFontPopup = (): void => {
    fontPopup.style.display = "block";
    fontTrigger.setAttribute("aria-expanded", "true");
    fontPopup
      .querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  };
  fontTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (fontPopup.style.display === "block") closeFontPopup();
    else openFontPopup();
  });
  // Click-away closes the popup. Esc is handled locally on the picker (a
  // capture-free listener on the trigger/popup) so the global keydown transport
  // handler stays untouched.
  document.addEventListener("click", (e) => {
    if (!fontRow.contains(e.target as Node)) closeFontPopup();
  });
  const onFontEsc = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeFontPopup();
      fontTrigger.focus();
    }
  };
  fontTrigger.addEventListener("keydown", onFontEsc);
  fontPopup.addEventListener("keydown", onFontEsc);

  // An option in the picker. A folder font carries `path` (selection sets
  // caption.font = path so the engine resolves family + fontsdir); a system font
  // has no path (selection sets caption.font = family). `face` is the CSS family
  // for the per-row live preview (best-effort — see the FontFace loading below).
  type FontOpt = { value: string; label: string; face?: string; path?: string };

  let selected = FONT_DEFAULT; // updated by (re)build / restore; the live selection

  // Reflect a selection onto the trigger label (in its own face) + custom-field
  // visibility. Single quotes are stripped so the inline family value can't break
  // out of its quoting. `display` overrides the shown text/face for a value that
  // is a file path (folder fonts) — show the family, never the raw path.
  const syncFontTrigger = (value: string, display?: { label: string; face: string }): void => {
    const custom = value === FONT_CUSTOM;
    fontField.style.display = custom ? "" : "none";
    if (custom) {
      fontTriggerLabel.textContent = m.captions.fontCustomPath;
      fontTriggerLabel.style.fontFamily = "";
    } else if (value === FONT_DEFAULT || value === "") {
      fontTriggerLabel.textContent = m.captions.fontSystemDefault;
      fontTriggerLabel.style.fontFamily = "";
    } else if (display) {
      fontTriggerLabel.textContent = display.label;
      fontTriggerLabel.style.fontFamily = display.face ? `'${display.face.replace(/'/g, "")}'` : "";
    } else {
      fontTriggerLabel.textContent = value;
      fontTriggerLabel.style.fontFamily = `'${value.replace(/'/g, "")}'`;
    }
  };

  const markFontSelected = (value: string): void => {
    for (const li of Array.from(fontPopup.children) as HTMLElement[]) {
      if (li.dataset.value === undefined) continue; // group headers aren't options
      const on = li.dataset.value === value;
      li.setAttribute("aria-selected", String(on));
      li.style.background = on ? "var(--panel-3)" : "";
    }
  };

  const fontGroupHeader = (text: string): HTMLElement => {
    const li = el("li");
    li.setAttribute("role", "presentation");
    li.textContent = text;
    li.style.cssText =
      "padding:8px 10px 4px; font-size:10.5px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; color:var(--faint); cursor:default;";
    return li;
  };

  // Folder fonts aren't installed system-wide, so the OS can't resolve their
  // family by name. Load each from its file (Tauri asset URL) via the FontFace
  // API so its row + the trigger preview in the REAL face; fall back silently to
  // the default face if loading fails (the web dev backend has no local-file URL
  // for arbitrary paths, or the file is malformed). The burn always uses the file
  // path, so a missed preview is purely cosmetic — the row still shows the family.
  const loadedFolderFaces = new Set<string>();
  const loadFolderFontFace = (family: string, path: string): void => {
    if (platformName !== "tauri") return; // no cross-backend local-file URL on web
    const key = `${family}\u0000${path}`;
    if (loadedFolderFaces.has(key)) return;
    loadedFolderFaces.add(key);
    void (async () => {
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const url = convertFileSrc(path);
        const face = new FontFace(family, `url("${url.replace(/"/g, "%22")}")`);
        await face.load();
        (document as Document & { fonts: FontFaceSet }).fonts.add(face);
        // Repaint the trigger if this is the live selection (the row already
        // carries the family, so it picks up the face once it's registered).
        if (selected === path) syncFontTrigger(path, { label: family, face: family });
      } catch {
        loadedFolderFaces.delete(key); // allow a later retry
      }
    })();
  };

  // All real (non-sentinel) options, so a restored clip whose font is a path or a
  // family resolves to the right row instead of falling to "Custom path…".
  let fontOpts: FontOpt[] = [];

  const fontOptionRow = (opt: FontOpt): HTMLElement => {
    const li = el("li");
    li.dataset.value = opt.value;
    li.setAttribute("role", "option");
    li.tabIndex = 0;
    li.textContent = opt.label;
    li.style.cssText =
      "padding:7px 10px; border-radius:7px; cursor:pointer; font-size:13px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
    // Each family row renders in its own face: system fonts resolve by name;
    // folder fonts are loaded via FontFace above (and previewed once ready).
    if (opt.face) li.style.fontFamily = `'${opt.face.replace(/'/g, "")}'`;
    li.addEventListener("mouseenter", () => {
      if (li.getAttribute("aria-selected") !== "true") li.style.background = "var(--panel-2)";
    });
    li.addEventListener("mouseleave", () => {
      if (li.getAttribute("aria-selected") !== "true") li.style.background = "";
    });
    const choose = (): void => {
      selected = opt.value;
      markFontSelected(selected);
      if (opt.value === FONT_DEFAULT) {
        setCaption("font", "");
        fontPathInput.value = "";
      } else if (opt.value === FONT_CUSTOM) {
        // Reveal the free-text field; keep whatever path is already there.
        setCaption("font", fontPathInput.value.trim());
      } else {
        // A folder font sets caption.font = its file path (engine resolves the
        // family + fontsdir); a system font sets caption.font = the family.
        setCaption("font", opt.path ?? opt.value);
      }
      const realFont = opt.value !== FONT_DEFAULT && opt.value !== FONT_CUSTOM;
      syncFontTrigger(
        opt.value === FONT_CUSTOM ? FONT_CUSTOM : state.caption.font || FONT_DEFAULT,
        realFont && opt.path ? { label: opt.label, face: opt.face ?? opt.label } : undefined,
      );
      closeFontPopup();
      if (opt.value === FONT_CUSTOM) fontPathInput.focus();
      else fontTrigger.focus();
    };
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      choose();
    });
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose();
      }
    });
    return li;
  };

  /**
   * Reflect `state.caption.font` onto the trigger + custom field, after a (re)build
   * or on clip restore. "" → default; a value matching a listed option → that
   * option; anything else → Custom path… (the free-text field shows it). Folder
   * fonts store a path, so show their family (and ensure its face is loaded).
   */
  const syncFontSelect = (): void => {
    const f = state.caption.font.trim();
    const hit = f ? fontOpts.find((o) => o.value === f) : undefined;
    if (!f) {
      selected = FONT_DEFAULT;
    } else if (hit) {
      selected = hit.value;
    } else {
      selected = FONT_CUSTOM;
      fontPathInput.value = f;
    }
    markFontSelected(selected);
    if (hit?.path) loadFolderFontFace(hit.label, hit.path);
    syncFontTrigger(
      selected === FONT_CUSTOM ? FONT_CUSTOM : state.caption.font || FONT_DEFAULT,
      hit?.path ? { label: hit.label, face: hit.face ?? hit.label } : undefined,
    );
  };

  // (Re)build the dropdown: scan the fonts folder (if set) into a "Your fonts"
  // group at the top, then list system fonts. Called once on mount and again
  // whenever the fonts-folder changes. Each rebuild supersedes the last (a stale
  // async result is dropped via the token).
  let fontBuildToken = 0;
  async function rebuildFontPicker(): Promise<void> {
    const token = ++fontBuildToken;
    let userFonts: { family: string; path?: string }[] = [];
    let sysFonts: { family: string; path?: string }[] = [];
    try {
      const dir = localStorage.getItem(FONTS_DIR_KEY)?.trim() ?? "";
      if (dir) userFonts = await platform.listUserFonts(dir);
    } catch {
      /* unreadable folder → no "Your fonts" group */
    }
    try {
      sysFonts = await platform.listFonts();
    } catch {
      /* enumeration unavailable → system-default + custom path only */
    }
    if (token !== fontBuildToken) return; // a newer rebuild started — drop this one

    // Folder fonts: keep those with a real family + path; de-dupe by family.
    const userByFamily = new Map<string, { family: string; path: string }>();
    for (const f of userFonts) {
      const fam = f.family.trim();
      if (!fam || !f.path) continue;
      const key = fam.toLowerCase();
      if (!userByFamily.has(key)) userByFamily.set(key, { family: fam, path: f.path });
    }
    const userList = Array.from(userByFamily.values());
    userList.sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: "base" }));
    const userKeys = new Set(userList.map((f) => f.family.toLowerCase()));

    // System families: de-dupe + sort; a folder font that also exists system-wide
    // is dropped here so the file-backed entry wins.
    const sysFamilies = Array.from(
      new Set(sysFonts.map((f) => f.family).filter((f) => f.trim())),
    ).filter((f) => !userKeys.has(f.toLowerCase()));
    sysFamilies.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    const userOpts: FontOpt[] = userList.map((f) => ({
      value: f.path,
      label: f.family,
      face: f.family,
      path: f.path,
    }));
    const sysOpts: FontOpt[] = sysFamilies.map((f) => ({ value: f, label: f, face: f }));
    fontOpts = [...userOpts, ...sysOpts];

    fontPopup.replaceChildren();
    fontPopup.append(fontOptionRow({ value: FONT_DEFAULT, label: m.captions.fontSystemDefault }));
    if (userOpts.length) {
      fontPopup.append(fontGroupHeader(m.captions.fontYourFonts));
      for (const o of userOpts) {
        fontPopup.append(fontOptionRow(o));
        if (o.path) loadFolderFontFace(o.label, o.path); // warm the preview face
      }
    }
    if (sysOpts.length) {
      fontPopup.append(fontGroupHeader(m.captions.fontSystemFonts));
      for (const o of sysOpts) fontPopup.append(fontOptionRow(o));
    }
    fontPopup.append(fontOptionRow({ value: FONT_CUSTOM, label: m.captions.fontCustomPath }));

    syncFontSelect();
  }

  /** Patch ONE field of the per-clip caption style through the store (a fresh
   *  object, so the preview renders via subscription). */
  function setCaption<K extends keyof EditorState["caption"]>(
    key: K,
    value: EditorState["caption"][K],
  ): void {
    store.set({ caption: { ...state.caption, [key]: value } });
  }

  /** A `#RRGGBB` colour control: swatch + live hex label, bound to `bind`. */
  function colorControl(label: string, get: () => string, set: (v: string) => void): HTMLElement {
    const row = el("div", "fl-rowg");
    row.style.cssText = "align-items:center; gap:8px;";
    const lab = el("span", "fl-label");
    lab.style.cssText = "flex:1; font-size:12px;";
    lab.textContent = label;
    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.value = get();
    const hex = el("span", "mono");
    hex.style.cssText = "font-size:12px; color:var(--faint); min-width:62px; text-align:right;";
    hex.textContent = get().toUpperCase();
    swatch.addEventListener("input", () => {
      set(swatch.value);
      hex.textContent = swatch.value.toUpperCase();
    });
    (swatch as HTMLInputElement & { _sync?: () => void })._sync = () => {
      swatch.value = get();
      hex.textContent = get().toUpperCase();
    };
    row.append(lab, swatch, hex);
    return row;
  }
  const fillRow = colorControl(
    m.captions.fill,
    () => state.caption.color,
    (v) => setCaption("color", v),
  );
  const outlineRow = colorControl(
    m.captions.outline,
    () => state.caption.outlineColor,
    (v) => setCaption("outlineColor", v),
  );

  /** A B/I/U-style toggle button bound to a boolean on `state.caption`. */
  function toggleBtn(
    glyph: string,
    css: string,
    title: string,
    get: () => boolean,
    set: (v: boolean) => void,
  ): HTMLButtonElement {
    const b = button(glyph, "fl-btn sm");
    if (css) b.style.cssText = css;
    b.title = title;
    const refresh = () => b.classList.toggle("primary", get());
    b.addEventListener("click", () => {
      set(!get());
      refresh();
    });
    (b as HTMLButtonElement & { _sync?: () => void })._sync = refresh;
    refresh();
    return b;
  }
  const boldBtn = toggleBtn(
    "B",
    "font-weight:700;",
    m.captions.bold,
    () => state.caption.bold,
    (v) => setCaption("bold", v),
  );
  const italicBtn = toggleBtn(
    "I",
    "font-style:italic;",
    m.captions.italic,
    () => state.caption.italic,
    (v) => setCaption("italic", v),
  );
  const underlineBtn = toggleBtn(
    "U",
    "text-decoration:underline;",
    m.captions.underline,
    () => state.caption.underline,
    (v) => setCaption("underline", v),
  );
  const emphasisRow = el("div", "fl-rowg");
  emphasisRow.style.gap = "6px";
  emphasisRow.append(boldBtn, italicBtn, underlineBtn);

  const boxColorRow = colorControl(
    m.captions.boxColor,
    () => state.caption.boxColor,
    (v) => setCaption("boxColor", v),
  );
  const shadowBtn = toggleBtn(
    m.captions.shadow,
    "",
    m.captions.shadowTitle,
    () => state.caption.shadow,
    (v) => setCaption("shadow", v),
  );
  const boxBtn = toggleBtn(
    m.captions.box,
    "",
    m.captions.boxTitle,
    () => state.caption.box,
    (v) => {
      setCaption("box", v);
      boxColorRow.style.display = v ? "" : "none";
    },
  );
  boxColorRow.style.display = state.caption.box ? "" : "none";
  const fxRow = el("div", "fl-rowg");
  fxRow.style.gap = "6px";
  fxRow.append(shadowBtn, boxBtn);

  const angleRow = el("div", "fl-rowg");
  angleRow.style.cssText = "align-items:center; gap:8px;";
  const angleLab = el("span", "fl-label");
  angleLab.style.cssText = "flex:none; font-size:12px;";
  angleLab.textContent = m.captions.rotate;
  const angleInput = document.createElement("input");
  angleInput.type = "range";
  angleInput.min = "-30";
  angleInput.max = "30";
  angleInput.step = "1";
  angleInput.style.flex = "1";
  angleInput.value = String(state.caption.angle);
  const angleVal = el("span", "mono");
  angleVal.style.cssText = "font-size:12px; color:var(--faint); min-width:34px; text-align:right;";
  angleVal.textContent = `${state.caption.angle}°`;
  angleInput.addEventListener("input", () => {
    setCaption("angle", Number(angleInput.value));
    angleVal.textContent = `${state.caption.angle}°`;
  });
  angleRow.append(angleLab, angleInput, angleVal);

  styleWrap.append(
    fontRow,
    fontField,
    fillRow,
    outlineRow,
    emphasisRow,
    fxRow,
    boxColorRow,
    angleRow,
  );

  /** Refresh every caption-style control from `state.caption` (used on clip restore). */
  function syncCaptionControls(): void {
    syncFontSelect();
    for (const c of [fillRow, outlineRow, boxColorRow]) {
      const sw = c.querySelector('input[type="color"]') as
        | (HTMLInputElement & { _sync?: () => void })
        | null;
      sw?._sync?.();
    }
    for (const b of [boldBtn, italicBtn, underlineBtn, shadowBtn, boxBtn] as Array<
      HTMLButtonElement & { _sync?: () => void }
    >) {
      b._sync?.();
    }
    boxColorRow.style.display = state.caption.box ? "" : "none";
    angleInput.value = String(state.caption.angle);
    angleVal.textContent = `${state.caption.angle}°`;
  }
  void rebuildFontPicker();

  return { element: styleWrap, sync: syncCaptionControls };
}
