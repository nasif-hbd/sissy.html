#!/usr/bin/env bash
# Write the file that removes the URL bar.
#
# Android will only hide the browser interface if the site publicly vouches for
# the app. That vouching is one file at
# https://<your-site>/.well-known/assetlinks.json naming the app's package and
# the fingerprint of the key that signed it. Get it wrong and the app still
# runs — with a URL bar across the top, which is the single most common
# complaint about apps built this way.
#
#   ./make-assetlinks.sh                      reads the fingerprint from your keystore
#   ./make-assetlinks.sh AA:BB:CC:...         or takes one you already have
#
# It writes ../.well-known/assetlinks.json, which package-web.sh then ships
# with the site.
set -euo pipefail
cd "$(dirname "$0")"

PACKAGE=$(grep -o "applicationId '[^']*'" app/build.gradle | cut -d"'" -f2)
OUT=../.well-known/assetlinks.json

fingerprint=${1:-}

if [ -z "$fingerprint" ]; then
  [ -f keystore.properties ] || {
    echo "No fingerprint given and no keystore.properties here."
    echo
    echo "Either pass the fingerprint:   ./make-assetlinks.sh AA:BB:CC:..."
    echo "or create the key first:       see README.md, step 4."
    exit 1
  }
  store=$(grep '^storeFile=' keystore.properties | cut -d= -f2-)
  alias=$(grep '^keyAlias=' keystore.properties | cut -d= -f2-)
  pass=$(grep '^storePassword=' keystore.properties | cut -d= -f2-)

  command -v keytool >/dev/null || { echo "keytool is not on PATH — install a JDK."; exit 1; }
  fingerprint=$(keytool -list -v -keystore "$store" -alias "$alias" -storepass "$pass" \
    | grep 'SHA256:' | head -1 | awk '{print $2}')
fi

# A fingerprint is 32 bytes as colon-separated hex. Anything else is a typo,
# and a typo here fails silently — the app installs and shows the URL bar.
if ! printf '%s' "$fingerprint" | grep -Eq '^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$'; then
  echo "That does not look like a SHA-256 fingerprint:"
  echo "  $fingerprint"
  echo "Expected 32 hex pairs separated by colons."
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<JSON
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "$PACKAGE",
    "sha256_cert_fingerprints": ["$(printf '%s' "$fingerprint" | tr 'a-f' 'A-F')"]
  }
}]
JSON

echo "wrote $OUT"
echo "  package     $PACKAGE"
echo "  fingerprint ${fingerprint:0:23}…"
echo
echo "Deploy the site, then check it is live and served as JSON:"
echo "  curl -sI https://vocabx.ylarena.online/.well-known/assetlinks.json"
