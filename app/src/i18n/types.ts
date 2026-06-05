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

/** Strings for the Settings dialog. */
export interface SettingsMessages {
  menuLabel: string;
  title: string;
  apiKeySection: string;
  apiKeyLabel: string;
  apiKeyPlaceholder: string;
  apiKeyHint: string;
  close: string;
}

/** The full message catalog for one locale. */
export interface Messages {
  help: HelpMessages;
  settings: SettingsMessages;
}
