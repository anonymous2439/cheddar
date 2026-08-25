#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Plain JS, no bundler needed — the server (games/chess's home, the main
# Cheddar API) is the sole authority on legal moves, so this client never
# needs its own chess logic/library. Same as karirs's build.
mkdir -p dist
cp src/game.js dist/game.js
echo "built dist/game.js"
