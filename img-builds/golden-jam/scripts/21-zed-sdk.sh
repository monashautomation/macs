#!/usr/bin/env bash
set -euo pipefail

sudo apt-get install -y zstd
# install zed_sdk
sudo mkdir -p /usr/local/packer/zed_sdk
sudo chown -R baker /usr/local/packer/zed_sdk
cd /usr/local/packer/zed_sdk
wget -O zed_sdk https://download.stereolabs.com/zedsdk/4.1/cu121/ubuntu22
chmod +x zed_sdk
./zed_sdk -- silent skip_cuda
