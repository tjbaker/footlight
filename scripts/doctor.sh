#!/usr/bin/env bash
# Footlight preflight: verify the external tools Footlight shells out to.
#
#   Required : node 26+, ffmpeg, ffprobe
#   Optional : yt-dlp (source downloads), cargo (native desktop build)
#
# Footlight does NOT bundle these — it invokes whatever is on your PATH. Exits
# non-zero if a REQUIRED tool is missing or too old. Run with `make doctor`.

set -u
fail=0

hr() { printf '%s\n' "------------------------------------------------------------"; }
found() { command -v "$1" >/dev/null 2>&1; }

req() { # name  install-hint
  if found "$1"; then
    printf '  ok        %-8s  %s\n' "$1" "$(command -v "$1")"
  else
    printf '  MISSING   %-8s  %s\n' "$1" "$2"
    fail=1
  fi
}

opt() { # name  what-for  install-hint
  if found "$1"; then
    printf '  ok        %-8s  %s\n' "$1" "$(command -v "$1")"
  else
    printf '  -         %-8s  optional (%s) — %s\n' "$1" "$2" "$3"
  fi
}

echo "Footlight environment check"
hr
echo "Required:"

if found node; then
  v=$(node -v); v=${v#v}; major=${v%%.*}
  case "$major" in '' | *[!0-9]*) major=0 ;; esac
  if [ "$major" -ge 26 ]; then
    printf '  ok        %-8s  v%s\n' "node" "$v"
  else
    printf '  TOO OLD   %-8s  v%s (need 26+) — https://nodejs.org or `brew install node`\n' "node" "$v"
    fail=1
  fi
else
  printf '  MISSING   %-8s  %s\n' "node" "Node 26+ — https://nodejs.org or \`brew install node\`"
  fail=1
fi

req ffmpeg  "brew install ffmpeg  (does all cut/crop/scale/encode)"
req ffprobe "brew install ffmpeg  (ships with ffmpeg)"

echo "Optional:"
opt yt-dlp "source downloads"       "brew install yt-dlp"
opt cargo  "native desktop build"   "https://rustup.rs"

hr
if [ "$fail" -ne 0 ]; then
  echo "Result: required tools missing above. Install them, then re-run \`make doctor\`."
  exit 1
fi
echo "Result: all required tools present."
echo "Next:   make gui        # browser GUI (no Rust needed)"
echo "        make tauri-dev  # native window (needs cargo)"
