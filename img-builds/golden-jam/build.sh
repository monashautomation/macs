#!/usr/bin/env bash
# Build the jammy-A16 golden image template on Proxmox.
# Secrets resolve via repo-root secrets.conf (see secrets.conf.example).
set -euo pipefail
cd "$(dirname "$0")"

packer init .
packer build \
  -var "proxmox_username=$(secrets proxmox_packer_username)" \
  -var "proxmox_token=$(secrets proxmox_packer_token)" \
  -var-file=golden-jam.pkrvars.hcl \
  "$@" .

