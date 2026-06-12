---
name: feature-dod
description: The definition of done for any user-facing Footlight feature. Use before declaring a feature complete or opening its PR.
---

# Feature definition of done

A user-facing feature is NOT done until:

- **i18n** — every user-visible string lives in the catalog
  (`app/src/i18n/`) in ALL locales, never hardcoded English in the view.
- **README** — the feature is documented in the README section it belongs to.
- **Help** — the in-app guide (`app/src/help.ts`) covers it.
- **Tests** — engine/CLI changes require tests (`CONTRIBUTING.md`); GUI
  behavior is covered through the jsdom editor suites or a direct view test.
- **Verified, not assumed** — run it: `npm run verify` at the root AND in
  `app/` (separate packages, separate Prettier/test runs), plus a manual
  check of the actual behavior where tests can't see it (e.g. canvas
  painting under jsdom).

Working norms that pair with this: decide-don't-over-ask, review subagent
diffs before committing them, never `git add -A`.
