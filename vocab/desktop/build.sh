#!/usr/bin/env bash
# Build the VocabX desktop launchers.
#
# One C file, two binaries. macOS is not built here — a Mach-O binary has to
# be linked on a Mac — so the Mac download ships the Perl launcher instead,
# which needs no build at all and uses the perl every Mac already has.
#
#   Ubuntu/Debian   sudo apt install build-essential mingw-w64
#   macOS           brew install mingw-w64          (for the Windows one)
#   Windows         pacman -S mingw-w64-x86_64-gcc  (in MSYS2)
#
#   ./build.sh              → VocabX.exe and VocabX beside this script
#   ./build.sh windows      → just the Windows one
#   ./build.sh linux        → just the Linux one
set -euo pipefail
cd "$(dirname "$0")"

want=${1:-both}
built=0

if [ "$want" = both ] || [ "$want" = windows ]; then
  CC_WIN=${CC_WIN:-x86_64-w64-mingw32-gcc}
  if command -v "$CC_WIN" >/dev/null; then
    # -mwindows suppresses the console window; the app's only UI is the browser.
    "$CC_WIN" -O2 -Wall -s -o VocabX.exe vocabx.c -lws2_32 -lshell32 -mwindows
    echo "built VocabX.exe  $(du -h VocabX.exe | cut -f1)"
    built=1
  else
    echo "skipped VocabX.exe — no $CC_WIN on PATH (install mingw-w64)"
  fi
fi

if [ "$want" = both ] || [ "$want" = linux ]; then
  CC_NIX=${CC:-cc}
  if command -v "$CC_NIX" >/dev/null; then
    "$CC_NIX" -O2 -Wall -o VocabX vocabx.c -lpthread
    strip VocabX 2>/dev/null || true
    echo "built VocabX      $(du -h VocabX | cut -f1)"
    built=1
  else
    echo "skipped VocabX — no C compiler on PATH"
  fi
fi

# The Mac launcher is a script, so there is nothing to compile — but it is
# still worth refusing to ship one that does not parse.
if command -v perl >/dev/null; then
  perl -c vocabx.pl >/dev/null 2>&1 || { echo "vocabx.pl does not parse"; exit 1; }
  echo "checked vocabx.pl (the macOS launcher)"
fi

[ "$built" = 1 ] || { echo "nothing was built"; exit 1; }
