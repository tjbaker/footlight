// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Localizable message shapes. All user-facing guide content is structured data
 * (not hardcoded HTML) so a new locale is just another `Messages` object — see
 * `en.ts` for the English catalog and `index.ts` for locale selection.
 */

/** One block of guide prose. */
export type GuideBlock =
  | { kind: "p"; text: string }
  | { kind: "steps"; items: string[] } // ordered how-to
  | { kind: "list"; items: string[] } // unordered bullets
  | { kind: "tip"; text: string }; // highlighted tip/gotcha

/** A titled section of the user guide. `id` anchors the table-of-contents link. */
export interface GuideSection {
  id: string;
  title: string;
  blocks: GuideBlock[];
}

/** Strings + content for the Help → User Guide dialog. */
export interface HelpMessages {
  menuLabel: string;
  title: string;
  subtitle: string;
  tocLabel: string;
  close: string;
  sections: GuideSection[];
}

/** Strings for the Settings dialog — a 5-panel left-nav modal. */
export interface SettingsMessages {
  menuLabel: string;
  title: string;
  /** Left-nav item labels. */
  nav: {
    general: string;
    rendering: string;
    ai: string;
    shortcuts: string;
    about: string;
  };
  /** Shared footer actions. */
  cancel: string;
  save: string;
  saved: string;
  close: string;

  general: {
    title: string;
    subtitle: string;
    appearance: string;
    theme: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    timecode: string;
    timecodeFrames: string;
    defaults: string;
    destination: string;
    destinationBrowse: string;
    destinationHint: string;
    trackingInterval: string;
    trackingIntervalHint: string;
    session: string;
    autosave: string;
    autosaveHint: string;
    clearSession: string;
    sessionCleared: string;
  };

  rendering: {
    title: string;
    subtitle: string;
    quality: string;
    qualityNearLossless: string;
    qualityHigh: string;
    qualityGood: string;
    qualitySmaller: string;
    preset: string;
    presetHint: string;
    audio: string;
    audioCopy: string;
    audioReencode: string;
    audioCopyHint: string;
    audioReencodeHint: string;
    bitrate: string;
    dryRun: string;
    dryRunHint: string;
    gapNote: string;
    captions: string;
    burnCaptions: string;
    burnCaptionsHint: string;
    captionFont: string;
    captionFontSystemDefault: string;
    captionFontCustom: string;
    captionFontPlaceholder: string;
    captionFontHint: string;
    captionStyleNote: string;
    captionStyle: string;
    captionStyleAppliesHint: string;
    captionColor: string;
    captionOutlineColor: string;
    captionEmphasis: string;
    captionBold: string;
    captionItalic: string;
    captionUnderline: string;
    captionBoldGlyph: string;
    captionItalicGlyph: string;
    captionUnderlineGlyph: string;
    fontsDir: string;
    fontsDirBrowse: string;
    fontsDirPlaceholder: string;
    fontsDirHint: string;
    captionFontGroupYours: string;
    captionFontGroupSystem: string;
  };

  ai: {
    title: string;
    subtitle: string;
    provider: string;
    providerGemini: string;
    providerClaude: string;
    providerOpenai: string;
    providerConnected: string;
    providerAddKey: string;
    notImplemented: string;
    notImplementedBody: string;
    apiKey: string;
    apiKeyPlaceholder: string;
    apiKeyShow: string;
    apiKeyHide: string;
    apiKeyTest: string;
    apiKeyTesting: string;
    apiKeyValid: string;
    apiKeyInvalid: string;
    apiKeyHint: string;
    model: string;
    recommended: string;
    costNote: string;
    costInterval: string;
    advanced: string;
    advancedSub: string;
    assistantModel: string;
    visionModel: string;
    overlayTitle: string;
    overlaySub: string;
    overlayPlaceholder: string;
    baseView: string;
    baseViewSub: string;
    baseViewShow: string;
    baseViewHide: string;
  };

  shortcuts: {
    title: string;
    subtitle: string;
  };

  about: {
    title: string;
    subtitle: string;
    repo: string;
    reportBug: string;
    licenses: string;
    environment: string;
    environmentHint: string;
  };
}

/** The full message catalog for one locale. */
export interface Messages {
  help: HelpMessages;
  settings: SettingsMessages;
}
