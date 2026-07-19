#!/usr/bin/env bash
set -euo pipefail

if [ ! -f /usr/local/packer/nvidia-grid.run ]; then
  echo "No GRID driver installed. Skipping nvlts."
  exit 0
fi

echo "Installing nvlts..."
curl -sSL "https://git.collinwebdesigns.de/vgpu/nvlts/-/raw/master/scripts/install.sh" | sudo bash # Install
