#!/usr/bin/env bash
# Publishes the standalone iframe-embeddable GL Sims page to nginx's plain
# static webroot — no proxy, no pm2 process, just two files (this
# directory's index.html + the client's own compiled game.js, the exact
# same bundle vscode vendors) dropped where nginx already serves static
# files directly, same as names.php and cheddar-builds/.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CLIENT_DIST="../client/dist/game.js"
DEST_DIR="/var/www/html/glsims"

if [ ! -f "$CLIENT_DIST" ]; then
    echo "no built game.js at $CLIENT_DIST — run ../client/build.sh first" >&2
    exit 1
fi

echo "2439" | sudo -S mkdir -p "$DEST_DIR"
echo "2439" | sudo -S cp index.html "$DEST_DIR/index.html"
echo "2439" | sudo -S cp "$CLIENT_DIST" "$DEST_DIR/game.js"
echo "2439" | sudo -S chown -R root:root "$DEST_DIR"
echo "2439" | sudo -S chmod 644 "$DEST_DIR/index.html" "$DEST_DIR/game.js"

echo "deployed to $DEST_DIR — reachable at http://109.123.234.69/glsims/"
