#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Pulls built output from the game projects under ../games into this
# extension's package. Each game still has its own package.json/build step
# and is developed as its own concern — this script is just the seam where
# its build output crosses into the extension. Add one line per game to
# vendor another one.
#
#   key            source dist dir (relative to this file's directory)
GAMES=(
    "hello_world:../games/hello-world/dist"
    "karirs:../games/karirs/client/dist"
)

DEST_ROOT="media/games"
rm -rf "$DEST_ROOT"
mkdir -p "$DEST_ROOT"

for entry in "${GAMES[@]}"; do
    key="${entry%%:*}"
    src="${entry#*:}"

    if [ ! -f "$src/game.js" ]; then
        echo "warning: no built game.js for '$key' at $src — did you run its build? skipping." >&2
        continue
    fi

    mkdir -p "$DEST_ROOT/$key"
    cp "$src/game.js" "$DEST_ROOT/$key/game.js"
    echo "vendored $key <- $src/game.js"
done
