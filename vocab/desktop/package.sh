#!/usr/bin/env bash
# Package the Windows download: the launcher plus the whole app beside it.
#
# The exe serves ./app over 127.0.0.1, so what ships is exactly what the web
# build ships — rebuild the data first (scripts/build-modules.mjs) and re-run
# this, or the download goes out with last release's word packs.
#
#   ./package.sh                 → ../../download/vocabx-windows.zip
set -euo pipefail
cd "$(dirname "$0")"

[ -f VocabX.exe ] || { echo "No VocabX.exe — run ./build.sh first."; exit 1; }

OUT=$(cd ../.. && pwd)/download/vocabx-windows.zip
STAGE=$(mktemp -d)/vocabx-windows
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

mkdir -p "$STAGE/app"
cp VocabX.exe README.txt "$STAGE/"
for part in index.html styles.css sw.js manifest.webmanifest js data fonts; do
  cp -r "../$part" "$STAGE/app/"
done

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$(dirname "$STAGE")" && zip -qr "$OUT" vocabx-windows)
echo "packaged $(du -h "$OUT" | cut -f1)  $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files  →  $OUT"
