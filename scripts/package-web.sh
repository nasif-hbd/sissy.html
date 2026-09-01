#!/usr/bin/env bash
# Package the static site for a web host — Cloudflare Pages, Netlify, GitHub
# Pages, or anything that serves a folder.
#
# What ships is the landing page, the app, and the Windows download the landing
# page links to. What does not ship is the AI proxy (server/ is a Node service
# you host separately, and it is where the keys live), the build scripts, the
# tests, and the source artwork the icons are cut from.
#
#   ./scripts/package-web.sh     → download/vocabx-web.zip
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=$(pwd)/download/vocabx-web.zip
STAGE=$(mktemp -d)/vocabx-web
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

mkdir -p "$STAGE/vocab" "$STAGE/download"

# The site root: the install page, the cache and security headers, and the
# marker that stops GitHub Pages running the whole thing through Jekyll.
cp index.html _headers .nojekyll "$STAGE/"

# The app. Named part by part rather than copied wholesale, so nothing new
# under vocab/ reaches a public host without someone deciding it should.
for part in index.html styles.css sw.js manifest.webmanifest js data fonts icons; do
  cp -r "vocab/$part" "$STAGE/vocab/"
done

# The desktop download, so the button on the landing page works.
cp download/vocabx-windows.zip "$STAGE/download/"

# A missing part is a broken site on someone's domain, and the list above is
# easy to forget to extend.
for part in index.html _headers .nojekyll vocab/js vocab/data vocab/icons \
            vocab/fonts vocab/styles.css vocab/sw.js vocab/manifest.webmanifest \
            download/vocabx-windows.zip; do
  [ -e "$STAGE/$part" ] || { echo "packaging lost $part"; exit 1; }
done

# Nothing with a key in it, ever — the proxy's env file is gitignored, but a
# packager that only excludes by name is one stray copy away from shipping one.
if find "$STAGE" -name '.env' -o -name '*.key' -o -name 'subscriptions.json' \
   -o -name 'feedback.jsonl' | grep -q .; then
  echo "refusing to package: a secret reached the staging directory"; exit 1
fi

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
# Zipped from inside the staging directory, so index.html is at the root of
# the archive. A host's drag-and-drop upload takes the archive's root as the
# site root; a wrapper folder would serve the whole site one level down.
(cd "$STAGE" && zip -qr "$OUT" . -x '.DS_Store')
echo "packaged $(du -h "$OUT" | cut -f1)  $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files  →  $OUT"
