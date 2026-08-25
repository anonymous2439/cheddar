#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Plain JS, no bundler needed — same as chess's build.
mkdir -p dist
cp src/game.js dist/game.js
echo "built dist/game.js"
