#!/usr/bin/env bash
# Footlight: install the system tools Footlight shells out to — macOS / Homebrew.
#
# Footlight does NOT bundle ffmpeg: this installs it through YOUR package manager
# (Homebrew), and Footlight still invokes whatever is on PATH. ffmpeg's LGPL/GPL
# terms apply to your own install, not to Footlight.
#
# Automated install is intentionally macOS-only — Linux/Windows package managers
# vary too much to drive safely. On those platforms run `make doctor`; it prints
# the exact install command for each missing tool. Node 26+ and the Rust toolchain
# are not installed here (use nodejs.org/nvm and rustup, which manage them better).

set -u

here="$(cd "$(dirname "$0")" && pwd)"

if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
  echo "setup-system: automated install is macOS/Homebrew only."
  echo "On your platform, run 'make doctor' — it prints the install command for each missing tool."
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "setup-system: Homebrew not found."
  echo "Install it from https://brew.sh, then re-run 'make setup-system'."
  exit 1
fi

echo "Installing system tools via Homebrew: ffmpeg (required)…"
brew install ffmpeg

echo
echo "Not installed here (manage these yourself):"
echo "  • Node 26+  → https://nodejs.org or a version manager (nvm / fnm)"
echo "  • Rust      → https://rustup.rs   (only for the native desktop build)"
echo
echo "Verifying environment…"
exec bash "$here/doctor.sh"
