#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Plain JS, no bundler needed yet — same as hello-world's build. A real
# bundler slots in here later if this module grows dependencies.
mkdir -p dist
cp src/game.js dist/game.js
echo "built dist/game.js"
