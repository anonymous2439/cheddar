#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

mkdir -p dist
npx esbuild src/game.js --bundle --format=iife --outfile=dist/game.js
echo "built dist/game.js"
