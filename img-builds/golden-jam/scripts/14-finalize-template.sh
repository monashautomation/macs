#!/usr/bin/env bash
set -euo pipefail

# Final step before the VM is turned into a template. Two jobs:
#  1. Make cloud-init actually read the Proxmox datasource on clones.
#  2. Strip build-time artifacts so they don't bake into the image.

# --- 1. cloud-init datasource ------------------------------------------------
# Ubuntu autoinstall (subiquity) leaves /etc/cloud/cloud.cfg.d/99-installer.cfg
# which pins `datasource_list: [None]` and bakes the build-time user-data in.
# That file loads AFTER 90_dpkg.cfg and wins, so a clone ignores the Proxmox
# cloud-init drive entirely (cloud-init reports DataSourceNone) and none of the
# deploy-time user-data - user creation, NetBird, Sunshine - ever runs.
# Remove the pin and the matching network freeze, then declare the datasources
# Proxmox actually provides (NoCloud drive; ConfigDrive for the Windows path's
# cousin, harmless here).
echo "Removing subiquity cloud-init datasource pin..."
sudo rm -f /etc/cloud/cloud.cfg.d/99-installer.cfg \
           /etc/cloud/cloud.cfg.d/90-installer-network.cfg
echo 'datasource_list: [ NoCloud, ConfigDrive ]' | \
  sudo tee /etc/cloud/cloud.cfg.d/99-pve.cfg > /dev/null

# --- 2. build-time artifact cleanup -----------------------------------------
# Don't bake the build-time apt proxy or the cacher CA into the template.
echo "Removing build-time apt proxy / cacher CA..."
sudo rm -f /etc/apt/apt.conf.d/99-packer-proxy /etc/apt/apt.conf.d/90curtin-aptproxy
sudo rm -f /usr/local/share/ca-certificates/apt-cacher-ng.crt
sudo update-ca-certificates --fresh >/dev/null 2>&1 || true
sudo chown --recursive root /usr/local/packer

# --- 3. reset cloud-init state (MUST be last) --------------------------------
# Wipe instance state + logs so the first clone boot is treated as a fresh
# instance and re-runs every per-instance module against the Proxmox seed.
echo "Cleaning cloud-init state..."
sudo cloud-init clean --logs
