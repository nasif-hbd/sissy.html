#!/usr/bin/env bash
# Build Lexio.exe for Windows.
#
# Cross-compiles from Linux or macOS with mingw-w64, or compiles natively on
# Windows with the same compiler under MSYS2. There is no toolchain to install
# beyond that and nothing is downloaded at build time.
#
#   Ubuntu/Debian   sudo apt install mingw-w64
#   macOS           brew install mingw-w64
#   Windows         pacman -S mingw-w64-x86_64-gcc      (in MSYS2)
#
#   ./build.sh                 → Lexio.exe beside this script
set -euo pipefail
cd "$(dirname "$0")"

CC=${CC:-x86_64-w64-mingw32-gcc}
command -v "$CC" >/dev/null || { echo "No $CC on PATH — install mingw-w64."; exit 1; }

# -mwindows suppresses the console window; the app's only UI is the browser.
"$CC" -O2 -s -o Lexio.exe lexio.c -lws2_32 -lshell32 -mwindows
echo "built $(ls -lh Lexio.exe | awk '{print $5}')  →  $(pwd)/Lexio.exe"
