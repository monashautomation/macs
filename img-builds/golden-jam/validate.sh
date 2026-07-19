#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# packer validate evaluates file(ssh_public_key_path), so the build keypair
# must exist (see build.sh).
[ -f pkey.pem ] || ssh-keygen -t ed25519 -f pkey.pem -N '' -C packer-build

packer init .
packer validate \
  -var "proxmox_username=$(secrets proxmox_packer_username)" \
  -var "proxmox_token=$(secrets proxmox_packer_token)" \
  -var-file=golden-jam.pkrvars.hcl \
  "$@" .

