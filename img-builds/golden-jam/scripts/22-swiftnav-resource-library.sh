#!/usr/bin/env bash
set -euo pipefail

echo "INSTALLING SWIFTNAV RESOURCE LIBRARY..."
sudo mkdir -p /usr/local/packer/swiftnav
sudo chown -R baker /usr/local/packer/swiftnav
cd /usr/local/packer/swiftnav
wget "https://www.swiftnav.com/resource-files/Swift%20Console/v4.0.19/Installer/swift-console_v4.0.19_linux.deb"
sudo dpkg -i ./swift-console_v4.0.19_linux.deb

echo "INSTALLING LIBSBP..."
git clone https://github.com/swift-nav/libsbp.git
cd libsbp
git checkout v4.11.0
cd c
git submodule update --init --recursive
mkdir -p build
cd build
cmake -DCMAKE_CXX_STANDARD=17 -DCMAKE_CXX_STANDARD_REQUIRED=ON -DCMAKE_CXX_EXTENSIONS=OFF ../
make
sudo make install
cd ../../../

# Pinned libserialport release required by the Swift console
wget https://github.com/sigrokproject/libserialport/releases/download/libserialport-0.1.2/libserialport-0.1.2.tar.gz
tar -xzf libserialport-0.1.2.tar.gz
cd libserialport-0.1.2
./configure
make
sudo make install
sudo ldconfig
