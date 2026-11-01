// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Font enumeration for the caption font picker: installed system families
//! (font-kit) and the font files in a user-chosen fonts folder.

use serde::Serialize;

/// One installed font family for the caption picker. Family-only is enough —
/// CoreText / fontconfig resolve a `Fontname` by name at render time — so `path`
/// is always `None` here (the web/dev backend fills it from fontconfig).
#[derive(Serialize)]
pub(crate) struct FontInfoDto {
    family: String,
    path: Option<String>,
}

/// Enumerate system font families via font-kit (CoreText on macOS, DirectWrite
/// on Windows, fontconfig on Linux), deduped and sorted case-insensitively.
/// Best-effort: any enumeration error yields an empty list so the picker falls
/// back to the free-text font field rather than failing.
#[tauri::command]
pub(crate) async fn list_fonts() -> Result<Vec<FontInfoDto>, String> {
    let mut families = match font_kit::source::SystemSource::new().all_families() {
        Ok(f) => f,
        Err(_) => return Ok(vec![]),
    };
    families.sort_by_key(|f| f.to_lowercase());
    families.dedup();
    Ok(families
        .into_iter()
        .map(|family| FontInfoDto { family, path: None })
        .collect())
}

/// Recursively collect font-file paths (`.ttf`/`.otf`/`.ttc`) under `dir`,
/// bounded by depth/count so a pathological tree can't wedge the walk.
/// Best-effort: unreadable sub-directories are skipped silently.
fn collect_font_files(dir: &std::path::Path, depth: usize, acc: &mut Vec<std::path::PathBuf>) {
    const MAX_DEPTH: usize = 8;
    const MAX_FILES: usize = 5000;
    if depth > MAX_DEPTH || acc.len() >= MAX_FILES {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // unreadable directory — skip.
    };
    for entry in entries.flatten() {
        if acc.len() >= MAX_FILES {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_font_files(&path, depth + 1, acc);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_lowercase().as_str(), "ttf" | "otf" | "ttc"))
            .unwrap_or(false)
        {
            acc.push(path);
        }
    }
}

/// Scan a user fonts folder for `.ttf`/`.otf`/`.ttc`, loading each file with
/// font-kit to read its real family name, returning a deduped (by `family+path`)
/// list sorted case-insensitively by family. Unlike `list_fonts`, `path` is
/// populated here so the caller can reference the exact file. An empty or
/// unreadable directory yields an empty list rather than an error.
#[tauri::command]
pub(crate) async fn list_fonts_in_dir(dir: String) -> Result<Vec<FontInfoDto>, String> {
    if dir.is_empty() {
        return Ok(vec![]);
    }
    let mut files = Vec::new();
    collect_font_files(std::path::Path::new(&dir), 0, &mut files);

    let mut seen = std::collections::HashSet::new();
    let mut fonts: Vec<FontInfoDto> = Vec::new();
    for file in files {
        let family = match font_kit::handle::Handle::from_path(file.clone(), 0).load() {
            Ok(font) => font.family_name(),
            Err(_) => continue, // unreadable/unsupported font file — skip.
        };
        if family.is_empty() {
            continue;
        }
        let path = file.to_string_lossy().to_string();
        if !seen.insert(format!("{family} {path}")) {
            continue;
        }
        fonts.push(FontInfoDto {
            family,
            path: Some(path),
        });
    }
    fonts.sort_by_key(|f| f.family.to_lowercase());
    Ok(fonts)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- fonts ------------------------------------------------------------

    /// collect_font_files keeps only .ttf/.otf/.ttc (case-insensitively),
    /// recursing into subdirectories.
    #[test]
    fn collect_font_files_filters_extensions_recursively() {
        let dir = std::env::temp_dir().join(format!("footlight_fonts_test_{}", std::process::id()));
        let sub = dir.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("a.ttf"), b"x").unwrap();
        std::fs::write(dir.join("b.OTF"), b"x").unwrap(); // extension case-insensitive
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::write(sub.join("c.ttc"), b"x").unwrap();

        let mut found = Vec::new();
        collect_font_files(&dir, 0, &mut found);
        let mut names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.ttf", "b.OTF", "c.ttc"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
