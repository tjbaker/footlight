# Bundled web fonts

The Footlight desktop app runs **offline from source**, so its UI fonts are
bundled locally as latin-subset **woff2** — there is no Google Fonts CDN call at
runtime.

## License

All three families are licensed under the **SIL Open Font License (OFL) 1.1**,
which permits bundling and redistribution as long as the license travels with
the fonts. The upstream license text for each family is checked in here:

```
OFL-hanken-grotesk.txt        (Copyright 2021 The Hanken Grotesk Project Authors)
OFL-bricolage-grotesque.txt   (Copyright 2022 The Bricolage Grotesque Project Authors)
OFL-jetbrains-mono.txt        (Copyright 2020 The JetBrains Mono Project Authors)
```

Keep these alongside the `.woff2` in any release build.

## Families and weights

| Family              | Weights            | Role in the UI                  |
| ------------------- | ------------------ | ------------------------------- |
| Hanken Grotesque    | 400, 500, 600, 700 | UI / body text                  |
| Bricolage Grotesque | 700                | brand wordmark / headings       |
| JetBrains Mono      | 400, 500           | technical readouts              |

Expected files in this directory (one per weight, matching `../fonts.css`):

```
hanken-grotesk-400.woff2
hanken-grotesk-500.woff2
hanken-grotesk-600.woff2
hanken-grotesk-700.woff2
bricolage-grotesque-700.woff2
jetbrains-mono-400.woff2
jetbrains-mono-500.woff2
```

## How to populate

The woff2 binaries are **not** checked in by default. To download them:

```bash
bash scripts/fetch-fonts.sh
```

This pulls the latin-subset woff2 from a reliable OFL source (Fontsource via
jsDelivr; the script notes google-webfonts-helper as a fallback) and writes them
here with the exact filenames above.

## Wiring

`app/src/fonts.css` declares one `@font-face` rule per weight (7 total),
referencing these files. The app simply `@import`s `fonts.css`.

Because each `@font-face` uses `font-display: swap`, **the app still works
without the woff2 present** — it falls back to system fonts until the files are
fetched. That fallback is acceptable for local/dev use.
