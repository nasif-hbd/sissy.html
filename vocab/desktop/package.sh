#!/usr/bin/env bash
# Package the desktop downloads: one per system, each a launcher plus the whole
# app beside it.
#
# The launcher serves ./app over 127.0.0.1, so what ships is exactly what the
# web build ships — rebuild the data first (scripts/build-modules.mjs) and
# re-run this, or the downloads go out with last release's word packs.
#
#   ./package.sh                 → all three, into ../../download/
#   ./package.sh windows|mac|linux
set -euo pipefail
cd "$(dirname "$0")"

want=${1:-all}
OUTDIR=$(cd ../.. && pwd)/download
mkdir -p "$OUTDIR"

# The parts of the app that ship. Named one by one rather than copied
# wholesale, so nothing new under vocab/ reaches a download without someone
# deciding it should.
PARTS=(index.html styles.css sw.js manifest.webmanifest js data fonts icons)

copy_app() {           # copy_app <destination>
  mkdir -p "$1"
  for part in "${PARTS[@]}"; do cp -r "../$part" "$1/"; done
  # A missing part is a broken app on someone's desktop, and the list above is
  # easy to forget to extend — icons/ was added to the web build and not here.
  for part in "${PARTS[@]}"; do
    [ -e "$1/$part" ] || { echo "packaging lost $part"; exit 1; }
  done
}

# Nothing with a key in it, ever — the proxy's env file is gitignored, but a
# packager that only excludes by name is one stray copy away from shipping one.
check_clean() {        # check_clean <staged root>
  if find "$1" -name '.env' -o -name '*.key' -o -name 'subscriptions.json' \
     -o -name 'feedback.jsonl' | grep -q .; then
    echo "refusing to package: a secret reached the staging directory"; exit 1
  fi
}

report() {             # report <zip>
  echo "packaged $(du -h "$1" | cut -f1)  $(unzip -l "$1" | tail -1 | awk '{print $2}') files  →  $1"
}

# ── Windows ───────────────────────────────────────────────────────────────
if [ "$want" = all ] || [ "$want" = windows ]; then
  [ -f VocabX.exe ] || { echo "No VocabX.exe — run ./build.sh first."; exit 1; }
  STAGE=$(mktemp -d)/vocabx-windows
  mkdir -p "$STAGE"
  cp VocabX.exe "$STAGE/"
  cp README.txt "$STAGE/"
  copy_app "$STAGE/app"
  check_clean "$STAGE"
  OUT="$OUTDIR/vocabx-windows.zip"; rm -f "$OUT"
  (cd "$(dirname "$STAGE")" && zip -qr "$OUT" vocabx-windows)
  rm -rf "$(dirname "$STAGE")"
  report "$OUT"
fi

# ── Linux ─────────────────────────────────────────────────────────────────
if [ "$want" = all ] || [ "$want" = linux ]; then
  [ -f VocabX ] || { echo "No VocabX binary — run ./build.sh first."; exit 1; }
  STAGE=$(mktemp -d)/vocabx-linux
  mkdir -p "$STAGE"
  cp VocabX "$STAGE/"
  chmod +x "$STAGE/VocabX"
  cp README-linux.txt "$STAGE/README.txt"
  cp install-menu.sh uninstall-menu.sh "$STAGE/"
  cp icon/icon-256.png "$STAGE/icon.png"
  copy_app "$STAGE/app"
  check_clean "$STAGE"
  OUT="$OUTDIR/vocabx-linux.zip"; rm -f "$OUT"
  (cd "$(dirname "$STAGE")" && zip -qr "$OUT" vocabx-linux)
  rm -rf "$(dirname "$STAGE")"
  report "$OUT"
fi

# ── macOS ─────────────────────────────────────────────────────────────────
# A real .app bundle, so it double-clicks and carries its own icon. The
# executable inside it is a two-line script that hands off to the Perl
# launcher, because a Mach-O binary cannot be linked anywhere but on a Mac.
if [ "$want" = all ] || [ "$want" = mac ]; then
  [ -f VocabX.icns ] || python3 build-icns.py icon VocabX.icns
  STAGE=$(mktemp -d)/vocabx-mac
  APP="$STAGE/VocabX.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

  VERSION=$(grep -o "build: *'v[0-9]*'" ../js/config.js | grep -o '[0-9]*')
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>VocabX</string>
  <key>CFBundleDisplayName</key><string>VocabX</string>
  <key>CFBundleIdentifier</key><string>online.ylarena.vocabx</string>
  <key>CFBundleExecutable</key><string>VocabX</string>
  <key>CFBundleIconFile</key><string>VocabX</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${VERSION:-1}</string>
  <key>CFBundleShortVersionString</key><string>1.${VERSION:-0}</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
  printf 'APPL????' > "$APP/Contents/PkgInfo"

  cat > "$APP/Contents/MacOS/VocabX" <<'LAUNCH'
#!/bin/bash
# The bundle's executable. Everything it does is in vocabx.pl beside it —
# this only works out where "beside it" is, which a script can do and a
# plist cannot.
here="$(cd "$(dirname "$0")/../Resources" && pwd)"
exec /usr/bin/perl "$here/vocabx.pl" "$here/app"
LAUNCH
  chmod +x "$APP/Contents/MacOS/VocabX"

  cp vocabx.pl "$APP/Contents/Resources/"
  cp VocabX.icns "$APP/Contents/Resources/"
  copy_app "$APP/Contents/Resources/app"
  cp README-mac.txt "$STAGE/README.txt"
  check_clean "$STAGE"

  OUT="$OUTDIR/vocabx-mac.zip"; rm -f "$OUT"
  # -y keeps symlinks as symlinks; the bundle has none today, but a zip that
  # silently flattens one is a bundle that will not launch.
  (cd "$(dirname "$STAGE")" && zip -qry "$OUT" vocabx-mac)
  rm -rf "$(dirname "$STAGE")"
  report "$OUT"
fi
