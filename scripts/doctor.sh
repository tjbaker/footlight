#!/usr/bin/env bash
# Footlight preflight: verify the external tools Footlight shells out to.
#
#   Required : node 26+, ffmpeg, ffprobe
#   Optional : yt-dlp (source downloads), cargo (native desktop build)
#
# Footlight does NOT bundle these — it invokes whatever is on your PATH. For each
# missing tool it prints the install command for your platform (Homebrew / apt /
# dnf / pacman / zypper / winget). Exits non-zero if a REQUIRED tool is missing
# or too old. Run with `make doctor`; on macOS, `make setup-system` installs them.

set -u
fail=0

hr() { printf '%s\n' "------------------------------------------------------------"; }
found() { command -v "$1" >/dev/null 2>&1; }

# Detect the platform package manager, for OS-aware install hints.
detect_pm() {
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then echo brew
  elif found apt-get; then echo apt
  elif found dnf;     then echo dnf
  elif found pacman;  then echo pacman
  elif found zypper;  then echo zypper
  elif found winget;  then echo winget
  else echo none
  fi
}
PM=$(detect_pm)

# Install command for a given tool on the detected platform.
hint() {
  case "$1" in
    ffmpeg | ffprobe)
      case "$PM" in
        brew)   echo "brew install ffmpeg" ;;
        apt)    echo "sudo apt install ffmpeg" ;;
        dnf)    echo "sudo dnf install ffmpeg" ;;
        pacman) echo "sudo pacman -S ffmpeg" ;;
        zypper) echo "sudo zypper install ffmpeg" ;;
        winget) echo "winget install Gyan.FFmpeg" ;;
        *)      echo "https://ffmpeg.org/download.html" ;;
      esac ;;
    node)
      if [ "$PM" = brew ]; then echo "brew install node  (or nvm/fnm for v26+)"
      else echo "https://nodejs.org (v26+), or a version manager (nvm/fnm)"; fi ;;
    yt-dlp)
      case "$PM" in
        brew)   echo "brew install yt-dlp" ;;
        apt)    echo "sudo apt install yt-dlp  (or: pipx install yt-dlp)" ;;
        dnf)    echo "sudo dnf install yt-dlp" ;;
        pacman) echo "sudo pacman -S yt-dlp" ;;
        zypper) echo "sudo zypper install yt-dlp" ;;
        winget) echo "winget install yt-dlp.yt-dlp" ;;
        *)      echo "pipx install yt-dlp — https://github.com/yt-dlp/yt-dlp" ;;
      esac ;;
    cargo) echo "https://rustup.rs" ;;
  esac
}

req() { # name  trailing-note
  if found "$1"; then
    printf '  ok        %-8s  %s\n' "$1" "$(command -v "$1")"
  else
    printf '  MISSING   %-8s  %s%s\n' "$1" "$(hint "$1")" "$2"
    fail=1
  fi
}

opt() { # name  what-for
  if found "$1"; then
    printf '  ok        %-8s  %s\n' "$1" "$(command -v "$1")"
  else
    printf '  -         %-8s  optional (%s) — %s\n' "$1" "$2" "$(hint "$1")"
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
    printf '  TOO OLD   %-8s  v%s (need 26+) — %s\n' "node" "$v" "$(hint node)"
    fail=1
  fi
else
  printf '  MISSING   %-8s  Node 26+ — %s\n' "node" "$(hint node)"
  fail=1
fi

req ffmpeg  "  (does all cut/crop/scale/encode)"
req ffprobe "  (ships with ffmpeg)"

# ffmpeg capability: burned captions (SPEC §6.5) use the `drawtext` filter, which
# exists only when ffmpeg is built with libfreetype. Not fatal — captions are opt-in.
if found ffmpeg; then
  if ffmpeg -hide_banner -filters 2>/dev/null | grep -qE '[[:space:]]drawtext[[:space:]]'; then
    printf '  ok        %-8s  %s\n' "drawtext" "captions supported (ffmpeg has libfreetype)"
  else
    printf '  -         %-8s  burned captions unavailable — ffmpeg lacks drawtext (needs libfreetype)\n' "drawtext"
    [ "$PM" = brew ] && printf '            %-8s  fix: brew install homebrew-ffmpeg/ffmpeg/ffmpeg\n' ""
  fi
fi

echo "Optional:"
opt yt-dlp "source downloads"
opt cargo  "native desktop build"

hr
if [ "$fail" -ne 0 ]; then
  echo "Result: required tools missing above. Install them, then re-run \`make doctor\`."
  [ "$PM" = brew ] && echo "        On macOS: \`make setup-system\` installs ffmpeg + yt-dlp via Homebrew."
  exit 1
fi
echo "Result: all required tools present."
echo "Next:   make gui        # browser GUI (no Rust needed)"
echo "        make tauri-dev  # native window (needs cargo)"
