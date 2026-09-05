#!/usr/bin/env bash
# Put VocabX in this desktop's application menu.
#
# One .desktop file in ~/.local/share/applications, pointing at wherever you
# unzipped this folder. No root, no package manager, nothing outside your own
# home directory — and ./uninstall-menu.sh takes it back out.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
apps="$HOME/.local/share/applications"
file="$apps/vocabx.desktop"

[ -x "$here/VocabX" ] || { echo "No VocabX binary beside this script."; exit 1; }

mkdir -p "$apps"
cat > "$file" <<DESKTOP
[Desktop Entry]
Type=Application
Name=VocabX
GenericName=English Vocabulary Trainer
Comment=117,000 words, 14 study packs, and everything works offline
Exec=$here/VocabX
Icon=$here/icon.png
Terminal=false
Categories=Education;Languages;
Keywords=vocabulary;english;ielts;flashcards;spelling;
StartupNotify=true
DESKTOP

command -v update-desktop-database >/dev/null && update-desktop-database "$apps" 2>/dev/null || true
echo "VocabX is in your application menu."
echo "  entry  $file"
echo "  points at $here/VocabX"
echo "Move this folder and the entry stops working — re-run this script if you do."
