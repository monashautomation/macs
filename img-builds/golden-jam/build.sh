#!/usr/bin/env bash
# Build the jammy-A16 golden image template on Proxmox.
# Secrets resolve via repo-root secrets.conf (see secrets.conf.example).
set -euo pipefail
cd "$(dirname "$0")"

# Per-builder SSH keypair for the Packer communicator (gitignored, generated
# on demand). The public half is baked as baker's authorized key during
# autoinstall; rebuilding with a fresh key rotates it.
[ -f pkey.pem ] || ssh-keygen -t ed25519 -f pkey.pem -N '' -C packer-build

packer init .
packer build \
  -var "proxmox_username=$(secrets proxmox_packer_username)" \
  -var "proxmox_token=$(secrets proxmox_packer_token)" \
  -var-file=golden-jam.pkrvars.hcl \
  "$@" .

