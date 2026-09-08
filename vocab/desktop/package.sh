#!/usr/bin/env bash
# Package the desktop download: one archive, three launchers, one copy of the
# app they all serve.
#
# The launcher serves ./app over 127.0.0.1, so what ships is exactly what the
# web build ships — rebuild the data first (scripts/build-modules.mjs) and
# re-run this, or the downloads go out with last release's word packs.
#
#   ./package.sh                 → ../../download/vocabx-desktop.zip
set -euo pipefail
cd "$(dirname "$0")"

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

# ── one folder, three launchers ───────────────────────────────────────────
# The app is 28MB of dictionary, and it is the same 28MB on every system. Three
# separate archives meant shipping it three times — 32MB of downloads to host,
# for 60KB of difference between them. So one archive holds all three
# launchers and one copy of the app, and each system's button points at it.
STAGE=$(mktemp -d)/vocabx-desktop
mkdir -p "$STAGE"

[ -f VocabX.exe ] || { echo "No VocabX.exe — run ./build.sh first."; exit 1; }
[ -f VocabX ]     || { echo "No VocabX binary — run ./build.sh first."; exit 1; }
[ -f VocabX.icns ] || python3 build-icns.py icon VocabX.icns

cp VocabX.exe VocabX "$STAGE/"
chmod +x "$STAGE/VocabX"
cp README-desktop.txt "$STAGE/README.txt"
cp install-menu.sh uninstall-menu.sh "$STAGE/"
cp icon/icon-256.png "$STAGE/icon.png"
copy_app "$STAGE/app"

# The macOS bundle. Its executable is two lines that hand off to vocabx.pl;
# a Mach-O binary would have to be linked on a Mac, and this needs nothing
# installed and nothing fetched.
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
# The bundle's executable. Everything it does is in vocabx.pl beside it — this
# only works out where the app folder is, which a script can do and a plist
# cannot: inside the bundle if someone put it there, otherwise next to the
# bundle, which is how the download is laid out.
res="$(cd "$(dirname "$0")/../Resources" && pwd)"
outside="$(cd "$(dirname "$0")/../../.." && pwd)/app"
app="$res/app"; [ -f "$app/index.html" ] || app="$outside"
exec /usr/bin/perl "$res/vocabx.pl" "$app"
LAUNCH
chmod +x "$APP/Contents/MacOS/VocabX"
cp vocabx.pl VocabX.icns "$APP/Contents/Resources/"

check_clean "$STAGE"
OUT="$OUTDIR/vocabx-desktop.zip"; rm -f "$OUT"
# -y keeps symlinks as symlinks; the bundle has none today, but a zip that
# silently flattens one is a bundle that will not launch.
(cd "$(dirname "$STAGE")" && zip -qry "$OUT" vocabx-desktop)
rm -rf "$(dirname "$STAGE")"
report "$OUT"
