#!/usr/bin/env bash
# Take the menu entry back out. The app itself is untouched — delete the
# folder whenever you want; nothing else was written anywhere.
set -euo pipefail
file="$HOME/.local/share/applications/vocabx.desktop"
if [ -f "$file" ]; then
  rm "$file"
  command -v update-desktop-database >/dev/null \
    && update-desktop-database "$(dirname "$file")" 2>/dev/null || true
  echo "removed $file"
else
  echo "no menu entry to remove"
fi
