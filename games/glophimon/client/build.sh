#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

mkdir -p dist
# --alias:three IS load-bearing now — game.js pulls the chat-bubble sprite
# helpers straight from glsims/client/src/character.js (a sibling package's
# own file, which imports "three" independently), so without this the
# bundle would otherwise end up with two separate THREE module instances
# (this package's and glsims's own node_modules/three) — see
# games/glsimsworld/client/build.sh's own comment for the exact bug that
# causes (instanceof checks silently failing across the two).
npx esbuild src/game.js --bundle --format=iife --outfile=dist/game.js --alias:three="$(pwd)/node_modules/three"
echo "built dist/game.js"
