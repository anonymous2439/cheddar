#!/usr/bin/env bash
set -euo pipefail

echo "2439" | sudo -S cp /home/rev/projects/cheddar/windows/.cheddar.ps1 /var/www/html/cheddar-cli/.cheddar.ps1
echo "2439" | sudo -S chown root:root /var/www/html/cheddar-cli/.cheddar.ps1
echo "2439" | sudo -S chmod 644 /var/www/html/cheddar-cli/.cheddar.ps1

echo "deployed .cheddar.ps1 to /var/www/html/cheddar-cli/"
