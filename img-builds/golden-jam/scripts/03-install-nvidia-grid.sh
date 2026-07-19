#!/usr/bin/env bash
set -euo pipefail

echo "Installing NVIDIA GRID drivers..."
# The packer file provisioner uploads the bundle under its original name.
bundle=$(sudo find /usr/local/packer -maxdepth 1 -name '*.run' | head -1)
if [ -n "$bundle" ]; then
  [ "$bundle" = /usr/local/packer/nvidia-grid.run ] || sudo mv "$bundle" /usr/local/packer/nvidia-grid.run
  sudo apt-get install -y gcc make pkgconf libvulkan1 libglvnd-dev
  sudo mkdir -p /etc/nvidia
  sudo touch /etc/nvidia/gridd.conf # Touch this early to prevent failures in gridd/nvlts
  sudo chmod +x /usr/local/packer/nvidia-grid.run
  sudo /usr/local/packer/nvidia-grid.run --silent --dkms
else
  echo "No NVIDIA bundle in /usr/local/packer. Skipping GRID driver."
fi
