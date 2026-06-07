# Changelog

## [0.5.0](https://github.com/tjbaker/footlight/compare/footlight-v0.4.0...footlight-v0.5.0) (2026-06-07)


### Features

* **app:** export the queue + Clear everything ([#108](https://github.com/tjbaker/footlight/issues/108)) ([4469bd6](https://github.com/tjbaker/footlight/commit/4469bd62b52eb7ff1f6c574d728886c679687e0b))
* **app:** first-launch empty-state onboarding ([#46](https://github.com/tjbaker/footlight/issues/46)) ([#109](https://github.com/tjbaker/footlight/issues/109)) ([0d6254c](https://github.com/tjbaker/footlight/commit/0d6254ca3c38364e2e85e6ad1461f3f18f039e47))
* **app:** NLE transport shortcuts (J/K/L, go-to In/Out, scene-cut nav) ([#106](https://github.com/tjbaker/footlight/issues/106)) ([5c3ccfd](https://github.com/tjbaker/footlight/commit/5c3ccfd93be3e5425f2be200f15e43ba6fc83800))
* **app:** preview each caption font in its own typeface ([#107](https://github.com/tjbaker/footlight/issues/107)) ([2ded9b1](https://github.com/tjbaker/footlight/commit/2ded9b1ba095745d6ecf891e4584ca9524b232c2))
* **assistant:** attach a sparse still strip to the chat turn ([#40](https://github.com/tjbaker/footlight/issues/40)) ([#113](https://github.com/tjbaker/footlight/issues/113)) ([392b987](https://github.com/tjbaker/footlight/commit/392b98730ada219f862cc0fe8893487a8b6a044d))


### Internationalization

* **editor:** move editor UI strings into the catalog ([#101](https://github.com/tjbaker/footlight/issues/101)) ([01a07ad](https://github.com/tjbaker/footlight/commit/01a07aded0b3c949a19658605219cd58d632a310))
* **locale:** add Brazilian Portuguese (pt-BR) translation ([#104](https://github.com/tjbaker/footlight/issues/104)) ([43a61f8](https://github.com/tjbaker/footlight/commit/43a61f8a5293cbbbd33c4136085dfaa46b84bc54))
* **locale:** add Spanish (es) translation ([#103](https://github.com/tjbaker/footlight/issues/103)) ([0ab18b1](https://github.com/tjbaker/footlight/commit/0ab18b1d0a997f29f112f88c40cf6d3583ae809f))
* **shortcuts:** single-source the keyboard-shortcuts reference ([#99](https://github.com/tjbaker/footlight/issues/99)) ([3d86461](https://github.com/tjbaker/footlight/commit/3d86461bf6db3361fd96aa58eccc7de5ebb27528))


### Documentation

* **contributing:** document squash-only merge policy ([#98](https://github.com/tjbaker/footlight/issues/98)) ([3451bee](https://github.com/tjbaker/footlight/commit/3451bee9b2581e487278ba84c8ffb513c4d60bb5))
* **help:** add Captions guide section; refresh shortcuts & queue ([#111](https://github.com/tjbaker/footlight/issues/111)) ([f04510d](https://github.com/tjbaker/footlight/commit/f04510dbd5fd3595f678761fe9f1233746f73c09))
* **readme:** quality sweep — drop 'thin wrapper', refresh feature list ([#110](https://github.com/tjbaker/footlight/issues/110)) ([9b54387](https://github.com/tjbaker/footlight/commit/9b54387bc6d11181bf0c37993c1ad24a7e1c43f0))

## [0.4.0](https://github.com/tjbaker/footlight/compare/footlight-v0.3.0...footlight-v0.4.0) (2026-06-07)

**The captions release.** Burn a styled hook + title into each clip, using your own fonts. Plus a public landing page at [footlight.dev](https://footlight.dev), a sturdier render-output folder, and a tidied-up About. Captions are **off by default** — a clean export stays the default.

### Burned-in captions (opt-in)

* **Hook + title burned over the clip**, rendered with [libass](https://github.com/libass/libass) (ASS subtitles) for crisp, styled text. Turn it on per render with the burn-captions toggle / `--burn-captions`. ([#49](https://github.com/tjbaker/footlight/pull/49), [#65](https://github.com/tjbaker/footlight/pull/65))
* **Per-clip styling, edited in situ** next to the caption text with a live preview: font, fill & outline colour, **bold / italic / underline**, drop shadow, opaque box, rotation, and 9-zone placement. ([#90](https://github.com/tjbaker/footlight/pull/90), styling [#83](https://github.com/tjbaker/footlight/pull/83) / [#89](https://github.com/tjbaker/footlight/pull/89))
* **Each clip carries its own caption style**, so one render can mix differently-styled captions. CSV manifests carry the text + position; JSON manifests carry the full per-clip `caption` object. ([#90](https://github.com/tjbaker/footlight/pull/90))
* **CLI:** `--burn-captions` plus `--caption-font / -color / -outline-color / -bold / -italic / -underline / -shadow / -box / -box-color / -angle` as render-wide defaults that a per-clip style overrides. A preflight check fails loudly when your ffmpeg lacks libass. ([#60](https://github.com/tjbaker/footlight/pull/60), [#64](https://github.com/tjbaker/footlight/pull/64))

### Custom fonts

* **System font picker** with a live preview, so you can match a clip's look without typing a font name. ([#61](https://github.com/tjbaker/footlight/issues/61), [#73](https://github.com/tjbaker/footlight/pull/73))
* **"Your fonts" folder** — point Settings at a folder of `.ttf`/`.otf` files and they show up in the picker, grouped above the system fonts. No bundled fonts and no font CDN (keeps the no-telemetry promise). ([#74](https://github.com/tjbaker/footlight/issues/74), [#78](https://github.com/tjbaker/footlight/pull/78))

### Other features

* **Bring-your-own key from the environment** — set `GEMINI_API_KEY` (or a local `.env`) instead of pasting into Settings. ([#69](https://github.com/tjbaker/footlight/pull/69))
* **Sturdier render output folder** — Footlight verifies the destination is writable *before* rendering (a clear message instead of a raw error mid-run), and a fresh install defaults to `~/Movies/footlight`. ([#94](https://github.com/tjbaker/footlight/pull/94))
* **[footlight.dev](https://footlight.dev) landing page**, deployed via GitHub Pages. ([#48](https://github.com/tjbaker/footlight/pull/48), [#66](https://github.com/tjbaker/footlight/pull/66))

### Bug Fixes

* No more OS-keychain prompt at every launch — the BYOK key is now read lazily, only when an AI feature actually needs it. ([#67](https://github.com/tjbaker/footlight/pull/67))
* Captions fail loudly with an actionable message when ffmpeg has no libass, instead of a cryptic per-clip error. ([#60](https://github.com/tjbaker/footlight/pull/60))
* Dropped a ReDoS-prone path regex flagged by CodeQL. ([#65](https://github.com/tjbaker/footlight/pull/65))

### Refactors

* **One About surface** — the macOS app menu and the in-app Help menu both open **Settings → About** now; the duplicate About modal is gone. ([#96](https://github.com/tjbaker/footlight/pull/96))

### Documentation

* Froze `SPEC.md` as design rationale; the living roadmap moved to GitHub issues.
* Documented captions end to end — burn-in, bring-your-own fonts + the fonts folder, styling, and the manifest fields. ([#51](https://github.com/tjbaker/footlight/pull/51), [#75](https://github.com/tjbaker/footlight/pull/75), [#86](https://github.com/tjbaker/footlight/pull/86))

### Build System / CI

* Stabilised a flaky real-render test with a per-test timeout. ([#84](https://github.com/tjbaker/footlight/pull/84))
* Bumped the GitHub Pages actions off the deprecated Node version. ([#72](https://github.com/tjbaker/footlight/pull/72))

## [0.3.0](https://github.com/tjbaker/footlight/compare/footlight-v0.2.0...footlight-v0.3.0) (2026-06-05)


### Features

* **app:** AI assistant dock UI ([#34](https://github.com/tjbaker/footlight/issues/34)) ([ab7e3b2](https://github.com/tjbaker/footlight/commit/ab7e3b294ea28864d4141c81eb132cd41c89ef17))
* **app:** canvas ghost previews for pending assistant proposals ([#37](https://github.com/tjbaker/footlight/issues/37)) ([91f800d](https://github.com/tjbaker/footlight/commit/91f800d3331141c544490c9dd7db0fad0ebb067d))
* **app:** OS-keychain secretStore platform seam + apiKey migration helper ([#26](https://github.com/tjbaker/footlight/issues/26)) ([683b36b](https://github.com/tjbaker/footlight/commit/683b36b5e382f4d13fd839300a0dfd12aacde4a1))
* **app:** Settings — 5-panel modal (General/Rendering/AI/Shortcuts/About) ([#35](https://github.com/tjbaker/footlight/issues/35)) ([ea2e6c5](https://github.com/tjbaker/footlight/commit/ea2e6c5bd173cdade8e47425162cbe94cf058ded))
* **app:** store the BYOK key in the OS keychain (wire secretStore) ([#31](https://github.com/tjbaker/footlight/issues/31)) ([bbbc3e2](https://github.com/tjbaker/footlight/commit/bbbc3e2553fbe2fae6b102e0473d1c6b23fe6587)), closes [#2](https://github.com/tjbaker/footlight/issues/2)
* **app:** thread render flags to the CLI; apply System theme at boot ([#36](https://github.com/tjbaker/footlight/issues/36)) ([d7f5ad4](https://github.com/tjbaker/footlight/commit/d7f5ad4780d9e19223b5b48fb7a6eaf89bb926a3))
* **assistant:** GeminiAssistant model adapter (function-calling) ([#25](https://github.com/tjbaker/footlight/issues/25)) ([003fbc5](https://github.com/tjbaker/footlight/commit/003fbc53c9278f90a72e41a57da9bf16d8f18a8a))
* **assistant:** platform seam + real VisionRunner ([#32](https://github.com/tjbaker/footlight/issues/32)) ([f6873db](https://github.com/tjbaker/footlight/commit/f6873dbfefca1434e76a72ccd8822b373bec07ef))
* **assistant:** single-turn orchestrator + offline mock assistant ([#11](https://github.com/tjbaker/footlight/issues/11)) ([2af4838](https://github.com/tjbaker/footlight/commit/2af4838a35685bed9a1ee531d4acfd258bf6dcc9))
* **assistant:** tool registry, contract types, and model resolver ([#10](https://github.com/tjbaker/footlight/issues/10)) ([e87bf0d](https://github.com/tjbaker/footlight/commit/e87bf0d94f785ebada3268bc1bb1b05719a7f965))
* **make:** add `make setup-system` + OS-aware install hints in doctor ([#29](https://github.com/tjbaker/footlight/issues/29)) ([4e140aa](https://github.com/tjbaker/footlight/commit/4e140aae9bba71718496079705fd4ac990da5a20))
* **ui:** audit style.css tokens and add the .fl-card rule (redesign A3) ([#21](https://github.com/tjbaker/footlight/issues/21)) ([c914ca9](https://github.com/tjbaker/footlight/commit/c914ca9d0dfbbb02f05d8b40e64c492d4c79bf87))
* **ui:** port assistant + ghost styles into style.css ([#30](https://github.com/tjbaker/footlight/issues/30)) ([192da39](https://github.com/tjbaker/footlight/commit/192da391202ea01876ac761fcff9630fabb21836))
* **ui:** rename "Track AI" tab to "Track subject" and use "queue" copy ([#9](https://github.com/tjbaker/footlight/issues/9)) ([1eabea8](https://github.com/tjbaker/footlight/commit/1eabea84fd9d24f72d70b034e2ab5abc1678a0a2))
* wire base.md into the system prompt + append-only framing-preferences overlay ([#39](https://github.com/tjbaker/footlight/issues/39)) ([2a81d56](https://github.com/tjbaker/footlight/commit/2a81d568b318b5520bfb2a3682dcc7887eafce25))


### Bug Fixes

* **app:** AI key Test button + honest "reads stills" copy ([#38](https://github.com/tjbaker/footlight/issues/38)) ([b029b7a](https://github.com/tjbaker/footlight/commit/b029b7a65f43589eb9530d6079d7b48121e9cd57))


### Refactors

* rename studio.ts to manifest.ts (drop the "studio" codename) ([#33](https://github.com/tjbaker/footlight/issues/33)) ([589ee40](https://github.com/tjbaker/footlight/commit/589ee40f4926894bd420244b3b4b5f8f847f67ca))


### Documentation

* add an annotated editor screenshot to the README ([#27](https://github.com/tjbaker/footlight/issues/27)) ([173c0a1](https://github.com/tjbaker/footlight/commit/173c0a1004863704ca8aa6f1237f73e62d370578))


### Build System

* require Node 26 (raise engines floor + CI + types + docs) ([#28](https://github.com/tjbaker/footlight/issues/28)) ([152924e](https://github.com/tjbaker/footlight/commit/152924e3eb130d83ed51fb9315394fa3cf25eb14))

## [0.2.0](https://github.com/tjbaker/footlight/compare/footlight-v0.1.0...footlight-v0.2.0) (2026-06-05)


### Features

* initial release of Footlight render engine, CLI, and Tauri GUI ([8f67a5a](https://github.com/tjbaker/footlight/commit/8f67a5a773c4fbea5d7be12bd9dda4237578fe3a))


### Bug Fixes

* escape error and framing text in innerHTML sinks (XSS hardening) ([50e8173](https://github.com/tjbaker/footlight/commit/50e8173824c36d73575d95aed0012a7ff121f7aa))
* read the About-dialog version from the root package.json ([2846409](https://github.com/tjbaker/footlight/commit/284640959152f4947936d0e4497b691db34a4ada))
* read the About-dialog version from the root package.json ([f0e81d7](https://github.com/tjbaker/footlight/commit/f0e81d73009e24afda3698c0ab1a5c72a04dfbf1))
* unblock CI — add @types/node and clear CodeQL findings ([51b44e1](https://github.com/tjbaker/footlight/commit/51b44e10e2b0976af6cbdf3be30f264d59e2c628))


### Documentation

* add quickstart and branding to README, plus a bug-report template ([2199d1c](https://github.com/tjbaker/footlight/commit/2199d1c2631661b8e01066b1355f6082e20dad2a))
