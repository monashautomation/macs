#!/usr/bin/env bash
set -euo pipefail

if [ "${INSTALL_CONDA:-false}" = "true" ]; then
  echo "Installing Miniconda..."
  wget -O /tmp/miniconda.sh https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
  sudo bash /tmp/miniconda.sh -b -p /opt/miniconda
  /opt/miniconda/bin/conda init
fi

if [ "${INSTALL_PYTORCH:-false}" = "true" ]; then
  echo "Installing PyTorch..."
  sudo apt-get install -y python3-pip
  python3 -m pip install torch torchvision torchaudio
fi

if [ "${INSTALL_VSCODE:-false}" = "true" ]; then
  echo "Installing VSCode..."
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor | sudo tee /etc/apt/keyrings/packages.microsoft.gpg > /dev/null
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" | sudo tee /etc/apt/sources.list.d/vscode.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y code
fi
