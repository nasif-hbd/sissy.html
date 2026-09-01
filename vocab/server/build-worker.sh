#!/usr/bin/env bash
# Bundle the Worker into one file, for pasting into the Cloudflare dashboard.
#
# `npx wrangler deploy` does not need this — it bundles the imports itself. It
# is for the dashboard's editor, which takes a single file, so the Worker can
# be deployed by someone who has no CLI, no npm and no connected repository.
#
#   ./build-worker.sh            → dist/worker.js
set -euo pipefail
cd "$(dirname "$0")"

# --key <k> bakes a Gemini key into dist/_worker.js, for a deployment with
# nothing left to configure. It is a fallback: GEMINI_API_KEY set on the Pages
# project still wins, so the key can be rotated without rebuilding.
#
# A Worker's source is never served to visitors, so this does not put the key
# in the browser. It does put it in a file — never commit one, and never
# publish the archive built from it.
KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

BUNDLER="npx --yes esbuild"

mkdir -p dist

# Two builds of the same proxy, for the two ways it can be deployed.
#   worker.js   a Worker of its own, on its own address.
#   _worker.js  Pages "advanced mode": the app and the proxy on one origin,
#               deployed by the same folder upload as the site.
$BUNDLER worker.mjs \
  --bundle --format=esm --target=es2022 --platform=neutral \
  --outfile=dist/worker.js --legal-comments=none

$BUNDLER pages-worker.mjs \
  --bundle --format=esm --target=es2022 --platform=neutral \
  --outfile=dist/_worker.js --legal-comments=none

if [ -n "$KEY" ]; then
  # Substituted after bundling, so the slot keeps its comment in the source
  # and only the built file ever carries a key.
  KEY="$KEY" python3 -c "
import os, pathlib, json
key = os.environ['KEY']
p = pathlib.Path('dist/_worker.js')
s = p.read_text(encoding='utf-8')
out = s.replace('var BAKED_KEY = \"\";', 'var BAKED_KEY = ' + json.dumps(key) + ';', 1)
if out == s:
    raise SystemExit('could not find the BAKED_KEY slot in the bundle')
p.write_text(out, encoding='utf-8')
"
  echo "  baked a Gemini key into dist/_worker.js — do not commit or publish it"
fi

# A Worker that references a Node builtin fails at deploy, not at review time,
# and the shared modules are edited with the Node proxy in mind.
for built in dist/worker.js dist/_worker.js; do
  if grep -qE 'from *"node:|require\("node:' "$built"; then
    echo "refusing to ship: $built pulls in a Node builtin"; exit 1
  fi
  printf 'bundled %6s  →  %s\n' "$(du -h "$built" | cut -f1)" "$(pwd)/$built"
done
