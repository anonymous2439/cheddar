#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Bundled via esbuild now that this module has a real dependency (three.js,
# for render3d.js) — a plain cp (see git history) only worked while this
# was dependency-free classic JS.
mkdir -p dist
npx esbuild src/game.js --bundle --format=iife --outfile=dist/game.js
echo "built dist/game.js"
