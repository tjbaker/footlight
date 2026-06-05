#!/usr/bin/env bash
# Copyright 2026 Trevor Baker, all rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Fetch the latin-subset woff2 web fonts that the Footlight "Studio" UI bundles
# locally (the app runs offline; no Google Fonts CDN at runtime). Downloads into
# app/src/fonts/ with filenames that match the @font-face rules in
# app/src/fonts.css. All three families are SIL Open Font License (OFL), which
# permits bundling/redistribution alongside the license — see
# app/src/fonts/README.md.
#
# Source: Fontsource, which publishes per-weight latin-subset woff2 at stable,
# predictable paths on the jsDelivr CDN. If a path 404s (Fontsource occasionally
# revivisions package layouts), the google-webfonts-helper API is a drop-in
# alternative:
#   https://gwfh.mranftl.com/api/fonts/<id>?download=zip&subsets=latin&variants=<w>&formats=woff2
#
# Usage:
#   bash scripts/fetch-fonts.sh

set -euo pipefail

# Resolve the repo root from this script's location so it works from anywhere.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
DEST_DIR="${REPO_ROOT}/app/src/fonts"

mkdir -p "${DEST_DIR}"

# Fontsource jsDelivr base. Each package ships files named:
#   <family-id>-latin-<weight>-normal.woff2
CDN="https://cdn.jsdelivr.net/fontsource/fonts"

# fetch <dest-filename> <fontsource-package> <fontsource-file>
fetch() {
  local dest="$1" pkg="$2" file="$3"
  local url="${CDN}/${pkg}@latest/${file}"
  echo "  ${dest}  <-  ${url}"
  curl -fsSL -o "${DEST_DIR}/${dest}" "${url}"
}

echo "Downloading Footlight UI fonts (latin subset, woff2) into:"
echo "  ${DEST_DIR}"
echo

# Hanken Grotesk — 400, 500, 600, 700 (UI / body)
fetch "hanken-grotesk-400.woff2" "hanken-grotesk" "hanken-grotesk-latin-400-normal.woff2"
fetch "hanken-grotesk-500.woff2" "hanken-grotesk" "hanken-grotesk-latin-500-normal.woff2"
fetch "hanken-grotesk-600.woff2" "hanken-grotesk" "hanken-grotesk-latin-600-normal.woff2"
fetch "hanken-grotesk-700.woff2" "hanken-grotesk" "hanken-grotesk-latin-700-normal.woff2"

# Bricolage Grotesque — 700 (brand wordmark / headings)
fetch "bricolage-grotesque-700.woff2" "bricolage-grotesque" "bricolage-grotesque-latin-700-normal.woff2"

# JetBrains Mono — 400, 500 (technical readouts)
fetch "jetbrains-mono-400.woff2" "jetbrains-mono" "jetbrains-mono-latin-400-normal.woff2"
fetch "jetbrains-mono-500.woff2" "jetbrains-mono" "jetbrains-mono-latin-500-normal.woff2"

echo
count="$(ls -1 "${DEST_DIR}"/*.woff2 2>/dev/null | wc -l | tr -d ' ')"
echo "Done. ${count} woff2 file(s) now in ${DEST_DIR}."
echo "The app @imports app/src/fonts.css, which references these by filename."
