#!/usr/bin/env bash
# Package the static site for a web host — Cloudflare Pages, Netlify, GitHub
# Pages, or anything that serves a folder.
#
# What ships is the landing page, the app, and the desktop download the landing
# page links to. What does not ship is the AI proxy (server/ is a Node service
# you host separately, and it is where the keys live), the build scripts, the
# tests, and the source artwork the icons are cut from.
#
#   ./scripts/package-web.sh     → download/vocabx-web.zip
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=$(pwd)/download/vocabx-web.zip
# The same site with the AI proxy inside it, as one Pages deployment.
OUT_AI=$(pwd)/download/vocabx-pages-with-ai.zip
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

# The desktop downloads, so the buttons on the landing page work. Built here
# if they are not lying around — they are assembled from committed launchers,
# so this needs no compiler and there is no step to forget.
# The desktop download, so the button on the landing page works. Built here if
# it is not lying around — it is assembled from committed launchers, so this
# needs no compiler and there is no step to forget.
[ -f download/vocabx-desktop.zip ] || vocab/desktop/package.sh
cp download/vocabx-desktop.zip "$STAGE/download/"

# A missing part is a broken site on someone's domain, and the list above is
# easy to forget to extend.
for part in index.html _headers .nojekyll vocab/js vocab/data vocab/icons \
            vocab/fonts vocab/styles.css vocab/sw.js vocab/manifest.webmanifest \
            download/vocabx-desktop.zip; do
  [ -e "$STAGE/$part" ] || { echo "packaging lost $part"; exit 1; }
done

# Nothing with a key in it, ever — the proxy's env file is gitignored, but a
# packager that only excludes by name is one stray copy away from shipping one.
if find "$STAGE" -name '.env' -o -name '*.key' -o -name 'subscriptions.json' \
   -o -name 'feedback.jsonl' | grep -q .; then
  echo "refusing to package: a secret reached the staging directory"; exit 1
fi

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT" "$OUT_AI"
# Zipped from inside the staging directory, so index.html is at the root of
# the archive. A host's drag-and-drop upload takes the archive's root as the
# site root; a wrapper folder would serve the whole site one level down.
(cd "$STAGE" && zip -qr "$OUT" . -x '.DS_Store')
echo "packaged $(du -h "$OUT" | cut -f1)  $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files  →  $OUT"

# And again with _worker.js in the root, which is how Pages runs the AI proxy
# itself: one upload, one origin, and no proxy address to configure. Built
# only when the bundle is already there, so this script never needs esbuild.
BUILT=vocab/server/dist/_worker.js
if [ -f "$BUILT" ]; then
  cp "$BUILT" "$STAGE/_worker.js"
  (cd "$STAGE" && zip -qr "$OUT_AI" . -x '.DS_Store')
  echo "packaged $(du -h "$OUT_AI" | cut -f1)  $(unzip -l "$OUT_AI" | tail -1 | awk '{print $2}') files  →  $OUT_AI"
else
  echo "skipped $OUT_AI — run vocab/server/build-worker.sh first"
fi
