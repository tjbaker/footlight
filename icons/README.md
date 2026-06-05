# Footlight — app icons (use these)

Locked mark: **"row of footlights"** (3 lamps, beams up) on the **Cool stage** tile
(warm lamps, cool navy house). These are the production images — use them instead of
re-deriving from any earlier master.

## Files
| file | size | mark | use |
|---|---|---|---|
| `icon-1024.png` | 1024² | full detail | **master / source** for the Tauri icon generator |
| `128x128@2x.png` | 256² | full detail | desktop |
| `128x128.png` | 128² | full detail | desktop (dock / Finder) |
| `64x64.png` | 64² | full detail | desktop |
| `32x32.png` | 32² | **simplified** | desktop small / tray |
| `16x16.png` | 16² | **simplified** | Finder list / tab |
| `favicon.svg` | scalable | simplified | web / dev / Activity window |
| `favicon.png` | 32² | simplified | favicon PNG fallback |

**Why two versions of the mark:** at ≤32px the full mark's thin beams turn to mush, so the
small PNGs (and `favicon.svg`) use a simplified treatment — chunkier lamps, wider/brighter
beams, stronger glow, slightly lighter tile for contrast. The large sizes keep the full detail.

## How to install (Tauri)
1. Regenerate the platform sets from the new master:
   ```
   cd app/src-tauri
   cargo tauri icon ../../icons/icon-1024.png      # adjust path to wherever you drop this folder
   ```
   This rewrites `icons/*.png`, `icon.icns`, `icon.ico`, and the iOS/Android/Square* sets.
2. **Then overwrite the tiny desktop PNGs with the crisp hand-tuned ones** (the generator only
   downscales the 1024, which re-muddies them):
   ```
   cp ../../icons/32x32.png ./icons/32x32.png
   cp ../../icons/16x16.png ./icons/16x16.png    # if present in your icon set
   ```
3. Favicon (web/dev + Activity window): copy `favicon.svg` + `favicon.png` into `app/public/`
   (already wired in `index.html` / `activity.html`).
4. Native icon only updates on a rebuild (`cargo tauri build` / `cargo tauri dev`); the favicon
   shows on a dev reload.

> Note: `.icns`/`.ico` small frames are still downscaled by the generator. On macOS that's a
> non-issue (Finder/Dock show 128px+). If Windows tiny-tray sharpness ever matters, embed
> `16x16.png`/`32x32.png` into `icon.ico` manually.

## Color reference
Lamp `#ff8a4a` · highlight `#ffd8b4` · glow `#ff9a5a` · tile navy `#1b2c45 → #0a0f1a`.
In-app top-bar mark: `footlight-mark.svg` (flat, `currentColor` = `--accent`).
