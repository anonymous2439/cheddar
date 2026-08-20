#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# This game is a single plain-JS file, so "build" is just a copy. A real game
# would run its actual bundler (esbuild/webpack/whatever) here instead and
# still produce dist/game.js as the output every platform vendors from.
mkdir -p dist
cp src/game.js dist/game.js
echo "built dist/game.js"
