#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CUDA_VERSION:-}" ]; then
  echo "Skipping CUDA installation (no version provided)."
  exit 0
fi

echo "Installing CUDA ${CUDA_VERSION}..."
wget -O /tmp/cuda-keyring.deb https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i /tmp/cuda-keyring.deb
sudo apt-get update
sudo apt-get install -y "cuda-toolkit-${CUDA_VERSION}"
