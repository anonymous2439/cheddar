#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

mkdir -p dist
# --alias:three forces the "three" this module imports directly *and* the
# separate "three" the reused games/glsims/client/src/character.js imports
# (its own bare specifier, resolved from *its* location — a different
# node_modules/three copy of the same version) to bundle as one single
# instance. Without this, esbuild has no way to know the two are "the
# same" and bundles both, which THREE.js itself warns about at runtime
# ("Multiple instances of Three.js being imported") — confirmed via a
# headless repro to cause real intermittent rendering corruption (colors
# bleeding between meshes at certain camera angles), not just a harmless
# console warning.
npx esbuild src/game.js --bundle --format=iife --outfile=dist/game.js --alias:three="$(pwd)/node_modules/three"
echo "built dist/game.js"
