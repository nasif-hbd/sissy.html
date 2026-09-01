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

# A Worker that references a Node builtin fails at deploy, not at review time,
# and the shared modules are edited with the Node proxy in mind.
for built in dist/worker.js dist/_worker.js; do
  if grep -qE 'from *"node:|require\("node:' "$built"; then
    echo "refusing to ship: $built pulls in a Node builtin"; exit 1
  fi
  printf 'bundled %6s  →  %s\n' "$(du -h "$built" | cut -f1)" "$(pwd)/$built"
done
