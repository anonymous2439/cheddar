#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BUILDS_DIR="/var/www/html/cheddar-builds"
VERSION=$(node -p "require('./package.json').version")
VSIX_NAME="cheddar-${VERSION}.vsix"

echo "vendoring game modules..."
./vendor-games.sh

echo "building v${VERSION}..."
rm -f "$VSIX_NAME"
npm run vsix

if [ ! -f "$VSIX_NAME" ]; then
    echo "expected $VSIX_NAME but it wasn't produced — aborting" >&2
    exit 1
fi

echo "deploying ${VSIX_NAME} to ${BUILDS_DIR}/ ..."
echo "2439" | sudo -S cp "$VSIX_NAME" "${BUILDS_DIR}/${VSIX_NAME}"
echo "2439" | sudo -S chown root:root "${BUILDS_DIR}/${VSIX_NAME}"
echo "2439" | sudo -S chmod 644 "${BUILDS_DIR}/${VSIX_NAME}"

MANIFEST=$(printf '{"version":"%s","file":"%s"}' "$VERSION" "$VSIX_NAME")
echo "2439" | sudo -S bash -c "echo '$MANIFEST' > '${BUILDS_DIR}/latest.json'"
echo "2439" | sudo -S chown root:root "${BUILDS_DIR}/latest.json"
echo "2439" | sudo -S chmod 644 "${BUILDS_DIR}/latest.json"

echo "deployed v${VERSION} — clients will see it next time they run /update"
